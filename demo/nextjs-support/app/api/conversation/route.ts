import { currentViewer, startConversation } from '@/lib/auth';

// "New conversation": same customer, same long-term memory, new session.
export async function POST() {
  const viewer = await currentViewer();
  if (!viewer) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  await startConversation(viewer.customer);
  return Response.json({ ok: true });
}
