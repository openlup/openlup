# Qualified runtime lock and conflict completion

Status: checkpoint 2 of 3 (approval pin). The reader preparation lands before
it, and the active SQL follows separately.

## Outcome and boundary

The restricted runtime login on both qualified generations (`qualified-v2` and
`qualified-admin`) cannot complete four existing native writers. Each fails
with `42501` and writes nothing:

| Writer | Locked or written table | Issued runtime grant |
|---|---|---|
| Subscription command apply (cancel, pause, resume, slide), customer store and operator support wrapper | renewal term lines, locked `FOR UPDATE` | `SELECT`, `INSERT`, `DELETE` |
| Operator recovery issue | recovery commands, locked `FOR UPDATE` | `SELECT`, `INSERT` |
| Platform control set and heartbeat | control operations, locked `FOR UPDATE` | `SELECT`, `INSERT` |
| Order promotion-claim transition trigger, on any runtime settlement of an order with a claim | claim events, appended with `INSERT … ON CONFLICT (claim_id, event_key) DO NOTHING` | `INSERT` only |

None of the four tables has row security. The legacy and managed chains are
unaffected.

The fix is one shared qualified completion unit,
`q2_20261103200000_runtime_lock_and_conflict_completion.sql`. Both qualified
plans select it after their issued tails. Until checkpoint 3, its exact bytes
are the
[inert fixture](../../../scripts/fixtures/reviewed-m14-qualified/db/platform/migrations/q2_20261103200000_runtime_lock_and_conflict_completion.sql).

For each of the three locked tables, the unit:

- enables row security, without `FORCE`;
- adds runtime-group policies that preserve the existing access;
- adds an `UPDATE` lock-only policy, `USING (true) WITH CHECK (false)`;
- grants `UPDATE` on one timestamp column only.

Row locking then works, and every actual update is refused.

For claim events, it grants `SELECT (claim_id, event_key)` only. A conflict
target needs `SELECT` on both arbiter columns. Row security would add nothing
there, because an arbiter also requires the new row to pass a select policy.
The runtime already reads the claims these keys derive from, and the other
event columns stay unreadable.

The pattern follows the issued runtime unit's lock-only precedent for privacy
erasures. The guard repeats the runtime-completion binding checks. It also
requires the unswitched installer to own all four targets, with no row
security or policy yet.

Exclusions:

- issued SQL and approvals;
- every function body and security mode;
- new routines;
- other tables;
- the legacy and managed chains;
- the reference adopter's production composition.

The adopter imports the packaged migration validator only with its default
legacy selection, whose output this change keeps identical.

## Delivery route

Qualified SQL uses the existing control-before-feature route: three separately
landed checkpoints, each on actual main before the next.

1. **Reader.**
   - The seventeenth fixed identity, and registry length 17 beside the existing set.
   - The manifest ordering rule for one shared late tail, with its packaged
     exact copy.
   - The inert exact fixture and tests.
   - The approval registry and the canonical manifest stay unchanged.
2. **Pin.** Only the exact seventeenth approval row.
3. **SQL.**
   - The identical active file and its packaged projection.
   - The appended row in both qualified plans, with measured inventories.
   - Real-PostgreSQL proofs:
     - the four writers succeed with receipts or exactly one event;
     - replays add no duplicate;
     - actual updates and other event reads are refused;
     - access for every other role is unchanged;
     - legacy and managed stay untouched.
   - Existing pinned qualified-runtime limits become positive proofs.

## Checkpoint 2 acceptance and proof

The registry gains exactly one row at position 17: the completion path and
SHA-256 `0a46e613d2b7daeea80a68682326cd514bccbcceac167520209254338beb09b7`, equal to the unchanged inert fixture. Every earlier row and every
other registry byte stays the same. The witnesses now expect 17 issued
approvals and pin position 17 to that fixture hash. The 16→17 append,
co-located refusal and repin refusal cases from checkpoint 1 still pass. No
SQL, manifest, reader or package file changes, so the package delta is 0 B.

## Checkpoint 1 acceptance and proof

- **Reader.** It accepts lengths 4, 5, 6, 7, 12, 16 and 17. It refuses:
  - lengths 8–11 and 13–15;
  - an eighteenth entry;
  - a wrong path at position 17;
  - swapped positions 16 and 17;
  - extra keys.
- **Qualified identity.** The completion path is a qualified identity, so its
  introduction requires a prior exact approval. Admission refuses, both for
  pull requests and in the merge group:
  - the pin and the SQL together;
  - a later repin;
  - machinery changed beside the SQL.
- **Manifest.** It admits the tail only once: as a tail of both qualified plans,
  after every issued tail, at the same position among shared units. Later
  shared forwards append after it. It refuses:
  - a legacy selection;
  - a schema-2 manifest;
  - insertion before the end;
  - changed bytes.

  Legacy and current qualified selections stay unchanged.
- **Fixture and probe.** SHA-256 pins the fixture bytes. Disposable PostgreSQL 16
  probes exercised these exact bytes on an installer-managed `qualified-v2`
  install, with a runtime login that is `NOSUPERUSER`, `NOBYPASSRLS` and
  `NOINHERIT`. These probes are not committed tests in this checkpoint.
  - Before the unit, all four writers fail with `42501`.
  - After it, the writers succeed:
    - pause, resume, slide and cancel apply, each with a receipt;
    - recovery issue returns `issued`, then `replayed`;
    - set and heartbeat record, then replay;
    - settlement records exactly one claim event, and repeated or later
      statuses add none.
  - Refusals after the unit:
    - every actual update on the three locked tables fails, through the row
      security check or the existing append-only trigger;
    - on claim events, reading other columns, update, delete and row locks all
      fail;
    - a conflicting append does nothing.
  - anon, authenticated and the restore login hold no access before or after.
  - A second application refuses through the guard.

Simplicity pre-check: this extends the existing fixed identity list and
ordering check exactly as the runtime-completion and owner-path tails did.
Refused alternatives:

- editing the issued units, whose approvals are immutable;
- a column grant without row security, which would admit a real update of
  the granted column on control operations and term lines (recovery commands
  also have an append-only trigger);
- changing a function, which is a routine or security-mode change;
- a shared portable forward, which the closed classes refuse because it carries
  table grants.
