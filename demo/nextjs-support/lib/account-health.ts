import type { LongTermMemoryFilter } from '@redis-iris/agent-memory/models';
import { customerByMemoryUserId, type Customer } from './customers.ts';
import { ENVIRONMENT_TYPE, KEEP_ALIVE_OFF, mergeEnvironment } from './environment.ts';
import { getMemoryClient } from './memory.ts';

export type HealthView = 'keep-alive-off' | 'all';

export interface HealthRow {
  customer: Customer;
  attributes: Record<string, unknown>;
  updatedAt: string;
}

/**
 * The query behind the "Account health" view: structured memories extracted
 * from support conversations, filtered by a typed field, across customers.
 * Staff only. Never expose a cross-customer query to a customer session.
 */
export function healthFilter(view: HealthView, ownerIds: string[]): LongTermMemoryFilter {
  return {
    ownerId: { in: ownerIds },
    memoryType: { eq: ENVIRONMENT_TYPE },
    ...(view === 'keep-alive-off' ? { attributes: { keep_alive_enabled: { string: KEEP_ALIVE_OFF } } } : {}),
  };
}

export async function accountHealth(view: HealthView): Promise<{ rows: HealthRow[]; filter: LongTermMemoryFilter }> {
  const owners = customerByMemoryUserId();
  // Restrict to this run's customers, so old rehearsals and other apps sharing
  // the store don't show up.
  const filter = healthFilter(view, [...owners.keys()]);
  const client = getMemoryClient();

  // 1. The filtered query: which customers match?
  const matches = await client.searchLongTermMemory({ filter, sortBy: 'updatedAt', sortOrder: 'DESC', limit: 100 });
  const matchedOwners = [...new Set(matches.items.map(item => item.ownerId).filter((id): id is string => !!id && owners.has(id)))];
  if (matchedOwners.length === 0) return { rows: [], filter };

  // 2. Extraction writes one record per detail (SDK, runtime, keep-alive…), so
  //    load each matching customer's full setup and merge it, newest value first.
  const { items } = view === 'all' ? matches : await client.searchLongTermMemory({
    filter: { ownerId: { in: matchedOwners }, memoryType: { eq: ENVIRONMENT_TYPE } },
    sortBy: 'updatedAt', sortOrder: 'DESC', limit: 100,
  });
  const rows = matchedOwners.map(ownerId => {
    const records = items.filter(item => item.ownerId === ownerId);
    return {
      customer: owners.get(ownerId)!,
      attributes: mergeEnvironment(records),
      updatedAt: (records[0]?.updatedAt ?? new Date()).toISOString(),
    };
  });
  return { rows, filter };
}
