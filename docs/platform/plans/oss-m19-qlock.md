# Qualified runtime term-line row lock

Status: checkpoint 1 (reader preparation) focused proof complete; maintainer
read required before DCO. No source commit. Base: `origin/main` `ad31565d`.

## Outcome and boundary

On both qualified generations (`qualified-v2` and `qualified-admin`) the
restricted runtime login cannot complete any native subscription lifecycle
command. The existing command apply locks the renewal term lines `FOR UPDATE`
before its replace-in-transaction rewrite, while the issued runtime units grant
the runtime group `SELECT`, `INSERT` and `DELETE` on that table without any
`UPDATE` column. Cancel, pause, resume and slide therefore fail with `42501`
and record no receipt, through both the customer command store and the operator
support wrapper. The legacy and managed chains are unaffected.

The fix is one shared qualified completion unit,
`q2_20261103200000_runtime_term_line_lock.sql` (its exact bytes are the
[inert fixture](../../../scripts/fixtures/reviewed-m14-qualified/db/platform/migrations/q2_20261103200000_runtime_term_line_lock.sql)
until checkpoint 3), selected by both qualified plans after their issued tails:

- enable row security on `public.subscription_renewal_term_lines` (the table
  has none today, so a lock-only policy alone could not bind);
- runtime-group policies preserving the existing `SELECT`, `INSERT` and
  `DELETE` access;
- an `UPDATE` lock-only policy, `USING (true) WITH CHECK (false)`, and
  `GRANT UPDATE (updated_at)` only, so row locking works and every actual
  update is refused.

It follows the issued runtime unit's lock-only pattern for privacy erasures.
Its guard repeats the runtime-completion binding checks and requires the
unswitched installer to own the target with no row security or policy yet.

Exclusions: issued SQL and approvals, every function body and security mode,
new routines, other tables, the legacy and managed chains, and the reference
adopter's production composition. The adopter imports the packaged migration
validator only with its default legacy selection, whose output this change
keeps identical.

## Delivery route

Qualified SQL uses the existing control-before-feature route. Three
separately landed checkpoints, each on actual main before the next:

1. **Reader.** The seventeenth fixed identity and registry length 17 beside the
   existing set. The manifest ordering rule for one shared late tail, with its
   packaged exact copy. The inert exact fixture and tests. The approval registry
   and the canonical manifest are unchanged.
2. **Pin.** Only the exact seventeenth approval row, SHA-256
   `a90d6315227698e6e1a8ba72ca9df953f6d5a066e7ffe2e976e180211d2bf3e8`.
3. **SQL.**
   - The identical active file and its packaged projection.
   - The appended row in both qualified plans with measured inventories.
   - Real-PostgreSQL proofs: the four commands through both wrappers with
     receipts; refused actual updates; unchanged access for every other role;
     legacy and managed untouched.
   - Existing pinned qualified-runtime lifecycle limits become positive proofs.

## Checkpoint 1 acceptance and proof

- The reader accepts lengths 4, 5, 6, 7, 12, 16 and 17. It refuses 8–11 and
  13–15, an eighteenth entry, a wrong path at position 17, swapped positions 16
  and 17, and extra keys.
- The lock path is a qualified identity. Its introduction requires a prior exact
  approval. Pin and SQL together refuse, a later repin refuses, and machinery
  changed beside its SQL refuses in pull-request and merge-group admission.
- The manifest admits the lock only once, as a tail of both qualified plans after
  every issued tail, at the same position among shared units. Later shared
  forwards append after it. Legacy selection of it, a schema-2 manifest with it,
  insertion before the end and changed bytes all refuse. Legacy and current
  qualified selections stay unchanged.
- The fixture bytes are pinned by SHA-256. A focused disposable PostgreSQL 16
  probe on an installer-managed `qualified-v2` install (a runtime login that is
  `NOSUPERUSER`, `NOBYPASSRLS` and `NOINHERIT`) showed the following. It is not
  a committed test in this checkpoint.
  - Before the unit, pause fails with `42501`.
  - After it, pause, resume, slide and cancel each apply and record a receipt.
  - `UPDATE … SET updated_at = updated_at` fails the row-security check, and
    `SET sku = sku` lacks privilege.
  - `SELECT`, `INSERT`, `DELETE` and the row lock succeed; line values and
    timestamps are unchanged.
  - A second application refuses through its guard.

Simplicity pre-check: extend the existing fixed identity list and ordering check
exactly as the runtime-completion and owner-path tails did. Refused
alternatives:
- edit the issued units: immutable approvals;
- a column grant without row security: it admits real updates;
- change the command function: a routine or security-mode change;
- a shared portable forward: the closed classes refuse table grants.
