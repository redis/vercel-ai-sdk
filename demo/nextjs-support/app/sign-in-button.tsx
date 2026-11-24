'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Customer } from '@/lib/customers';

type Account = Pick<Customer, 'id' | 'company' | 'contact' | 'plan' | 'accent'>;

export const staffAccount: Account = {
  id: 'staff', company: 'Waypoint staff', contact: 'Account health view', plan: 'Enterprise', accent: '#16181d',
};

export function SignInButton({ customer, staff = false }: { customer: Account; staff?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signIn() {
    setBusy(true);
    const response = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId: customer.id }),
    });
    if (response.ok) router.push(((await response.json()) as { to: string }).to);
    else setBusy(false);
  }

  return (
    <button className="customer-card" style={{ borderColor: customer.accent }} onClick={signIn} disabled={busy}>
      <span className="dot" style={{ background: customer.accent }} />
      <span>
        <strong>{customer.company}</strong>
        <span className="muted"> · {customer.contact}{staff ? '' : ` · ${customer.plan}`}</span>
      </span>
    </button>
  );
}
