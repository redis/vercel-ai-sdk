import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolLoopAgent, isStepCount, type ToolSet } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import {
  createRedisAgentMemory, instructions,
  type RedisAgentMemoryOptions, type RedisAgentMemoryScope,
} from '../src/index.js';

const apiKey = 'test-secret-iris-key';
const serverURL = 'https://iris.example.test';
const timestamp = '2026-09-25T12:34:56.000Z';
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function memory(overrides: Record<string, unknown> = {}) {
  return {
    memoryId: 'memory-1', text: 'Prefers concise replies.', ownerId: 'user-1',
    sessionId: 'older-session', createdAt: timestamp, updatedAt: timestamp, ...overrides,
  };
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'event-1', sessionId: 'session-1', actorId: 'user-1', role: 'USER',
    content: [{ text: 'Hello.' }], createdAt: timestamp, systemTimestamp: timestamp, ...overrides,
  };
}

function namespace(overrides: Record<string, unknown> = {}) {
  return {
    namespaceId: 'root-1', name: 'personal', rootId: 'root-1', ownerId: 'user-1',
    scope: 'PERSONAL', state: 'ACTIVE', revision: '1', path: '/personal',
    createdAt: timestamp, updatedAt: timestamp, ...overrides,
  };
}

/** Exercise the official SDK against a fake HTTP boundary, rather than mocking its methods. */
function transport(...responses: Array<{ body: unknown; status?: number }>) {
  const requests: Array<{ request: Request; body: any }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const text = await request.clone().text();
    const body = text ? JSON.parse(text) : undefined;
    requests.push({ request, body });
    const response = responses.shift();
    if (!response) throw new Error(`Unexpected HTTP request: ${request.method} ${request.url}`);
    const created = request.method === 'POST' && /\/(memories|sessions|namespaces|sessions\/[^/]+\/events)$/.test(new URL(request.url).pathname);
    return new Response(JSON.stringify(typeof response.body === 'function' ? response.body(body) : response.body), {
      status: response.status ?? (created ? 201 : 200),
      headers: { 'content-type': 'application/json' },
    });
  });
  return { requests, fetch: fetch as typeof globalThis.fetch };
}

async function run(tools: ToolSet, name: string, input: unknown, abortSignal?: AbortSignal): Promise<any> {
  const definition = tools[name];
  if (!definition?.execute) throw new Error(`No executable tool named ${name}`);
  const schema = definition.inputSchema as { parseAsync(input: unknown): Promise<unknown> };
  const parsed = await schema.parseAsync(input);
  return definition.execute(parsed, { toolCallId: 'test-call', messages: [], abortSignal, context: {} });
}

function makeTools(
  serverUrl?: string,
  storeId?: string,
  key?: string,
  scope: RedisAgentMemoryScope = {},
  options: RedisAgentMemoryOptions = {},
) {
  return createRedisAgentMemory({ ...options, serverUrl, storeId, apiKey: key, scope }).tools();
}

function toolsWith(
  fetch: typeof globalThis.fetch,
  scope: RedisAgentMemoryScope = {},
  options: RedisAgentMemoryOptions = {},
) {
  vi.stubGlobal('fetch', fetch);
  return makeTools(serverURL, 'store-1', apiKey, scope, options);
}

describe('RedisAgentMemory toolset', () => {
  it('can be passed directly as a ToolSet and exposes no enumerable client or credentials', () => {
    const tools: ToolSet = toolsWith(transport().fetch);
    expect(Object.keys(tools)).toEqual([
      'get_memory_context', 'start_session', 'add_session_event', 'get_session_event',
      'get_session_memory', 'list_sessions', 'create_memories', 'get_memory',
      'search_memories', 'update_memory', 'upsert_memory', 'update_memory_fields',
      'list_memory_sources', 'list_memory_source_evidence', 'list_source_memories',
    ]);
    for (const definition of Object.values(tools)) {
      expect(definition).toHaveProperty('inputSchema');
      expect(definition.execute).toBeTypeOf('function');
      expect(definition.description).toBeTypeOf('string');
    }
    expect(JSON.stringify(tools)).not.toContain(apiKey);
    expect(instructions).toBeTypeOf('string');
    expect(instructions.length).toBeGreaterThan(100);
  });

  it.each([
    { options: undefined, deletes: false, namespaces: false },
    { options: { allowDeletes: false, namespaceTools: false }, deletes: false, namespaces: false },
    { options: { allowDeletes: true }, deletes: true, namespaces: false },
    { options: { namespaceTools: true }, deletes: false, namespaces: true },
    { options: { allowDeletes: true, namespaceTools: true }, deletes: true, namespaces: true },
  ])('exposes only the tools enabled by $options', async ({ options, deletes, namespaces }) => {
    const tools = makeTools(serverURL, 'store-1', apiKey, undefined, options);
    expect(tools.search_memories).toBeDefined();
    for (const name of ['delete_memories', 'delete_session_event', 'delete_session_memory']) {
      expect(tools[name] !== undefined).toBe(deletes);
    }
    for (const name of [
      'list_namespaces', 'get_namespace', 'create_namespace', 'update_namespace', 'move_memories',
      'get_namespace_routing', 'put_namespace_routing',
    ]) {
      expect(tools[name] !== undefined).toBe(namespaces);
    }
    expect(tools.delete_namespace !== undefined).toBe(deletes && namespaces);
    expect(await run(tools, 'get_memory_context', {})).toHaveProperty('allowDeletes', deletes);
  });

  it.each([
    { options: undefined, ingestion: false, views: false, viewDeletes: false },
    { options: { ingestionTools: true }, ingestion: true, views: false, viewDeletes: false },
    { options: { summaryViewTools: true }, ingestion: false, views: true, viewDeletes: false },
    { options: { summaryViewTools: true, allowDeletes: true }, ingestion: false, views: true, viewDeletes: true },
  ])('exposes ingestion and Summary View tools only when enabled by $options', ({ options, ingestion, views, viewDeletes }) => {
    const tools = makeTools(serverURL, 'store-1', apiKey, undefined, options);
    for (const name of [
      'create_document_ingestion', 'get_document_ingestion', 'list_document_ingestion_outputs',
      'get_ingestion_hook_status', 'list_ingestion_hook_statuses',
    ]) expect(tools[name] !== undefined).toBe(ingestion);
    for (const name of [
      'list_summary_views', 'get_summary_view', 'create_summary_view', 'update_summary_view',
      'refresh_summary_view', 'get_summary_view_result',
    ]) expect(tools[name] !== undefined).toBe(views);
    expect(tools.delete_summary_view !== undefined).toBe(viewDeletes);
  });

  it('uses environment configuration when positional connection arguments are omitted', async () => {
    vi.stubEnv('AGENT_MEMORY_URL', 'https://environment.example.test');
    vi.stubEnv('AGENT_MEMORY_STORE_ID', 'environment-store');
    vi.stubEnv('AGENT_MEMORY_API_KEY', 'environment-key');
    const http = transport({ body: { items: [] } });
    vi.stubGlobal('fetch', http.fetch);

    await run(makeTools(), 'search_memories', {});

    const { request } = http.requests[0]!;
    expect(request.url).toBe('https://environment.example.test/iris/data/v1/agent-memory/stores/environment-store/memories/search');
    expect(request.headers.get('authorization')).toBe('Bearer environment-key');
  });

  it('uses explicit connection options ahead of environment configuration and copies scope', async () => {
    vi.stubEnv('AGENT_MEMORY_URL', 'https://environment.example.test');
    vi.stubEnv('AGENT_MEMORY_STORE_ID', 'environment-store');
    vi.stubEnv('AGENT_MEMORY_API_KEY', 'environment-key');
    const http = transport({ body: { items: [] } });
    vi.stubGlobal('fetch', http.fetch);
    const scope = { userId: 'user-1', sessionId: 'session-1' };
    const tools = makeTools(serverURL, 'store-1', apiKey, scope);
    scope.userId = 'changed-user';
    scope.sessionId = 'changed-session';

    await run(tools, 'search_memories', {});

    const { request, body } = http.requests[0]!;
    expect(request.url).toBe(`${serverURL}/iris/data/v1/agent-memory/stores/store-1/memories/search`);
    expect(request.headers.get('authorization')).toBe(`Bearer ${apiKey}`);
    expect(body.filter).toEqual({ op: 'ALL', ownerId: { eq: 'user-1' } });
    const context = await run(tools, 'get_memory_context', {});
    expect(context).toMatchObject({ userId: 'user-1', sessionId: 'session-1' });
    expect(context).not.toHaveProperty('ownerId');
  });

  it('requires a server URL because each store has its own endpoint', () => {
    vi.stubEnv('AGENT_MEMORY_URL', undefined);
    const http = transport();
    vi.stubGlobal('fetch', http.fetch);

    expect(() => makeTools(undefined, 'store-1', apiKey)).toThrow('AGENT_MEMORY_URL');
    vi.stubEnv('AGENT_MEMORY_URL', '  ');
    expect(() => makeTools(undefined, 'store-1', apiKey)).toThrow('AGENT_MEMORY_URL');
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('fails at construction when required connection options are missing', () => {
    vi.stubEnv('AGENT_MEMORY_API_KEY', undefined);
    vi.stubEnv('AGENT_MEMORY_STORE_ID', undefined);
    expect(() => makeTools(serverURL, 'store-1')).toThrow('AGENT_MEMORY_API_KEY');
    expect(() => makeTools(serverURL, undefined, apiKey)).toThrow('AGENT_MEMORY_STORE_ID');
  });

  it.each([0, -1, NaN, Infinity])('rejects an invalid request timeout of %s', timeoutMs => {
    expect(() => makeTools(serverURL, 'store-1', apiKey, undefined, { timeoutMs })).toThrow('timeoutMs');
  });

  it('aborts a stalled HTTP request after the configured timeout', async () => {
    let receivedSignal: AbortSignal | undefined;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      receivedSignal = request.signal;
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(request.signal.reason);
        if (request.signal.aborted) abort();
        else request.signal.addEventListener('abort', abort, { once: true });
      });
    };
    const tools = toolsWith(fetch, {}, { timeoutMs: 20 });

    await expect(run(tools, 'search_memories', {})).rejects.toMatchObject({ code: 'IRIS_REQUEST_FAILED' });
    expect(receivedSignal?.aborted).toBe(true);
    expect(receivedSignal?.reason).toHaveProperty('name', 'TimeoutError');
  });

  it('uses SDK HTTP serialization and preserves search pagination and records', async () => {
    const http = transport({ body: { items: [memory()], nextCursor: 'next-page' } });
    const result = await run(toolsWith(http.fetch), 'search_memories', {
      query: 'communication preferences', limit: 5, cursor: 'previous-page',
      filter: { createdAt: { gte: '2026-09-01T00:00:00Z' } },
    });
    expect(http.requests).toHaveLength(1);
    const { request, body } = http.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe(`${serverURL}/iris/data/v1/agent-memory/stores/store-1/memories/search`);
    expect(request.headers.get('authorization')).toBe(`Bearer ${apiKey}`);
    expect(body).toMatchObject({
      query: 'communication preferences', limit: 5, cursor: 'previous-page',
      filter: { createdAt: { gte: '2026-09-01T00:00:00.000Z' } },
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ memoryId: 'memory-1', text: 'Prefers concise replies.' });
    expect(new Date(result.items[0].createdAt).toISOString()).toBe(timestamp);
    expect(result.nextCursor).toBe('next-page');
  });

  it('maps user scope to the owner filter while retaining memories from other sessions', async () => {
    const http = transport({ body: { items: [memory()] } });
    await run(toolsWith(http.fetch, { userId: 'user-1', sessionId: 'current-session' }),
      'search_memories', { query: 'preferences', filter: { topics: { in: ['preferences'] } } });
    expect(http.requests[0]!.body.filter).toEqual({
      op: 'ALL', ownerId: { eq: 'user-1' }, topics: { in: ['preferences'] },
    });
  });

  it('refuses a namespace filter that conflicts with a fixed session and namespace', async () => {
    const http = transport();
    const tools = toolsWith(http.fetch, { sessionId: 'session-1', namespaceId: 'notes-1' });
    await expect(run(tools, 'list_sessions', { namespaceId: 'other' })).rejects.toMatchObject({ code: 'INVALID_SCOPE' });
    expect(http.requests).toHaveLength(0);
  });

  it('applies a namespace filter to a fixed session', async () => {
    const session = { sessionId: 'session-1', ownerId: 'user-1', namespaceId: 'notes-1', events: [] };
    const http = transport({ body: session }, { body: session });
    const tools = toolsWith(http.fetch, { sessionId: 'session-1' });
    expect((await run(tools, 'list_sessions', { namespaceId: 'other' })).items).toEqual([]);
    expect((await run(tools, 'list_sessions', { namespaceId: 'notes-1' })).items).toHaveLength(1);
  });

  it('uses the scoped user ID as the owner when listing sessions', async () => {
    const http = transport({ body: { items: [{ sessionId: 'session-1', ownerId: 'user-1' }] } });
    const tools = toolsWith(http.fetch, { userId: 'user-1' });

    const result = await run(tools, 'list_sessions', {});

    expect(result.items).toEqual([{ sessionId: 'session-1', ownerId: 'user-1' }]);
    const query = new URL(http.requests[0]!.request.url).searchParams;
    expect(query.get('ownerId')).toBe('user-1');
    expect(query.has('userId')).toBe(false);
  });

  it('filters session listing by the fixed namespace and rejects sessions outside it', async () => {
    const http = transport(
      { body: { items: [{ sessionId: 'session-1', ownerId: 'user-1', namespaceId: 'notes-1' }] } },
      { body: { items: [{ sessionId: 'session-2', ownerId: 'user-1', namespaceId: 'other' }] } },
    );
    const tools = toolsWith(http.fetch, { userId: 'user-1', namespaceId: 'notes-1' });

    const result = await run(tools, 'list_sessions', {});

    expect(result.items).toEqual([{ sessionId: 'session-1', ownerId: 'user-1', namespaceId: 'notes-1' }]);
    const query = new URL(http.requests[0]!.request.url).searchParams;
    expect(query.get('ownerId')).toBe('user-1');
    expect(query.get('namespaceId')).toBe('notes-1');
    await expect(run(tools, 'list_sessions', {})).rejects.toMatchObject({ code: 'INVALID_SCOPE' });
  });

  it('lists a namespace without an owner or includeAll, which the service refuses to combine with a filter', async () => {
    const http = transport({ body: { items: [{ sessionId: 'session-1', namespaceId: 'notes-1' }] } });
    const tools = toolsWith(http.fetch, { namespaceId: 'notes-1' });
    await run(tools, 'list_sessions', {});
    const query = new URL(http.requests[0]!.request.url).searchParams;
    expect(query.get('namespaceId')).toBe('notes-1');
    expect(query.has('includeAll')).toBe(false);
    await expect(run(tools, 'list_sessions', { includeAll: true })).rejects.toMatchObject({ code: 'INVALID_SCOPE' });
    expect(http.requests).toHaveLength(1);
  });

  it('limits namespace administration to personal namespaces owned by the scoped user', async () => {
    const http = transport({ body: { items: [namespace()] } });
    const tools = toolsWith(http.fetch, { userId: 'user-1' }, { namespaceTools: true });

    const result = await run(tools, 'list_namespaces', {});

    expect(result.items[0]).toMatchObject({ namespaceId: 'root-1', ownerId: 'user-1' });
    const query = new URL(http.requests[0]!.request.url).searchParams;
    expect(query.get('ownerId')).toBe('user-1');
    expect(query.get('scope')).toBe('PERSONAL');
    expect(query.has('userId')).toBe(false);
  });

  it('rejects an OR search that would bypass an enforced owner filter', async () => {
    const http = transport();
    const tools = toolsWith(http.fetch, { userId: 'user-1' });
    await expect(run(tools, 'search_memories', {
      query: 'preferences', filter: { op: 'ANY', topics: { eq: 'preferences' } },
    })).rejects.toThrow();
    expect(http.requests).toHaveLength(0);
  });

  it('rejects a conflicting explicit owner before issuing a request', async () => {
    const http = transport();
    const tools = toolsWith(http.fetch, { userId: 'user-1' });
    await expect(run(tools, 'search_memories', {
      filter: { ownerId: { eq: 'someone-else' } },
    })).rejects.toThrow();
    expect(http.requests).toHaveLength(0);
  });

  it('generates UUIDs, fills write scope, and maps partial bulk failures to input records', async () => {
    const http = transport({
      status: 201,
      body: ({ memories }: { memories: Array<{ memoryId: string }> }) => ({
        created: [memories[0]!.memoryId],
        errors: [{ memoryId: memories[1]!.memoryId, type: '/errors/bad-request', title: 'Unknown custom type', status: 400 }],
      }),
    });
    const tools = toolsWith(http.fetch, { userId: 'user-1', sessionId: 'session-1' });
    const result = await run(tools, 'create_memories', { memories: [
      { text: 'Prefers concise replies.', memoryType: 'communication', attributes: { concise: true } },
      { text: 'Other custom data.', memoryType: 'custom-type' },
    ] });
    const ids = http.requests[0]!.body.memories.map((record: { memoryId: string }) => record.memoryId);
    expect(new Set(ids).size).toBe(2);
    expect(result).toEqual({
      memoryIds: ids,
      created: [ids[0]],
      errors: [{ memoryId: ids[1], type: '/errors/bad-request', title: 'Unknown custom type', status: 400 }],
    });
    expect(http.requests[0]!.body.memories).toEqual([
      { memoryId: expect.stringMatching(uuidV4), text: 'Prefers concise replies.', memoryType: 'communication', attributes: { concise: true }, ownerId: 'user-1', sessionId: 'session-1' },
      { memoryId: expect.stringMatching(uuidV4), text: 'Other custom data.', memoryType: 'custom-type', ownerId: 'user-1', sessionId: 'session-1' },
    ]);
    expect(http.requests).toHaveLength(1);
  });

  it('generates fresh UUIDs on every invocation and never uses caller-supplied IDs', async () => {
    const response = {
      status: 201,
      body: ({ memories }: { memories: Array<{ memoryId: string }> }) => ({ created: memories.map(memory => memory.memoryId) }),
    };
    const http = transport(response, response);
    const tools = toolsWith(http.fetch, { userId: 'user-1' });
    const input = { memories: [{ id: 'model-guessed-id', text: 'Prefers TypeScript.' }] };

    const parsedResult = await run(tools, 'create_memories', input);
    const directResult = await tools.create_memories!.execute!(input, {
      toolCallId: 'direct-call', messages: [], context: {},
    });

    const ids = http.requests.map(({ body }) => body.memories[0].memoryId);
    expect(ids).toEqual([expect.stringMatching(uuidV4), expect.stringMatching(uuidV4)]);
    expect(new Set(ids).size).toBe(2);
    expect([parsedResult, directResult]).toEqual(ids.map(id => ({ memoryIds: [id], created: [id] })));
    expect(input.memories[0]!.id).toBe('model-guessed-id');
  });

  it('checks ownership when a model guesses a direct memory ID', async () => {
    const http = transport({ body: memory({ ownerId: 'someone-else' }) });
    const tools = toolsWith(http.fetch, { userId: 'user-1' });
    await expect(run(tools, 'get_memory', { memoryId: 'memory-1' })).rejects.toThrow();
    expect(http.requests.map(({ request }) => request.method)).toEqual(['GET']);
  });

  it('preflights every memory before deleting a scoped batch', async () => {
    const http = transport(
      { body: memory({ memoryId: 'mine' }) },
      { body: memory({ memoryId: 'theirs', ownerId: 'someone-else' }) },
    );
    const tools = toolsWith(http.fetch, { userId: 'user-1' }, { allowDeletes: true });
    await expect(run(tools, 'delete_memories', { memoryIds: ['mine', 'theirs'] })).rejects.toThrow();
    expect(http.requests).toHaveLength(2);
    expect(http.requests.every(({ request }) => request.method === 'GET')).toBe(true);
  });

  it.each(['create_memories', 'add_session_event', 'update_memory'])(
    'prevents %s from placing data in another owner’s namespace hierarchy', async name => {
      const http = transport(
        ...(name === 'update_memory' ? [{ body: memory() }] : []),
        { body: { namespace: namespace({ namespaceId: 'child-1', parentId: 'root-1', ownerId: undefined }) } },
        { body: { namespace: namespace({ ownerId: 'someone-else' }) } },
      );
      const tools = toolsWith(http.fetch, { userId: 'user-1' });
      const placement = { namespaceId: 'child-1' };
      const input = name === 'create_memories'
        ? { memories: [{ text: 'Private preferences.', ...placement }] }
        : name === 'add_session_event'
          ? { actorId: 'user-1', role: 'USER', content: [{ text: 'Private preferences.' }], ...placement }
          : { memoryId: 'memory-1', changes: placement };
      await expect(run(tools, name, input)).rejects.toThrow();
      expect(http.requests).toHaveLength(name === 'update_memory' ? 3 : 2);
      expect(http.requests.every(({ request }) => request.method === 'GET')).toBe(true);
      expect(http.requests.at(-1)!.request.url).toContain('/namespaces/root-1');
    },
  );

  it('allows placement in the owner’s personal namespace and validates it once per bulk write', async () => {
    const http = transport(
      { body: { namespace: namespace() } },
      {
        status: 201,
        body: ({ memories }: { memories: Array<{ memoryId: string }> }) => ({ created: memories.map(memory => memory.memoryId) }),
      },
    );
    const tools = toolsWith(http.fetch, { userId: 'user-1' });
    const records = ['Prefers TypeScript.', 'Prefers concise replies.'].map(text => ({
      text, namespaceId: 'root-1',
    }));
    const result = await run(tools, 'create_memories', { memories: records });
    expect(http.requests.map(({ request }) => request.method)).toEqual(['GET', 'POST']);
    expect(http.requests[1]!.body.memories).toEqual(records.map(record => ({
      ...record, memoryId: expect.stringMatching(uuidV4), ownerId: 'user-1',
    })));
    const ids = http.requests[1]!.body.memories.map((record: { memoryId: string }) => record.memoryId);
    expect(result).toEqual({ memoryIds: ids, created: ids });
  });

  it('prevents reading a session outside the fixed session scope', async () => {
    const http = transport();
    const tools = toolsWith(http.fetch, { userId: 'user-1', sessionId: 'session-1' });
    await expect(run(tools, 'get_session_memory', { sessionId: 'another-session' })).rejects.toThrow();
    expect(http.requests).toHaveLength(0);
  });

  it('starts a session with a USER event and returns the server-generated ID', async () => {
    const http = transport({ status: 201, body: { event: event({ sessionId: 'generated-session' }) } });
    const tools = toolsWith(http.fetch, { userId: 'user-1' });
    const result = await run(tools, 'start_session', { actorId: 'user-1', text: 'Hello.' });
    expect(result.event.sessionId).toBe('generated-session');
    expect(http.requests[0]!.body).toMatchObject({
      actorId: 'user-1', role: 'USER', content: [{ text: 'Hello.' }],
    });
    expect(http.requests[0]!.body.sessionId).toBeUndefined();
    expect(Number.isNaN(Date.parse(http.requests[0]!.body.createdAt))).toBe(false);
  });

  it('requires a newly generated scoped session to start with its owner as a USER', async () => {
    const http = transport();
    const tools = toolsWith(http.fetch, { userId: 'user-1' });
    await expect(run(tools, 'start_session', { actorId: 'another-user', text: 'Hello.' })).rejects.toThrow();
    await expect(run(tools, 'add_session_event', {
      actorId: 'user-1', role: 'ASSISTANT', content: [{ text: 'Hello.' }],
    })).rejects.toThrow();
    expect(http.requests).toHaveLength(0);
  });

  it('returns the first event for a keyed start_session retry after the first attempt created the session', async () => {
    const reply = event({ eventId: 'event-2', actorId: 'assistant-1', role: 'ASSISTANT', createdAt: '2026-09-25T12:35:00.000Z', systemTimestamp: '2026-09-25T12:35:00.000Z' });
    const history = { sessionId: 'session-1', ownerId: 'user-1', events: [reply, event()] };
    const http = transport({ body: history }, { body: history });
    const tools = toolsWith(http.fetch, { userId: 'user-1' });
    const result = await run(tools, 'start_session', {
      sessionId: 'session-1', actorId: 'user-1', text: 'Hello.', createdAt: timestamp, idempotencyKey: 'start-1',
    });
    expect(result.event).toMatchObject({ eventId: 'event-1', sessionId: 'session-1', actorId: 'user-1', role: 'USER' });
    expect(http.requests.map(({ request }) => request.method)).toEqual(['GET', 'GET']);
  });

  it('refuses a keyed start_session whose request differs from the existing first event', async () => {
    const history = { sessionId: 'session-1', ownerId: 'user-1', events: [event()] };
    const http = transport({ body: history }, { body: history });
    const tools = toolsWith(http.fetch, { userId: 'user-1' });
    await expect(run(tools, 'start_session', {
      sessionId: 'session-1', actorId: 'user-1', text: 'Something else.', idempotencyKey: 'start-1',
    })).rejects.toThrow(/first event differs/);
    expect(http.requests.map(({ request }) => request.method)).toEqual(['GET', 'GET']);
  });

  it('refuses a keyed start_session on another owner\'s session before any write', async () => {
    const http = transport({ body: { sessionId: 'session-1', ownerId: 'another-user', events: [] } });
    const tools = toolsWith(http.fetch, { userId: 'user-1' });
    await expect(run(tools, 'start_session', {
      sessionId: 'session-1', actorId: 'user-1', text: 'Hello.', idempotencyKey: 'start-1',
    })).rejects.toThrow(/outside the configured user scope/);
    expect(http.requests.map(({ request }) => request.method)).toEqual(['GET']);
  });

  it('finds the creation event by server time when a later append is backdated', async () => {
    const backdated = event({
      eventId: 'event-2', actorId: 'assistant-1', role: 'ASSISTANT',
      createdAt: '2020-01-01T00:00:00.000Z', systemTimestamp: '2026-09-25T13:00:00.000Z',
    });
    const history = { sessionId: 'session-1', ownerId: 'user-1', events: [backdated, event()] };
    const http = transport({ body: history }, { body: history });
    const tools = toolsWith(http.fetch, { userId: 'user-1' });
    const result = await run(tools, 'start_session', {
      sessionId: 'session-1', actorId: 'user-1', text: 'Hello.', createdAt: timestamp, idempotencyKey: 'start-1',
    });
    expect(result.event.eventId).toBe('event-1');
  });

  it('refuses an unkeyed start_session on an existing session', async () => {
    const http = transport({ body: { sessionId: 'session-1', ownerId: 'user-1', events: [] } });
    const tools = toolsWith(http.fetch, { userId: 'user-1' });
    await expect(run(tools, 'start_session', { sessionId: 'session-1', actorId: 'user-1', text: 'Hello.' }))
      .rejects.toThrow(/already exists/);
    expect(http.requests.map(({ request }) => request.method)).toEqual(['GET']);
  });

  it('uses the assistant as event actor while retaining the human session owner', async () => {
    const assistantEvent = event({ actorId: 'assistant-1', role: 'ASSISTANT' });
    const http = transport(
      { body: { sessionId: 'session-1', ownerId: 'user-1', events: [] } },
      { status: 201, body: { event: assistantEvent } },
    );
    const tools = toolsWith(http.fetch, { userId: 'user-1', sessionId: 'session-1' });
    const result = await run(tools, 'add_session_event', {
      actorId: 'assistant-1', role: 'ASSISTANT', content: [{ text: 'Hello.' }],
      createdAt: '2026-09-25T14:34:56+02:00', metadata: { source: 'test' },
    });
    expect(result.event.actorId).toBe('assistant-1');
    expect(http.requests.map(({ request }) => request.method)).toEqual(['GET', 'POST']);
    expect(new URL(http.requests[1]!.request.url).pathname).toMatch(/\/sessions\/session-1\/events$/);
    expect(http.requests[1]!.body).toMatchObject({
      actorId: 'assistant-1', role: 'ASSISTANT',
      createdAt: timestamp, metadata: { source: 'test' },
    });
  });

  it('does not expose upstream response bodies or credentials in thrown errors', async () => {
    const privateBody = `private-memory-content ${apiKey}`;
    const http = transport({ status: 500, body: { message: privateBody } });
    let failure: unknown;
    try { await run(toolsWith(http.fetch), 'search_memories', { text: 'preferences' }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    const serialized = `${String(failure)} ${JSON.stringify(failure)}`;
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain('private-memory-content');
    expect(http.requests).toHaveLength(1);
  });

  it('propagates cancellation to the underlying HTTP request', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let resolveStarted!: () => void;
    const started = new Promise<void>(resolve => { resolveStarted = resolve; });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      receivedSignal = request.signal;
      resolveStarted();
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (request.signal.aborted) abort();
        else request.signal.addEventListener('abort', abort, { once: true });
      });
    };
    const result = run(toolsWith(fetch), 'search_memories', { text: 'preferences' }, controller.signal);
    const rejected = expect(result).rejects.toThrow();
    await started;
    controller.abort();
    await rejected;
    expect(receivedSignal?.aborted).toBe(true);
  });

  it('runs an AI SDK 7 tool loop and separates intermediate text from the final memory-informed reply', async () => {
    const http = transport({ body: { items: [memory()] } });
    const tools = toolsWith(http.fetch, { userId: 'user-1' }, { namespaceTools: true });
    const usage = {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 },
    };
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async options => {
        calls += 1;
        if (calls === 1) {
          expect(options.tools?.some(tool => tool.name === 'search_memories')).toBe(true);
          expect(options.tools?.some(tool => tool.name === 'create_namespace')).toBe(true);
          expect(options.tools?.find(tool => tool.name === 'create_memories')).toMatchObject({
            type: 'function',
            inputSchema: { properties: { memories: { items: {
              properties: expect.not.objectContaining({ id: expect.anything() }),
              required: ['text'],
            } } } },
          });
          expect(options.tools).toHaveLength(Object.keys(tools).length);
          for (const definition of options.tools ?? []) {
            expect(definition.type).toBe('function');
            if (definition.type === 'function') expect(definition.inputSchema.type).toBe('object');
          }
          return {
            content: [
              { type: 'text', text: 'Let me check your saved preferences.' },
              { type: 'tool-call', toolCallId: 'recall-1', toolName: 'search_memories', input: '{"query":"communication preferences"}' },
            ],
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [],
          };
        }
        expect(JSON.stringify(options.prompt)).toContain('Prefers concise replies.');
        return {
          content: [{ type: 'text', text: 'I will keep my replies concise.' }],
          finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [],
        };
      },
    });
    const agent = new ToolLoopAgent({ model, tools, instructions, stopWhen: isStepCount(3) });
    const result = await agent.generate({ prompt: 'How do I prefer you to respond?' });
    expect(result.steps[0]?.text).toBe('Let me check your saved preferences.');
    expect(result.finalStep.text).toBe('I will keep my replies concise.');
    expect(result.steps).toHaveLength(2);
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]!.body.filter).toMatchObject({ ownerId: { eq: 'user-1' } });
    expect(calls).toBe(2);
  });
});
