// Imports each customer's earlier support messages into Redis Agent Memory,
// then waits until background extraction has turned them into memories.
// Run it at least a few minutes before you record:  npm run seed

import { randomUUID } from 'node:crypto';
import { customers, memoryUserId, type Customer } from '../lib/customers.ts';
import { accountHealth } from '../lib/account-health.ts';
import { ENVIRONMENT_TYPE, KEEP_ALIVE_OFF } from '../lib/environment.ts';
import { getMemoryClient } from '../lib/memory.ts';

for (const file of ['.env.local', '.env']) {
  try { process.loadEnvFile(file); } catch { /* optional */ }
}

// Casual messages that mention setup details in passing, the way people
// actually write support tickets. Nothing says "remember this".
const history: Record<string, string[]> = {
  'lindgren-logistics': [
    'Hey, quick billing question: can we switch our Pro plan from monthly to annual billing?',
    'Great. Unrelated FYI: we finished moving our backend from Virginia to our new Frankfurt data center last month, so almost all our traffic is EU now. We haven\'t touched the Waypoint gateway itself, it\'s still on us-east.',
    'Also, our ops team only works from curl, so please give me curl commands rather than SDK snippets.',
    'That\'s all for today, thanks!',
  ],
  'harbor-health': [
    'Following up on last quarter\'s connection-reset errors: we turned off HTTP keep-alive in our client and the errors went away, so you can close that ticket.',
    'For your notes, all our calls to Waypoint come from AWS Lambda functions in us-east, Node 18, Waypoint SDK 3.0.',
    'And a reminder that we\'re under HIPAA: please never ask me to paste request payloads, they can contain patient data.',
    'Thanks, that\'s it for now.',
  ],
  // Background customers: they never sign in during the demo, but their
  // history makes the staff "Account health" query worth running.
  'brightline-media': [
    'Our Go services on Kubernetes in us-west call Waypoint through SDK 3.1. Back in March we disabled keep-alive in the Go client to get rid of those connection resets.',
    'Anyway, can you send me last month\'s invoice?',
  ],
  'okafor-freight': [
    'We just upgraded to Waypoint SDK 3.2.1 on our Java services in eu-central, keep-alive is on. Is there anything else we should change?',
  ],
  'tidepool-games': [
    'Our matchmaking runs on AWS Lambda in ap-southeast and calls Waypoint with SDK 3.0. We turned off keep-alive during the reset incident and never turned it back on.',
    'Also, how do I add a teammate to our account?',
  ],
  'meridian-bank': [
    'Quick check before our audit: we run .NET services in us-east on Waypoint SDK 3.2, keep-alive is on, default settings. Do you have a SOC 2 report we can share with auditors?',
  ],
};

async function seedCustomer(customer: Customer) {
  // Past tickets are imported as the customer's messages only, the way you'd
  // backfill history from a helpdesk. If the seed also recorded generated agent
  // replies, extraction would store the agent's own advice ("Assistant
  // recommended...") as long-term memory, and those notes crowd the customer's
  // facts out of recall. The live app still records both sides of each turn.
  const userId = memoryUserId(customer);
  const sessionId = randomUUID();
  console.log(`${customer.company}: importing session ${sessionId.slice(0, 8)} as ${userId}`);
  const started = Date.now() - 60 * 60_000; // an hour ago, one minute apart
  for (const [index, text] of (history[customer.id] ?? []).entries()) {
    await getMemoryClient().addSessionEvent(sessionId, {
      actorId: userId,
      role: 'USER',
      content: [{ text }],
      createdAt: new Date(started + index * 60_000),
      idempotencyKey: `${sessionId}-${index}`,
    });
    console.log(`  > ${text.slice(0, 80)}…`);
  }
  return userId;
}

async function waitForFacts(customer: Customer, userId: string) {
  // First wait for ordinary facts, then give the structured customer_environment
  // record a little longer. Extraction runs in the background on the service's cadence.
  const minimum = customer.canSignIn ? 2 : 1;
  const factsDeadline = Date.now() + 8 * 60_000;
  let environmentDeadline = Infinity;
  while (Date.now() < Math.min(factsDeadline, environmentDeadline)) {
    const { items } = await getMemoryClient().searchLongTermMemory({
      filter: { ownerId: { eq: userId } }, sortBy: 'updatedAt', sortOrder: 'DESC', limit: 50,
    });
    const hasEnvironment = items.some(item => item.memoryType === ENVIRONMENT_TYPE);
    if (items.length >= minimum && environmentDeadline === Infinity) environmentDeadline = Date.now() + 3 * 60_000;
    if (items.length >= minimum && (hasEnvironment || Date.now() >= environmentDeadline - 10_000)) {
      console.log(`\n${customer.company}: ${items.length} memories`);
      for (const item of items) {
        const attributes = item.memoryType === ENVIRONMENT_TYPE ? ` ${JSON.stringify(item.attributes ?? {})}` : '';
        console.log(`  • [${item.memoryType ?? 'semantic'}] ${item.text}${attributes}`);
      }
      if (!hasEnvironment) {
        console.warn(`  ! No ${ENVIRONMENT_TYPE} record. Check that the type exists on this service (see MEMORY_TYPE.md).`);
      }
      return hasEnvironment;
    }
    await new Promise(resolve => setTimeout(resolve, 10_000));
  }
  console.warn(`\n${customer.company}: fewer than ${minimum} memories after 8 minutes. Check the extraction cadence.`);
  return false;
}

const seeded = await Promise.all(customers.map(async customer => ({ customer, userId: await seedCustomer(customer) })));
console.log('\nWaiting for background extraction (set Extraction cadence to 60 s to make this quick)…');
const results = await Promise.all(seeded.map(({ customer, userId }) => waitForFacts(customer, userId)));
const ready = results.every(Boolean) && await checkDemoReady();
process.exit(ready ? 0 : 1);

/**
 * Extraction is done by an AI model, so a run can come out slightly different.
 * Check the exact values the recording relies on, using the same query as the
 * staff page.
 */
async function checkDemoReady(): Promise<boolean> {
  const { rows } = await accountHealth('all');
  const setup = (id: string) => rows.find(row => row.customer.id === id)?.attributes ?? {};
  const harbor = setup('harbor-health');
  const lindgren = setup('lindgren-logistics');
  // Every customer except Lindgren describes the services that call Waypoint.
  const noRuntime = rows.filter(row => row.customer.id !== 'lindgren-logistics' && !row.attributes.client_runtime).map(row => row.customer.id);
  // Only Lindgren talks about the Waypoint gateway itself.
  const strayGateway = rows.filter(row => row.customer.id !== 'lindgren-logistics' && row.attributes.gateway_region).map(row => row.customer.id);
  const keepAliveOff = (await accountHealth('keep-alive-off')).rows.map(row => row.customer.id).sort();
  const expectedOff = ['brightline-media', 'harbor-health', 'tidepool-games'];

  const checks: [string, boolean][] = [
    ['Harbor: keep-alive is "false"', harbor.keep_alive_enabled === KEEP_ALIVE_OFF],
    ['Harbor: SDK is 3.0', harbor.sdk_version === '3.0'],
    ['Harbor: runtime mentions Lambda', /lambda/i.test(String(harbor.client_runtime ?? ''))],
    ['Harbor: origin is us-east', /us-east/i.test(String(harbor.origin_location ?? ''))],
    ['Lindgren: gateway is us-east', lindgren.gateway_region === 'us-east'],
    ['Lindgren: origin is Frankfurt', /frankfurt/i.test(String(lindgren.origin_location ?? ''))],
    ['Lindgren: runtime is not curl', !/curl/i.test(String(lindgren.client_runtime ?? ''))],
    [`Every other customer has a runtime (missing: ${noRuntime.join(', ') || 'none'})`, noRuntime.length === 0],
    [`Only Lindgren has a gateway region (also: ${strayGateway.join(', ') || 'none'})`, strayGateway.length === 0],
    [`Staff "Keep-alive off" view lists exactly Brightline, Harbor, Tidepool (got: ${keepAliveOff.join(', ') || 'none'})`,
      JSON.stringify(keepAliveOff) === JSON.stringify(expectedOff)],
  ];
  console.log('\nDemo checks:');
  for (const [label, ok] of checks) console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  const ok = checks.every(([, passed]) => passed);
  console.log(ok
    ? '\nReady to demo.'
    : '\nNot ready. Extraction came out differently this time. Change DEMO_RUN in .env.local and run npm run seed again.');
  return ok;
}
