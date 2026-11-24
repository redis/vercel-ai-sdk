import { redirect } from 'next/navigation';
import { currentViewer, isStaff } from '@/lib/auth';
import { signInCustomers } from '@/lib/customers';
import { SignInButton, staffAccount } from './sign-in-button';

export const dynamic = 'force-dynamic';

export default async function Home() {
  if (await currentViewer()) redirect('/support');
  if (await isStaff()) redirect('/staff');
  return (
    <main className="signin">
      <div className="brand">Waypoint <span>Support</span></div>
      <h1>Sign in as a customer</h1>
      <p className="muted">
        Demo sign-in. To show two customers side by side, sign in as one here and as the other in a
        private window.
      </p>
      <div className="customer-list">
        {signInCustomers.map(customer => (
          <SignInButton key={customer.id} customer={customer} />
        ))}
      </div>
      <h2 className="staff-heading">Or sign in as Waypoint staff</h2>
      <div className="customer-list">
        <SignInButton customer={staffAccount} staff />
      </div>
    </main>
  );
}
