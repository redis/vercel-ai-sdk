# Changelog

## 0.2.0

* `list_sessions` now filters by a fixed `scope.namespaceId` instead of rejecting namespace-scoped listing.
* Bumps `@redis-iris/agent-memory` to v1.0.0.
* **Breaking:** `namespaceRef` and the legacy `namespace` label are replaced by `namespaceId`; scope no longer accepts `namespace`.
* **Breaking:** `search_memories` takes `query`, `minScore`, and `filter.op` (`ALL`/`ANY`) instead of `text`, `similarityThreshold`, and `filterOp`.
* **Breaking:** pagination uses `cursor` / `nextCursor` instead of `pageToken` / `nextPageToken`; `list_sessions` returns session objects without `total`.

## 0.1.1

* Fixes wrong imports in documentation and demos

## 0.1.0

* Initial release.
