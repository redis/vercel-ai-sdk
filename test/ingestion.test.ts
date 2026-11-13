import type { AgentMemory } from '@redis-iris/agent-memory';
import type { IngestionHookStatus } from '@redis-iris/agent-memory/models';
import type { ToolSet } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { createIngestionTools } from '../src/ingestion.js';
import { createScopedMemory, type RedisAgentMemoryScope } from '../src/scoped-memory.js';

const ING = `ing_${'a'.repeat(32)}`;
const EX = `ex_${'b'.repeat(32)}`;
const now = new Date('2026-11-01T00:00:00Z');

function hookStatus(overrides: Partial<IngestionHookStatus> = {}): IngestionHookStatus {
  return {
    eventId: 'evt-1', ingestionOperationId: 'op-1', phase: 'INPUT', path: '/memories', ownerId: 'user-1',
    source: {}, configRevision: 'r1', state: 'ACCEPTED', applyState: 'APPLIED', attempts: 1,
    createdAt: now, updatedAt: now, deadline: now, applied: 1, filtered: 0, conflicts: 0, ...overrides,
  };
}

function setup(
  scope: RedisAgentMemoryScope = {},
  memories: Record<string, { ownerId: string; namespaceId?: string }> = {},
  outputs: string[] = [],
  statuses: IngestionHookStatus[] = [hookStatus()],
) {
  const ingestion = { ingestionId: ING, status: { processing: 'SUCCEEDED', cleanup: 'PENDING', createdCount: outputs.length } };
  const client = {
    createDocumentIngestion: vi.fn(async (_body: Record<string, unknown>, _options?: unknown) => ({
      headers: { 'x-internal': ['secret'] }, result: { ingestionId: ING, status: ingestion.status },
    })),
    getDocumentIngestion: vi.fn(async (_id: string, _options?: unknown) => ({ ingestion })),
    listDocumentIngestionOutputs: vi.fn(async (..._args: unknown[]) => ({ items: outputs, nextCursor: 'next' })),
    getLongTermMemory: vi.fn(async (id: string, _options?: unknown) => {
      const memory = memories[id];
      if (!memory) throw Object.assign(new Error('not found'), { statusCode: 404 });
      return { id, ...memory };
    }),
    getIngestionHookStatus: vi.fn(async (eventId: string, _options?: unknown) => ({
      status: statuses.find(status => status.eventId === eventId)!,
    })),
    listIngestionHookStatuses: vi.fn(async (..._args: unknown[]) => ({ items: statuses })),
  };
  const sdk = client as unknown as AgentMemory;
  return { tools: createIngestionTools(sdk, createScopedMemory(sdk, scope)), client };
}

async function run(tools: ToolSet, name: string, input: unknown): Promise<any> {
  const definition = tools[name];
  if (!definition?.execute) throw new Error(`Missing tool: ${name}`);
  const schema = definition.inputSchema as { parseAsync(value: unknown): Promise<unknown> };
  return definition.execute(await schema.parseAsync(input), { toolCallId: 'ingestion-test', messages: [], context: {} });
}

const submission = {
  documentId: 'policy', revision: 'v1', content: 'Prefers email. Café ✓', mediaType: 'text/markdown',
  extractorId: EX, idempotencyKey: 'policy-v1',
};

describe('create_document_ingestion', () => {
  it('base64-encodes UTF-8 content, forces the scoped owner, and returns only the body', async () => {
    const { tools, client } = setup({ userId: 'user-1' });
    const result = await run(tools, 'create_document_ingestion', submission);
    expect(client.createDocumentIngestion.mock.calls[0]![0]).toEqual({
      ...submission, content: Buffer.from(submission.content, 'utf8').toString('base64'), ownerId: 'user-1',
    });
    expect(result).toEqual({ ingestionId: ING, status: expect.objectContaining({ processing: 'SUCCEEDED' }) });
  });

  it('rejects another owner under a fixed userId', async () => {
    const { tools, client } = setup({ userId: 'user-1' });
    await expect(run(tools, 'create_document_ingestion', { ...submission, ownerId: 'user-2' })).rejects.toThrow();
    expect(client.createDocumentIngestion).not.toHaveBeenCalled();
  });

  it('requires an owner without a fixed userId', async () => {
    const { tools, client } = setup();
    await expect(run(tools, 'create_document_ingestion', submission)).rejects.toThrow();
    await run(tools, 'create_document_ingestion', { ...submission, ownerId: 'user-9' });
    expect(client.createDocumentIngestion.mock.calls[0]![0]).toMatchObject({ ownerId: 'user-9' });
  });

  it('is refused under a fixed namespace, which it cannot place memories in', async () => {
    const { tools, client } = setup({ userId: 'user-1', namespaceId: 'ns-1' });
    await expect(run(tools, 'create_document_ingestion', submission)).rejects.toThrow();
    expect(client.createDocumentIngestion).not.toHaveBeenCalled();
  });

  it('rejects input without an idempotency key or with a malformed extractor ID', async () => {
    const { tools } = setup({ userId: 'user-1' });
    const { idempotencyKey: _omitted, ...withoutKey } = submission;
    await expect(run(tools, 'create_document_ingestion', withoutKey)).rejects.toThrow();
    await expect(run(tools, 'create_document_ingestion', { ...submission, extractorId: 'ex_1' })).rejects.toThrow();
  });
});

describe('document ingestion reads', () => {
  it('passes through unscoped reads with paging', async () => {
    const { tools, client } = setup({}, {}, ['m-other']);
    expect(await run(tools, 'list_document_ingestion_outputs', { ingestionId: ING, limit: 5, cursor: 'c1' }))
      .toEqual({ items: ['m-other'], nextCursor: 'next' });
    expect(client.listDocumentIngestionOutputs.mock.calls[0]!.slice(0, 3)).toEqual([ING, 5, 'c1']);
    expect(client.getLongTermMemory).not.toHaveBeenCalled();
  });

  it('returns owned outputs and drops memories deleted since extraction', async () => {
    const { tools } = setup({ userId: 'user-1' }, { m1: { ownerId: 'user-1' } }, ['m1', 'm-deleted']);
    expect(await run(tools, 'list_document_ingestion_outputs', { ingestionId: ING }))
      .toEqual({ items: ['m1'], nextCursor: 'next' });
  });

  it.each(['list_document_ingestion_outputs', 'get_document_ingestion'])(
    'refuses %s when an output belongs to another user', async (name) => {
      const { tools } = setup({ userId: 'user-1' }, { m1: { ownerId: 'user-1' }, m2: { ownerId: 'user-2' } }, ['m1', 'm2']);
      await expect(run(tools, name, { ingestionId: ING })).rejects.toThrow();
    },
  );

  it('refuses outputs placed outside a fixed namespace', async () => {
    const { tools } = setup({ namespaceId: 'ns-1' }, { m1: { ownerId: 'user-1', namespaceId: 'ns-2' } }, ['m1']);
    await expect(run(tools, 'list_document_ingestion_outputs', { ingestionId: ING })).rejects.toThrow();
  });

  it('returns the status of an owned ingestion', async () => {
    const { tools } = setup({ userId: 'user-1' }, { m1: { ownerId: 'user-1' } }, ['m1']);
    expect(await run(tools, 'get_document_ingestion', { ingestionId: ING }))
      .toEqual({ ingestion: expect.objectContaining({ ingestionId: ING }) });
  });

  it.each(['get_document_ingestion', 'list_document_ingestion_outputs'])(
    'refuses %s under a fixed user when no output can be verified, within a bounded page walk', async (name) => {
      const { tools, client } = setup({ userId: 'user-1' }, {}, []);
      await expect(run(tools, name, { ingestionId: ING })).rejects.toMatchObject({ code: 'INVALID_SCOPE' });
      expect(client.listDocumentIngestionOutputs.mock.calls.length).toBeLessThanOrEqual(6);
    },
  );

  it('lets a scoped toolset read an ingestion it submitted before any output exists', async () => {
    const { tools, client } = setup({ userId: 'user-1' }, {}, []);
    await expect(run(tools, 'get_document_ingestion', { ingestionId: ING })).rejects.toMatchObject({ code: 'INVALID_SCOPE' });
    await run(tools, 'create_document_ingestion', submission);
    client.listDocumentIngestionOutputs.mockClear();
    expect(await run(tools, 'get_document_ingestion', { ingestionId: ING }))
      .toEqual({ ingestion: expect.objectContaining({ ingestionId: ING }) });
    expect(await run(tools, 'list_document_ingestion_outputs', { ingestionId: ING })).toMatchObject({ items: [] });
    expect(client.listDocumentIngestionOutputs).toHaveBeenCalledTimes(1);
  });

  it('stops the scope proof at the first verified output instead of checking the whole page', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `m${i}`);
    const { tools, client } = setup({ userId: 'user-1' }, Object.fromEntries(ids.map(id => [id, { ownerId: 'user-1' }])), ids);
    await run(tools, 'get_document_ingestion', { ingestionId: ING });
    expect(client.getLongTermMemory.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it.each(['get_ingestion_hook_status', 'list_ingestion_hook_statuses'])(
    'refuses %s when scoped only by sessionId, since statuses are store-wide', async (name) => {
      const { tools, client } = setup({ sessionId: 'session-1' });
      await expect(run(tools, name, { eventId: 'evt-1' })).rejects.toMatchObject({ code: 'INVALID_SCOPE' });
      expect(client.getIngestionHookStatus).not.toHaveBeenCalled();
      expect(client.listIngestionHookStatuses).not.toHaveBeenCalled();
    },
  );

  it('refuses a scoped status read when every output was deleted', async () => {
    const { tools } = setup({ namespaceId: 'ns-1' }, {}, ['m-deleted']);
    await expect(run(tools, 'get_document_ingestion', { ingestionId: ING })).rejects.toMatchObject({ code: 'INVALID_SCOPE' });
  });

  it('follows nextCursor past empty pages to prove scope', async () => {
    const { tools, client } = setup({ userId: 'user-1' }, { m1: { ownerId: 'user-1' } });
    client.listDocumentIngestionOutputs
      .mockResolvedValueOnce({ items: [], nextCursor: 'c1' })
      .mockResolvedValueOnce({ items: ['m1'], nextCursor: undefined } as never);
    expect(await run(tools, 'get_document_ingestion', { ingestionId: ING }))
      .toEqual({ ingestion: expect.objectContaining({ ingestionId: ING }) });
    expect(client.listDocumentIngestionOutputs.mock.calls[1]!.slice(0, 3)).toEqual([ING, 100, 'c1']);
  });

  it('returns an empty outputs page once scope is proven on a later page', async () => {
    const { tools, client } = setup({ userId: 'user-1' }, { m1: { ownerId: 'user-1' } });
    client.listDocumentIngestionOutputs
      .mockResolvedValueOnce({ items: [], nextCursor: 'c1' })
      .mockResolvedValueOnce({ items: [], nextCursor: 'c1' })
      .mockResolvedValueOnce({ items: ['m1'], nextCursor: undefined } as never);
    expect(await run(tools, 'list_document_ingestion_outputs', { ingestionId: ING }))
      .toEqual({ items: [], nextCursor: 'c1' });
  });

  it('rejects malformed ingestion IDs before calling the server', async () => {
    const { tools, client } = setup();
    await expect(run(tools, 'get_document_ingestion', { ingestionId: 'ing_x' })).rejects.toThrow();
    expect(client.getDocumentIngestion).not.toHaveBeenCalled();
  });
});

describe('ingestion hook statuses', () => {
  const mine = hookStatus();
  const theirs = hookStatus({ eventId: 'evt-2', ownerId: 'user-2' });

  it('filters listed statuses to the fixed user', async () => {
    const { tools, client } = setup({ userId: 'user-1' }, {}, [], [mine, theirs]);
    expect((await run(tools, 'list_ingestion_hook_statuses', { limit: 10 })).items).toEqual([mine]);
    expect(client.listIngestionHookStatuses.mock.calls[0]!.slice(0, 2)).toEqual([10, undefined]);
  });

  it('lists every status without a fixed user', async () => {
    const { tools } = setup({}, {}, [], [mine, theirs]);
    expect((await run(tools, 'list_ingestion_hook_statuses', {})).items).toEqual([mine, theirs]);
  });

  it('returns an owned status and refuses another user’s', async () => {
    const { tools } = setup({ userId: 'user-1' }, {}, [], [mine, theirs]);
    expect(await run(tools, 'get_ingestion_hook_status', { eventId: 'evt-1' })).toEqual({ status: mine });
    await expect(run(tools, 'get_ingestion_hook_status', { eventId: 'evt-2' })).rejects.toThrow();
  });

  it.each([
    ['get_ingestion_hook_status', { namespaceId: 'ns-1' }],
    ['list_ingestion_hook_statuses', { namespaceId: 'ns-1' }],
    ['get_ingestion_hook_status', { userId: 'user-1', namespaceId: 'ns-1' }],
    ['list_ingestion_hook_statuses', { userId: 'user-1', namespaceId: 'ns-1' }],
  ] as const)(
    'refuses %s under a fixed namespace %j', async (name, scope) => {
      const { tools, client } = setup(scope, {}, [], [mine]);
      await expect(run(tools, name, { eventId: 'evt-1' })).rejects.toMatchObject({ code: 'INVALID_SCOPE' });
      expect(client.getIngestionHookStatus).not.toHaveBeenCalled();
      expect(client.listIngestionHookStatuses).not.toHaveBeenCalled();
    },
  );
});
