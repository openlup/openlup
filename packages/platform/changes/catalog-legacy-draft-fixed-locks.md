Native base and promoted legacy drafts take the same catalogue locks.
`public.catalog_admission_check_legacy_draft` ignores its last argument, so a
direct call with `false` or `NULL` now takes write-transaction row locks and
refuses in a read-only transaction with `25006`. A fresh promoted draft takes
the locks before validating its money: under contention or a stale
`REPEATABLE READ` snapshot it returns the lock failure, such as `40001`,
instead of the money refusal. Exact replay and uncontended results are unchanged.

Migration: Apply the native forward
`20261125120000_catalog_legacy_draft_fixed_locks.sql`. It changes no grant,
table or TypeScript caller. Retry a `40001` draft in a new transaction.
