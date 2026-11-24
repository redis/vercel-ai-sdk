import type { UIMessage } from 'ai';

/** What Agent Memory did on one turn, summarized for the UI. */
export interface MemoryTrace {
  restoredEvents: number;
  recalledMemories: number;
  searchOutcome: string;
  injected: number;
  userRecorded: boolean;
  assistantRecorded: boolean;
  /** Long-term memories that were included in the prompt for this reply. */
  usedMemoryIds?: string[];
}

export type SupportMessage = UIMessage<{ memory: MemoryTrace | null }>;

export interface KnownFact {
  id: string;
  text: string;
  type: string;
  topics: string[];
  createdAt: string;
  fromThisConversation: boolean;
  /** Structured fields, for records of a custom memory type. */
  attributes?: Record<string, unknown>;
  /** For a merged customer_environment record: the IDs of the records it combines. */
  mergedIds?: string[];
}

/** Header each page sends with the conversation it was rendered for (see isStaleTab in lib/auth.ts). */
export const PAGE_SESSION_HEADER = 'x-waypoint-session';
