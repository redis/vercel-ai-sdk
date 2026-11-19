import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolSet } from 'ai';
import { createRedisAgentMemory, type RedisAgentMemoryScope } from '../src/index.js';

const serverURL = 'https://iris.example.test';
const base = `${serverURL}/iris/data/v1/agent-memory/stores/store-1`;
const timestamp = '2026-09-25T12:34:56.000Z';
const notFound = { status: 404, body: { title: 'Missing', type: '/errors/resource-not-found' } };
const created = { status: 201, body: (request: { memories: Array<{ memoryId: string }> }) => ({
  created: request.memories.map(record => record.memoryId),
}) };

afterEach(() => vi.unstubAllGlobals());

function memory(overrides: Record<string, unknown> = {}) {
  return {
    memoryId: 'memory-1', text: 'Prefers concise replies.', ownerId: 'user-1',
    createdAt: timestamp, updatedAt: timestamp, ...overrides,
  };
}

function transport(...responses: Array<{ body?: any; status?: number }>) {
  const requests: Array<{ method: string; url: URL; body: any }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const text = await request.clone().text();
    requests.push({ method: request.method, url: new URL(request.url), body: text ? JSON.parse(text) : undefined });
    const response = responses.shift();
    if (!response) throw new Error(`Unexpected HTTP request: ${request.method} ${request.url}`);
    const body = typeof response.body === 'function' ? response.body(requests.at(-1)!.body) : response.body;
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status: response.status ?? 200, headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetch);
  return requests;
}

function tools(scope: RedisAgentMemoryScope = {}): ToolSet {
  return createRedisAgentMemory({ serverUrl: serverURL, storeId: 'store-1', apiKey: 'key', scope }).tools();
}

async function run(toolset: ToolSet, name: string, input: unknown): Promise<any> {
  const definition = toolset[name];
  if (!definition?.execute) throw new Error(`No executable tool named ${name}`);
  const schema = definition.inputSchema as { parseAsync(input: unknown): Promise<unknown> };
  return definition.execute(await schema.parseAsync(input), { toolCallId: 'test-call', messages: [], context: {} });
}

describe('sorting', () => {
  it('sends sort options for a filter-only memory listing', async () => {
    const requests = transport({ body: { items: [] } });
    await run(tools(), 'search_memories', {
      sortBy: 'updatedAt', sortOrder: 'DESC', excludeDocumentManaged: true, filter: { topics: { eq: 'food' } },
    });
    expect(requests[0]!.body).toMatchObject({ sortBy: 'updatedAt', sortOrder: 'DESC', excludeDocumentManaged: true });
  });

  it('rejects sorting a semantic query before any request', async () => {
    const requests = transport();
    await expect(run(tools(), 'search_memories', { query: 'food', sortBy: 'createdAt' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(requests).toHaveLength(0);
  });

  it('lists sessions in a namespace with sort options and no owner', async () => {
    const requests = transport({ body: { items: [] } });
    await run(tools(), 'list_sessions', { namespaceId: 'notes-1', sortBy: 'updatedAt', sortOrder: 'DESC' });
    const query = requests[0]!.url.searchParams;
    expect(query.get('namespaceId')).toBe('notes-1');
    expect(query.get('sortBy')).toBe('updatedAt');
    expect(query.get('sortOrder')).toBe('DESC');
    expect(query.has('includeAll')).toBe(false);
  });

  it('refuses a session namespace filter outside the fixed namespace', async () => {
    const requests = transport();
    await expect(run(tools({ namespaceId: 'notes-1' }), 'list_sessions', { namespaceId: 'other' }))
      .rejects.toMatchObject({ code: 'INVALID_SCOPE' });
    expect(requests).toHaveLength(0);
  });
});

describe('actor IDs', () => {
  const append = { sessionId: 'session-1', role: 'ASSISTANT', content: [{ text: 'Hi.' }] };

  it.each(['has space', 'agent:v1', 'a/b', '..', '.', 'x'.repeat(65)])('rejects the actor ID %j before any request', async actorId => {
    const requests = transport();
    await expect(run(tools(), 'add_session_event', { ...append, actorId })).rejects.toThrow();
    await expect(run(tools(), 'start_session', { actorId, text: 'Hello.' })).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it('accepts the service\'s full actor ID alphabet', async () => {
    const event = {
      eventId: 'event-1', sessionId: 'session-1', actorId: 'agent_1.v2+x=y@z-1', role: 'ASSISTANT',
      content: [{ text: 'Hi.' }], createdAt: timestamp, systemTimestamp: timestamp,
    };
    const requests = transport({ status: 201, body: { event } });
    await run(tools(), 'add_session_event', { ...append, actorId: 'agent_1.v2+x=y@z-1' });
    expect(requests[0]!.body.actorId).toBe('agent_1.v2+x=y@z-1');
  });
});

describe('failure guidance', () => {
  it('tells the agent how to recover from a stale revision', async () => {
    transport({ status: 412, body: { title: 'Precondition Failed' } });
    await expect(run(tools(), 'update_memory', {
      memoryId: 'memory-1', changes: { text: 'Prefers tea.' }, expectedRevision: 'rev-1',
    })).rejects.toMatchObject({
      code: 'IRIS_HTTP_412', statusCode: 412, message: expect.stringMatching(/get_memory.*revision/is),
    });
  });

  it('gives conflict guidance that is not specific to creating', async () => {
    transport({ status: 409, body: {} });
    await expect(run(tools(), 'update_memory', {
      memoryId: 'memory-1', changes: { text: 'x' },
    })).rejects.toMatchObject({
      code: 'IRIS_HTTP_409',
      message: expect.stringMatching(/current state.*Read the current state before retrying/s),
    });
  });

  it('does not suggest a rejected write may have partially succeeded', async () => {
    transport({ status: 412, body: {} });
    await expect(run(tools(), 'update_memory', {
      memoryId: 'memory-1', changes: { text: 'x' }, expectedRevision: 'rev-1',
    })).rejects.toMatchObject({ message: expect.not.stringMatching(/partially succeeded/i) });
  });
});

describe('idempotency', () => {
  it('replays a keyed memory batch with the same IDs and key', async () => {
    const requests = transport(created, created);
    const input = { idempotencyKey: 'retry-1', memories: [{ text: 'Likes tea.' }] };
    const first = await run(tools({ userId: 'user-1' }), 'create_memories', input);
    const second = await run(tools({ userId: 'user-1' }), 'create_memories', input);
    expect(second.memoryIds).toEqual(first.memoryIds);
    expect(requests[0]!.body).toEqual(requests[1]!.body);
    expect(requests[0]!.body).toMatchObject({ idempotencyKey: expect.stringMatching(/^[0-9a-f]{64}$/), memories: [{ memoryId: first.memoryIds[0] }] });
  });

  it('keeps keyed memoryIds aligned with the input and nulls a record the service rejects', async () => {
    const preClaimed = { status: 201, body: (request: { memories: Array<{ memoryId: string }> }) => ({
      created: [request.memories[0]!.memoryId, request.memories[2]!.memoryId],
      errors: [{ memoryId: request.memories[1]!.memoryId, type: '/errors/conflict', title: 'Conflict', status: 409 }],
    }) };
    const requests = transport(preClaimed);
    const result = await run(tools({ userId: 'user-1' }), 'create_memories', {
      idempotencyKey: 'retry-5', memories: [{ text: 'A.' }, { text: 'B.' }, { text: 'C.' }],
    });
    const sent = requests[0]!.body.memories.map((record: { memoryId: string }) => record.memoryId);
    expect(result.memoryIds).toEqual([sent[0], null, sent[2]]);
    expect(result.errors).toEqual([expect.objectContaining({ memoryId: sent[1], status: 409 })]);
  });

  it('derives different IDs for different keys, owners, and positions', async () => {
    const requests = transport(created, created, created);
    const ids = async (userId: string, idempotencyKey: string) => {
      await run(tools({ userId }), 'create_memories', { idempotencyKey, memories: [{ text: 'A.' }, { text: 'B.' }] });
      return requests.at(-1)!.body.memories.map((record: { memoryId: string }) => record.memoryId) as string[];
    };
    const base = await ids('user-1', 'retry-1');
    const otherKey = await ids('user-1', 'retry-2');
    const otherOwner = await ids('user-2', 'retry-1');
    expect(base[0]).not.toBe(base[1]);
    expect(new Set([...base, ...otherKey, ...otherOwner]).size).toBe(6);
  });

  it('derives different IDs for the same key and owner under different fixed scopes', async () => {
    const requests = transport(created, created, created, created);
    const ids = async (scope: Record<string, string>) => {
      await run(tools(scope), 'create_memories', { idempotencyKey: 'retry-1', memories: [{ text: 'A.', ownerId: 'user-1' }] });
      return requests.at(-1)!.body.memories[0].memoryId as string;
    };
    const all = [
      await ids({}), await ids({ namespaceId: 'notes-1' }), await ids({ namespaceId: 'notes-2' }), await ids({ sessionId: 'session-1' }),
    ];
    expect(new Set(all).size).toBe(4);
  });

  it('generates fresh IDs for unkeyed batches', async () => {
    transport(created, created);
    const input = { memories: [{ text: 'Likes tea.', ownerId: 'user-1' }] };
    const first = await run(tools(), 'create_memories', input);
    const second = await run(tools(), 'create_memories', input);
    expect(second.memoryIds).not.toEqual(first.memoryIds);
  });

  it('passes the key and revision guard through a memory update', async () => {
    const requests = transport({ body: memory({ text: 'Prefers tea.' }) });
    await run(tools(), 'update_memory', {
      memoryId: 'memory-1', changes: { text: 'Prefers tea.' }, expectedRevision: 'rev-3', idempotencyKey: 'retry-2',
    });
    expect(requests[0]!.method).toBe('PATCH');
    expect(requests[0]!.body).toMatchObject({ text: 'Prefers tea.', expectedRevision: 'rev-3', idempotencyKey: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('passes the key through a session append', async () => {
    const event = {
      eventId: 'event-1', sessionId: 'session-1', actorId: 'agent-1', role: 'ASSISTANT',
      content: [{ text: 'Hi.' }], createdAt: timestamp, systemTimestamp: timestamp,
    };
    const requests = transport({ status: 201, body: { event } });
    await run(tools(), 'add_session_event', {
      sessionId: 'session-1', actorId: 'agent-1', role: 'ASSISTANT', content: [{ text: 'Hi.' }],
      createdAt: timestamp, idempotencyKey: 'retry-3',
    });
    expect(requests[0]!.body).toMatchObject({ idempotencyKey: expect.stringMatching(/^[0-9a-f]{64}$/), createdAt: timestamp });
  });
});

describe('idempotency key scoping', () => {
  const sentKey = async (
    userId: string, name: string, input: Record<string, unknown>,
    responses: Array<{ body?: any; status?: number }> = [created],
  ) => {
    const requests = transport(...responses);
    await run(tools({ userId }), name, input);
    return requests.at(-1)!.body.idempotencyKey as string;
  };
  const batch = { idempotencyKey: 'create-1', memories: [{ text: 'Likes tea.' }] };

  it('sends different store keys for two users who pick the same key', async () => {
    const first = await sentKey('user-1', 'create_memories', batch);
    const second = await sentKey('user-2', 'create_memories', batch);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
  });

  it('sends the same store key when one user repeats an identical request', async () => {
    const first = await sentKey('user-1', 'create_memories', batch);
    const second = await sentKey('user-1', 'create_memories', batch);
    expect(second).toBe(first);
  });

  it('sends different store keys for one key reused on two memories', async () => {
    const update = (memoryId: string) => sentKey('user-1', 'update_memory', {
      memoryId, changes: { text: 'Prefers tea.' }, idempotencyKey: 'edit-1',
    }, [{ body: memory() }, { body: memory() }]);
    expect(await update('memory-1')).not.toBe(await update('memory-2'));
  });

  it('sends different store keys for two users appending to the same session ID', async () => {
    const event = {
      eventId: 'event-1', sessionId: 'session-1', actorId: 'agent-1', role: 'ASSISTANT',
      content: [{ text: 'Hi.' }], createdAt: timestamp, systemTimestamp: timestamp,
    };
    const append = (userId: string) => sentKey(userId, 'add_session_event', {
      sessionId: 'session-1', actorId: 'agent-1', role: 'ASSISTANT', content: [{ text: 'Hi.' }],
      createdAt: timestamp, idempotencyKey: 'append-1',
    }, [{ body: { sessionId: 'session-1', ownerId: userId, events: [] } }, { status: 201, body: { event } }]);
    expect(await append('user-1')).not.toBe(await append('user-2'));
  });
});

describe('upsert_memory', () => {
  it('creates a missing memory with the scoped owner and session', async () => {
    const requests = transport(notFound, { body: { memoryId: 'memory-9', created: true } });
    const result = await run(tools({ userId: 'user-1', sessionId: 'session-1' }), 'upsert_memory', {
      memoryId: 'memory-9', text: 'Lives in Lisbon.', attributes: { city: 'Lisbon' }, idempotencyKey: 'retry-4',
    });
    expect(result).toEqual({ memoryId: 'memory-9', created: true });
    expect(requests[1]!.method).toBe('PUT');
    expect(requests[1]!.url.pathname).toBe(new URL(`${base}/memories/memory-9`).pathname);
    expect(requests[1]!.body).toEqual({
      text: 'Lives in Lisbon.', attributes: { city: 'Lisbon' }, ownerId: 'user-1',
      sessionId: 'session-1', idempotencyKey: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('refuses to replace another owner’s memory', async () => {
    const requests = transport({ body: memory({ ownerId: 'someone-else' }) });
    await expect(run(tools({ userId: 'user-1' }), 'upsert_memory', { memoryId: 'memory-1', text: 'Mine now.' }))
      .rejects.toMatchObject({ code: 'INVALID_SCOPE' });
    expect(requests).toHaveLength(1);
  });

  it('refuses an owner outside the user scope before any request', async () => {
    const requests = transport(notFound);
    await expect(run(tools({ userId: 'user-1' }), 'upsert_memory', {
      memoryId: 'memory-1', text: 'Hijack.', ownerId: 'someone-else',
    })).rejects.toMatchObject({ code: 'INVALID_SCOPE' });
    expect(requests.filter(request => request.method === 'PUT')).toHaveLength(0);
  });
});

describe('update_memory_fields', () => {
  it('asserts scope and pins the fixed namespace', async () => {
    const requests = transport({ body: memory({ namespaceId: 'notes-1', memoryType: 'profile' }) }, {});
    const result = await run(tools({ namespaceId: 'notes-1' }), 'update_memory_fields', {
      memoryId: 'memory-1', memoryType: 'profile', attributes: { city: 'Porto' }, expectedRevision: 'rev-1',
    });
    expect(result).toEqual({ updated: true, memoryId: 'memory-1' });
    expect(requests[1]!.method).toBe('PATCH');
    expect(requests[1]!.url.pathname.endsWith('/memories/memory-1/fields')).toBe(true);
    expect(requests[1]!.body).toEqual({
      memoryType: 'profile', attributes: { city: 'Porto' }, expectedRevision: 'rev-1', namespaceId: 'notes-1',
    });
  });

  it('requires text or attributes', async () => {
    const requests = transport();
    await expect(run(tools(), 'update_memory_fields', { memoryId: 'memory-1', memoryType: 'profile' }))
      .rejects.toMatchObject({ code: 'INVALID_SCOPE' });
    expect(requests).toHaveLength(0);
  });
});

describe('provenance', () => {
  it('pages source links after asserting the memory is in scope', async () => {
    const link = { sourceId: 'src-1', kind: 'SESSION', session: { sessionId: 'session-1', ownerId: 'user-1' } };
    const requests = transport({ body: memory() }, { body: { items: [link], nextCursor: 'next' } });
    const result = await run(tools({ userId: 'user-1' }), 'list_memory_sources', { memoryId: 'memory-1', limit: 5 });
    expect(result).toEqual({ items: [link], nextCursor: 'next' });
    expect(requests[1]!.url.pathname.endsWith('/memories/memory-1/sources')).toBe(true);
    expect(requests[1]!.url.searchParams.get('limit')).toBe('5');
  });

  it('refuses evidence for another owner’s memory', async () => {
    const requests = transport({ body: memory({ ownerId: 'someone-else' }) });
    await expect(run(tools({ userId: 'user-1' }), 'list_memory_source_evidence', { memoryId: 'memory-1', sourceId: 'src-1' }))
      .rejects.toMatchObject({ code: 'INVALID_SCOPE' });
    expect(requests).toHaveLength(1);
  });

  it('lists source memories for the scoped owner and drops records outside the namespace', async () => {
    const requests = transport({ body: { items: [
      memory({ namespaceId: 'notes-1' }), memory({ memoryId: 'memory-2', namespaceId: 'other' }),
    ] } });
    const result = await run(tools({ userId: 'user-1', namespaceId: 'notes-1' }), 'list_source_memories', { sourceId: 'src-1' });
    expect(requests[0]!.url.pathname.endsWith('/sources/src-1/memories')).toBe(true);
    expect(requests[0]!.url.searchParams.get('ownerId')).toBe('user-1');
    expect(result.items.map((item: { memoryId: string }) => item.memoryId)).toEqual(['memory-1']);
  });

  it('requires an owner without a user scope', async () => {
    const requests = transport();
    await expect(run(tools(), 'list_source_memories', { sourceId: 'src-1' })).rejects.toMatchObject({ code: 'INVALID_SCOPE' });
    expect(requests).toHaveLength(0);
  });
});

describe('owner ID format', () => {
  it.each(['user_42', 'alice@example.com', 'a+b=c.d-e'])('accepts %s as the fixed user', async (ownerId) => {
    const requests = transport({ body: { items: [] } });
    await run(tools({ userId: ownerId }), 'list_source_memories', { sourceId: 'src-1' });
    expect(requests[0]!.url.searchParams.get('ownerId')).toBe(ownerId);
  });

  it.each(['user_42', 'alice@example.com'])('accepts %s as a tool input', async (ownerId) => {
    const requests = transport({ body: { items: [] } });
    await run(tools(), 'list_source_memories', { sourceId: 'src-1', ownerId });
    expect(requests[0]!.url.searchParams.get('ownerId')).toBe(ownerId);
  });

  it.each(['.', '..', 'alice smith', 'a/b', 'x'.repeat(65)])('rejects %s before any request', async (ownerId) => {
    const requests = transport();
    expect(() => tools({ userId: ownerId })).toThrow();
    await expect(run(tools(), 'list_source_memories', { sourceId: 'src-1', ownerId })).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it('accepts an underscore in a session ID', async () => {
    const requests = transport({ body: { sessionId: 'session_1', ownerId: 'user_42', events: [] } });
    await run(tools({ userId: 'user_42', sessionId: 'session_1' }), 'get_session_memory', {});
    expect(requests[0]!.url.pathname.endsWith('/sessions/session_1')).toBe(true);
  });
});
