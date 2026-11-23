Native base and promoted legacy drafts take the same catalogue locks.
`public.catalog_admission_check_legacy_draft` ignores its last argument, so a
direct call with `false` or `NULL` now takes write-transaction row locks and
refuses in a read-only transaction with `25006`. A fresh promoted draft now
takes these locks before validating its money. Its `SHARE` lock waits while a
publication holds the catalogue fence. A wait that exceeds the caller's
`lock_timeout` returns `55P03`. After a completed wait at `READ COMMITTED`, a
draft whose demand the publication made governed returns `55000` before money
validation. At `REPEATABLE READ`, the stale product-row guard returns `40001`.
Only the publisher uses `NOWAIT`, and its fence returns `55P03` while a fresh
draft holds the lock. Exact replay and uncontended results are unchanged.

Migration: Apply the native forward
`20261125120000_catalog_legacy_draft_fixed_locks.sql`. It changes no grant,
table or TypeScript caller. Retry a `40001` draft in a new transaction.
