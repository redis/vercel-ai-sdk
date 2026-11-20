import { redirect } from 'next/navigation';
import { currentViewer } from '@/lib/auth';
import { SupportChat } from './support-chat';

export const dynamic = 'force-dynamic';

export default async function SupportPage() {
  const viewer = await currentViewer();
  if (!viewer) redirect('/');
  // Keyed by session so "New conversation" starts with an empty chat.
  return <SupportChat key={viewer.sessionId} customer={viewer.customer} sessionId={viewer.sessionId} />;
}
