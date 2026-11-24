'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Customer } from '@/lib/customers';
import { ENVIRONMENT_TYPE, environmentFields, formatAttribute } from '@/lib/environment';
import { PAGE_SESSION_HEADER, type KnownFact, type MemoryTrace, type SupportMessage } from '@/lib/types';

export function SupportChat({ customer, sessionId }: { customer: Customer; sessionId: string }) {
  const router = useRouter();
  const [input, setInput] = useState('');
  const [memoryOn, setMemoryOn] = useState(true);
  // Set when another tab in this browser signed in as someone else (or out).
  const [stale, setStale] = useState<null | 'other-customer' | 'signed-out'>(null);
  const memoryRef = useRef(memoryOn);
  memoryRef.current = memoryOn;

  const transport = useMemo(() => new DefaultChatTransport<SupportMessage>({
    api: '/api/chat',
    // Tells the server which conversation this tab belongs to, so a tab can't
    // keep chatting after the browser signed in as another customer elsewhere.
    headers: { [PAGE_SESSION_HEADER]: sessionId },
    // Send only the newest message. The server never trusts or replays a
    // client-side history; Agent Memory restores the conversation.
    prepareSendMessagesRequest: ({ messages }) => ({
      body: { message: messages.at(-1), memory: memoryRef.current },
    }),
  }), [sessionId]);

  const { messages, sendMessage, status, error } = useChat<SupportMessage>({ transport });
  const busy = status === 'submitted' || status === 'streaming';
  useEffect(() => {
    if (error?.message.includes('signed-in-elsewhere')) setStale('other-customer');
    else if (error?.message.includes('Sign in first')) setStale('signed-out');
  }, [error]);
  const lastReply = [...messages].reverse().find(message => message.role === 'assistant');
  const usedIds = lastReply?.metadata?.memory?.usedMemoryIds ?? [];

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy || stale) return;
    sendMessage({ text });
    setInput('');
  }

  async function newConversation() {
    await fetch('/api/conversation', { method: 'POST' });
    router.refresh();
  }

  async function switchCustomer() {
    await fetch('/api/auth', { method: 'DELETE' });
    router.push('/');
  }

  return (
    <div className="app" style={{ ['--accent' as string]: customer.accent }}>
      <header className="topbar">
        <div className="brand">Waypoint <span>Support</span></div>
        <div className="who">
          <span className="dot" style={{ background: customer.accent }} />
          <strong>{customer.company}</strong>
          <span className="muted">· {customer.contact} · {customer.plan}</span>
        </div>
        <div className="actions">
          <label className={`toggle ${memoryOn ? 'on' : ''}`}>
            <input type="checkbox" checked={memoryOn} onChange={event => setMemoryOn(event.target.checked)} />
            <span>Memory {memoryOn ? 'on' : 'off'}</span>
          </label>
          <button className="ghost" onClick={newConversation} disabled={busy}>New conversation</button>
          <button className="ghost" onClick={switchCustomer}>Switch customer</button>
        </div>
      </header>

      <div className="body">
        <section className="chat">
          <div className="session muted">Conversation {sessionId.slice(0, 8)}</div>
          <div className="messages" ref={listRef}>
            {messages.length === 0 && (
              <div className="empty muted">
                Ask about your account. Try <em>"Why is my API latency so high?"</em>
              </div>
            )}
            {messages.map(message => (
              <div key={message.id} className={`msg ${message.role}`}>
                <div className="bubble">
                  {message.parts.map((part, index) => (part.type === 'text'
                    ? <p key={index}>{part.text}</p>
                    : null))}
                </div>
                {message.role === 'assistant' && message.metadata !== undefined && (
                  <Trace trace={message.metadata.memory} />
                )}
              </div>
            ))}
            {status === 'submitted' && <div className="msg assistant"><div className="bubble typing">…</div></div>}
            {error && !stale && <div className="error">The agent couldn't answer. Check the server log and try again.</div>}
          </div>
          {stale && (
            <div className="stale">
              <span>
                {stale === 'other-customer'
                  ? `This browser signed in as another customer in a different tab. This tab is no longer ${customer.company}.`
                  : 'This browser signed out in a different tab.'}
              </span>
              <button onClick={() => window.location.reload()}>Reload</button>
            </div>
          )}
          <form className="composer" onSubmit={submit}>
            <input
              value={input}
              onChange={event => setInput(event.target.value)}
              placeholder={`Message Waypoint support as ${customer.contact}`}
              disabled={stale !== null}
              autoFocus
            />
            <button type="submit" disabled={busy || !input.trim() || stale !== null}>Send</button>
          </form>
        </section>

        <MemoryPanel enabled={memoryOn} refreshKey={messages.length} usedIds={usedIds}
          sessionId={sessionId} onStale={setStale} />
      </div>
    </div>
  );
}

function Trace({ trace }: { trace: MemoryTrace | null }) {
  if (!trace) return <div className="trace off">Memory off · the model saw only this message</div>;
  const recall = trace.searchOutcome === 'success'
    ? `recalled ${trace.recalledMemories} ${trace.recalledMemories === 1 ? 'fact' : 'facts'}`
    : trace.searchOutcome === 'empty' ? 'no facts recalled yet' : `recall ${trace.searchOutcome}`;
  return (
    <div className="trace">
      Redis Agent Memory · {recall} · restored {trace.restoredEvents} earlier{' '}
      {trace.restoredEvents === 1 ? 'message' : 'messages'} · {trace.assistantRecorded ? 'turn saved' : 'turn not saved'}
    </div>
  );
}

function MemoryPanel({ enabled, refreshKey, usedIds, sessionId, onStale }: {
  enabled: boolean; refreshKey: number; usedIds: string[]; sessionId: string;
  onStale: (kind: 'other-customer' | 'signed-out') => void;
}) {
  const [facts, setFacts] = useState<KnownFact[] | null>(null);
  const [hidden, setHidden] = useState(0);
  const [failed, setFailed] = useState(false);
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch('/api/memories', { cache: 'no-store', headers: { [PAGE_SESSION_HEADER]: sessionId } });
        // Keep showing this customer's last facts rather than someone else's.
        if (response.status === 409) { if (!cancelled) onStale('other-customer'); return; }
        if (response.status === 401) { if (!cancelled) onStale('signed-out'); return; }
        if (!response.ok) throw new Error(String(response.status));
        const data = await response.json() as { facts: KnownFact[]; hiddenAssistantNotes?: number };
        if (cancelled) return;
        // Highlight facts that appeared after the panel first loaded.
        if (seen.current) {
          const added = data.facts.filter(fact => !seen.current!.has(fact.id)).map(fact => fact.id);
          if (added.length) setFresh(previous => new Set([...previous, ...added]));
        }
        seen.current = new Set(data.facts.map(fact => fact.id));
        setFacts(data.facts);
        setHidden(data.hiddenAssistantNotes ?? 0);
        setFailed(false);
      } catch {
        if (!cancelled) setFailed(true);
      }
    }
    load();
    // Extraction runs in the background, so poll for new facts.
    const timer = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [refreshKey, sessionId, onStale]);

  const isUsed = (fact: KnownFact) => (fact.mergedIds ?? [fact.id]).some(id => usedIds.includes(id));

  return (
    <aside className={`panel ${enabled ? '' : 'dimmed'}`}>
      <h2>What the agent knows about you</h2>
      <p className="muted small">
        Long-term memories in Redis Agent Memory, extracted from earlier conversations. Only your own are
        shown or used.
      </p>
      {failed && <p className="error small">Couldn't load memories. Check the Agent Memory settings.</p>}
      {facts === null && !failed && <p className="muted small">Loading…</p>}
      {facts?.length === 0 && <p className="muted small">Nothing yet. Facts appear here a minute or so after a conversation.</p>}
      <ul className="facts">
        {facts?.map(fact => (
          <li key={fact.id} className={[fresh.has(fact.id) && 'fresh', isUsed(fact) && 'used'].filter(Boolean).join(' ')}>
            {isUsed(fact) && <span className="used-label">Used in the last reply</span>}
            {fact.type === ENVIRONMENT_TYPE && fact.attributes
              ? <EnvironmentRecord attributes={fact.attributes} />
              : <span>{fact.text}</span>}
            <span className="meta">
              {fact.fromThisConversation ? 'from this conversation' : 'from an earlier conversation'}
              {fact.topics.length > 0 && ` · ${fact.topics.slice(0, 3).join(', ')}`}
            </span>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <p className="muted small">
          {hidden} {hidden === 1 ? 'note' : 'notes'} about the agent's own earlier replies not shown.
        </p>
      )}
      {!enabled && <p className="muted small">Memory is off: the agent isn't using these.</p>}
    </aside>
  );
}

function EnvironmentRecord({ attributes }: { attributes: Record<string, unknown> }) {
  const rows = environmentFields
    .map(field => ({ field, value: formatAttribute(field, attributes[field.key]) }))
    .filter(row => row.value !== undefined);
  return (
    <div className="record">
      <span className="record-type">{ENVIRONMENT_TYPE}</span>
      <dl>
        {rows.map(({ field, value }) => (
          <div key={field.key}>
            <dt>{field.label}</dt>
            <dd className={field.type === 'flag' ? `flag ${value}` : ''}>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
