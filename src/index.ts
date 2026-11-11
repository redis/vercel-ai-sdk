import type { AgentMemory } from '@redis-iris/agent-memory';
import type { LongTermMemoryFilter } from '@redis-iris/agent-memory/models';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import * as s from './schemas.js';
import { createNamespaceTools } from './namespaces.js';
import { createIngestionTools } from './ingestion.js';
import { createSummaryViewTools } from './summary-views.js';
import { RedisAgentMemoryToolError, sanitizeMemoryError } from './errors.js';
import { createSessionEventHook, type SessionEventHook, type SessionEventHookOptions } from './session-event-hook.js';
import {
  copyMemoryScope,
  createScopedMemory,
  extendMemoryScope,
  memoryErrorStatus,
  resolveAgentMemoryClient,
  type RedisAgentMemoryScope,
} from './scoped-memory.js';
import {
  assertConfiguredLanguageModel,
  createRedisAgentMemoryModel,
  type ConfiguredLanguageModel,
  type RedisAgentMemoryModel,
  type RedisAgentMemoryModelOptions,
} from './provider.js';
export { instructions } from './instructions.js';
export { RedisAgentMemoryToolError } from './errors.js';
export type {
  ConfiguredLanguageModel,
  RedisAgentMemoryDiagnostic, RedisAgentMemoryDiagnosticError,
  RedisAgentMemoryLimits, RedisAgentMemoryModel, RedisAgentMemoryModelOptions,
  RedisAgentMemoryProvenance, RedisAgentMemoryProvenanceEntry,
} from './provider.js';
export type {
  SessionEventHook, SessionEventHookInput, SessionEventHookOptions,
  SessionHookEvent, SessionEventHookErrorContext,
} from './session-event-hook.js';
export type { RedisAgentMemoryScope } from './scoped-memory.js';
interface RedisAgentMemoryToolOptions {
  /** Expose deletion tools. Defaults to false. */
  allowDeletes?: boolean;
  /** Expose namespace administration and store-wide routing tools. Defaults to false. */
  namespaceTools?: boolean;
  /** Expose document ingestion and ingestion hook status tools. Defaults to false. */
  ingestionTools?: boolean;
  /** Expose Summary View tools. Defaults to false. */
  summaryViewTools?: boolean;
  /** HTTP request timeout in milliseconds. Defaults to 30,000. Must be positive and finite. */
  timeoutMs?: number;
}

interface RedisAgentMemoryBaseOptions extends RedisAgentMemoryToolOptions {
  serverUrl?: string;
  storeId?: string;
  apiKey?: string;
  /** Overridable default. Derive scopes and overrides from trusted, authenticated application state. */
  scope?: RedisAgentMemoryScope;
}

export type RedisAgentMemoryOptions<DefaultModel extends ConfiguredLanguageModel | undefined = undefined> =
  RedisAgentMemoryBaseOptions & (undefined extends DefaultModel
    ? { /** Optional configured AI SDK model default. Model-name strings are not accepted. */ model?: DefaultModel }
    : { /** Configured AI SDK model default. Model-name strings are not accepted. */ model: DefaultModel });

export interface RedisAgentMemoryToolsOptions {
  /** Replaces the entire factory default scope when supplied. */
  scope?: RedisAgentMemoryScope;
}

/** A tool map with non-enumerable helpers for scoping and application session recording. */
export type RedisAgentMemoryTools = ToolSet & {
  readonly withContext: (scope: RedisAgentMemoryScope) => RedisAgentMemoryTools;
  /** Record USER text in onStart or ASSISTANT text in onEnd. Requires fixed userId/sessionId. */
  readonly createSessionEventHook: <Role extends SessionEventHookOptions['role']>(options: SessionEventHookOptions<Role>) => SessionEventHook<Role>;
};

function fail(message: string): never { throw new RedisAgentMemoryToolError('INVALID_SCOPE', message); }

/** A replayed idempotent batch must carry the same memory IDs, or the server rejects it as a different request. */
async function retryStableMemoryId(idempotencyKey: string, ownerId: string, index: number): Promise<string> {
  const input = new TextEncoder().encode(JSON.stringify([idempotencyKey, ownerId, index]));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input));
  return Array.from(digest.subarray(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
}

function buildTools(
  client: AgentMemory,
  scope: Readonly<RedisAgentMemoryScope>,
  options: Readonly<RedisAgentMemoryToolOptions>,
): RedisAgentMemoryTools {
  const deletes = options.allowDeletes ?? false;
  const scoped = createScopedMemory(client, scope);
  const {
    place, resolveSession, resolveOwner, checkPlacement, hasResourceScope,
  } = scoped;
  const assertSession = (sessionId: string, signal?: AbortSignal) => scoped.assertSession(sessionId, { signal });
  const assertMemory = (id: string, signal?: AbortSignal) => scoped.assertMemory(id, { signal });
  const assertPlacementOwner = (value: { namespaceId?: string }, signal?: AbortSignal) => (
    scoped.assertPlacementOwner(value, { signal })
  );
  const append = (input: z.infer<typeof s.event>, signal?: AbortSignal, start = false) => (
    scoped.appendSessionEvent(input, { signal, start })
  );
  const sessionInput = z.object({ sessionId: s.sessionId.optional() });
  const eventInput = sessionInput.extend({ eventId: s.id });
  const tools: ToolSet = {
    get_memory_context: tool({
      description: 'Get fixed memory scope and identity rules before using memory. Contains no credentials.',
      inputSchema: z.object({}), execute: async () => ({ ...scope, allowDeletes: deletes,
        userIdentityRule: 'Use userId as ownerId for the user’s memories and actorId for USER events. ASSISTANT events use the agent’s actorId.',
        sessionOwnerRule: 'The first event actor becomes the immutable session owner. Start with the user.',
        longTermRecall: 'Search spans sessions unless an explicit session filter is supplied.',
      }),
    }),
    start_session: tool({
      description: 'Start a conversation with the user’s first event. Redis Agent Memory generates and returns a session ID when none is provided. Retain the returned ID. Fails when the named session already exists. With idempotencyKey, a retry whose actorId, text, and createdAt match the session’s first event returns that event instead.',
      inputSchema: z.object({
        sessionId: s.sessionId.optional(), actorId: s.id, text: s.text,
        createdAt: s.timestamp.optional().describe('ISO 8601 timestamp; defaults to the current time. Supply it with idempotencyKey so a retry sends the identical request.'),
        idempotencyKey: s.sessionIdempotencyKey.optional(), ...s.placement,
      }),
      execute: (input, { abortSignal }) => append({ ...input, role: 'USER', content: [{ text: input.text }] }, abortSignal, true),
    }),
    add_session_event: tool({
      description: 'Append a USER, ASSISTANT, or SYSTEM event. Reuse the conversation’s sessionId. actorId is the author. Do not duplicate application logging. The store may not deduplicate appends by idempotencyKey, so after an uncertain append read get_session_memory before retrying.',
      inputSchema: s.event, execute: (input, { abortSignal }) => append(input, abortSignal),
    }),
    get_session_event: tool({
      description: 'Get one event by sessionId and eventId.', inputSchema: eventInput,
      execute: async (input, { abortSignal }) => {
        const sessionId = resolveSession(input.sessionId);
        if (hasResourceScope) await assertSession(sessionId, abortSignal);
        return client.getSessionEvent(sessionId, input.eventId, { signal: abortSignal });
      },
    }),
    get_session_memory: tool({
      description: 'Get conversation events and its latest summary. Include summarized events only when full older history is needed.',
      inputSchema: sessionInput.extend({ includeSummarisedEvents: z.boolean().optional() }),
      execute: async (input, { abortSignal }) => {
        const result = await client.getSessionMemory(resolveSession(input.sessionId), input.includeSummarisedEvents, { signal: abortSignal });
        if (scope.userId && result.ownerId !== scope.userId) fail('Session is outside the configured user scope.');
        checkPlacement(result); return result;
      },
    }),
    list_sessions: tool({
      description: 'List sessions for an owner or a namespace, with pagination, within any fixed scope. Unscoped callers must explicitly request includeAll to list the whole store. Sort by sessionId, createdAt, or updatedAt.',
      inputSchema: z.object({
        ownerId: s.ownerId.optional(), namespaceId: s.id.optional().describe('Only sessions placed in this namespace.'),
        includeAll: z.boolean().optional(), ...s.page, limit: z.number().int().min(1).max(1000).optional(),
        sortBy: z.enum(['sessionId', 'createdAt', 'updatedAt']).optional(), sortOrder: s.sortOrder.optional(),
      }),
      execute: async (input, { abortSignal }) => {
        if (scope.sessionId) {
          if (input.ownerId && scope.userId && input.ownerId !== scope.userId) fail('Cannot override user scope.');
          const session = await assertSession(scope.sessionId, abortSignal);
          return { items: [{ sessionId: session.sessionId, ownerId: session.ownerId, namespaceId: session.namespaceId }] };
        }
        const { namespaceId } = place({ namespaceId: input.namespaceId });
        if (input.includeAll && (scope.userId || namespaceId || input.ownerId)) {
          fail('includeAll cannot be combined with a user or namespace scope, ownerId, or namespaceId.');
        }
        const owner = input.ownerId || scope.userId;
        if (!owner && !namespaceId && !input.includeAll) fail('Supply ownerId or namespaceId, or explicitly set includeAll: true.');
        if (owner) resolveOwner(owner);
        // The service rejects includeAll alongside any filter, so a namespace filter stands in for it.
        const filtered = owner || namespaceId;
        const result = await client.listSessions(
          input.limit, input.cursor, owner, filtered ? undefined : true, { signal: abortSignal }, namespaceId,
          input.sortBy, input.sortOrder,
        );
        for (const item of result.items) checkPlacement(item);
        return result;
      },
    }),
    create_memories: tool({
      description: 'Create up to 100 durable memories in one batch. IDs are generated automatically; do not supply them. Use the user ID as ownerId; fixed scope.userId supplies it automatically. created and errors report per-record outcomes. Without idempotencyKey each call generates new IDs and memoryIds lists them all in input order, so reconcile uncertain writes before retrying. With idempotencyKey, a retry of the identical request replays the saved result with the same IDs, and memoryIds lists only the records the service created, in input order; a rejected record appears in errors instead.',
      inputSchema: z.object({ memories: z.array(s.memory).min(1).max(100), idempotencyKey: s.idempotencyKey.optional() }),
      execute: async ({ memories, idempotencyKey }, { abortSignal }) => {
        const records = await Promise.all(memories.map(async (memory, index) => {
          const sessionId = memory.sessionId ?? scope.sessionId;
          if (scope.sessionId && sessionId !== scope.sessionId) fail('Cannot override session association.');
          const ownerId = resolveOwner(memory.ownerId);
          const memoryId = idempotencyKey === undefined
            ? globalThis.crypto.randomUUID() : await retryStableMemoryId(idempotencyKey, ownerId, index);
          return { ...place(memory), memoryId, ownerId, sessionId };
        }));
        const checkedNamespaces = new Set<string>();
        for (const record of records) {
          const namespaceId = record.namespaceId;
          if (namespaceId && !checkedNamespaces.has(namespaceId)) {
            await assertPlacementOwner(record, abortSignal);
            checkedNamespaces.add(namespaceId);
          }
        }
        const result = await client.bulkCreateLongTermMemories({ memories: records, idempotencyKey }, { signal: abortSignal });
        const all = records.map(record => record.memoryId);
        if (idempotencyKey === undefined) return { ...result, memoryIds: all };
        // Keyed IDs are guessable, so another owner may already hold one; report only what the service created.
        const created = new Set(result.created);
        return { ...result, memoryIds: all.filter(id => created.has(id)) };
      },
    }),
    get_memory: tool({
      description: 'Get a long-term memory by ID within the configured scope. The record carries its revision, its first source links, and documentManaged when document ingestion produced it.',
      inputSchema: z.object({ memoryId: s.id }),
      execute: ({ memoryId }, { abortSignal }) => assertMemory(memoryId, abortSignal),
    }),
    search_memories: tool({
      description: 'Search durable memories semantically with query, or list them with filters only. Results are items plus optional nextCursor. Recall spans conversations. Scoped searches require filter.op ALL. sortBy and sortOrder order a filter-only listing and cannot be combined with query.',
      inputSchema: s.search,
      execute: async (input, { abortSignal }) => {
        if (input.query !== undefined && (input.sortBy !== undefined || input.sortOrder !== undefined)) {
          throw new RedisAgentMemoryToolError('INVALID_INPUT', 'sortBy and sortOrder apply only to filter-only listing. Omit query to sort.');
        }
        const filter: LongTermMemoryFilter = { ...input.filter, createdAt: input.filter?.createdAt
          ? Object.fromEntries(Object.entries(input.filter.createdAt).filter(([,v]) => v !== undefined).map(([k,v]) => [k, new Date(v!)])) : undefined };
        return scoped.searchLongTermMemory({ ...input, filter }, { signal: abortSignal });
      },
    }),
    update_memory: tool({
      description: 'Partially correct a memory’s text or organization. Supply at least one change; omitted fields stay unchanged. Document-managed memories accept only namespace changes. Use update_memory_fields for custom attributes or upsert_memory for a full replacement.',
      inputSchema: z.object({
        memoryId: s.id, changes: s.memoryUpdate,
        expectedRevision: s.expectedRevision.optional(), idempotencyKey: s.idempotencyKey.optional(),
      }),
      execute: async ({ memoryId, changes, expectedRevision, idempotencyKey }, { abortSignal }) => {
        if (!Object.values(changes).some(v => v !== undefined)) fail('Supply at least one change.');
        if (hasResourceScope) await assertMemory(memoryId, abortSignal);
        if (changes.ownerId !== undefined) resolveOwner(changes.ownerId);
        if (scope.sessionId && changes.sessionId !== undefined && changes.sessionId !== scope.sessionId) fail('Cannot override session association.');
        const placed = place(changes);
        await assertPlacementOwner(placed, abortSignal);
        return client.updateLongTermMemory(memoryId, { ...placed, expectedRevision, idempotencyKey }, { signal: abortSignal });
      },
    }),
    upsert_memory: tool({
      description: 'Create or fully replace one manually managed memory by ID, including custom attributes. Omitted optional fields are cleared and memoryType defaults to semantic. Read the memory first and send every field to keep. Pass expectedRevision to guard against concurrent changes. Document-managed memories cannot be replaced.',
      inputSchema: s.memory.extend({
        memoryId: s.memoryId.describe('ID of the memory to replace, or a new ID to create one.'),
        expectedRevision: s.expectedRevision.optional(), idempotencyKey: s.idempotencyKey.optional(),
      }),
      execute: async ({ memoryId, ...input }, { abortSignal }) => {
        if (hasResourceScope) {
          try { await assertMemory(memoryId, abortSignal); }
          catch (error) { if (memoryErrorStatus(error) !== 404) throw error; }
        }
        const sessionId = input.sessionId ?? scope.sessionId;
        if (scope.sessionId && sessionId !== scope.sessionId) fail('Cannot override session association.');
        const placed = { ...place(input), ownerId: resolveOwner(input.ownerId), sessionId };
        await assertPlacementOwner(placed, abortSignal);
        return client.upsertLongTermMemory(memoryId, placed, { signal: abortSignal });
      },
    }),
    update_memory_fields: tool({
      description: 'Atomically update the text and/or attributes of a custom-typed memory. memoryType must match the stored type. Pass the memory’s current namespaceId; omitting it asserts the memory has no namespace.',
      inputSchema: z.object({
        memoryId: s.id, memoryType: z.string().min(1).describe('The stored custom memory type.'),
        text: s.text.optional(), attributes: s.attributes.optional().describe('Field name to value, matching the custom type’s declared fields.'),
        expectedRevision: s.expectedRevision.optional(), idempotencyKey: s.idempotencyKey.optional(), ...s.placement,
      }),
      execute: async ({ memoryId, ...input }, { abortSignal }) => {
        if (input.text === undefined && input.attributes === undefined) fail('Supply text or attributes.');
        if (hasResourceScope) await assertMemory(memoryId, abortSignal);
        await client.updateLongTermMemoryFields(memoryId, place(input), { signal: abortSignal });
        return { updated: true, memoryId };
      },
    }),
    list_memory_sources: tool({
      description: 'List where a memory came from: document revisions or sessions, with their first evidence. Follow nextCursor for more links.',
      inputSchema: z.object({ memoryId: s.id, ...s.page }),
      execute: async ({ memoryId, limit, cursor }, { abortSignal }) => {
        if (hasResourceScope) await assertMemory(memoryId, abortSignal);
        return client.listMemorySourceLinks(memoryId, limit, cursor, { signal: abortSignal });
      },
    }),
    list_memory_source_evidence: tool({
      description: 'Page the extraction evidence for one source of a memory: document chunks or the session event IDs supplied to extraction. Evidence attributes input, not cited facts. Get sourceId from list_memory_sources.',
      inputSchema: z.object({ memoryId: s.id, sourceId: s.id, ...s.page }),
      execute: async ({ memoryId, sourceId, limit, cursor }, { abortSignal }) => {
        if (hasResourceScope) await assertMemory(memoryId, abortSignal);
        return client.listMemorySourceEvidence(memoryId, sourceId, limit, cursor, { signal: abortSignal });
      },
    }),
    list_source_memories: tool({
      description: 'List one owner’s memories derived from a source. Get sourceId from list_memory_sources. Follow nextCursor for more. Memories outside a fixed namespace scope are omitted.',
      inputSchema: z.object({ sourceId: s.id, ownerId: s.ownerId.optional(), ...s.page }),
      execute: async ({ sourceId, ownerId, limit, cursor }, { abortSignal }) => {
        const owner = resolveOwner(ownerId);
        const result = await client.listSourceMemories(sourceId, owner, limit, cursor, { signal: abortSignal });
        if (result.items.some(item => item.ownerId !== owner)) fail('Memory is outside the requested owner.');
        return scope.namespaceId === undefined ? result
          : { ...result, items: result.items.filter(item => item.namespaceId === scope.namespaceId) };
      },
    }),
  };
  if (deletes) Object.assign(tools, {
    delete_memories: tool({
      description: 'Delete 1 to 100 long-term memories by ID. Use for explicit forget requests. Inspect deleted and per-record errors before claiming success.',
      inputSchema: z.object({ memoryIds: z.array(s.id).min(1).max(100) }),
      execute: async ({ memoryIds }, { abortSignal }) => {
        if (hasResourceScope) for (const id of memoryIds) await assertMemory(id, abortSignal);
        return client.bulkDeleteLongTermMemories({ memoryIds }, { signal: abortSignal });
      },
    }),
    delete_session_event: tool({
      description: 'Delete one event. Previously promoted long-term memories remain and must be deleted separately.', inputSchema: eventInput,
      execute: async (input, { abortSignal }) => {
        const sessionId = resolveSession(input.sessionId);
        if (hasResourceScope) await assertSession(sessionId, abortSignal);
        await client.deleteSessionEvent(sessionId, input.eventId, { signal: abortSignal });
        return { deleted: true, sessionId, eventId: input.eventId };
      },
    }),
    delete_session_memory: tool({
      description: 'Delete a conversation’s session memory. This does not delete promoted long-term memories.', inputSchema: sessionInput,
      execute: async (input, { abortSignal }) => {
        const sessionId = resolveSession(input.sessionId);
        if (hasResourceScope) await assertSession(sessionId, abortSignal);
        await client.deleteSessionMemory(sessionId, { signal: abortSignal });
        return { deleted: true, sessionId };
      },
    }),
  });
  if (options.namespaceTools) Object.assign(tools, createNamespaceTools(client, {
    ownerId: scope.userId, namespaceId: scope.namespaceId, allowDeletes: deletes, assertMemory,
  }));
  if (options.ingestionTools) Object.assign(tools, createIngestionTools(client, scoped));
  if (options.summaryViewTools) Object.assign(tools, createSummaryViewTools(client, scoped, { allowDeletes: deletes }));
  // Errors from the generated SDK may contain response bodies and headers. Never expose these to the model.
  for (const entry of Object.values(tools)) {
    const execute = entry.execute!;
    entry.execute = async (input, execution) => {
      try { return await execute(input, execution); }
      catch (error) {
        if (execution.abortSignal?.aborted) throw new DOMException('Memory operation aborted.', 'AbortError');
        throw sanitizeMemoryError(error);
      }
    };
  }
  // Keep application helpers out of AI SDK tool enumeration and object spreads.
  Object.defineProperties(tools, {
    withContext: {
      value: (context: RedisAgentMemoryScope) => buildTools(
        client,
        copyMemoryScope(extendMemoryScope(scope, context), options),
        options,
      ),
    },
    createSessionEventHook: {
      value: (hookOptions: SessionEventHookOptions) => createSessionEventHook(scope, append, hookOptions),
    },
  });
  return tools as RedisAgentMemoryTools;
}

type ModelCallWithDefault = (options?: RedisAgentMemoryModelOptions) => RedisAgentMemoryModel;
type ModelCallWithoutDefault = (
  options: RedisAgentMemoryModelOptions & { model: ConfiguredLanguageModel },
) => RedisAgentMemoryModel;

export type RedisAgentMemory<DefaultModel extends ConfiguredLanguageModel | undefined = undefined> = Readonly<{
  tools: (options?: RedisAgentMemoryToolsOptions) => RedisAgentMemoryTools;
  model: undefined extends DefaultModel ? ModelCallWithoutDefault : ModelCallWithDefault;
}>;

/**
 * Create one immutable Redis Agent Memory factory and share its Iris client across tools and request models.
 * Each `model()` call returns fresh request-local state and must be reused only within one application request.
 */
export function createRedisAgentMemory<DefaultModel extends ConfiguredLanguageModel | undefined = undefined>(
  input: RedisAgentMemoryOptions<DefaultModel>,
): RedisAgentMemory<DefaultModel> {
  const options = Object.freeze({ ...input });
  if (options.model !== undefined) assertConfiguredLanguageModel(options.model);
  const defaultScope = copyMemoryScope(options.scope ?? {}, options);
  const toolOptions: Readonly<RedisAgentMemoryToolOptions> = Object.freeze({
    allowDeletes: options.allowDeletes,
    namespaceTools: options.namespaceTools,
    ingestionTools: options.ingestionTools,
    summaryViewTools: options.summaryViewTools,
    timeoutMs: options.timeoutMs,
  });
  let client: ReturnType<typeof resolveAgentMemoryClient>;
  try {
    client = resolveAgentMemoryClient(
      options.serverUrl,
      options.storeId,
      options.apiKey,
      options.timeoutMs ?? 30_000,
    );
  } catch (error) {
    throw new RedisAgentMemoryToolError(
      'INVALID_CONFIGURATION',
      error instanceof Error ? error.message : 'Redis Agent Memory connection configuration is invalid.',
    );
  }
  const defaultModel = options.model;
  const memory = {
    tools(callOptions: RedisAgentMemoryToolsOptions = {}) {
      const scope = callOptions.scope === undefined
        ? defaultScope
        : copyMemoryScope(callOptions.scope, toolOptions);
      return buildTools(client, scope, toolOptions);
    },
    model(callOptions: RedisAgentMemoryModelOptions = {}) {
      const selectedModel = callOptions.model === undefined ? defaultModel : callOptions.model;
      assertConfiguredLanguageModel(selectedModel);
      const scope = callOptions.scope === undefined
        ? defaultScope
        : copyMemoryScope(callOptions.scope);
      const { model: _model, ...requestOptions } = callOptions;
      return createRedisAgentMemoryModel(client, selectedModel, { ...requestOptions, scope });
    },
  };
  return Object.freeze(memory) as RedisAgentMemory<DefaultModel>;
}
