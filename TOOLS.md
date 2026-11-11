# Redis Agent Memory Tools for Vercel's AI SDK

[Redis Agent Memory](https://redis.io/agent-memory/), a part of the [Iris suite](https://redis.io/iris/), provides a managed memory layer that gives agents intelligent short-term memory and persistent context across conversations.
It allows AI agents to combine session history with long-term memories so they can recall user preferences, retain useful facts, and pick up where they left off.

This integration provides tools that add Redis Agent Memory to agents built with Vercel's [AI SDK](https://ai-sdk.dev/).
The tools are created by the same server-side `createRedisAgentMemory(...)` factory.
Use the tools either to delegate memory management entirely to your AI agent, or for implementing a desired custom behavior.

## Installation

Follow the [steps in the README.md](README.md#installation).

## Quick start

These examples use Anthropic directly; install its provider with `npm install @ai-sdk/anthropic@^4` and set `ANTHROPIC_API_KEY`.
Other AI SDK 7-compatible configured models work with the same APIs. Model-name strings are not accepted.

### Agent-managed session recording (no hooks)

Give the agent the memory tools and let it decide when to record session events or save long-term facts.
Tools do not require a configured model.

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { ToolLoopAgent, isStepCount } from 'ai';
import { createRedisAgentMemory, instructions } from '@redis/vercel-ai-sdk';

const userId = 'user-123';
const sessionId = 'conversation-456';
const agentId = 'assistant-1';

const memory = createRedisAgentMemory({
  serverUrl: process.env.AGENT_MEMORY_URL,
  storeId: process.env.AGENT_MEMORY_STORE_ID,
  apiKey: process.env.AGENT_MEMORY_API_KEY,
});
const tools = memory.tools({ scope: { userId, sessionId } });

const agent = new ToolLoopAgent({
  model: anthropic('claude-sonnet-4-5'),
  tools,
  instructions: `${instructions}
Current user and memory owner: ${userId}
Current session: ${sessionId}
Current assistant actor: ${agentId}
The application does not log session events. Decide when to record this conversation
using start_session or add_session_event. Start a new session with the user's
message, then use add_session_event for subsequent USER and ASSISTANT events.`,
  stopWhen: isStepCount(8),
});

const result = await agent.generate({
  prompt: 'Remember that I prefer TypeScript examples.',
});
console.log(result.finalStep.text);
```

Instructions guide the model's tool choices; they do not guarantee that every message or the final reply is stored.
Saving a long-term fact with `create_memories` is separate from recording conversation events.
This approach does not automatically load conversation history into model context.

### Automatic session recording with hooks

Use toolset `onStart` and `onEnd` helpers to record the current user message and the final assistant reply independently of the model's tool choices.
Keep session-write tools out of `activeTools` to avoid duplicate recording.

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { ToolLoopAgent, isStepCount } from 'ai';
import { createRedisAgentMemory, instructions } from '@redis/vercel-ai-sdk';

const userId = 'user-123';
const sessionId = 'conversation-456';
const agentId = 'assistant-1';
const memory = createRedisAgentMemory({
  serverUrl: process.env.AGENT_MEMORY_URL,
  storeId: process.env.AGENT_MEMORY_STORE_ID,
  apiKey: process.env.AGENT_MEMORY_API_KEY,
});
const tools = memory.tools({ scope: { userId, sessionId } });

const agent = new ToolLoopAgent({
  model: anthropic('claude-sonnet-4-5'),
  tools,
  activeTools: [
    'get_memory_context', 'get_session_memory',
    'create_memories', 'search_memories', 'update_memory',
  ],
  instructions: `${instructions}
Current user and memory owner: ${userId}
Current session: ${sessionId}
Current assistant actor: ${agentId}
The application records user input before generation and the final reply afterward.
Do not write session events. Use get_session_memory to read saved messages.`,
  stopWhen: isStepCount(8),
  onStart: tools.createSessionEventHook({
    role: 'USER',
    actorId: userId,
    onError: error => console.error('USER session save failed:', error.message),
  }),
  onEnd: tools.createSessionEventHook({
    role: 'ASSISTANT',
    actorId: agentId,
    onError: error => console.error('ASSISTANT session save failed:', error.message),
  }),
});
```

The USER write is awaited before the model starts, and the ASSISTANT hook records nonempty final text in `onEnd`.
See [Recording session events](#recording-session-events) for input requirements, observers, and failure behavior.

## Combining tools

`memory.tools()` returns an AI SDK `ToolSet`.
Its enumerable properties are exclusively tools; credentials and the SDK client remain in closures.

```ts
import { createRedisAgentMemory } from '@redis/vercel-ai-sdk';

const memory = createRedisAgentMemory({ serverUrl, storeId, apiKey });
const memoryTools = memory.tools({ scope: { userId } });
const tools = {
  search_memories: memoryTools.search_memories!,
  get_memory: memoryTools.get_memory!,
};
```

This is a server-side package.
Never put the Redis Agent Memory API keys in a frontend bundle.

## Reusing tools across conversations

Create a toolset for each trusted request scope.
Factory-level scope is only an overridable default: it is not an authorization ceiling.
Supplying a call-level scope replaces the **entire** factory scope rather than merging fields, so a session or namespace from another request cannot be inherited accidentally.
Omitting `scope`, or passing `scope: undefined`, uses the factory default.

```ts
const memory = createRedisAgentMemory({
  serverUrl,
  storeId,
  apiKey,
  scope: { userId: 'default-user', sessionId: 'default-session' },
});

const first = memory.tools(); // uses the complete factory scope
const second = memory.tools({
  scope: { userId: 'user-42', sessionId: 'conversation-2' },
}); // replaces it completely
```

Factory defaults and per-call overrides must come from trusted, authenticated application state.
They do not establish the caller's identity or replace application authorization.

A returned toolset retains the non-enumerable `withContext(scope)` helper for **narrowing that toolset's already resolved scope**, plus `createSessionEventHook(options)`.
`withContext` shares the client, does not mutate either toolset, fills only missing fields, and rejects conflicting fixed values.
This is intentionally different from the whole-scope replacement used by `memory.tools({ scope })`:

```ts
const userTools = memory.tools({ scope: { userId: 'user-42' } });
const conversationTools = userTools.withContext({ sessionId: 'conversation-1' });
```

Scope remains optional for tools.
An unscoped toolset retains its existing unscoped behavior.
Helpers are omitted from enumeration and object spread.

## Recording session events

Call `createSessionEventHook(options)` on a scoped toolset and pass the returned callback to the matching lifecycle hook: `role: 'USER'` goes on `onStart`, and `role: 'ASSISTANT'` goes on `onEnd`.
Each callback records one event using the same ownership and namespace checks as the session tools.
The [hook example above](#automatic-session-recording-with-hooks) shows both callbacks.

`userId` and `sessionId` must be fixed in the toolset's resolved scope before creating the hook, through `memory.tools({ scope })` or the returned toolset's `withContext(scope)` narrowing helper.
The hook captures that scope.
Supply `actorId` for each hook; the USER actor must equal scoped `userId`, and the ASSISTANT actor identifies your agent.
Like `withContext`, the helper is non-enumerable, so it is not advertised to the model or copied by object spread.

The USER hook reads the `onStart` input messages.
The final message must have role `user`, with either a content string or text parts.
Text parts remain separate event content items; images, files, and other non-text parts are ignored.
A user message without nonempty text fails validation.
The ASSISTANT hook reads `finalStep.text` and skips an empty reply.
Each hook validates its event before writing.
No `include.requestMessages` setting is needed.
Earlier history, intermediate steps, tool calls, and tool results are not recorded.

The USER write is awaited before the model starts, so memory tools can read that message during generation.
It remains saved if generation later fails.
The ASSISTANT event is recorded only when AI SDK invokes `onEnd` with nonempty final
text.

Hook options are:

| Option | Behavior |
| --- | --- |
| `role` | Required: `'USER'` for `onStart`, or `'ASSISTANT'` for `onEnd` |
| `actorId` | Required author ID; must match scoped `userId` for USER events |
| `onError(error, context)` | Required handler for validation or write failures; receives a sanitized `RedisAgentMemoryToolError` |
| `onEventStart(info)` | Optional observer called before each append attempt |
| `onEventSaved(info)` | Optional observer called after each confirmed append |

Observer `info` has type `SessionHookEvent` and contains `sessionId`, `role`, and `actorId`.
Error `context` contains those fields plus `userId` and `phase` (`'validation'` or `'write'`).
Callbacks may be asynchronous and are awaited; their exceptions, including exceptions from `onError`, are ignored.
Observer errors do not interrupt recording.
Hook writes do not trigger the AI SDK's `onToolExecutionStart` or `onToolExecutionEnd` callbacks; use the event observers for session logging.

The two hooks run independently.
A USER save failure does not stop generation or prevent the ASSISTANT hook from running.
A failed write may have committed without confirmation, so the assistant event may still be appended afterward.
Ownership checks still prevent an ASSISTANT event from starting a new user-owned session.
Hooks send no `idempotencyKey`.
Writes are not atomic, retried, or deduplicated; verify uncertain outcomes before retrying and register each hook only once per generation.
AI SDK ignores lifecycle callback exceptions, so report failures through `onError`.
To require persistence before proceeding with generation or returning a reply, use the official SDK in the application workflow.

## Configuration

The configuration is documented in the project's [README.md](README.md#configuration).

## Tool reference

All parameter names are camelCase.
IDs remain visible to the model; fixed scopes cannot be overridden.
The three deletion tools below are exposed only when `options.allowDeletes` is `true`.

| Tool | Parameters and result |
| --- | --- |
| `get_memory_context` | `{}` → configured IDs and identity rules, no secrets |
| `start_session` | `{actorId, text, sessionId?, createdAt?, idempotencyKey?, namespaceId?}` → `{event}`; omit sessionId to have it generated |
| `add_session_event` | `{actorId, role, content: [{text}], sessionId?, createdAt?, metadata?, idempotencyKey?, namespaceId?}` → `{event}` |
| `get_session_event` | `{sessionId?, eventId}` → `{event}` |
| `get_session_memory` | `{sessionId?, includeSummarisedEvents?}` → session, events, optional summary |
| `list_sessions` | `{ownerId?, namespaceId?, includeAll?, limit?, cursor?, sortBy?, sortOrder?}` → `{items: [{sessionId, ownerId?, ...}], nextCursor?}` |
| `create_memories` | `{memories: [...], idempotencyKey?}` without IDs → `{memoryIds, created, errors?}`; IDs are generated automatically |
| `get_memory` | `{memoryId}` → memory record with `revision`, first source links, and `documentManaged` |
| `search_memories` | `{query?, filter?, minScore?, limit?, cursor?, sortBy?, sortOrder?, excludeDocumentManaged?}` → `{items, nextCursor?}` |
| `update_memory` | `{memoryId, changes: {...}, expectedRevision?, idempotencyKey?}` → updated memory record |
| `upsert_memory` | `{memoryId, text, ownerId?, sessionId?, memoryType?, topics?, attributes?, namespaceId?, expectedRevision?, idempotencyKey?}` → memory record |
| `update_memory_fields` | `{memoryId, memoryType, text?, attributes?, namespaceId?, expectedRevision?, idempotencyKey?}` → `{updated: true, memoryId}` |
| `list_memory_sources` | `{memoryId, limit?, cursor?}` → source links with `nextCursor?` |
| `list_memory_source_evidence` | `{memoryId, sourceId, limit?, cursor?}` → evidence with `nextCursor?` |
| `list_source_memories` | `{sourceId, ownerId?, limit?, cursor?}` → memories with `nextCursor?` |
| `delete_memories` | `{memoryIds: [...]}` → `{deleted, errors?}` |
| `delete_session_event` | `{sessionId?, eventId}` → deletion confirmation |
| `delete_session_memory` | `{sessionId?}` → deletion confirmation |

`sessionId` is required for retrieval/deletion unless fixed in the scope.
`role` is `USER`, `ASSISTANT`, or `SYSTEM`. `createdAt` accepts an ISO 8601 string with timezone and defaults to the current time.
Session/owner IDs follow the server's 1–64 alphanumeric-or-hyphen convention; actor IDs accept 1–255 characters.
An `upsert_memory` ID accepts 1 to 64 letters, digits, underscores, or hyphens.
`limit` accepts 1 to 100, except `list_sessions`, which accepts 1 to 1000.
`start_session` fails when the named session already exists, except for a keyed retry that matches its first event.

A create record contains:

```ts
{
  text: 'The user prefers TypeScript.',
  ownerId: 'user-123',               // Optional when scope.userId is set
  sessionId: 'conversation-456',    // Optional; defaults to scoped session
  memoryType: 'semantic',           // Optional; registered custom types also work
  topics: ['programming'],
  attributes: { /* fields matching your custom type, if applicable */ },
  namespaceId: 'your-namespace-id',
}
```

The wrapper generates an ID for each create record.
The agent does not supply an `id`.
Without an `idempotencyKey`, the returned `memoryIds` array lists all generated IDs in input order, including any failed records.
With an `idempotencyKey`, the IDs are derived from the key, so a retry replays the same request, and `memoryIds` lists only the records the service created.
In both cases `created` contains successful IDs and `errors` contains per-ID failures.
Keep successful IDs for later retrieval, updates, and deletion.

Bulk create/delete accepts 1–100 records/IDs and preserves the server's per-record errors.
Text accepts 1–50,000 characters; topics accept up to 50 tags.

### Retries and idempotency keys

`start_session`, `add_session_event`, `create_memories`, `update_memory`, `upsert_memory`, and `update_memory_fields` accept an optional `idempotencyKey` of 1 to 255 characters.
The tools pass it to Redis Agent Memory unchanged.
For memory writes, a retry that reuses the key with the identical request replays the saved result, and the same key with a different request fails with HTTP 409.
A store that selects an input hook requires the key, and a write without it fails.

To retry an uncertain memory write, send the identical request with the same key.
Session events are different.
The store may not deduplicate `add_session_event` by the key, so an identical keyed retry can append a second event.
After an uncertain append, read the session with `get_session_memory` before retrying.

Without a key, each `create_memories` call generates fresh UUID v4 IDs.
If a request times out or its outcome is uncertain, search for the memories before retrying to avoid duplicates.
Retry only records confirmed to have failed.

With a key, `create_memories` derives each ID from the key, the record's owner, and the record's position in the batch.
The ID is 32 lowercase hex characters.
A retry with the same key, the same records, and the same order produces the same IDs, so the server can replay the saved result.
Reordering the records or changing an owner changes the IDs.

The tools do not retry or deduplicate writes without a key.
`start_session` with a named `sessionId` checks first that the session does not exist.
The store refuses to create an existing session even with the same key, so the tool handles a keyed retry itself.
When the session exists, passes the scope checks, and its first event matches the request's `actorId`, role, text, and any `createdAt`, the tool returns that event without writing.
Otherwise, and always without a key, the retry fails with that check.
For a matching retry, send the same `createdAt` as the first attempt.

### Updates and revisions

`update_memory` changes only the fields in `changes`: `text`, `memoryType`, `topics`, `ownerId`, `sessionId`, and namespace placement.
Omitted fields stay unchanged.
An empty `sessionId` clears it when not fixed by scope.
Per the tool description, a document-managed memory accepts only namespace changes.

`upsert_memory` creates a memory under the given ID, or fully replaces the memory with that ID.
Omitted optional fields are cleared, and `memoryType` defaults to `semantic`.
Read the memory with `get_memory` first and send every field to keep.
Per the tool description, document-managed memories cannot be replaced.

`update_memory_fields` changes the `text`, the `attributes`, or both of a custom-typed memory.
It requires at least one of them.
`memoryType` must match the stored type.
Pass the memory's current `namespaceId`; omitting it asserts that the memory has no namespace.

`update_memory`, `upsert_memory`, and `update_memory_fields` accept `expectedRevision`.
Read the current `revision` from `get_memory`.
Per the tool descriptions, a stale revision fails with HTTP 412.

### Memory provenance

`list_memory_sources` lists where a memory came from: document revisions or sessions, with their first evidence.
`list_memory_source_evidence` pages the extraction evidence for one source of that memory, such as document chunks or session event IDs.
Evidence shows the input given to extraction, not a citation for the fact.
`list_source_memories` lists one owner's memories derived from a source.
Get `sourceId` from `list_memory_sources`.

`list_source_memories` requires `ownerId` unless the scope fixes `userId`.
It refuses a result that contains another owner's memory.
With a fixed namespace, it omits memories outside that namespace, so a page can hold fewer items than `limit`.
With a fixed user or namespace, `list_memory_sources` and `list_memory_source_evidence` check the memory's owner and placement first.

Search filters support `ownerId`, `sessionId`, `topics`, and `memoryType` with exactly one of `{eq}`, `{ne}`, `{in: [...]}`, or `{all: [...]}`.
`namespaceId` supports `{eq}` or `{in}`. Use `unnamespaced` without namespace selectors. Date comparisons accept ISO strings:

```ts
{
  query: 'preferred programming language',
  filter: {
    op: 'ALL',
    ownerId: { eq: 'user-123' },
    topics: { in: ['programming'] },
    createdAt: { gte: '2026-01-01T00:00:00Z' },
    attributes: { confirmed: { boolean: true } },
  },
  limit: 10,
}
```

Attribute filters accept exactly one of `{string}`, `{number}`, `{boolean}`, or `{list: string[]}` per field.
Omit `query` to list/filter without a semantic query.
Pagination uses the returned opaque `nextCursor` with the same search parameters.

`sortBy` (`createdAt` or `updatedAt`) and `sortOrder` (`ASC` or `DESC`) order a filter-only listing.
The tool rejects either one combined with `query`.
`excludeDocumentManaged: true` omits memories produced by document ingestion.

`list_sessions` sorts by `sessionId`, `createdAt`, or `updatedAt`, with the same `sortOrder` values.

## Identity and scope behavior

`scope.userId` identifies the application user.
The tools use that identity in role-specific fields: `ownerId` for the user's memories, sessions, and PERSONAL namespaces, and `actorId` for their USER events.
Memory creation supplies `ownerId` automatically from `scope.userId`; session tools and `createSessionEventHook` require an explicit `actorId`.

Append `instructions` to your agent's instructions and supply current user/agent/session IDs in trusted application context.
A USER event uses the human user's ID as `actorId`; an ASSISTANT event uses the agent's ID.
The first event establishes immutable session ownership, so initialize user-owned sessions with the user's message.
With `scope.userId` set, the wrapper requires a new session to start with a USER event whose `actorId` matches that user ID.

The host must retain session IDs between requests.
An agent generating a session ID does not itself make that ID persistent across future model calls.
In the tools approach, persist IDs and conversation history in application storage and reuse them on later requests.
The automatic-memory model can restore available Redis Agent Memory session history when given the same session ID.

`scope.sessionId` restricts session operations but **does not filter long-term recall by session**, allowing recall from earlier conversations.
To limit long-term recall to one conversation, pass an explicit `filter.sessionId`.

User/namespace-scoped searches require `filter.op: 'ALL'`; an OR filter could bypass a fixed owner predicate and is rejected.
Direct-ID reads, updates, and deletes check existing ownership/placement before returning or mutating a resource.
User-scoped resource placements require a PERSONAL namespace owned by that user.

With a fixed session, `list_sessions` returns only that session.
Without a fixed session, `list_sessions` needs an `ownerId`, a `namespaceId`, or explicit `includeAll: true`.
A fixed `userId` supplies the owner, and a fixed `namespaceId` supplies the namespace.
A `namespaceId` argument that differs from a fixed namespace is rejected.
`includeAll` is rejected alongside an owner or a namespace, because the service does not allow it alongside a filter.
With a namespace scope, `list_sessions` rejects any returned session outside that namespace.

Resolved scopes provide application guardrails and use preflight reads.
Factory scope is only a replaceable default, not an authorization ceiling.
Neither is a substitute for authentication, store-level permissions, or protection against concurrent ownership changes made by other clients.

## Optional namespace tools

Set `namespaceTools: true` on `createRedisAgentMemory(...)` to add:

| Tool | Parameters |
| --- | --- |
| `list_namespaces` | `{parentId?, scope?, ownerId?, limit?, cursor?, sortBy?, sortOrder?}` |
| `get_namespace` | `{namespaceId}` |
| `create_namespace` | `{name?, path?, scope?, parentId?, ownerId?}` |
| `update_namespace` | `{namespaceId, name?, state?: 'ARCHIVED'}` |
| `move_memories` | `{memoryIds, namespaceId?}` |
| `get_namespace_routing` | `{}` |
| `put_namespace_routing` | `{policy}` |
| `delete_namespace` | `{namespaceId}`; omitted when deletes are disabled |

Create roots with name/scope, children with name/parentId, or a hierarchy with path/scope.
Namespace scopes are `PERSONAL` and `SHARED`; PERSONAL roots require an owner.
User-scoped tools restrict access to that user's personal namespaces, including child namespaces inheriting root ownership.
A fixed namespace scope prevents creation or moving memories outside that namespace.
Legacy namespace scopes cannot enable resource administration tools.
Archive and delete operations follow the server's rules; deletion is for empty leaf namespaces.

`list_namespaces` sorts by `id`, `name`, `createdAt`, or `updatedAt`, and defaults to `id`.
`sortOrder` is `ASC` or `DESC`, and defaults to `ASC`.
`limit` accepts 1 to 1000.

`move_memories` with a `namespaceId` moves the memories to that active namespace.
Without a `namespaceId`, it asks the store to route the memories by its routing policy.
Per the tool description, automatic routing applies only to memories already in a shared namespace; personal and unnamespaced memories keep their placement and get a per-item error.
A toolset with a fixed `userId` or `namespaceId` refuses automatic routing, because routing can move memories outside the scope.

`get_namespace_routing` reads the store-wide routing policy.
`put_namespace_routing` replaces the whole policy, so read it first and send every rule to keep.
A toolset with a fixed `userId` or `namespaceId` refuses both tools.
A policy has this shape:

```ts
{
  enabled: true,
  rules: [{
    id: 'support-tickets',               // 1 to 64 characters
    destinationNamespaceId: 'shared-ns', // a SHARED namespace
    enabled: true,
    action: 'ACCEPT',                    // or 'REJECT'
    strategies: [
      { kind: 'LLM_PROMPT', llmPrompt: { prompt: 'Support ticket details' } },
      { kind: 'MATCHER_SPEC', matcher: { kind: 'REGEX', regex: { pattern: '^TICKET-' } } },
    ],
  }],
}
```

Each strategy carries exactly the block that matches its `kind`.
Regex patterns use RE2 syntax, without lookaround or backreferences.

## Optional ingestion tools

Set `ingestionTools: true` on `createRedisAgentMemory(...)` to add:

| Tool | Parameters |
| --- | --- |
| `create_document_ingestion` | `{documentId, revision, content, mediaType, extractorId, ownerId?, idempotencyKey}` |
| `get_document_ingestion` | `{ingestionId}` |
| `list_document_ingestion_outputs` | `{ingestionId, limit?, cursor?}` |
| `get_ingestion_hook_status` | `{eventId}` |
| `list_ingestion_hook_statuses` | `{limit?, cursor?}` |

`create_document_ingestion` submits one revision of a document for asynchronous extraction into long-term memories.
`content` is plain UTF-8 text, and the tool base64-encodes it.
`mediaType` is `text/plain` or `text/markdown`.
`extractorId` is `ex_` followed by 32 hex characters, and must name an extractor configured for documents.
`idempotencyKey` is required.
`ownerId` is required unless the scope fixes `userId`.
A toolset with a fixed `namespaceId` refuses this tool, because the extracted memories cannot be placed in that namespace.

Poll `get_document_ingestion` until the processing state is terminal.
The states are `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, and `PARTIAL`.
Then page the created memory IDs with `list_document_ingestion_outputs`.
A page can be empty while `nextCursor` is present.
`ingestionId` is `ing_` followed by 32 hex characters.

The 1.0.0 ingestion record has no `ownerId`.
A toolset with a fixed `userId` or `namespaceId` proves scope through the memories the ingestion produced.
Both tools return nothing until at least one output memory passes the scope check.
They follow `nextCursor` for up to 5 pages of 100 outputs to find one.
They refuse the read with `INVALID_SCOPE` when none does, and when any returned memory is outside the scope.
Output IDs whose memory no longer exists are skipped.

A scoped toolset therefore cannot poll an ingestion that has produced no memories yet.
Use an unscoped toolset to watch a queued or running ingestion, or wait for the first outputs.

`get_ingestion_hook_status` reads one ingestion hook decision by the event ID of the write it judged.
`list_ingestion_hook_statuses` lists recent decisions, newest first.
Per the tool descriptions, statuses are kept for seven days.
Use them after a write fails with HTTP 422 (stopped hook) or HTTP 503 (retryable hook).
With a fixed `userId`, `get_ingestion_hook_status` refuses another owner's status, and `list_ingestion_hook_statuses` omits them, so a page can hold fewer items than `limit`.
Hook statuses are store-wide.
A toolset with a fixed `namespaceId` refuses both tools, because statuses carry no namespace.

## Optional Summary View tools

Set `summaryViewTools: true` on `createRedisAgentMemory(...)` to add:

| Tool | Parameters |
| --- | --- |
| `list_summary_views` | `{limit?, cursor?}` |
| `get_summary_view` | `{viewId}` |
| `create_summary_view` | `{name, description?, visibility?, filter?, groupBy, evictionPolicy?, timeWindowSeconds?, output, refreshPolicy}` |
| `update_summary_view` | `{viewId, name?, description?, filter?, clearFilter?, groupBy?, evictionPolicy?, timeWindowSeconds?, clearTimeWindow?, output?, refreshPolicy?, state?}` |
| `refresh_summary_view` | `{viewId, target, partition?}` |
| `get_summary_view_result` | `{viewId, partition?, includeSourceMemoryIds?}` |
| `delete_summary_view` | `{viewId}`; omitted when deletes are disabled |

A Summary View keeps a generated summary of the long-term memories its `filter` selects.
`filter` uses the `search_memories` filter shape.
`groupBy` lists up to four of `ownerId`, `sessionId`, `namespaceId`, and `memoryType`, and splits the view into one partition per distinct value.
An empty `groupBy` keeps a single summary.
`output.format` is `TEXT` or `STRUCTURED`; `STRUCTURED` requires `output.schema`, a flat list of fields.
`refreshPolicy.mode` is `MANUAL` or `CONTINUOUS`; `CONTINUOUS` requires `reconcileIntervalSeconds`.
`visibility` is `PRIVATE` (the default) or `SHARED`, and cannot change after creation.
Per the tool description, `PRIVATE` keeps the view to the API caller, not to an application user.

`refresh_summary_view` queues an asynchronous refresh.
`target: 'PARTITION'` refreshes one exact partition, and `target: 'FULL'` reconciles every partition and takes no partition.
`get_summary_view_result` reads one partition.
Check its `status` before using `value`.
`partition` holds one value for each `groupBy` field of the view.

### Summary Views under a fixed scope

These rules apply when the scope fixes `userId`, `namespaceId`, or both.
A fixed `sessionId` alone does not restrict Summary Views.
A toolset without a fixed user or namespace has full access to every view.

A view's `ownerId` is the API caller, so the tools prove access from the view's `filter` and `groupBy`.
A fixed field is pinned when the view's filter contains exactly `{eq: <fixed value>}` for it, and the filter is conjunctive.
A filter is conjunctive when `op` is `ALL`, or when `op` is omitted and the field is the filter's only condition.
`userId` maps to the `ownerId` field, and `namespaceId` maps to the `namespaceId` field.

Each view gets one of three access levels:

| Level | Condition | Allowed tools |
| --- | --- | --- |
| Hidden | The view is `SHARED`, or a fixed field is neither pinned nor in `groupBy` | None; `list_summary_views` omits it, and the other tools refuse it |
| Read | The view is `PRIVATE`, and every fixed field that is not pinned is in `groupBy` | `get_summary_view`, `get_summary_view_result`, and `refresh_summary_view` with `target: 'PARTITION'` |
| Manage | The view is `PRIVATE`, and every fixed field is pinned | All read tools, plus `update_summary_view`, `refresh_summary_view` with `target: 'FULL'`, and `delete_summary_view` |

A page of `list_summary_views` can hold fewer items than `limit`, because hidden views are omitted.

For partition reads and refreshes, the tools fill in each fixed value whose field is in the view's `groupBy`.
A partition value that conflicts with a fixed value is refused.

`create_summary_view` always creates a `PRIVATE` view and refuses `visibility: 'SHARED'`.
It pins the filter to the fixed user and namespace and sets `op: 'ALL'`, so the new view is at the manage level.
It refuses a filter with `op: 'ANY'` or a filter that names a different owner or namespace.
`update_summary_view` requires the manage level, pins a new filter the same way, and refuses `clearFilter`.

## Failures and cancellation

Tool execution throws `RedisAgentMemoryToolError` with a safe `code`, message, and optional HTTP `statusCode`.
Upstream headers, bodies, and API keys are not passed into model context.
Cancellation is surfaced as `AbortError`.
Bulk results retain partial errors so the agent can identify individual failures.
An uncertain memory creation or session append can already have committed.
Retry it with the same `idempotencyKey` and identical input, or reconcile its outcome before retrying without a key.
Scope refusals use the code `INVALID_SCOPE`.

Automatic summary/promotion behavior belongs to the Redis Agent Memory store configuration.
Deleting session history does not cascade to promoted long-term memories.
The package has no LLM dependency of its own and does not configure store promotion workers, store administration, or custom extraction workers.
