import { anthropic } from '@ai-sdk/anthropic';
import { streamText, type UIMessage } from 'ai';
import type { RedisAgentMemoryDiagnostic } from '@redis/vercel-ai-sdk';
import { z } from 'zod';
import { currentViewer, isStaleTab, staleTabResponse } from '@/lib/auth';
import { ASSISTANT_ID, acquireSessionLock, getMemory, modelName } from '@/lib/memory';
import { supportSystemPrompt } from '@/lib/product';
import type { MemoryTrace, SupportMessage } from '@/lib/types';

export const maxDuration = 60;

// The client sends only the newest message. Agent Memory restores the rest of
// the conversation, so there's no history array to trust, trim, or replay.
const body = z.object({
  message: z.object({
    role: z.literal('user'),
    parts: z.array(z.object({ type: z.string(), text: z.string().optional() }).loose()),
  }).loose(),
  memory: z.boolean(),
});

function textOf(message: Pick<UIMessage, 'parts'>): string {
  return message.parts
    .flatMap(part => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
    .join('\n')
    .trim();
}

function summarize(events: RedisAgentMemoryDiagnostic[]): Omit<MemoryTrace, 'usedMemoryIds'> {
  const find = (operation: string) => events.find(event => event.operation === operation);
  const restore = find('session.restore');
  const search = find('memory.search');
  return {
    restoredEvents: restore?.outcome === 'success' ? restore.count ?? 0 : 0,
    recalledMemories: search?.outcome === 'success' ? search.count ?? 0 : 0,
    searchOutcome: search?.outcome ?? 'skipped',
    injected: find('context.inject')?.includedCount ?? 0,
    userRecorded: find('session.user.write')?.outcome === 'success',
    assistantRecorded: find('session.assistant.write')?.outcome === 'success',
  };
}

export async function POST(request: Request) {
  // 1. Scope comes from the authenticated session, not from the request body.
  const viewer = await currentViewer();
  if (!viewer) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  if (isStaleTab(request, viewer)) return staleTabResponse();

  const parsed = body.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) return Response.json({ error: 'Invalid request.' }, { status: 400 });
  const prompt = textOf(parsed.data.message as unknown as UIMessage);
  if (!prompt) return Response.json({ error: 'Empty message.' }, { status: 400 });

  // 2. One conversation, one request at a time. Overlapping requests on the
  //    same session would interleave their recorded events.
  const release = await acquireSessionLock(viewer.sessionId);
  request.signal.addEventListener('abort', release, { once: true });

  try {
    const diagnostics: RedisAgentMemoryDiagnostic[] = [];
    const usedMemoryIds: string[] = [];
    const useMemory = parsed.data.memory;

    // 3. A fresh request-scoped model for every request. With memory off, this
    //    is the plain model and the turn isn't recorded.
    const model = useMemory
      ? getMemory().model({
        scope: { userId: viewer.userId, sessionId: viewer.sessionId },
        assistantId: ASSISTANT_ID,
        // Report which long-term memories were put in the prompt (IDs only).
        includeMemoryProvenance: true,
        // Recall more than the default 5: a support history holds many facts,
        // and the one that matters for this question may not rank first.
        limits: { memoryCount: 8 },
        onDiagnostic: event => {
          diagnostics.push(event);
          console.log(`[memory] ${viewer.userId} ${event.operation} ${event.outcome}`
            + (event.count !== undefined ? ` count=${event.count}` : '')
            + (event.error?.statusCode !== undefined ? ` http=${event.error.statusCode}` : ''));
        },
      })
      : anthropic(modelName);

    const result = streamText({
      model,
      system: supportSystemPrompt(viewer.customer),
      prompt,
      maxRetries: 0,
      abortSignal: request.signal,
      onStepEnd: step => {
        const included = step.providerMetadata?.redisAgentMemory?.memories;
        if (Array.isArray(included)) {
          for (const entry of included) {
            const id = (entry as { id?: unknown } | null)?.id;
            if (typeof id === 'string' && !usedMemoryIds.includes(id)) usedMemoryIds.push(id);
          }
        }
      },
      onFinish: release,
      onError: release,
      onAbort: release,
    });

    return result.toUIMessageStreamResponse<SupportMessage>({
      // 4. Ship what memory did on this turn to the UI, for the trace line
      //    under each reply. The assistant write lands just before `finish`.
      messageMetadata: ({ part }) => (part.type === 'finish'
        ? { memory: useMemory ? { ...summarize(diagnostics), usedMemoryIds } : null }
        : undefined),
      onError: () => 'The support agent could not answer. Check the server log and try again.',
    });
  } catch (error) {
    release();
    console.error('[chat] request failed', error instanceof Error ? error.message : error);
    return Response.json({ error: 'The support agent could not answer.' }, { status: 500 });
  }
}
