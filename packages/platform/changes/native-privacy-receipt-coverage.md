### Native erasure receipt coverage

Native erasure retries verify required coverage before returning the original
receipt. An uncovered receipt returns HTTP 503 (`UPSTREAM_UNAVAILABLE`) with
`PRIVACY_RECEIPT_COVERAGE_INCOMPLETE` in `error.details.privacyCode` and these
facts in `error.details`. Here `<owners>` lists the required contributor IDs
with missing coverage, separated by commas.

- `observed` — A prior erasure is missing recorded coverage for the required owners (`<owners>`).
- `cause` — The original receipt and verified owner approvals do not establish their local disposition.
- `fix` — Ask the data privacy owner and contributor owners to reconcile the missing coverage against the original receipt.
- `recheck` — Retry the original erasure request after reconciliation.

Migration: Forward `findErasureReplay` on the held transaction in native store
wrappers, returning the original receipt and its covered contributor IDs.
Update strict clients to accept the coverage refusal and its four facts. Run
`reconcilePostgresPrivacyErasure` in an owner session for each missing contributor
with verified approval for the original receipt, as described in **Reconcile
coverage of a native erasure receipt** in the **Personal data** guide. Retry the
original subject and idempotency key once coverage is complete. Follow
**Rehearse native privacy cutover for each store** before reopening native
privacy traffic.
