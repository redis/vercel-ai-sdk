# What you'd build without Redis Agent Memory

The chat in this demo gets memory from one call, `memory.model(...)`. This page sketches the memory layer behind that call, the one you'd build and run yourself otherwise. Each part is a place where teams get stuck. It's an outline, not a complete design.

## 1. A conversation log

Every message is stored in order, per session and per user.

- Two requests on one session can race, so writes need an ordering guarantee.
- A retried request mustn't write twice, so each write needs an idempotency key.
- A session ID mustn't work for anyone else, so every read and write checks the owner.
- Loading history has to stop at a size budget rather than a message count, or long sessions overflow the context window.

## 2. Summaries

Long conversations outgrow the context window, so older messages get compressed into a summary. The summarizer mustn't run twice at once, mustn't drop messages that arrive while it runs, and has to run again when the summary goes stale.

## 3. Extraction

Turning chat into facts worth keeping is a model call with its own schema and prompt:

```ts
const ExtractedFacts = z.object({
  facts: z.array(z.object({
    text: z.string(),                 // one self-contained fact about the user
    topics: z.array(z.string()),
    supersedes: z.array(z.string()),  // IDs of older facts this one replaces
  })),
});
```

The prompt is most of the work. Expect weeks of iteration on what counts as durable, how to word facts so they're found later, and how to handle "we used to…", "starting next month…" and jokes.

Extraction has to run off the request path: a queue, workers, retries on timeouts and rate limits, and debouncing, so a 20-turn chat doesn't cost 20 extraction calls.

## 4. Embeddings and a per-user vector index

Each fact is embedded and stored with its owner, topics and an expiry. A fact that replaces an older one has to delete or retire it. Switching embedding models later means re-embedding every fact.

Every search must be filtered by owner:

```ts
const facts = await searchFacts({ ownerId, query, limit: 5 }); // vector search, pre-filtered by ownerId
```

Forget the filter once and one customer's facts end up in another customer's prompt. That's a security incident, not a bug.

## 5. Deduplication

"Uses Frankfurt", "Backend in Frankfurt" and "Moved our servers to Germany" are the same fact. Catching that takes a similarity threshold you tune by hand.

## 6. Sensitive data

Before a fact is stored, keys, tokens and card numbers need filtering out with patterns, plus a model check for what patterns can't catch, such as medical details. Different customers will want different rules.

## 7. Building the prompt

Load the session and search the facts in parallel, with a deadline, so a slow memory read never holds up the reply. Fit both into a budget. Mark recalled memory as untrusted, so a stored "ignore previous instructions" can't steer the model.

## 8. Structured memory you can query

The demo's `customer_environment` record would be a second extraction pass with its own schema, plus rules for merging partial updates and conflicting values ("we turned it back on"). Then an index on every field, so support can ask for "keep-alive off and SDK older than 3.2" across all customers, with that query open to staff only.

## 9. And the rest

Retention and deletion requests, a way to see what's stored, metrics on extraction cost, backfills, migrations, and someone on call.

## In this demo

The chat side is the `getMemory().model(...)` call in [app/api/chat/route.ts](app/api/chat/route.ts). The structured part is a memory type set up in the Redis Cloud console ([MEMORY_TYPE.md](MEMORY_TYPE.md)) and one `searchLongTermMemory` call ([lib/account-health.ts](lib/account-health.ts)).
