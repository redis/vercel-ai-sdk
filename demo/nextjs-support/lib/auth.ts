import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { findCustomer, memoryUserId, type Customer } from './customers.ts';
import { PAGE_SESSION_HEADER } from './types.ts';

// Demo-grade authentication: a signed, httpOnly cookie. In a real app this is
// your auth provider's session. What matters is the rule it demonstrates: the
// memory scope (userId, sessionId) is derived on the server from authenticated
// state, never read from the request body.

const SESSION_COOKIE = 'waypoint_session';
const STAFF_COOKIE = 'waypoint_staff';
const cookieOptions = () => ({
  httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production', path: '/',
});

function secret(): string {
  const value = process.env.DEMO_AUTH_SECRET;
  if (!value || value.length < 16) throw new Error('Set DEMO_AUTH_SECRET (at least 16 characters).');
  return value;
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

// The demo run is part of the sign-in, so changing DEMO_RUN signs everyone out.
// Otherwise an open conversation would belong to the previous run's owner, and
// Agent Memory would rightly refuse it (a scope violation).
const currentRun = () => process.env.DEMO_RUN?.trim() ?? '';

function verify(token: string | undefined): { customerId: string; sessionId: string; run?: string } | undefined {
  if (!token) return undefined;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return undefined;
  const payload = token.slice(0, dot);
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(token.slice(dot + 1));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
  const [customerId, sessionId, run] = payload.split(':');
  return customerId && sessionId ? { customerId, sessionId, run } : undefined;
}

export interface Viewer {
  customer: Customer;
  /** Agent Memory owner: stable across conversations. */
  userId: string;
  /** Agent Memory session: one per conversation. */
  sessionId: string;
}

export async function currentViewer(): Promise<Viewer | undefined> {
  const store = await cookies();
  const claims = verify(store.get(SESSION_COOKIE)?.value);
  const customer = findCustomer(claims?.customerId);
  if (!claims || !customer?.canSignIn || claims.run !== currentRun()) return undefined;
  return { customer, userId: memoryUserId(customer), sessionId: claims.sessionId };
}

/** Signs in as a customer and starts a new conversation (a new Agent Memory session). */
export async function startConversation(customer: Customer): Promise<void> {
  const store = await cookies();
  const payload = `${customer.id}:${randomUUID()}:${currentRun()}`;
  store.set(SESSION_COOKIE, `${payload}.${sign(payload)}`, cookieOptions());
}

// Staff access for the cross-customer "Account health" view. Separate from
// customer sign-in: customers must never be able to run cross-customer queries.
export async function startStaffSession(): Promise<void> {
  const payload = `staff:${randomUUID()}`;
  (await cookies()).set(STAFF_COOKIE, `${payload}.${sign(payload)}`, cookieOptions());
}

export async function isStaff(): Promise<boolean> {
  return verify((await cookies()).get(STAFF_COOKIE)?.value)?.customerId === 'staff';
}

export async function signOut(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  store.delete(STAFF_COOKIE);
}

/**
 * Tabs in one browser share the sign-in cookie, so signing in as another
 * customer in a second tab silently changes who the first tab is talking as.
 * Each page sends the conversation it was rendered for; requests from a tab
 * whose conversation is no longer the signed-in one are refused.
 */
export function isStaleTab(request: Request, viewer: Viewer): boolean {
  const expected = request.headers.get(PAGE_SESSION_HEADER);
  return expected !== null && expected !== viewer.sessionId;
}

export const staleTabResponse = () => Response.json(
  { error: 'signed-in-elsewhere', message: 'This browser signed in as another customer in a different tab. Reload this page.' },
  { status: 409 },
);
