import { z } from 'zod';
import { signOut, startConversation, startStaffSession } from '@/lib/auth';
import { findCustomer } from '@/lib/customers';

// Demo sign-in: pick a customer. Replace with your real auth provider.
export async function POST(request: Request) {
  const parsed = z.object({ customerId: z.string() }).safeParse(await request.json().catch(() => undefined));
  if (parsed.data?.customerId === 'staff') {
    await startStaffSession();
    return Response.json({ ok: true, to: '/staff' });
  }
  const customer = findCustomer(parsed.data?.customerId);
  if (!customer?.canSignIn) return Response.json({ error: 'Unknown customer.' }, { status: 400 });
  await startConversation(customer);
  return Response.json({ ok: true, to: '/support' });
}

export async function DELETE() {
  await signOut();
  return Response.json({ ok: true });
}
