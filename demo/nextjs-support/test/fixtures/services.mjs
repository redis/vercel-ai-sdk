// Preloaded into the Next.js server under test (NODE_OPTIONS=--import). It
// replaces fetch, plays Redis Agent Memory and Anthropic, and appends every
// request to DEMO_TEST_TRACE as one JSON line. Nothing reaches the network:
// any other request is recorded as `unexpected` and fails.
import { appendFileSync } from 'node:fs';

const run = process.env.DEMO_RUN;
const owner = id => `${id}-${run}`;
const at = '2026-10-07T12:00:00.000Z';
const earlier = '2026-07-01T12:00:00.000Z';
const memory = (ownerId, memoryId, text, extra = {}) => ({
  memoryId, ownerId, text, memoryType: 'semantic', topics: [], createdAt: at, updatedAt: at, ...extra,
});
const environment = (ownerId, memoryId, text, attributes, updatedAt = at) =>
  memory(ownerId, memoryId, text, { memoryType: 'customer_environment', attributes, createdAt: updatedAt, updatedAt });

// Long-term memories as extraction would have left them after `npm run seed`.
// The older records come first, so a query that ignores sortBy gets the stale value.
const memories = [
  environment(owner('lindgren-logistics'), 'lin-env-0', 'The origin servers run in Virginia.', { origin_location: 'Virginia' }, earlier),
  environment(owner('okafor-freight'), 'oka-env-0', 'Keep-alive was turned off during the reset incident.', { keep_alive_enabled: 'false' }, earlier),
  environment(owner('lindgren-logistics'), 'lin-env-1', 'The gateway runs in us-east.', { gateway_region: 'us-east' }),
  environment(owner('lindgren-logistics'), 'lin-env-2', 'The origin servers moved to Frankfurt in October.', { origin_location: 'Frankfurt' }),
  memory(owner('lindgren-logistics'), 'lin-1', 'The operations team works from curl.'),
  memory(owner('lindgren-logistics'), 'lin-2', 'Assistant recommended adding a eu-central region.'),
  environment(owner('harbor-health'), 'har-env-1', 'Calls come from AWS Lambda in us-east with Node 18.', { client_runtime: 'AWS Lambda with Node 18', origin_location: 'us-east' }),
  environment(owner('harbor-health'), 'har-env-2', 'The client has HTTP keep-alive turned off.', { keep_alive_enabled: 'false', sdk_version: '3.0' }),
  memory(owner('harbor-health'), 'har-1', 'Never ask for request payloads.'),
  environment(owner('brightline-media'), 'bri-env-1', 'Go on Kubernetes, keep-alive off.', { client_runtime: 'Go on Kubernetes', keep_alive_enabled: 'false' }),
  environment(owner('tidepool-games'), 'tid-env-1', 'AWS Lambda, keep-alive off.', { client_runtime: 'AWS Lambda', keep_alive_enabled: 'false' }),
  environment(owner('okafor-freight'), 'oka-env-1', 'Java services, keep-alive on.', { client_runtime: 'Java', keep_alive_enabled: 'true' }),
  environment(owner('meridian-bank'), 'mer-env-1', '.NET services in eu-central.', { client_runtime: '.NET' }),
  // Another app sharing the store. No query from this run may return it.
  environment('another-app-user', 'other-env-1', 'Keep-alive off.', { keep_alive_enabled: 'false' }),
];

const sessions = new Map();
let modelCalls = 0;
const record = entry => appendFileSync(process.env.DEMO_TEST_TRACE, `${JSON.stringify({ ...entry, t: Date.now() })}\n`);

function matches(item, filter = {}) {
  const { op = 'ALL', ownerId, memoryType, attributes, ...rest } = filter;
  if (op !== 'ALL') throw new Error(`Unsupported filter op: ${op}`);
  if (Object.keys(rest).length) throw new Error(`Unsupported filter: ${Object.keys(rest).join(', ')}`);
  if (ownerId?.eq !== undefined && item.ownerId !== ownerId.eq) return false;
  if (ownerId?.in !== undefined && !ownerId.in.includes(item.ownerId)) return false;
  if (memoryType?.eq !== undefined && item.memoryType !== memoryType.eq) return false;
  for (const [key, condition] of Object.entries(attributes ?? {})) {
    if (item.attributes?.[key] !== condition.string) return false;
  }
  return true;
}

// Anthropic's streaming Messages API. The answer names the model call, so tests
// can check what the next turn restored.
function streamedAnswer(text) {
  const events = [
    ['message_start', { type: 'message_start', message: { id: `msg_${modelCalls}`, type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  // The test process talks to this server over loopback; let that through.
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return realFetch(input, init);
  const text = request.body ? await request.text() : '';
  const body = text ? JSON.parse(text) : undefined;
  const entry = { url: request.url, method: request.method, body };

  if (url.origin === 'https://api.anthropic.com' && url.pathname === '/v1/messages') {
    modelCalls += 1;
    const call = modelCalls;
    record({ kind: 'model', call, ...entry });
    // A prompt containing SLOW holds the reply, to test overlapping requests.
    if (text.includes('SLOW')) await new Promise(resolve => setTimeout(resolve, 600));
    const response = streamedAnswer(`Answer ${call}.`);
    record({ kind: 'model-done', call });
    return response;
  }

  const root = '/iris/data/v1/agent-memory/stores/test-store';
  if (url.origin === 'https://memory.example.test' && url.pathname.startsWith(root)) {
    const path = url.pathname.slice(root.length);
    const session = path.match(/^\/sessions\/([^/]+)$/);
    if (request.method === 'GET' && session) {
      record({ kind: 'session-restore', sessionId: session[1], ...entry });
      const stored = sessions.get(session[1]);
      return stored
        ? Response.json({ sessionId: session[1], ownerId: stored.ownerId, events: stored.events })
        : Response.json({ title: 'Missing' }, { status: 404 });
    }
    const append = path.match(/^\/sessions\/([^/]+)\/events$/);
    if (request.method === 'POST' && append) {
      const sessionId = append[1];
      record({ kind: 'session-append', sessionId, ...entry });
      const stored = sessions.get(sessionId) ?? { ownerId: body.role === 'USER' ? body.actorId : undefined, events: [] };
      const event = { ...body, sessionId, eventId: `event-${stored.events.length + 1}`, systemTimestamp: at };
      stored.events.push(event);
      sessions.set(sessionId, stored);
      return Response.json({ event }, { status: 201 });
    }
    if (request.method === 'POST' && path === '/memories/search') {
      record({ kind: 'memory-search', ...entry });
      const limit = body.limit ?? 10;
      const found = memories.filter(item => matches(item, body.filter));
      if (body.sortBy === 'updatedAt') {
        const direction = body.sortOrder === 'ASC' ? 1 : -1;
        found.sort((a, b) => direction * a.updatedAt.localeCompare(b.updatedAt));
      }
      return Response.json({ items: found.slice(0, limit) });
    }
  }

  record({ kind: 'unexpected', ...entry });
  throw new Error(`Unexpected request: ${request.method} ${request.url}`);
};
