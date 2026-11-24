'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

// Demo only: marks the row as notified. Nothing is sent anywhere.
export function NotifyButton({ company }: { company: string }) {
  const [done, setDone] = useState(false);
  return (
    <button className={done ? 'ghost done' : 'notify'} onClick={() => setDone(true)} disabled={done}
      aria-label={`Notify ${company}`}>
      {done ? 'Notified ✓' : 'Notify'}
    </button>
  );
}

export function SignOutButton() {
  const router = useRouter();
  return (
    <button className="ghost" onClick={async () => {
      await fetch('/api/auth', { method: 'DELETE' });
      router.push('/');
    }}>
      Sign out
    </button>
  );
}
