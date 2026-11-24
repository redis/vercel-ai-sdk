# Next.js support agent with structured memory

This private Next.js app shows the automatic-memory model wrapper in a multi-user web app. It's a support agent for Waypoint, a fictional API gateway. Two customers ask the same question, "Why is our API latency so high?", and each gets a different, correct diagnosis, because the agent remembers their setups from earlier support conversations. Neither customer's details ever reach the other's prompt.

Redis Agent Memory also extracts each customer's setup into a structured record with typed fields, using a custom memory type. Support staff can query those records across customers, for example "everyone with keep-alive off", and contact them before they open a ticket.

The chat goes through `memory.model(...)` from this package. The staff query and the "what the agent knows" panel use the Agent Memory client, [`@redis-iris/agent-memory`](https://github.com/redis/iris-sdks), directly, because the wrapper is scoped to one user.

To see what that one wrapper replaces, read [What you'd build without Redis Agent Memory](WITHOUT_AGENT_MEMORY.md).

## Setup

You need Node.js 22 or newer, a Redis Cloud account with an [Agent Memory](https://redis.io/docs/latest/develop/ai/context-engine/agent-memory/) service, and an Anthropic API key.

From the repository root, build the local package first:

```sh
npm ci
npm run build
cd demo/nextjs-support
npm ci
cp .env.example .env.local
```

Fill in `.env.local`:

| Variable | Where it comes from |
|----------|---------------------|
| `ANTHROPIC_API_KEY` | Your Anthropic key. `ANTHROPIC_MODEL` is optional (default `claude-sonnet-5-5`). |
| `AGENT_MEMORY_URL`, `AGENT_MEMORY_STORE_ID` | Redis Cloud → Agent Memory → your service → Configuration → General settings |
| `AGENT_MEMORY_API_KEY` | Configuration → **Connect → Create API key** (shown only once) |
| `DEMO_AUTH_SECRET` | Any long random string, for example from `openssl rand -hex 32` |
| `DEMO_RUN` | A suffix such as `run1`, appended to every customer ID, so each run starts with empty memory without flushing the store. Changing it signs out open windows. |

Then, in the Redis Cloud console:

1. **Create the `customer_environment` memory type** exactly as described in [MEMORY_TYPE.md](MEMORY_TYPE.md). Do this before seeding: names and fields can't be changed later.
2. **Set Configuration → Memory configuration → Extraction cadence to 60 seconds**, so new facts show up quickly.

Calls use the real Anthropic and Redis Agent Memory services and may incur charges.

## Seed the customers' history

```sh
npm run seed
```

This imports earlier support messages for six customers, the way you'd backfill history from a helpdesk: a billing question with a data-center move mentioned in passing, a closed ticket about keep-alive, and so on. It imports the customers' side only. When generated agent replies were included, extraction stored the agent's own advice as memories ("Assistant recommended…"), and those notes pushed the customer's facts out of recall.

Two customers, Lindgren and Harbor, can sign in. The other four exist so the staff query has something to filter.

The script waits until each customer has a `customer_environment` record, prints what was extracted, and checks the values the demo relies on, for example that Harbor's keep-alive is `"false"` and exactly three customers have keep-alive off. It ends with **Ready to demo** or **Not ready**. Extraction is done by a model, so runs vary: if it says **Not ready**, change `DEMO_RUN` and seed again.

## Try it

```sh
npm run dev
```

1. Open <http://localhost:3000> and sign in as **Lindgren Logistics**. In a private window, sign in as **Harbor Health**. Ask both: *Why is our API latency so high this week?*
   - **Lindgren:** the origin moved to Frankfurt but the gateway is still in us-east, so traffic crosses the Atlantic twice. The fix comes as curl, because that's what their ops team uses.
   - **Harbor:** keep-alive was turned off last quarter, so every Lambda call pays a new TLS handshake. The fix is to upgrade to SDK 3.2+ and turn keep-alive back on, and the agent doesn't ask for payloads.
2. Look at **What the agent knows about you**. The memories used in the reply are highlighted, and the setup shows as one typed `customer_environment` record.
3. In Lindgren's window, select **New conversation**, switch **Memory on** to **Memory off**, and ask the same question. With no earlier messages and no long-term memory, the agent has to ask where the gateway and origin are. Memory-off turns aren't recorded, so select **New conversation** again before you switch memory back on.
4. Mention a new detail in passing, such as "we're moving to SDK 3.2 next week". About a minute later it appears in the panel.
5. Select **New conversation**. The chat is empty, but the agent still knows the customer: a new session, the same long-term memory.
6. Select **Switch customer**, then **Waypoint staff**. **Keep-alive off** lists Harbor Health, Brightline Media and Tidepool Games, from one `searchLongTermMemory` call filtered by memory type and a typed field. **Notify** is a demo button and sends nothing.

The server log prints one `[memory]` line per memory operation: operation, outcome and counts, never content.

## The hard parts, and where they live

These are the places teams get memory wrong in a multi-user app. Each one is a few lines here, and each has a test.

1. **Scope comes from auth, never from the client.** `userId` and `sessionId` come from a signed, httpOnly cookie ([lib/auth.ts](lib/auth.ts)). The chat route ignores anything the client says about identity. If one customer could pass another's ID, the other's memories would be one request away.
2. **The client sends only the newest message.** Agent Memory restores the conversation, so there's no client-supplied history to trust or trim ([support-chat.tsx](app/support/support-chat.tsx), `prepareSendMessagesRequest`).
3. **A fresh memory model for every request.** `getMemory().model({ scope, ... })` is created inside the route handler, never shared across requests ([app/api/chat/route.ts](app/api/chat/route.ts)).
4. **One request per conversation at a time.** Recording isn't idempotent, so overlapping requests on one session would interleave their events. [lib/memory.ts](lib/memory.ts) holds a per-session lock until the stream ends. It's in-process, which works for one server; multiple instances need a distributed lock.
5. **Memory context is marked untrusted.** The wrapper injects recalled facts as a labeled system block, and the system prompt tells the model to treat them as reference only ([lib/product.ts](lib/product.ts)).
6. **Show what's stored.** The panel lists the customer's memories through the Agent Memory client, filtered by the server-side owner ID ([app/api/memories/route.ts](app/api/memories/route.ts)).
7. **Cross-customer queries never run for a customer.** The Account health query ([lib/account-health.ts](lib/account-health.ts)) runs only for a separate staff session, and only over this run's customer IDs. In this demo anyone can start a staff session from the home page; in a real app it needs staff authorization.
8. **A tab can't keep acting for someone who signed out.** Tabs in one browser share the sign-in cookie, so signing in as another customer in a second tab would silently change who the first tab talks as. Each page sends the conversation it was opened for (`x-waypoint-session`). The chat and memory routes refuse a mismatch with 409, and the page asks you to reload.

## Memory behavior

- **Extraction runs in the background.** With the cadence at 60 seconds, a fact mentioned in chat shows up in the panel about a minute later. A fact from this conversation isn't guaranteed to be recallable in the next turn.
- **One record per detail.** Extraction writes a separate `customer_environment` record for each detail it finds (SDK version, runtime, keep-alive…). The app merges them, newest value first ([lib/environment.ts](lib/environment.ts)).
- **Extraction is done by a model.** Occasionally a value lands in the wrong field or is left empty. The seed checks catch this before a demo, and the extraction prompt in [MEMORY_TYPE.md](MEMORY_TYPE.md) keeps it rare. Attribute filters are exact and case-sensitive.
- **Every question you ask as a customer becomes a memory too,** and shows in the panel. Rehearse under one `DEMO_RUN`, then seed a fresh one for the real demo.
- Default reads and writes are best effort. If Agent Memory is unavailable, the agent still answers, without memory.

## Test without live services

```sh
npm test
```

This builds the app and runs it with `next start`, with Redis Agent Memory and Anthropic replaced by [test/fixtures/services.mjs](test/fixtures/services.mjs). No credentials are needed and no network calls are made. The tests cover each customer getting only their own memories, every search filtered by the server-side owner, identity in the request body being ignored, signed-out and forged requests being refused before any call, only the newest message being sent, memory off sending no memory context, overlapping requests being serialized, stale tabs getting 409, the panel's owner filter and merged record with the newest value winning, the staff query's typed filter over this run's customers only, a customer who turned keep-alive back on dropping off the staff list, customers being kept out of the staff page, and a new `DEMO_RUN` signing out old conversations.

## Production notes

- Replace the demo sign-in with your auth provider. Keep the rule that scope is derived on the server.
- Replace the in-process session lock with a distributed one (for example Redis `SET NX` with a TTL) if you run more than one instance.
- Gate the cross-customer query behind real staff authorization.
- A customer who turns keep-alive back on can leave an older record that still says `"false"`. The staff view re-checks each matching customer's newest value, so they drop off the list. It loads up to 100 records per query; page through results for more customers.
- Recording sends user and assistant text to Redis Agent Memory. Configure retention and sensitive-data exclusions on the service to match your policy.

The local dependency is `file:../..`, resolving to the repository-root library. [.npmrc](.npmrc) sets `install-links=true`, so npm installs it as a packed copy, the way an app gets it from npm: the library then uses this app's `ai` and `zod` instead of the root's development copies. After library edits, run `npm run build` at the root, then `npm ci` here.
