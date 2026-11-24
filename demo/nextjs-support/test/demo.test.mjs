// End-to-end tests against the production build (`next start`) with Redis Agent
// Memory and Anthropic replaced by test/fixtures/services.mjs. No credentials,
// no network. `npm test` builds first.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const demoRoot = fileURLToPath(new URL('..', import.meta.url));
const preload = fileURLToPath(new URL('./fixtures/services.mjs', import.meta.url));
const nextBin = join(demoRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
const directory = mkdtempSync(join(tmpdir(), 'redis-memory-nextjs-demo-test-'));
const trace = join(directory, 'requests.jsonl');
const servers = [];

const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

async function startServer(run) {
  const port = await freePort();
  const env = {
    PATH: process.env.PATH,
    NODE_OPTIONS: `--import ${preload}`,
    NEXT_TELEMETRY_DISABLED: '1',
    ANTHROPIC_API_KEY: 'fake-anthropic-key',
    ANTHROPIC_MODEL: 'claude-test',
    AGENT_MEMORY_URL: 'https://memory.example.test',
    AGENT_MEMORY_STORE_ID: 'test-store',
    AGENT_MEMORY_API_KEY: 'fake-memory-key',
    DEMO_AUTH_SECRET: 'test-secret-test-secret-test-secret',
    DEMO_RUN: run,
    DEMO_TEST_TRACE: trace,
  };
  const child = spawn(process.execPath, [nextBin, 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: demoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  servers.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`next start exited:\n${output}`);
    try {
      if ((await fetch(base)).ok) return { base, output: () => output };
    } catch { /* not listening yet */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`next start did not come up:\n${output}`);
}

let app;
before(async () => { app = await startServer('t1'); });
after(() => {
  for (const child of servers) child.kill();
  rmSync(directory, { recursive: true, force: true });
});

// ── helpers ────────────────────────────────────────────────────────────────

const requests = kind => readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  .filter(entry => kind === undefined || entry.kind === kind);
const resetTrace = () => writeFileSync(trace, '');
async function waitFor(check, what) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for ${what}`);
}
const noUnexpected = () => assert.deepEqual(requests('unexpected'), []);

async function signIn(customerId, server = app) {
  const response = await fetch(`${server.base}/api/auth`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ customerId }),
  });
  assert.equal(response.status, 200);
  return response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
}

async function chat(cookie, text, { memory = true, headers = {}, extra = {}, server = app } = {}) {
  const response = await fetch(`${server.base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, ...headers },
    body: JSON.stringify({ message: { id: 'm1', role: 'user', parts: [{ type: 'text', text }] }, memory, ...extra }),
  });
  const body = await response.text();
  const finish = body.split('\n').filter(line => line.startsWith('data: {'))
    .map(line => JSON.parse(line.slice(6))).find(chunk => chunk.type === 'finish');
  return { status: response.status, body, metadata: finish?.messageMetadata };
}

const owner = id => `${id}-t1`;
const modelBody = entry => JSON.stringify(entry.body);

// ── tests ──────────────────────────────────────────────────────────────────

test('each customer gets only their own memories, and every search is filtered by the server-side owner', async () => {
  resetTrace();
  const lindgren = await signIn('lindgren-logistics');
  const harbor = await signIn('harbor-health');
  const question = 'Why is our API latency so high this week?';

  const first = await chat(lindgren, question);
  assert.equal(first.status, 200);
  assert.match(first.body, /Answer \d+\./);
  const second = await chat(harbor, question);
  assert.equal(second.status, 200);

  const [lindgrenCall, harborCall] = requests('model');
  // Markers that appear only in the seeded memories, never in the product knowledge.
  assert.match(modelBody(lindgrenCall), /moved to Frankfurt in October/);
  assert.doesNotMatch(modelBody(lindgrenCall), /keep-alive turned off|Node 18/);
  assert.match(modelBody(harborCall), /keep-alive turned off/);
  assert.doesNotMatch(modelBody(harborCall), /in October|works from curl/);

  const owners = requests('memory-search').map(entry => entry.body.filter.ownerId.eq);
  assert.deepEqual(owners, [owner('lindgren-logistics'), owner('harbor-health')]);
  assert.ok(first.metadata.memory.recalledMemories > 0);
  assert.ok(first.metadata.memory.usedMemoryIds.includes('lin-env-2'));
  noUnexpected();
});

test('the client sends only the newest message; Agent Memory restores the rest of the conversation', async () => {
  resetTrace();
  const cookie = await signIn('lindgren-logistics');
  await chat(cookie, 'First question');
  await waitFor(() => requests('session-append').length === 2, 'the first turn to be recorded');
  await chat(cookie, 'Second question');

  const [, secondCall] = requests('model');
  const messages = JSON.stringify(secondCall.body.messages);
  assert.equal(messages.split('First question').length - 1, 1);
  assert.match(messages, /Answer \d+\./);
  assert.match(messages, /Second question/);
  await waitFor(() => requests('session-append').length === 4, 'the second turn to be recorded');
  assert.deepEqual(requests('session-append').map(entry => entry.body.role), ['USER', 'ASSISTANT', 'USER', 'ASSISTANT']);
  assert.equal(new Set(requests('session-append').map(entry => entry.sessionId)).size, 1);
  noUnexpected();
});

test('identity in the request body is ignored: scope comes from the signed cookie', async () => {
  resetTrace();
  const cookie = await signIn('lindgren-logistics');
  await chat(cookie, 'Hello', { extra: { userId: owner('harbor-health'), sessionId: 'someone-else', customerId: 'harbor-health' } });
  assert.deepEqual(requests('memory-search').map(entry => entry.body.filter.ownerId.eq), [owner('lindgren-logistics')]);
  assert.doesNotMatch(modelBody(requests('model')[0]), /keep-alive turned off|Node 18/);
  noUnexpected();
});

test('signed-out or tampered requests are refused before any memory or model call', async () => {
  resetTrace();
  assert.equal((await chat('', 'Hello')).status, 401);
  const cookie = await signIn('lindgren-logistics');
  const forged = cookie.replace(/waypoint_session=([^.;]+)\.[^;]+/, (_, payload) =>
    `waypoint_session=${payload.replace('lindgren-logistics', 'harbor-health')}.forged`);
  assert.equal((await chat(forged, 'Hello')).status, 401);
  assert.deepEqual(requests(), []);
});

test('memory off sends no memory context and records nothing', async () => {
  resetTrace();
  const cookie = await signIn('lindgren-logistics');
  const result = await chat(cookie, 'Why is our API latency so high this week?', { memory: false });
  assert.equal(result.status, 200);
  assert.equal(result.metadata.memory, null);
  assert.equal(requests('model').length, 1);
  assert.doesNotMatch(modelBody(requests('model')[0]), /in October|works from curl/);
  assert.deepEqual(requests().filter(entry => entry.kind !== 'model' && entry.kind !== 'model-done'), []);
});

test('overlapping requests on one conversation are serialized', async () => {
  resetTrace();
  const cookie = await signIn('harbor-health');
  await Promise.all([chat(cookie, 'SLOW first'), chat(cookie, 'second')]);
  await waitFor(() => requests('session-append').length === 4, 'both turns to be recorded');
  const appends = requests('session-append');
  const firstAssistant = appends.find(entry => entry.body.role === 'ASSISTANT');
  const secondModel = requests('model')[1];
  assert.ok(secondModel.t >= firstAssistant.t, 'the second model call started before the first turn was recorded');
  assert.deepEqual(appends.map(entry => entry.body.role), ['USER', 'ASSISTANT', 'USER', 'ASSISTANT']);
  noUnexpected();
});

test('a tab still showing an earlier conversation is refused with 409', async () => {
  resetTrace();
  const cookie = await signIn('lindgren-logistics');
  const result = await chat(cookie, 'Hello', { headers: { 'x-waypoint-session': 'an-earlier-conversation' } });
  assert.equal(result.status, 409);
  assert.deepEqual(requests(), []);
});

test('the panel lists only the viewer’s memories, merges the setup record newest value first, and hides notes about the assistant', async () => {
  resetTrace();
  const cookie = await signIn('lindgren-logistics');
  const response = await fetch(`${app.base}/api/memories`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const { facts, hiddenAssistantNotes } = await response.json();
  assert.deepEqual(requests('memory-search').map(entry => entry.body.filter), [{ ownerId: { eq: owner('lindgren-logistics') } }]);
  const setup = facts.find(fact => fact.type === 'customer_environment');
  // lin-env-0 says Virginia, but it's older than lin-env-2's Frankfurt.
  assert.deepEqual(setup.attributes, { gateway_region: 'us-east', origin_location: 'Frankfurt' });
  assert.deepEqual(setup.mergedIds.sort(), ['lin-env-0', 'lin-env-1', 'lin-env-2']);
  assert.equal(hiddenAssistantNotes, 1);
  assert.doesNotMatch(JSON.stringify(facts), /keep-alive|another-app/);
});

test('staff see every customer with keep-alive off, from a typed filter over this run’s customers only', async () => {
  resetTrace();
  const staff = await signIn('staff');
  const response = await fetch(`${app.base}/staff`, { headers: { cookie: staff } });
  assert.equal(response.status, 200);
  const html = await response.text();
  for (const company of ['Harbor Health', 'Brightline Media', 'Tidepool Games']) assert.match(html, new RegExp(company));
  // Okafor has an older keep-alive-off record but turned it back on since, so it must not be listed.
  for (const company of ['Lindgren Logistics', 'Okafor Freight', 'Meridian Bank']) assert.doesNotMatch(html, new RegExp(company));
  const [, details] = requests('memory-search');
  assert.ok(details.body.filter.ownerId.in.includes(owner('okafor-freight')),
    'Okafor matches the typed filter, so this covers the re-check of the newest value');

  const [query] = requests('memory-search');
  assert.deepEqual(query.body.filter.memoryType, { eq: 'customer_environment' });
  assert.deepEqual(query.body.filter.attributes, { keep_alive_enabled: { string: 'false' } });
  assert.equal(query.body.filter.ownerId.in.length, 6);
  assert.ok(query.body.filter.ownerId.in.every(id => id.endsWith('-t1')));
  noUnexpected();
});

test('a customer session cannot open the staff page or run its query', async () => {
  resetTrace();
  const cookie = await signIn('harbor-health');
  const response = await fetch(`${app.base}/staff`, { headers: { cookie }, redirect: 'manual' });
  assert.ok([303, 307, 308].includes(response.status), `expected a redirect, got ${response.status}`);
  assert.equal(new URL(response.headers.get('location'), app.base).pathname, '/');
  assert.deepEqual(requests(), []);
});

test('changing DEMO_RUN signs out existing conversations', async () => {
  const cookie = await signIn('lindgren-logistics');
  const nextRun = await startServer('t2');
  resetTrace();
  assert.equal((await chat(cookie, 'Hello', { server: nextRun })).status, 401);
  assert.deepEqual(requests(), []);
});
