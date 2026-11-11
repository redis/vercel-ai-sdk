import { tool, type ToolSet } from 'ai';
import type { AgentMemory } from '@redis-iris/agent-memory';
import type { LongTermMemoryFilter, SummaryView, SummaryViewScope } from '@redis-iris/agent-memory/models';
import { z } from 'zod';
import { RedisAgentMemoryToolError } from './errors.js';
import * as s from './schemas.js';
import type { ScopedMemory } from './scoped-memory.js';

export interface SummaryViewToolOptions {
  allowDeletes: boolean;
}

/** read covers the definition, result reads, and partition refreshes; manage covers edits, full refreshes, and deletes. */
type Access = 'none' | 'read' | 'manage';
type ScopedField = 'ownerId' | 'namespaceId';
type FilterInput = NonNullable<z.infer<typeof s.search>['filter']>;

function fail(message: string): never {
  throw new RedisAgentMemoryToolError('INVALID_SCOPE', message);
}

const groupBy = z.array(z.enum(['ownerId', 'sessionId', 'namespaceId', 'memoryType']))
  .max(4)
  .refine(fields => new Set(fields).size === fields.length, 'List each groupBy field once.')
  .describe('One partition per distinct value of these fields. An empty list keeps a single summary.');
const output = z.object({
  format: z.enum(['TEXT', 'STRUCTURED']),
  instructions: z.string().min(1).optional().describe('What the summary should cover.'),
  schema: z.object({
    fields: z.array(z.object({
      name: z.string().min(1),
      description: z.string(),
      type: z.enum(['STRING', 'INTEGER', 'FLOAT', 'BOOLEAN', 'STRING_LIST', 'FLOAT_LIST', 'OBJECT']),
    })).min(1),
  }).optional().describe('Flat field list for STRUCTURED output. Nested schemas and required fields are not supported.'),
}).refine(value => (value.format === 'STRUCTURED') === (value.schema !== undefined),
  'Supply schema exactly when format is STRUCTURED.');
const refreshPolicy = z.object({
  mode: z.enum(['MANUAL', 'CONTINUOUS']),
  debounceSeconds: z.number().int().nonnegative().optional(),
  reconcileIntervalSeconds: z.number().int().positive().optional(),
}).refine(value => value.mode === 'CONTINUOUS'
  ? value.reconcileIntervalSeconds !== undefined
  : value.debounceSeconds === undefined && value.reconcileIntervalSeconds === undefined,
'CONTINUOUS requires reconcileIntervalSeconds. MANUAL omits both interval fields.');
const evictionPolicy = z.object({ maxPartitions: z.number().int().positive() })
  .describe('Keep at most this many partitions.');
const timeWindowSeconds = z.number().int().positive().describe('Only summarize memories from this rolling window.');
const filter = s.search.shape.filter.describe('Long-term memory filter that selects the source memories.');
const partition = z.object({
  ownerId: s.id.optional(), sessionId: s.id.optional(), namespaceId: s.id.optional(), memoryType: s.id.optional(),
}).describe('One value for each groupBy field of the view. Omit for a view without groupBy.');
const viewId = s.id.describe('Summary View ID, such as sv_ followed by 32 hex characters.');

function toFilter(input: FilterInput): LongTermMemoryFilter {
  const { createdAt, ...rest } = input;
  if (createdAt === undefined) return rest;
  return {
    ...rest,
    createdAt: Object.fromEntries(Object.entries(createdAt)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, new Date(value!)])),
  };
}

/** Optional Summary View tools. Scoped toolsets only reach views whose partitions they can prove are theirs. */
export function createSummaryViewTools(
  client: AgentMemory,
  ctx: ScopedMemory,
  options: SummaryViewToolOptions,
): ToolSet {
  const fixed = (['ownerId', 'namespaceId'] as const)
    .map(field => [field, field === 'ownerId' ? ctx.scope.userId : ctx.scope.namespaceId] as const)
    .filter((entry): entry is readonly [ScopedField, string] => entry[1] !== undefined);

  // The view ownerId is the API caller, not the application user, so access is proven from filter and groupBy.
  function access(view: SummaryView): Access {
    if (!ctx.hasResourceScope) return 'manage';
    if (view.visibility !== 'PRIVATE') return 'none';
    const viewFilter: LongTermMemoryFilter = view.filter ?? {};
    const conditions = Object.entries(viewFilter).filter(([key, value]) => key !== 'op' && value !== undefined).length;
    // The service default for op is not documented, so an implicit op only counts when nothing else could be ORed in.
    const conjunctive = viewFilter.op?.toUpperCase() === 'ALL' || (viewFilter.op === undefined && conditions === 1);
    let level: Access = 'manage';
    for (const [field, value] of fixed) {
      const condition = viewFilter[field];
      const pinned = conjunctive && condition?.eq === value
        && Object.values(condition).filter(item => item !== undefined).length === 1;
      if (pinned) continue;
      if (!view.groupBy.includes(field)) return 'none';
      level = 'read';
    }
    return level;
  }

  async function assertView(id: string, needed: Exclude<Access, 'none'>, signal?: AbortSignal): Promise<SummaryView> {
    const view = await client.getSummaryView(id, { signal });
    const level = access(view);
    if (level === 'none') fail('Summary View is outside the configured user or namespace scope.');
    if (needed === 'manage' && level !== 'manage') {
      fail('This Summary View is shared across users or namespaces. Only views whose filter is pinned to the configured scope can be changed.');
    }
    return view;
  }

  function scopeFilter(input?: FilterInput): LongTermMemoryFilter | undefined {
    const converted = input && toFilter(input);
    return ctx.hasResourceScope ? ctx.scopeSearch({ filter: converted }).filter : converted;
  }

  function resolvePartition(view: SummaryView | undefined, input: SummaryViewScope = {}): SummaryViewScope | undefined {
    const resolved = { ...input };
    if (view) {
      for (const [field, value] of fixed) {
        if (resolved[field] !== undefined && resolved[field] !== value) fail(`Cannot reach another ${field} partition.`);
        if (view.groupBy.includes(field)) resolved[field] = value;
      }
    }
    return Object.values(resolved).some(value => value !== undefined) ? resolved : undefined;
  }

  const tools: ToolSet = {
    list_summary_views: tool({
      description:
        'List Summary View definitions and their state. Summary text is not included; use get_summary_view_result for it. ' +
        'Reuse nextCursor to fetch another page. With a fixed user or namespace, only PRIVATE views limited to that user ' +
        'or namespace are listed, so a page can hold fewer items than limit.',
      inputSchema: z.object({ ...s.page }),
      execute: async ({ limit, cursor }, { abortSignal }) => {
        const result = await client.listSummaryViews(limit, cursor, { signal: abortSignal });
        return { ...result, items: result.items.filter(view => access(view) !== 'none') };
      },
    }),

    get_summary_view: tool({
      description:
        'Get one Summary View definition with its filter, groupBy, output, refresh policy, state, and definitionVersion. ' +
        'With a fixed user or namespace, views outside that user or namespace are refused.',
      inputSchema: z.object({ viewId }),
      execute: ({ viewId: id }, { abortSignal }) => assertView(id, 'read', abortSignal),
    }),

    create_summary_view: tool({
      description:
        'Create a Summary View that keeps a generated summary of matching long-term memories. ' +
        'groupBy splits it into one partition per value of each listed field. TEXT output writes prose. ' +
        'STRUCTURED output fills the fields in output.schema. MANUAL views refresh only through refresh_summary_view. ' +
        'CONTINUOUS views refresh on their own and reconcile every reconcileIntervalSeconds. ' +
        'The first refresh runs asynchronously. PRIVATE (the default) keeps the view to this API caller. ' +
        'SHARED publishes a view of shared memories to every store-authorized caller. ' +
        'With a fixed user or namespace, the view is always PRIVATE, SHARED is refused, and the filter is pinned to that ' +
        'user and namespace, so groupBy cannot reach other memories.',
      inputSchema: z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        visibility: z.enum(['PRIVATE', 'SHARED']).optional().describe('Immutable after creation.'),
        filter,
        groupBy,
        evictionPolicy: evictionPolicy.optional(),
        timeWindowSeconds: timeWindowSeconds.optional(),
        output,
        refreshPolicy,
      }),
      execute: async ({ visibility, filter: input, ...request }, { abortSignal }) => {
        if (ctx.hasResourceScope && visibility === 'SHARED') {
          fail('A toolset with a fixed user or namespace can only create PRIVATE Summary Views.');
        }
        return client.createSummaryView({
          ...request,
          source: 'LONG_TERM',
          visibility: ctx.hasResourceScope ? 'PRIVATE' : visibility,
          filter: scopeFilter(input),
        }, { signal: abortSignal });
      },
    }),

    update_summary_view: tool({
      description:
        'Change a Summary View. Source and visibility cannot change. Changes to filter, groupBy, time window, eviction, ' +
        'output, or refresh policy increment definitionVersion and refresh the view. Name and description changes do not. ' +
        'state switches the view between ACTIVE and DISABLED. filter and clearFilter cannot be combined, nor can ' +
        'timeWindowSeconds and clearTimeWindow. With a fixed user or namespace, only views whose filter is pinned to that ' +
        'user and namespace can change, a new filter is pinned the same way, and clearFilter is refused.',
      inputSchema: z.object({
        viewId,
        name: z.string().min(1).optional(),
        description: z.string().optional().describe('Send an empty string to clear it.'),
        filter: filter.describe('Replaces the saved filter.'),
        clearFilter: z.boolean().optional(),
        groupBy: groupBy.optional(),
        evictionPolicy: evictionPolicy.optional(),
        timeWindowSeconds: timeWindowSeconds.optional(),
        clearTimeWindow: z.boolean().optional(),
        output: output.optional(),
        refreshPolicy: refreshPolicy.optional(),
        state: z.enum(['ACTIVE', 'DISABLED']).optional(),
      }),
      execute: async ({ viewId: id, filter: input, ...changes }, { abortSignal }) => {
        if (input === undefined && !Object.values(changes).some(value => value !== undefined)) fail('Supply at least one change.');
        if (ctx.hasResourceScope) {
          if (changes.clearFilter) fail('Cannot clear the filter that keeps this view inside the configured scope.');
          await assertView(id, 'manage', abortSignal);
        }
        return client.updateSummaryView(id, {
          ...changes,
          filter: input === undefined ? undefined : scopeFilter(input),
        }, { signal: abortSignal });
      },
    }),

    refresh_summary_view: tool({
      description:
        'Queue a Summary View refresh. It runs asynchronously, so read the result later and check its status. ' +
        'PARTITION refreshes one exact partition. FULL reconciles every partition and takes no partition. ' +
        'With a fixed user or namespace, the partition is filled in with that user and namespace, other values are refused, ' +
        'and FULL is allowed only on views whose filter is pinned to that user and namespace.',
      inputSchema: z.object({ viewId, target: z.enum(['PARTITION', 'FULL']), partition: partition.optional() }),
      execute: async ({ viewId: id, target, partition: input }, { abortSignal }) => {
        if (target === 'FULL' && input !== undefined) fail('A FULL refresh takes no partition.');
        const view = ctx.hasResourceScope
          ? await assertView(id, target === 'FULL' ? 'manage' : 'read', abortSignal)
          : undefined;
        return client.refreshSummaryView(id, {
          target,
          scope: target === 'PARTITION' ? resolvePartition(view, input) : undefined,
        }, { signal: abortSignal });
      },
    }),

    get_summary_view_result: tool({
      description:
        'Read the generated summary for one exact partition of a Summary View. Check status before using value. ' +
        'COLD, PENDING, and EMPTY have no value. READY and REFRESHING carry a value. FAILED keeps the last good value ' +
        'when one exists and reports errorCode. stale means the value lags its sources. truncated means some memories ' +
        'or content were left out. Invalid output is withheld while the service repairs it. ' +
        'With a fixed user or namespace, the partition is filled in with that user and namespace and other values are refused.',
      inputSchema: z.object({
        viewId,
        partition: partition.optional(),
        includeSourceMemoryIds: z.boolean().optional().describe('Also return the IDs of the summarized memories.'),
      }),
      execute: async ({ viewId: id, partition: input, includeSourceMemoryIds }, { abortSignal }) => {
        const view = ctx.hasResourceScope ? await assertView(id, 'read', abortSignal) : undefined;
        const resolved = resolvePartition(view, input) ?? {};
        return client.getSummaryViewResult(
          id, resolved.ownerId, resolved.sessionId, resolved.namespaceId, resolved.memoryType,
          includeSourceMemoryIds, { signal: abortSignal },
        );
      },
    }),
  };

  if (options.allowDeletes) {
    tools.delete_summary_view = tool({
      description:
        'Delete a Summary View on the user\'s explicit request. Deletion is asynchronous and safe to repeat. ' +
        'The view enters DELETING and its schedule and materialized summaries are removed. ' +
        'With a fixed user or namespace, only views whose filter is pinned to that user and namespace can be deleted.',
      inputSchema: z.object({ viewId }),
      execute: async ({ viewId: id }, { abortSignal }) => {
        if (ctx.hasResourceScope) await assertView(id, 'manage', abortSignal);
        return client.deleteSummaryView(id, { signal: abortSignal });
      },
    });
  }

  return tools;
}
