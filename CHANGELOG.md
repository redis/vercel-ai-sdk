# Changelog

## Unreleased

* Adds `upsert_memory`, `update_memory_fields`, `list_memory_sources`, `list_memory_source_evidence`, and `list_source_memories` to every toolset.
* Adds the opt-in `ingestionTools` option for `create_document_ingestion`, `get_document_ingestion`, `list_document_ingestion_outputs`, `get_ingestion_hook_status`, and `list_ingestion_hook_statuses`. Defaults to `false`.
* Adds the opt-in `summaryViewTools` option for the Summary View tools. Defaults to `false`. `delete_summary_view` also requires `allowDeletes`.
* Adds `get_namespace_routing` and `put_namespace_routing` to `namespaceTools`.
* `move_memories` routes memories by the store's routing policy when `namespaceId` is omitted.
* `search_memories`, `list_sessions`, and `list_namespaces` accept `sortBy` and `sortOrder`. `search_memories` sorts only without `query`.
* `search_memories` accepts `excludeDocumentManaged`. `list_sessions` accepts a `namespaceId` filter.
* `start_session`, `add_session_event`, `create_memories`, `update_memory`, `upsert_memory`, and `update_memory_fields` accept `idempotencyKey`. `start_session` also accepts `createdAt`.
* `create_memories` with `idempotencyKey` derives deterministic memory IDs, so an identical retry replays the saved result.
* `update_memory`, `upsert_memory`, and `update_memory_fields` accept `expectedRevision`.
* Under a fixed `userId` or `namespaceId`, routing tools and automatic routing are refused. Summary Views are hidden, readable, or manageable by how their filter pins the scope. A `SHARED` view is readable, with the partition forced to the scope, but cannot be updated, refreshed, or deleted. `create_summary_view` creates only `PRIVATE` views.
* `create_document_ingestion` is refused under a fixed `namespaceId`.
* The 1.0.0 ingestion record has no `ownerId`, so a toolset with a fixed `userId` or `namespaceId` reads an ingestion only after it has produced a memory in scope.
* Ingestion hook status tools are refused under a fixed `namespaceId`.
* `create_memories` with an `idempotencyKey` derives memory IDs from the key and returns only the IDs the service created.
* A keyed `start_session` retry on an existing session returns the session's first event when `actorId`, role, text, and any `createdAt` match, because the store refuses a repeated `createSession` with HTTP 409. The first event is the earliest by the store's `systemTimestamp`, so a backdated append cannot displace it.
* Session event `idempotencyKey` descriptions no longer promise replay, because the store does not deduplicate session events by key. After an uncertain `add_session_event`, read `get_session_memory` before retrying.
* `ownerId` accepts 1 to 64 letters, digits, and `_+=.@-` except `.` and `..`, and `sessionId` accepts underscores, matching the SDK.
* `actorId` follows the `ownerId` rule, as the store enforces. This applies to `start_session`, `add_session_event`, `createSessionEventHook`, and the model wrapper's `assistantId`. Longer or differently punctuated IDs now fail validation before any request.
* A stale `expectedRevision` (HTTP 412) and an HTTP 409 conflict now return recovery guidance instead of the generic configuration message.
* `list_sessions` with a fixed `sessionId` validates `namespaceId` against a fixed namespace and returns no items when the filter names a different namespace than the session's.
* A scope with only `sessionId` sets no owner or namespace boundary. Set `userId` or `namespaceId` when `sessionId` must act as a write boundary.

## 0.2.0

* Bumps `@redis-iris/agent-memory` to v1.0.0.
* `list_sessions` now filters by a fixed `scope.namespaceId` instead of rejecting namespace-scoped listing.
* **Breaking:** `serverUrl` / `AGENT_MEMORY_URL` is now required; the built-in `gcp-us-east4` fallback is removed because each store has its own endpoint URL.
* **Breaking:** `namespaceRef` and the legacy `namespace` label are replaced by `namespaceId`; scope no longer accepts `namespace`, and unknown scope fields now throw rather than being ignored.
* **Breaking:** `search_memories` takes `query`, `minScore`, and `filter.op` (`ALL`/`ANY`) instead of `text`, `similarityThreshold`, and `filterOp`.
* **Breaking:** pagination uses `cursor` / `nextCursor` instead of `pageToken` / `nextPageToken`; `list_sessions` returns session objects without `total`.

## 0.1.1

* Fixes wrong imports in documentation and demos

## 0.1.0

* Initial release.
