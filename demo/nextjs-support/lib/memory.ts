import { anthropic } from '@ai-sdk/anthropic';
import { AgentMemory } from '@redis-iris/agent-memory';
import { createRedisAgentMemory } from '@redis/vercel-ai-sdk';

export const modelName = process.env.ANTHROPIC_MODEL?.trim() || 'claude-sonnet-5-5';

// One factory per server process, created on first use so builds don't need
// credentials. It shares the Agent Memory client and the default model.
// Connection values come from AGENT_MEMORY_URL, AGENT_MEMORY_STORE_ID, and
// AGENT_MEMORY_API_KEY.
let factory: ReturnType<typeof create> | undefined;
const create = () => createRedisAgentMemory({ model: anthropic(modelName) });
export function getMemory() {
  factory ??= create();
  return factory;
}

export const ASSISTANT_ID = 'waypoint-support';

// The official Agent Memory SDK, used directly only for the "what the agent
// knows" panel. The chat path goes through the AI SDK wrapper above.
let client: AgentMemory | undefined;
export function getMemoryClient(): AgentMemory {
  const serverURL = process.env.AGENT_MEMORY_URL?.trim();
  if (!serverURL) throw new Error('Set AGENT_MEMORY_URL.');
  client ??= new AgentMemory({
    serverURL,
    storeId: process.env.AGENT_MEMORY_STORE_ID,
    apiKey: process.env.AGENT_MEMORY_API_KEY,
  });
  return client;
}

// The wrapper is best effort and not idempotent: two overlapping requests on the
// same session can interleave their writes. Serialize requests per session.
// This in-process lock is enough for one `next dev` server. Across several
// instances you need a distributed lock (for example Redis SET NX with a TTL).
// A streamed reply holds the lock until the stream ends, because the wrapper
// records the assistant turn at the end of the stream.
const tails = new Map<string, Promise<void>>();
const MAX_HOLD_MS = 120_000;

export async function acquireSessionLock(sessionId: string): Promise<() => void> {
  const previous = tails.get(sessionId) ?? Promise.resolve();
  let resolve!: () => void;
  const current = new Promise<void>(done => { resolve = done; });
  const tail = previous.then(() => current);
  tails.set(sessionId, tail);
  await previous;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    resolve();
    if (tails.get(sessionId) === tail) tails.delete(sessionId);
  };
  // Never let a stuck stream block the conversation forever.
  const timer = setTimeout(release, MAX_HOLD_MS);
  return release;
}
