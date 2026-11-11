import type { AgentMemory } from '@redis-iris/agent-memory';
import type { SummaryView } from '@redis-iris/agent-memory/models';
import type { ToolSet } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { createScopedMemory, type RedisAgentMemoryScope } from '../src/scoped-memory.js';
import { createSummaryViewTools } from '../src/summary-views.js';

const now = new Date('2026-09-25T12:00:00Z');
const textOutput = { format: 'TEXT', instructions: 'Summarize preferences.' };
const manual = { mode: 'MANUAL' };

function view(overrides: Partial<SummaryView> = {}): SummaryView {
  return {
    viewId: 'sv-1', ownerId: 'api-caller', visibility: 'PRIVATE', name: 'Preferences', source: 'LONG_TERM',
    groupBy: [], output: { format: 'TEXT' }, refreshPolicy: { mode: 'MANUAL' }, definitionVersion: 1,
    state: 'ACTIVE', createdAt: now, updatedAt: now, ...overrides,
  };
}

const pinnedToUser = view({ viewId: 'pinned', filter: { ownerId: { eq: 'user-1' } } });
const groupedByOwner = view({ viewId: 'grouped', groupBy: ['ownerId'] });
const otherOwner = view({ viewId: 'other', filter: { ownerId: { eq: 'user-2' } } });
const shared = view({ viewId: 'shared', visibility: 'SHARED', filter: { ownerId: { eq: 'user-1' } } });
const sharedByOwner = view({ viewId: 'shared-grouped', visibility: 'SHARED', groupBy: ['ownerId'] });
const sharedUnscoped = view({ viewId: 'shared-hidden', visibility: 'SHARED', groupBy: ['sessionId'] });

function setup(scope: RedisAgentMemoryScope = {}, records: SummaryView[] = [], allowDeletes = true) {
  const stored = new Map(records.map(record => [record.viewId, record]));
  const client = {
    listSummaryViews: vi.fn(async (..._args: unknown[]) => ({ items: records, nextCursor: 'next' })),
    getSummaryView: vi.fn(async (id: string, _options?: unknown) => {
      const record = stored.get(id);
      if (!record) throw new Error(`Missing fixture view ${id}`);
      return record;
    }),
    createSummaryView: vi.fn(async (body: Record<string, unknown>, _options?: unknown) => view(body)),
    updateSummaryView: vi.fn(async (id: string, body: Record<string, unknown>, _options?: unknown) => view({ viewId: id, ...body })),
    refreshSummaryView: vi.fn(async (id: string, body: { target: string }, _options?: unknown) => ({ viewId: id, target: body.target, accepted: true })),
    getSummaryViewResult: vi.fn(async (id: string, ..._args: unknown[]) => ({ viewId: id, status: 'READY' })),
    deleteSummaryView: vi.fn(async (id: string, _options?: unknown) => ({ viewId: id, state: 'DELETING' })),
  };
  const memory = client as unknown as AgentMemory;
  const tools = createSummaryViewTools(memory, createScopedMemory(memory, scope), { allowDeletes });
  return { tools, client };
}

async function run(tools: ToolSet, name: string, input: unknown): Promise<any> {
  const definition = tools[name];
  if (!definition?.execute) throw new Error(`Missing tool: ${name}`);
  const schema = definition.inputSchema as { parseAsync(value: unknown): Promise<unknown> };
  return definition.execute(await schema.parseAsync(input), { toolCallId: 'summary-view-test', messages: [], context: {} });
}

const scopeRefusal = { code: 'INVALID_SCOPE' };
const createInput = { name: 'Preferences', groupBy: [], output: textOutput, refreshPolicy: manual };

describe('create_summary_view', () => {
  it('passes an unscoped request through with the long-term source and parsed dates', async () => {
    const { tools, client } = setup();
    await run(tools, 'create_summary_view', {
      ...createInput, visibility: 'SHARED', groupBy: ['namespaceId'],
      filter: { createdAt: { gte: '2026-01-01T00:00:00Z' } },
    });
    expect(client.createSummaryView.mock.calls[0]![0]).toEqual({
      ...createInput, groupBy: ['namespaceId'], source: 'LONG_TERM', visibility: 'SHARED',
      filter: { createdAt: { gte: new Date('2026-01-01T00:00:00Z') } },
    });
  });

  it('forces a private view pinned to the fixed user', async () => {
    const { tools, client } = setup({ userId: 'user-1' });
    await run(tools, 'create_summary_view', { ...createInput, groupBy: ['sessionId'], filter: { topics: { eq: 'food' } } });
    expect(client.createSummaryView.mock.calls[0]![0]).toMatchObject({
      visibility: 'PRIVATE', groupBy: ['sessionId'],
      filter: { op: 'ALL', ownerId: { eq: 'user-1' }, topics: { eq: 'food' } },
    });
  });

  it('pins the fixed namespace and refuses unnamespaced sources', async () => {
    const { tools, client } = setup({ namespaceId: 'ns-1' });
    await run(tools, 'create_summary_view', createInput);
    expect(client.createSummaryView.mock.calls[0]![0]).toMatchObject({
      visibility: 'PRIVATE', filter: { op: 'ALL', namespaceId: { eq: 'ns-1' } },
    });
    await expect(run(tools, 'create_summary_view', { ...createInput, filter: { unnamespaced: true } })).rejects.toMatchObject(scopeRefusal);
    expect(client.createSummaryView).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a SHARED view', { visibility: 'SHARED' }],
    ['another owner', { filter: { ownerId: { eq: 'user-2' } } }],
    ['a widened owner filter', { filter: { ownerId: { in: ['user-1', 'user-2'] } } }],
    ['an ANY filter', { filter: { op: 'ANY', topics: { eq: 'food' } } }],
  ])('refuses %s for a fixed user', async (_label, overrides) => {
    const { tools, client } = setup({ userId: 'user-1' });
    await expect(run(tools, 'create_summary_view', { ...createInput, ...overrides })).rejects.toMatchObject(scopeRefusal);
    expect(client.createSummaryView).not.toHaveBeenCalled();
  });

  it('rejects structured output without a schema and continuous refresh without an interval', async () => {
    const { tools } = setup();
    await expect(run(tools, 'create_summary_view', { ...createInput, output: { format: 'STRUCTURED' } }))
      .rejects.toThrow('Supply schema exactly when format is STRUCTURED.');
    await expect(run(tools, 'create_summary_view', { ...createInput, refreshPolicy: { mode: 'CONTINUOUS' } }))
      .rejects.toThrow('CONTINUOUS requires reconcileIntervalSeconds.');
    await expect(run(tools, 'create_summary_view', {
      ...createInput, refreshPolicy: { mode: 'MANUAL', reconcileIntervalSeconds: 60 },
    })).rejects.toThrow('MANUAL omits both interval fields.');
  });
});

describe('summary view visibility under a fixed scope', () => {
  const unpinned = view({ viewId: 'unpinned', groupBy: ['sessionId'] });
  const anyOp = view({ viewId: 'any', filter: { op: 'ANY', ownerId: { eq: 'user-1' }, topics: { eq: 'food' } } });
  const implicitOp = view({ viewId: 'implicit', filter: { ownerId: { eq: 'user-1' }, topics: { eq: 'food' } } });
  const explicitAll = view({ viewId: 'all', filter: { op: 'ALL', ownerId: { eq: 'user-1' }, topics: { eq: 'food' } } });
  const records = [
    pinnedToUser, groupedByOwner, otherOwner, shared, unpinned, anyOp, implicitOp, explicitAll, sharedByOwner, sharedUnscoped,
  ];

  it('lists only views limited to the fixed user and keeps the cursor', async () => {
    const { tools, client } = setup({ userId: 'user-1' }, records);
    const result = await run(tools, 'list_summary_views', { limit: 10, cursor: 'page-2' });
    expect(result.items.map((item: SummaryView) => item.viewId)).toEqual(['pinned', 'grouped', 'shared', 'all', 'shared-grouped']);
    expect(result.nextCursor).toBe('next');
    expect(client.listSummaryViews.mock.calls[0]!.slice(0, 2)).toEqual([10, 'page-2']);
  });

  it('lists every view without a fixed scope', async () => {
    const { tools } = setup({}, records);
    expect((await run(tools, 'list_summary_views', {})).items).toHaveLength(records.length);
  });

  it.each(['other', 'unpinned', 'any', 'implicit', 'shared-hidden'])('refuses to get view %s', async (viewId) => {
    const { tools } = setup({ userId: 'user-1' }, records);
    await expect(run(tools, 'get_summary_view', { viewId })).rejects.toMatchObject(scopeRefusal);
  });

  it('gets a SHARED view the fixed user can read', async () => {
    const { tools } = setup({ userId: 'user-1' }, records);
    expect(await run(tools, 'get_summary_view', { viewId: 'shared' })).toEqual(shared);
    expect(await run(tools, 'get_summary_view', { viewId: 'shared-grouped' })).toEqual(sharedByOwner);
  });

  it('keeps every SHARED view out of reach of changes, refreshes, and deletes', async () => {
    const { tools, client } = setup({ userId: 'user-1' }, [shared, sharedByOwner]);
    for (const viewId of ['shared', 'shared-grouped']) {
      await expect(run(tools, 'update_summary_view', { viewId, name: 'Renamed' })).rejects.toMatchObject(scopeRefusal);
      await expect(run(tools, 'refresh_summary_view', { viewId, target: 'FULL' })).rejects.toMatchObject(scopeRefusal);
      await expect(run(tools, 'refresh_summary_view', { viewId, target: 'PARTITION' })).rejects.toMatchObject(scopeRefusal);
      await expect(run(tools, 'delete_summary_view', { viewId })).rejects.toMatchObject(scopeRefusal);
    }
    expect(client.updateSummaryView).not.toHaveBeenCalled();
    expect(client.refreshSummaryView).not.toHaveBeenCalled();
    expect(client.deleteSummaryView).not.toHaveBeenCalled();
  });

  it('requires both fixed fields to be pinned or grouped', async () => {
    const userOnly = view({ viewId: 'user-only', filter: { ownerId: { eq: 'user-1' } } });
    const both = view({ viewId: 'both', filter: { op: 'ALL', ownerId: { eq: 'user-1' }, namespaceId: { eq: 'ns-1' } } });
    const { tools } = setup({ userId: 'user-1', namespaceId: 'ns-1' }, [userOnly, both]);
    await expect(run(tools, 'get_summary_view', { viewId: 'user-only' })).rejects.toMatchObject(scopeRefusal);
    expect(await run(tools, 'get_summary_view', { viewId: 'both' })).toEqual(both);
  });
});

describe('get_summary_view_result', () => {
  it('fills the fixed owner into a grouped partition', async () => {
    const { tools, client } = setup({ userId: 'user-1' }, [groupedByOwner]);
    await run(tools, 'get_summary_view_result', { viewId: 'grouped', includeSourceMemoryIds: true });
    expect(client.getSummaryViewResult.mock.calls[0]!.slice(0, 6))
      .toEqual(['grouped', 'user-1', undefined, undefined, undefined, true]);
  });

  it('refuses another owner partition', async () => {
    const { tools, client } = setup({ userId: 'user-1' }, [groupedByOwner]);
    await expect(run(tools, 'get_summary_view_result', { viewId: 'grouped', partition: { ownerId: 'user-2' } })).rejects.toMatchObject(scopeRefusal);
    expect(client.getSummaryViewResult).not.toHaveBeenCalled();
  });

  it('does not add an owner the view does not group by', async () => {
    const { tools, client } = setup({ userId: 'user-1' }, [pinnedToUser]);
    await run(tools, 'get_summary_view_result', { viewId: 'pinned' });
    expect(client.getSummaryViewResult.mock.calls[0]!.slice(0, 5)).toEqual(['pinned', undefined, undefined, undefined, undefined]);
  });

  it('fills the fixed namespace into a namespace-grouped partition', async () => {
    const byNamespace = view({ viewId: 'by-ns', groupBy: ['namespaceId', 'memoryType'] });
    const { tools, client } = setup({ namespaceId: 'ns-1' }, [byNamespace]);
    await run(tools, 'get_summary_view_result', { viewId: 'by-ns', partition: { memoryType: 'semantic' } });
    expect(client.getSummaryViewResult.mock.calls[0]!.slice(0, 5)).toEqual(['by-ns', undefined, undefined, 'ns-1', 'semantic']);
  });

  it('forces the fixed owner partition on a SHARED view grouped by owner', async () => {
    const { tools, client } = setup({ userId: 'user-1' }, [sharedByOwner]);
    await run(tools, 'get_summary_view_result', { viewId: 'shared-grouped' });
    expect(client.getSummaryViewResult.mock.calls[0]!.slice(0, 5))
      .toEqual(['shared-grouped', 'user-1', undefined, undefined, undefined]);
    await expect(run(tools, 'get_summary_view_result', {
      viewId: 'shared-grouped', partition: { ownerId: 'user-2' },
    })).rejects.toMatchObject(scopeRefusal);
    expect(client.getSummaryViewResult).toHaveBeenCalledTimes(1);
  });

  it('refuses a SHARED view with a fixed field neither pinned nor grouped', async () => {
    const { tools, client } = setup({ userId: 'user-1' }, [sharedUnscoped]);
    await expect(run(tools, 'get_summary_view_result', { viewId: 'shared-hidden' })).rejects.toMatchObject(scopeRefusal);
    expect(client.getSummaryViewResult).not.toHaveBeenCalled();
  });

  it('refuses a view outside the fixed owner', async () => {
    const { tools, client } = setup({ userId: 'user-1' }, [otherOwner]);
    await expect(run(tools, 'get_summary_view_result', { viewId: 'other', partition: { ownerId: 'user-1' } })).rejects.toMatchObject(scopeRefusal);
    expect(client.getSummaryViewResult).not.toHaveBeenCalled();
  });
});

describe('update_summary_view', () => {
  it('pins a replacement filter on a view the fixed user owns', async () => {
    const { tools, client } = setup({ userId: 'user-1' }, [pinnedToUser]);
    await run(tools, 'update_summary_view', { viewId: 'pinned', filter: { topics: { eq: 'travel' } }, state: 'DISABLED' });
    expect(client.updateSummaryView.mock.calls[0]!.slice(0, 2)).toEqual(['pinned', {
      state: 'DISABLED', filter: { op: 'ALL', ownerId: { eq: 'user-1' }, topics: { eq: 'travel' } },
    }]);
  });

  it('keeps the saved filter when none is supplied', async () => {
    const { tools, client } = setup({ userId: 'user-1' }, [pinnedToUser]);
    await run(tools, 'update_summary_view', { viewId: 'pinned', groupBy: ['ownerId', 'sessionId'] });
    expect(client.updateSummaryView.mock.calls[0]![1]).toEqual({ groupBy: ['ownerId', 'sessionId'] });
  });

  it.each([
    ['a view shared across owners', { viewId: 'grouped', name: 'Renamed' }],
    ['clearing the filter', { viewId: 'pinned', clearFilter: true }],
    ['another owner filter', { viewId: 'pinned', filter: { ownerId: { eq: 'user-2' } } }],
    ['an empty change', { viewId: 'pinned' }],
  ])('refuses %s', async (_label, input) => {
    const { tools, client } = setup({ userId: 'user-1' }, [pinnedToUser, groupedByOwner]);
    await expect(run(tools, 'update_summary_view', input)).rejects.toMatchObject(scopeRefusal);
    expect(client.updateSummaryView).not.toHaveBeenCalled();
  });

  it('allows clearing the filter without a fixed scope', async () => {
    const { tools, client } = setup();
    await run(tools, 'update_summary_view', { viewId: 'any', clearFilter: true });
    expect(client.getSummaryView).not.toHaveBeenCalled();
    expect(client.updateSummaryView.mock.calls[0]![1]).toEqual({ clearFilter: true });
  });
});

describe('refresh_summary_view', () => {
  it('fills the fixed owner into a partition refresh', async () => {
    const { tools, client } = setup({ userId: 'user-1' }, [groupedByOwner]);
    await run(tools, 'refresh_summary_view', { viewId: 'grouped', target: 'PARTITION' });
    expect(client.refreshSummaryView.mock.calls[0]!.slice(0, 2))
      .toEqual(['grouped', { target: 'PARTITION', scope: { ownerId: 'user-1' } }]);
  });

  it('refuses a full refresh of a view shared across owners', async () => {
    const { tools, client } = setup({ userId: 'user-1' }, [groupedByOwner]);
    await expect(run(tools, 'refresh_summary_view', { viewId: 'grouped', target: 'FULL' })).rejects.toMatchObject(scopeRefusal);
    expect(client.refreshSummaryView).not.toHaveBeenCalled();
  });

  it('allows a full refresh of a view the fixed user owns', async () => {
    const { tools, client } = setup({ userId: 'user-1' }, [pinnedToUser]);
    await run(tools, 'refresh_summary_view', { viewId: 'pinned', target: 'FULL' });
    expect(client.refreshSummaryView.mock.calls[0]!.slice(0, 2)).toEqual(['pinned', { target: 'FULL', scope: undefined }]);
  });

  it('refuses a partition with a full refresh and another owner partition', async () => {
    const { tools, client } = setup({ userId: 'user-1' }, [pinnedToUser, groupedByOwner]);
    await expect(run(tools, 'refresh_summary_view', { viewId: 'pinned', target: 'FULL', partition: {} })).rejects.toMatchObject(scopeRefusal);
    await expect(run(tools, 'refresh_summary_view', {
      viewId: 'grouped', target: 'PARTITION', partition: { ownerId: 'user-2' },
    })).rejects.toMatchObject(scopeRefusal);
    expect(client.refreshSummaryView).not.toHaveBeenCalled();
  });
});

describe('delete_summary_view', () => {
  it('is only offered with allowDeletes', () => {
    expect(setup({}, [], false).tools.delete_summary_view).toBeUndefined();
    expect(Object.keys(setup().tools).sort()).toEqual([
      'create_summary_view', 'delete_summary_view', 'get_summary_view', 'get_summary_view_result',
      'list_summary_views', 'refresh_summary_view', 'update_summary_view',
    ]);
  });

  it('deletes a view the fixed user owns and refuses a view shared across owners', async () => {
    const { tools, client } = setup({ userId: 'user-1' }, [pinnedToUser, groupedByOwner]);
    expect(await run(tools, 'delete_summary_view', { viewId: 'pinned' })).toEqual({ viewId: 'pinned', state: 'DELETING' });
    await expect(run(tools, 'delete_summary_view', { viewId: 'grouped' })).rejects.toMatchObject(scopeRefusal);
    expect(client.deleteSummaryView.mock.calls.map(([id]) => id)).toEqual(['pinned']);
  });
});
