// Fictional customers of a fictional product. Everything the agent knows about
// them beyond name and plan comes from earlier support conversations (see
// scripts/seed.ts), not from this file.

export interface Customer {
  id: string;
  company: string;
  contact: string;
  plan: 'Starter' | 'Pro' | 'Enterprise';
  accent: string;
  /** Hero customers can sign in to the chat. The others only have seeded history. */
  canSignIn: boolean;
}

export const customers: Customer[] = [
  { id: 'lindgren-logistics', company: 'Lindgren Logistics', contact: 'Sam', plan: 'Pro', accent: '#2563eb', canSignIn: true },
  { id: 'harbor-health', company: 'Harbor Health', contact: 'Priya', plan: 'Enterprise', accent: '#059669', canSignIn: true },
  { id: 'brightline-media', company: 'Brightline Media', contact: 'Jonas', plan: 'Pro', accent: '#9333ea', canSignIn: false },
  { id: 'okafor-freight', company: 'Okafor Freight', contact: 'Ada', plan: 'Pro', accent: '#ea580c', canSignIn: false },
  { id: 'tidepool-games', company: 'Tidepool Games', contact: 'Mei', plan: 'Starter', accent: '#0891b2', canSignIn: false },
  { id: 'meridian-bank', company: 'Meridian Bank', contact: 'Luis', plan: 'Enterprise', accent: '#be123c', canSignIn: false },
];

export const signInCustomers = customers.filter(customer => customer.canSignIn);

export function findCustomer(id: string | undefined): Customer | undefined {
  return customers.find(customer => customer.id === id);
}

/**
 * The stable Agent Memory owner ID for a customer. DEMO_RUN lets each rehearsal
 * start from empty memory without flushing the store.
 */
export function memoryUserId(customer: Customer): string {
  const run = process.env.DEMO_RUN?.trim();
  const userId = run ? `${customer.id}-${run}` : customer.id;
  if (!/^[A-Za-z0-9-]{1,64}$/.test(userId)) {
    throw new Error('DEMO_RUN must contain only letters, digits, and hyphens.');
  }
  return userId;
}

/** Maps memory owner IDs back to customers, for staff views. */
export function customerByMemoryUserId(): Map<string, Customer> {
  return new Map(customers.map(customer => [memoryUserId(customer), customer]));
}
