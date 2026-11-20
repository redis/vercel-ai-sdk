import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateText, stepCountIs, streamText, tool } from 'ai';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { z } from 'zod';
import { createRedisAgentMemory, type RedisAgentMemoryDiagnostic } from '../src/index.js';

const timestamp = '2026-10-07T12:00:00.000Z';
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};
const scope = { userId: 'user-1', sessionId: 'session-1' };
type Failures = { search?: number; USER?: number; ASSISTANT?: number };

beforeEach(() => { (globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false; });
afterEach(() => {
  delete (globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS;
  vi.unstubAllGlobals();
});

function transport(failures: Failures = {}) {
  const events: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const failure = (status?: number) => Response.json({ title: 'SENTINEL PRIVATE BODY' }, { status });
    if (request.url.endsWith('/memories/search')) {
      return failures.search ? failure(failures.search) : Response.json({ items: [] });
    }
    if (request.method === 'GET') {
      return events.length === 0
        ? Response.json({ title: 'Missing' }, { status: 404 })
        : Response.json({ sessionId: 'session-1', ownerId: 'user-1', events });
    }
    const body = await request.json() as Record<string, unknown>;
    const status = failures[body.role as 'USER' | 'ASSISTANT'];
    if (status) return failure(status);
    const saved = { ...body, sessionId: 'session-1', eventId: `event-${events.length + 1}`, systemTimestamp: timestamp };
    events.push(saved);
    return Response.json({ event: saved }, { status: 201 });
  }));
}

function memoryModel(base: MockLanguageModelV4, diagnostics: RedisAgentMemoryDiagnostic[] = []) {
  return createRedisAgentMemory({
    serverUrl: 'https://warnings.example.test', storeId: 'store-1', apiKey: 'secret-key', model: base,
  }).model({ scope, assistantId: 'assistant-1', onDiagnostic: event => diagnostics.push(event) });
}

const generating = () => new MockLanguageModelV4({ doGenerate: async () => ({
  content: [{ type: 'text', text: 'Answer.' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [],
}) });

const streaming = () => new MockLanguageModelV4({ doStream: async () => ({
  stream: convertArrayToReadableStream([
    { type: 'stream-start' as const, warnings: [] },
    { type: 'text-start' as const, id: 'answer' },
    { type: 'text-delta' as const, id: 'answer', delta: 'Answer.' },
    { type: 'text-end' as const, id: 'answer' },
    { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'stop' }, usage },
  ]),
}) });

describe('memory failures in AI SDK warnings', () => {
  it.each<[string, Failures, string[]]>([
    ['healthy store and a new session', {}, []],
    ['failed search', { search: 503 }, ['Redis Agent Memory memory.search failure (IRIS_HTTP_503).']],
    ['failed USER write', { USER: 500 }, ['Redis Agent Memory session.user.write failure (IRIS_HTTP_500).']],
    ['failed ASSISTANT write', { ASSISTANT: 500 },
      ['Redis Agent Memory session.assistant.write failure (IRIS_HTTP_500).']],
  ])('generateText reports %s', async (_name, failures, messages) => {
    transport(failures);

    const result = await generateText({ model: memoryModel(generating()), prompt: 'Question.' });

    expect(result.text).toBe('Answer.');
    expect(result.warnings).toEqual(messages.map(message => ({ type: 'other', message })));
    expect(JSON.stringify(result.warnings)).not.toMatch(/SENTINEL|Question|user-1|secret-key/);
  });

  it('streamText reports read and USER write failures from before inference', async () => {
    transport({ search: 503, USER: 500 });

    const result = streamText({ model: memoryModel(streaming()), prompt: 'Question.' });

    expect(await result.text).toBe('Answer.');
    expect(await result.warnings).toEqual([
      { type: 'other', message: 'Redis Agent Memory memory.search failure (IRIS_HTTP_503).' },
      { type: 'other', message: 'Redis Agent Memory session.user.write failure (IRIS_HTTP_500).' },
    ]);
  });

  it('streamText reports pre-inference failures when the upstream stream has no stream-start', async () => {
    transport({ search: 503 });
    const base = new MockLanguageModelV4({ doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'text-start' as const, id: 'answer' },
        { type: 'text-delta' as const, id: 'answer', delta: 'Answer.' },
        { type: 'text-end' as const, id: 'answer' },
        { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'stop' }, usage },
      ]),
    }) });

    const result = streamText({ model: memoryModel(base), prompt: 'Question.' });

    expect(await result.text).toBe('Answer.');
    expect(await result.warnings).toEqual([
      { type: 'other', message: 'Redis Agent Memory memory.search failure (IRIS_HTTP_503).' },
    ]);
  });

  it('streamText leaves a failed ASSISTANT write to onDiagnostic because stream-start has already been sent', async () => {
    transport({ ASSISTANT: 500 });
    const diagnostics: RedisAgentMemoryDiagnostic[] = [];

    const result = streamText({ model: memoryModel(streaming(), diagnostics), prompt: 'Question.' });

    expect(await result.text).toBe('Answer.');
    expect(await result.warnings).toEqual([]);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      operation: 'session.assistant.write', outcome: 'failure',
    }));
  });

  it('reports a cached read failure once across tool-loop steps', async () => {
    transport({ search: 503 });
    let calls = 0;
    const base = new MockLanguageModelV4({ doGenerate: async () => (++calls === 1
      ? { content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'noop', input: '{}' }],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] }
      : { content: [{ type: 'text', text: 'Answer.' }],
        finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }) });

    const result = await generateText({
      model: memoryModel(base), prompt: 'Question.', stopWhen: stepCountIs(2),
      tools: { noop: tool({ inputSchema: z.object({}), execute: async () => 'ok' }) },
    });

    expect(result.steps.map(step => step.warnings?.length ?? 0)).toEqual([1, 0]);
  });
});
