# Qualified runtime lock and conflict completion

SQL admission update, 6 November 2026: supported class data, exact approval pins
and SQL may land together under the [current admission rule](../DATA_AND_MIGRATIONS.md#co-located-sql-and-approval-pins).
Earlier requirements here for a separate class or pin approval before SQL are
historical; other scope, proof and owner gates remain unchanged.

Status: checkpoint 3 of 3 (active SQL). The reader preparation, the approval
pin and the delivery destination forward land before it.

## Outcome and boundary

Before this unit, the restricted runtime login on both qualified generations
(`qualified-v2` and `qualified-admin`) could not complete five existing native
paths. Each failed with `42501` and wrote nothing:

| Writer | Locked or written table | Issued runtime grant |
|---|---|---|
| Subscription command apply (cancel, pause, resume, slide), customer store and operator support wrapper | renewal term lines, locked `FOR UPDATE` | `SELECT`, `INSERT`, `DELETE` |
| Operator recovery issue | recovery commands, locked `FOR UPDATE` | `SELECT`, `INSERT` |
| Platform control set and heartbeat | control operations, locked `FOR UPDATE` | `SELECT`, `INSERT` |
| Order promotion-claim transition trigger, on any runtime settlement of an order with a claim | claim events, appended with `INSERT … ON CONFLICT (claim_id, event_key) DO NOTHING` | `INSERT` only |
| Operator lead absorption, counting blocking rows per client | delivery destinations, read by client | none; row security already enabled |

The first four tables had no row security; delivery destinations already did.
The legacy and managed chains are unaffected.

The fix is one shared qualified completion unit,
`q2_20261103200000_runtime_lock_and_conflict_completion.sql`. Both qualified
plans select it after their issued tails. Its exact bytes equal the approved
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

For delivery destinations, it grants `SELECT (client_id)` and adds a runtime
`SELECT` policy, `USING (true)`. Without the policy, the existing row security
would silently return zero rows, and absorption would miss a blocking
destination. Addresses stay unreadable, and every write stays unavailable.

The pattern follows the issued runtime unit's lock-only precedent for privacy
erasures. The guard repeats the runtime-completion binding checks. It also
requires the unswitched installer to own the four row-lock and arbiter
targets, with no row security or policy yet. It also requires the delivery
destinations to be in their exact post-creation state: owned by the installer,
row security on without `FORCE`, no policy, and owner-only table and column
privileges.

Order dependency: the active unit must follow the delivery destination forward
in the shared order. The inert fixture and the approval pin have no runtime
effect, so they can land first. A grant or policy that any other change adds to
delivery destinations before the active unit would make its guard refuse every
installation.

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
     - absorption applies without destinations and refuses by name with one;
     - replays add no duplicate;
     - actual updates, other event and destination reads, and destination
       writes are refused;
     - the guard refuses a destination table in any other state;
     - access for every other role is unchanged;
     - legacy and managed stay untouched.
   - Existing pinned qualified-runtime limits become positive proofs.

## Checkpoint 3 acceptance and proof

The active file is byte-identical to the approved fixture, and its packaged
copy and projection are regenerated. Both qualified plans append it last. The
four qualified inventories are measured again on PostgreSQL 16:

| Plan | Installer shape | Digest prefix |
|---|---|---|
| qualified | bootstrap | `3f7044a5` |
| qualified | separate | `0f3b53ca` |
| restricted | installer-managed | `1454db63` |
| restricted | operator-provisioned | `1c3d47d5` |

The composition, restore and upgrade witnesses pin these values and the new unit
counts: qualified 103, restricted 102, legacy 98 unchanged.

The [witness](../../../tests/postgres/qualifiedRuntimeLockCompletion.test.ts)
runs on `qualified-v2` and on operator-provisioned `qualified-admin`. Each run
uses an actual restricted runtime login. It proves:

- **Row security and access.** It is bound on the three locked tables with
  exactly the expected policies, table grants and column grants. Claim events
  stay without row security and gain column `SELECT (claim_id, event_key)` only.
  Delivery destinations keep row security, gain the one runtime select policy
  and column `SELECT (client_id)` only.
- **Roles.** It enumerates every non-predefined role reaching each target: the
  installing owner, the superuser, the runtime group and the runtime login. On
  `qualified-v2` the installing owner is the superuser itself; on
  `qualified-admin` it is the non-superuser migration login. anon,
  authenticated and the restore login hold nothing.
- **Lifecycle commands.** Cancel, pause, resume and slide apply through the
  customer command store; pause, resume and slide through the operator support
  wrapper. Each records a receipt.
- **Recovery issue.** It returns `issued`, then `replayed`, with one receipt.
  Receipt updates refuse; the existing append-only trigger answers first, so
  the lock-only check is observed on its own on control operations and term
  lines.
- **Platform control.** Set and heartbeat record, then replay. Receipt updates
  refuse.
- **Claim settlement.** Settling an order with a promotion claim records
  exactly one `redeemed:paid` event. Repeated or later statuses add none,
  because the transition returns before appending; a direct conflicting append
  as the runtime inserts nothing, which proves the arbiter path. Reading other
  columns, row locks, updates and deletes on events all refuse.
- **Absorption.** A lead without destinations is absorbed, then replayed. A
  lead with one is refused with `lead_has_commercial_footprint` naming
  `commerce_destinations`, on replay too, and its client and destination rows
  stay unchanged. The runtime can count destinations by client, while reading
  addresses or whole rows, row locks, inserts, updates and deletes refuse.
- **Term lines.** Every actual update on term lines refuses, including
  `SET col = col` and `ON CONFLICT DO UPDATE`. Reads, row locks, inserts and
  deletes keep working.
- **Guard.** A second application of the unit refuses through its guard. With
  the four lock and conflict targets returned to their prerequisite state
  inside a rolled-back transaction, the unit applies only to a delivery
  destination table in its created state. It refuses with
  `runtime_lock_completion_destination_state_invalid` for the installed state,
  a renamed table, disabled or forced row security, an extra policy, a table
  grant and a column grant.

The existing pins of these limits on the destination, purchase-hold,
retained-renewal and notice-delivery witnesses become positive proofs on the
restricted runtime:

- operator pause, resume and slide apply with one support command;
- absorption applies without destinations, replays, and refuses one lead
  destination by name with only its command and audit rows added;
- absorption of a lead blocked by a privacy erasure, a command receipt or a
  stock wait refuses by that table, not by destinations, with only its command
  and audit rows added, and the unblocked lead applies and replays;
- operator recovery issuance records one command, one notice and one token,
  and its replay adds none;
- command cancellation beside purchase owners applies without changing them;
- the stale promotion sweep cancels its order, while the runtime still has no
  table-wide claim-event `SELECT`.

The issued-prefix observation in the purchase-hold setup still refuses,
because that prefix ends before this unit. The account-consents witness now
expects this tail after its forward on every qualified profile, and no tail on
legacy.

The legacy and managed chains are untouched: the legacy plan and its inventory
are unchanged, and no `supabase/` path changes.

## Checkpoint 2 acceptance and proof

The registry gains exactly one row at position 17: the completion path and
SHA-256 `6f360a14e5e722a9930fb845e40c5c25aa4d5bf1a20fd9bb23d22b0c6b75f2b1`, equal to the unchanged inert fixture. Every earlier row and every
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
  - Before the unit, all four writers fail with `42501`, and so does lead
    absorption at the destinations count.
  - After it, the writers succeed:
    - pause, resume, slide and cancel apply, each with a receipt;
    - recovery issue returns `issued`, then `replayed`;
    - set and heartbeat record, then replay;
    - settlement records exactly one claim event, and repeated or later
      statuses add none;
    - a lead without destinations is absorbed, then replayed, and a lead with
      one is refused naming `commerce_destinations`.
  - Refusals after the unit:
    - every actual update on the three locked tables fails, through the row
      security check or the existing append-only trigger;
    - on claim events, reading other columns, update, delete and row locks all
      fail;
    - a conflicting append does nothing;
    - on delivery destinations, reading addresses or whole rows, inserts,
      updates, deletes and row locks all fail.
  - The absorption probe ran on the delivery destination forward, with the
    pending block classifications inserted as the shared order will hold them.
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
