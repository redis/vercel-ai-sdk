import { tool, type ToolSet } from 'ai';
import type { AgentMemory } from '@redis-iris/agent-memory';
import { z } from 'zod';
import { RedisAgentMemoryToolError } from './errors.js';
import * as s from './schemas.js';
import { memoryErrorStatus, type ScopedMemory } from './scoped-memory.js';

const ingestionId = z.string().regex(/^ing_[0-9a-f]{32}$/).describe('Ingestion ID returned by create_document_ingestion.');
const extractorId = z.string().regex(/^ex_[0-9a-f]{32}$/).describe('Document extractor ID configured for this store.');

const MAX_PROOF_PAGES = 5;
const PROOF_BATCH = 5;
const SCOPED_READ_RULE =
  'A toolset with a fixed user or namespace can read an ingestion it submitted itself, or one that has produced memories in that scope; any other read is refused.';
const HOOK_SCOPE_RULE = 'Unavailable when the toolset has a fixed namespace, or a sessionId without a fixed user.';

function fail(message: string): never {
  throw new RedisAgentMemoryToolError('INVALID_SCOPE', message);
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  // Chunked so large documents stay under the engine's argument count limit.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Optional document ingestion and ingestion hook tools. Access checks never trust model-supplied IDs. */
export function createIngestionTools(client: AgentMemory, ctx: ScopedMemory): ToolSet {
  const { scope, hasResourceScope } = ctx;
  // An ingestion that produced no memories (still running, failed, or fully filtered) cannot prove scope through
  // its outputs, so a scoped toolset also trusts the ingestions it submitted itself with its own forced owner.
  const submitted = new Set<string>();

  // A document ingestion record carries no owner, so scope is proven through the memories it produced.
  const verifyOutputs = async (ids: string[], signal?: AbortSignal) => {
    if (!hasResourceScope) return ids;
    const kept = await Promise.all(ids.map(async (id) => {
      try {
        await ctx.assertMemory(id, { signal });
        return id;
      } catch (error) {
        if (memoryErrorStatus(error) === 404) return undefined;
        throw error;
      }
    }));
    return kept.filter((id): id is string => id !== undefined);
  };

  const assertIngestionInScope = async (id: string, signal?: AbortSignal) => {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PROOF_PAGES; page++) {
      const outputs = await client.listDocumentIngestionOutputs(id, 100, cursor, { signal });
      // One ingestion has one owner, so a handful of checks per page is proof enough; stop at the first that passes.
      for (let i = 0; i < outputs.items.length; i += PROOF_BATCH) {
        if ((await verifyOutputs(outputs.items.slice(i, i + PROOF_BATCH), signal)).length > 0) return;
      }
      cursor = outputs.nextCursor;
      if (cursor === undefined) break;
    }
    fail('Document ingestion has not produced any memories in the configured scope yet.');
  };

  const assertHookScope = () => {
    if (scope.sessionId !== undefined && !hasResourceScope) {
      fail('Ingestion hook statuses are store-wide, so they are unavailable when the toolset is scoped only by sessionId.');
    }
    if (scope.namespaceId !== undefined) {
      fail('Ingestion hook statuses carry no namespace, so they are unavailable when the toolset has a fixed namespace.');
    }
  };

  return {
    create_document_ingestion: tool({
      description:
        'Submit one revision of a text or Markdown document for asynchronous extraction into long-term memories. ' +
        'Pass the document as plain text; it is encoded for you. The extractor must be configured for documents. ' +
        'Reuse idempotencyKey only to retry the same submission. Poll get_document_ingestion until processing is terminal. ' +
        'Unavailable when the toolset has a fixed namespace, because extracted memories cannot be placed in it.',
      inputSchema: z.object({
        documentId: s.id.describe('Your stable logical document ID. Case-sensitive.'),
        revision: s.id.describe('Immutable revision token for this version of the document.'),
        content: z.string().min(1).describe('Document text, UTF-8.'),
        mediaType: z.enum(['text/plain', 'text/markdown']),
        extractorId,
        ownerId: s.ownerId.optional().describe('Owner of the extracted memories. Required unless the toolset has a fixed scope.userId.'),
        idempotencyKey: s.id.describe('Key for this submission. Required.'),
      }),
      execute: async ({ content, ownerId, ...input }, { abortSignal }) => {
        if (scope.namespaceId !== undefined) fail('Document ingestion cannot be placed in the configured namespace.');
        const result = await client.createDocumentIngestion(
          { ...input, content: toBase64(content), ownerId: ctx.resolveOwner(ownerId) },
          { signal: abortSignal },
        );
        submitted.add(result.result.ingestionId);
        return result.result;
      },
    }),

    get_document_ingestion: tool({
      description:
        'Read the status of a document ingestion: processing state (QUEUED, RUNNING, SUCCEEDED, FAILED, PARTIAL), ' +
        'cleanup state, chunk progress, created and filtered memory counts, and any error. ' +
        SCOPED_READ_RULE,
      inputSchema: z.object({ ingestionId }),
      execute: async ({ ingestionId: id }, { abortSignal }) => {
        const result = await client.getDocumentIngestion(id, { signal: abortSignal });
        if (hasResourceScope && !submitted.has(id)) await assertIngestionInScope(id, abortSignal);
        return result;
      },
    }),

    list_document_ingestion_outputs: tool({
      description:
        'List the IDs of long-term memories a document ingestion created. Wait for a terminal processing state first. ' +
        'Reuse nextCursor to fetch another page. A page can be empty while nextCursor is present. ' +
        SCOPED_READ_RULE,
      inputSchema: z.object({ ingestionId, ...s.page }),
      execute: async ({ ingestionId: id, limit, cursor }, { abortSignal }) => {
        const result = await client.listDocumentIngestionOutputs(id, limit, cursor, { signal: abortSignal });
        const items = await verifyOutputs(result.items, abortSignal);
        if (hasResourceScope && items.length === 0 && !submitted.has(id)) await assertIngestionInScope(id, abortSignal);
        return { ...result, items };
      },
    }),

    get_ingestion_hook_status: tool({
      description:
        'Read one ingestion hook decision by the event ID of the write it judged. Shows decision state, apply state, ' +
        'attempts, and applied, filtered, and conflict counts. Use it after a write fails with HTTP 422 (stopped) or 503 (retryable). ' +
        'Earlier writes can have completed before a later failure. ' + HOOK_SCOPE_RULE,
      inputSchema: z.object({ eventId: s.id }),
      execute: async ({ eventId }, { abortSignal }) => {
        assertHookScope();
        const result = await client.getIngestionHookStatus(eventId, { signal: abortSignal });
        if (scope.userId !== undefined && result.status.ownerId !== scope.userId) {
          fail('Ingestion hook status is outside the configured user scope.');
        }
        return result;
      },
    }),

    list_ingestion_hook_statuses: tool({
      description:
        'List recent ingestion hook decisions, newest first. Statuses are kept for seven days. ' +
        'Reuse nextCursor to fetch another page. A page can be empty while nextCursor is present. ' + HOOK_SCOPE_RULE,
      inputSchema: z.object(s.page),
      execute: async ({ limit, cursor }, { abortSignal }) => {
        assertHookScope();
        const result = await client.listIngestionHookStatuses(limit, cursor, { signal: abortSignal });
        if (scope.userId === undefined) return result;
        return { ...result, items: result.items.filter(status => status.ownerId === scope.userId) };
      },
    }),
  };
}
