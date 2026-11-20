import { currentViewer, isStaleTab, staleTabResponse } from '@/lib/auth';
import { getMemoryClient } from '@/lib/memory';
import { ENVIRONMENT_TYPE, mergeEnvironment } from '@/lib/environment';
import type { KnownFact } from '@/lib/types';

// "What the agent knows about you": the signed-in customer's long-term memories,
// newest first. The owner filter comes from the server-side session, so one
// customer can never list another's memories.
export async function GET(request: Request) {
  const viewer = await currentViewer();
  if (!viewer) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  if (isStaleTab(request, viewer)) return staleTabResponse();

  try {
    const result = await getMemoryClient().searchLongTermMemory({
      filter: { ownerId: { eq: viewer.userId } },
      sortBy: 'updatedAt',
      sortOrder: 'DESC',
      limit: 50,
    });
    const all: KnownFact[] = result.items
      // Defense in depth: never render a record that isn't this viewer's.
      .filter(item => item.ownerId === viewer.userId)
      .map(item => ({
        id: item.memoryId,
        text: item.text,
        type: item.memoryType ?? 'semantic',
        topics: item.topics ?? [],
        createdAt: item.createdAt.toISOString(),
        fromThisConversation: item.sessionId === viewer.sessionId,
        ...(item.attributes ? { attributes: item.attributes } : {}),
      }));
    // Extraction also stores notes about the agent's own earlier replies
    // ("Assistant recommended…"). Keep the panel to facts about the customer,
    // and report how many notes were left out.
    const aboutAssistant = (fact: KnownFact) => /^(The )?assistant\b/i.test(fact.text);
    const visible = all.filter(fact => !aboutAssistant(fact));
    const hiddenAssistantNotes = all.length - visible.length;

    // Extraction writes one customer_environment record per detail (SDK,
    // runtime, keep-alive…). Show them as one record, newest value first.
    const environment = visible.filter(fact => fact.type === ENVIRONMENT_TYPE);
    const others = visible.filter(fact => fact.type !== ENVIRONMENT_TYPE);
    const facts: KnownFact[] = environment.length === 0 ? others : [{
      ...environment[0],
      id: environment.map(fact => fact.id).join('+'),
      text: environment.map(fact => fact.text).join(' '),
      attributes: mergeEnvironment(environment),
      fromThisConversation: environment.some(fact => fact.fromThisConversation),
      mergedIds: environment.map(fact => fact.id),
    }, ...others];
    return Response.json({ facts, hiddenAssistantNotes });
  } catch (error) {
    console.error('[memories] list failed', error instanceof Error ? error.message : error);
    return Response.json({ error: 'Could not load memories.' }, { status: 502 });
  }
}
