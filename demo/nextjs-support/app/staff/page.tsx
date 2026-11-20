import Link from 'next/link';
import { redirect } from 'next/navigation';
import { accountHealth, type HealthView } from '@/lib/account-health';
import { isStaff } from '@/lib/auth';
import { environmentFields, formatAttribute } from '@/lib/environment';
import { NotifyButton, SignOutButton } from './staff-actions';

export const dynamic = 'force-dynamic';

const views: { id: HealthView; label: string }[] = [
  { id: 'keep-alive-off', label: 'Keep-alive off' },
  { id: 'all', label: 'All customers' },
];

export default async function StaffPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  if (!(await isStaff())) redirect('/');
  const view: HealthView = (await searchParams).view === 'all' ? 'all' : 'keep-alive-off';

  let result: Awaited<ReturnType<typeof accountHealth>> | undefined;
  try {
    result = await accountHealth(view);
  } catch (error) {
    console.error('[staff] account health query failed', error instanceof Error ? error.message : error);
  }

  // Show the filter as sent: one line per condition, owner list shortened.
  const queryText = result && [
    'agentMemory.searchLongTermMemory({',
    '  filter: {',
    ...Object.entries(result.filter).map(([key, value]) => key === 'ownerId'
      ? `    ownerId: { in: [/* ${result!.filter.ownerId?.in?.length ?? 0} customers */] },`
      : `    ${key}: ${JSON.stringify(value).replace(/"([a-z_A-Z]+)":/g, '$1: ').replace(/[{]/g, '{ ').replace(/[}]/g, ' }').replace(/,/g, ', ')},`),
    '  },',
    '})',
  ].join('\n');

  return (
    <div className="app">
      <header className="topbar" style={{ ['--accent' as string]: '#16181d' }}>
        <div className="brand">Waypoint <span>Staff</span></div>
        <div className="who"><strong>Account health</strong></div>
        <div className="actions"><SignOutButton /></div>
      </header>
      <main className="staff">
        <p className="muted">
          Customer setups extracted by Redis Agent Memory from support conversations, as structured{' '}
          <code>customer_environment</code> records. Nobody filled in a form.
        </p>

        <nav className="views">
          {views.map(item => (
            <Link key={item.id} href={`/staff?view=${item.id}`} className={item.id === view ? 'active' : ''}>
              {item.label}
            </Link>
          ))}
        </nav>

        {queryText && <pre className="query">{queryText}</pre>}

        {!result && <p className="error">Couldn't query Agent Memory. Check the server log.</p>}
        {result && result.rows.length === 0 && (
          <p className="muted">No matching customers yet. Run <code>npm run seed</code> and wait for extraction.</p>
        )}
        {result && result.rows.length > 0 && (
          <table className="health">
            <thead>
              <tr>
                <th>Customer</th>
                {environmentFields.map(field => <th key={field.key}>{field.label}</th>)}
                {view === 'keep-alive-off' && <th />}
              </tr>
            </thead>
            <tbody>
              {result.rows.map(row => (
                <tr key={row.customer.id}>
                  <td>
                    <span className="dot" style={{ background: row.customer.accent }} /> {row.customer.company}
                    <div className="muted small">{row.customer.plan}</div>
                  </td>
                  {environmentFields.map(field => {
                    const value = formatAttribute(field, row.attributes[field.key]);
                    return (
                      <td key={field.key} className={field.type === 'flag' && value ? `flag ${value}` : ''}>
                        {value ?? <span className="muted">—</span>}
                      </td>
                    );
                  })}
                  {view === 'keep-alive-off' && <td><NotifyButton company={row.customer.company} /></td>}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {view === 'keep-alive-off' && result && result.rows.length > 0 && (
          <p className="muted small">
            These customers turned keep-alive off after the old connection-reset bug, which SDK 3.2 fixed. Notify is a demo
            button: nothing is sent.
          </p>
        )}
      </main>
    </div>
  );
}
