import { z } from 'zod';

export const id = z.string().min(1).max(255);
export const sessionId = z.string().min(1).max(64).regex(/^[A-Za-z0-9-]+$/);
export const memoryId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
export const ownerId =sessionId.describe('Stable application user identifier. Reuse it across conversations.');
export const timestamp = z.iso.datetime({ offset: true });
export const text = z.string().min(1).max(50_000);
export const topics = z.array(z.string().min(1).max(100)).max(50);
export const placement = { namespaceId: id.optional() };
export const page = { limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional() };
export const idempotencyKey = z.string().min(1).max(255).describe(
  'Retry key. Reuse it only with the identical request to replay the saved result for up to 24 hours. ' +
  'Required when the store selects an input hook.');
export const sessionIdempotencyKey = z.string().min(1).max(255).describe(
  'Required when the store selects an input hook. The store may not deduplicate session events by this key, ' +
  'so after an uncertain append read get_session_memory before retrying.');
export const expectedRevision = z.string().min(1).describe(
  'Apply the write only if the memory still has this revision. Read it from get_memory. A stale revision fails with HTTP 412.');
export const sortOrder = z.enum(['ASC', 'DESC']);
export const attributes = z.record(z.string(), z.unknown());
export const event = z.object({
  sessionId: sessionId.optional().describe('Reuse the current session ID. Omit only to create a new session.'),
  actorId: id.describe('Author of this event: user ID for USER, agent ID for ASSISTANT.'),
  role: z.enum(['USER', 'ASSISTANT', 'SYSTEM']),
  content: z.array(z.object({ text })).min(1),
  createdAt: timestamp.optional().describe('ISO 8601 timestamp; defaults to the current time.'),
  metadata: z.unknown().optional().describe('Optional JSON metadata attached to the event.'),
  idempotencyKey: sessionIdempotencyKey.optional(),
  ...placement,
});
export const memory = z.object({
  text,
  ownerId: ownerId.optional().describe('Memory owner’s user ID. Required unless the toolset has a fixed scope.userId.'),
  sessionId: sessionId.optional(),
  memoryType: z.string().min(1).optional().describe('Built-in or registered custom memory type.'),
  topics: topics.optional(),
  attributes: attributes.optional(),
  ...placement,
});
export const memoryUpdate = z.object({
  text: text.optional(), memoryType: z.string().min(1).optional(), topics: topics.optional(),
  ownerId: ownerId.optional(), sessionId: z.union([sessionId, z.literal('')]).optional(), ...placement,
});
const comparison = z.object({
  eq: z.string().optional(), ne: z.string().optional(),
  in: z.array(z.string()).min(1).optional(), all: z.array(z.string()).min(1).optional(),
}).refine(value => Object.values(value).filter(v => v !== undefined).length === 1,
  'Supply exactly one of eq, ne, in, all.');
export const search = z.object({
  query: text.optional(), minScore: z.number().min(0).max(1).optional(), ...page,
  sortBy: z.enum(['createdAt', 'updatedAt']).optional().describe('Order a filter-only listing. Omit query when sorting.'),
  sortOrder: sortOrder.optional().describe('Order a filter-only listing. Omit query when sorting.'),
  excludeDocumentManaged: z.boolean().optional().describe('Omit memories produced by document ingestion.'),
  filter: z.object({
    op: z.enum(['ALL', 'ANY']).optional(),
    sessionId: comparison.optional(), ownerId: comparison.optional(),
    topics: comparison.optional(), memoryType: comparison.optional(),
    namespaceId: z.object({ eq: id.optional(), in: z.array(id).min(1).optional() })
      .refine(v => (v.eq === undefined) !== (v.in === undefined), 'Supply exactly one of eq or in.').optional(),
    unnamespaced: z.boolean().optional(),
    createdAt: z.object({ gt: timestamp.optional(), gte: timestamp.optional(), lt: timestamp.optional(),
      lte: timestamp.optional(), eq: timestamp.optional() }).optional(),
    attributes: z.record(z.string(), z.union([
      z.object({ string: z.string() }).strict(), z.object({ number: z.number() }).strict(),
      z.object({ boolean: z.boolean() }).strict(), z.object({ list: z.array(z.string()) }).strict(),
    ])).optional(),
  }).optional(),
});
