# Native OMS list predicate repair

Status: focused proof passed; frozen candidate preparing independent review;
development preview.

## Outcome, scope and authority

Restore the existing reduced native OMS control-plane list/count on the qualified
native schema. The task worker implements and obtains two independent fresh
reviews under the store supervisor. Local edits, tests and DCO commits are
approved. Stop at READY_FOR_VERIFY; final verification, submission and landing
wait for the programme lead's ordered instruction and payment-owner join
confirmation. No release, publication, hosted service or adopter change is included.

Worktree: `oss-m19-g12p`; branch: `codex/oss-m19-g12p`.
Code base and freshly fetched policy revision:
`bb0008481a11267ec6dbe3e7e531299777cddc19`.

Scope is one native adapter predicate, its adjacent mock assertion, one real
PostgreSQL witness, this record and additive catalogue rows. The managed adapter,
package files, SQL definitions, grants and migrations are excluded. The subsequent
store export must move the repaired body unchanged in its own task.

## Acceptance and sufficient evidence

Keep the cancelled status and both existing metadata marker conditions unchanged.
A marked order is visible when it has a renewal operation link, when any linked
settlement intent is settled, or when any linked payment truth event in any state
is captured or indeterminate. A marker without those
facts, including refused-only, is hidden. Non-marked orders remain visible.
List and count share one predicate; query errors remain errors without fallback.
The change repairs an internal native persistence query without changing the
public request/response boundary, managed rail, or a review/release control.

An owned disposable PostgreSQL instance must install the hash-checked qualified-v2
chain. Adapter calls use its restricted runtime login. Discriminating cases cover
both markers with no fact, settled intent, captured, indeterminate, refused-only,
no marker, count equality, repeated reads and detail read. A missing table grant
is a stop for the SQL owner, never a fixture grant. Mock assertions only check
SQL wiring; real PostgreSQL supplies behavioral proof. Focused tests, structural
rules, published-tree typecheck, lint and policy precede signed-commit review.

## Native join evidence and risk

`db/platform/migrations/20260810180000_payment_settlement_rail.sql:151-178`
defines `commerce_settlement_intents.order_id` as a non-null foreign key to
`commerce_orders.id` and its status set includes `settled`.
`db/platform/migrations/20260815150000_payment_truth_reconciliation.sql:23-49`
defines `payment_truth_events.settlement_intent_id` as a non-null foreign key to
`commerce_settlement_intents.id`; outcomes are captured, refused, indeterminate.
The same migration's existing reconciliation join at lines 147-148 confirms the
intent/event key. Proposed order correlation is `intent.order_id = orders.id`,
and event correlation is `event.settlement_intent_id = intent.id`.
The payment owner confirmed this join at the base revision by code inspection,
executing nothing; the task worker independently checked the defining foreign
keys and existing readback join before relying on that confirmation.

The base query references absent `commerce_payments`. Replacing only that guard
avoids a compatibility relation or error fallback. The renewal exclusion and separate NOT EXISTS clauses
preserve linked renewals and settled intent evidence without a truth event; the event clause
intentionally treats indeterminate as possibly taken money. The marker expressions
stay unchanged, but their combined value is tested as TRUE: absent metadata keys
produce SQL NULL, which must not hide an unmarked cancelled row. Real proof covers
empty metadata and an unrelated checkoutAbandoned value.

## Confirmed renewal boundary and known ingest dependency

The supervisor's continuation adds `orders.renewal_operation_id IS NULL` to the
conditions that must all hold to hide an order. No retry join is required.
Independent native-source checks at the pinned base establish:

- `db/platform/migrations/20260815120000_automatic_subscription_renewal.sql:226-244`
  adds the nullable order renewal key, its foreign key and fingerprint constraint.
  Preparation creates the linked order and intent at :874-916, and records
  `attempt_prepared` at :918-928 without inserting a truth event. Its outcome
  routine at :1038-1095 calls settlement and records renewal outcome/terminal
  state, without inserting a truth event. Settled intent evidence remains needed.
- `db/platform/migrations/20261022160000_subscription_retry_lifecycle.sql:9-22`
  relates retry obligations to renewal operation, order and settlement intent.
  Its prepare function at :218-270 sets `prepared` and writes a prepare receipt,
  without inserting a truth event. A dispatched attempt with no answer can
  therefore lack truth. The predicate conservatively retains every linked order.
- `db/platform/migrations/20260808180000_oms_order_hold_rail.sql:408-448`
  allows unpaid cancellation based on `pending_payment`, without refusing a
  prepared renewal/retry. The native adapter calls `oms_cancel_unpaid_order`
  (`server/adapters/postgres/omsControl.ts:64`); no native SQL function named
  `oss_cancel_unpaid_order` was found. The native cancellation mechanism is
  confirmed without asserting an untraced alias or a managed behavior change.
- `db/platform/migrations/q2_20261026130000_runtime_capabilities.sql:122-137`
  grants existing table read access including orders and settlement intents;
  :187 includes truth events. Real restricted-login column and table reads are
  still required evidence, not inferred solely from SQL grants.

Known gap, excluded from this repair: a verified capture after cancellation can
leave no truth row. Ingest inserts its event then immediately applies terminal
captured/refused outcomes without a surrounding exception handler
(`db/platform/migrations/20260815150000_payment_truth_reconciliation.sql:342-378`).
The current terminal implementation calls settlement
(`db/platform/migrations/20261022192000_invoicing_payment_decoupling.sql:57-69`),
and the current settlement replacement rejects a non-payable order before
writing settlement (`db/platform/migrations/20260826100000_late_payment_shifts_the_subscription_cycle.sql:125-138`).
That exception rolls back ingest and its event. This predicate cannot protect
against an absent fact. It depends on the separate payment-truth ingest repair
(G6); the subsequent G12 store-promotion record must carry the same dependency.
No claim that the native guard can never hide an order that took money is made.

Marker provenance: a scoped search of `db/platform/migrations/**` at the base
found no occurrence of `supersededByStableJourneyKey` or `checkoutAbandoned`,
so no native SQL writer of either marker was found and no native rows are
expected to be hidden by this scope today. This is an inspected-source limit,
not proof that every host can never supply metadata. The package failure handler
passes `checkout_journey_consumed` to its compensation port
(`packages/platform/src/commerce/server/commerceCheckoutFailureHandler.ts:87-97`);
that port's native binding was not traced. Neither observation changes the
approved predicate or expands this task to marker production.

## Execution evidence and delivery state

- Pinned Node 24.21.0 and npm 11.19.0; owned `npm ci` and package prerequisite
  builds (`npm run pretest`): PASS. Lockfile unchanged.
- Real `tests/postgres/omsControlPlaneNative.test.ts`: 2/2 PASS, 4.48 seconds.
  The complete selected qualified-v2 chain and ledger hashes/positions match;
  migration replay applies nothing. The actual runtime login is non-superuser
  without BYPASSRLS; it reads both money tables and the renewal key without a
  fixture grant. The absent `commerce_payments` relation is also confirmed.
- The database matrix seeds 18 orders: both markers against no intent, created
  intent, settled intent, open captured/indeterminate events and refused-only;
  both cancelled renewal-linked markers without facts; two unmarked cancelled
  orders; two non-cancelled marked orders. Exactly 12 are visible. Unpaginated
  list/count, cancelled filter, pagination and repeat reads agree.
- Reduced detail read (T03-02): PASS through the restricted runtime role for a
  hidden marker, including empty hold/operation reads; missing order returns null.
  This establishes the existing reduced projection, not rich OMS detail.
- Adjacent mock suite: 2/2 PASS. Structural ast-grep check: PASS.
  Final published-tree typecheck after the fixture repair: PASS, five projects,
  zero unresolved edges and zero diagnostics. `npm run lint`: PASS, zero errors
  and 33 existing warnings; no warning repair was attempted.
- Publication policy/navigation generation identifies two scoped no-impact
  explanations: existing PostgreSQL domain-binding guidance does not specify
  these payment relations or claim native/managed row parity; contributor test
  guidance already covers this fixture location, restricted login and helper.
  Their exact delta-bound trailers accompany the candidate commit. No owner
  prose claim, instruction, public API, control or gate budget changes.
- Measured npm package input delta: 0 files, +0 bytes. No package path differs
  from the base; the package subtree remains
  `30adf466d1d9de1e238d7db5322fd39ec3fbdbc8`. No package artifact was repacked.
  Managed adapter, migrations, grants and package sources remain unchanged.

The initial policy invocation before staging refused the two new files as absent
from the materialized inventory; staging the intended set resolved that check.
The first attempted runner launch lacked the local binary directory on PATH and
executed no tests. After fixing PATH, the first database execution failed during
fixture setup with conflicting UUID/text inference for one reused parameter;
behavioral tests did not run. A separate text idempotency parameter repaired
only the fixture, then the complete database suite passed. Raw logs, including
failures, remain in this worktree's ignored `.context/scratch/`.
The fixture seeds persisted money facts via the owner; it does not qualify
payment ingest or repair the known post-cancellation ingest gap.

Native review starts at cycle 0, with two fresh independent reviewers required.
The frozen committed candidate and subsequent actual reports, finding closure,
cycle and expiry live in `.context/scratch/agent-review/`. No canonical final
verification, PR, merge or release is claimed. The lead names the verification
and landing slot after review; the same G6 dependency applies to G12's record.

Self-retro: focused admission waits (30–213 seconds observed per stage)
dominated elapsed work. Reusing one untyped fixture parameter as both UUID and
text caused the avoidable setup failure; distinct idempotency input is simpler
than adding casts or retry logic. Trace native foreign keys and use real runtime
proof before calling a source-only read ready. The direct shared predicate needs
no fallback, compatibility relation, retry join or new abstraction.

## Authorized integration and landing continuation

The programme lead named this row for final verification and delivery. The
supervisor explicitly authorized merging current main, resolving only the
catalogue overlap as an additive union, fresh integration review, full local
verification, push, PR, source receipt and queueing. Stop at queued or merged.
No release, publication, credential, settings or other-row authority is added.

Fresh policy revision and integration base:
`09cd599bfef6bff74f4431b0cf7a00ebf80f1e6a`. Applicable agent/contributor,
AI-accountability, native-review and verifier instructions are unchanged since
the previous policy pin. The prior candidate was
`92e19e3e7e3caee04c42427a8e94834ce3ad7c93`, tree
`bfaa16497ccef92337da8a9a27053b47ea47589c`.

The actual merge produced exactly one conflict:
`config/openlup-publication-catalog.json`, where both branches added task rows
at the same insertion point. Resolution preserves every byte from main and
adds only this task's record and PostgreSQL-test rows at their sorted positions.
Removing those two exact row blocks reproduces main's catalogue byte for byte;
JSON parsing also passes. No other conflict exists. Native adapter and both
behavioral tests remain byte-equal to the prior candidate. Changes inherited
from main include the packaged migration runner/facades and communication
conformance; their interactions are included in the integration review.

This is a manual additive union, not mechanical integration. Native history,
reviewer exclusions, findings and earliest applicable source expiry carry on;
ordinary prepare must charge the changed candidate, with no cycle refund.
The earlier cycle-0 state remains historical. Focused merged-tree checks, two
fresh integration reviews and full canonical verification are required before
submission. Exact post-commit evidence and delivery identities remain in the
existing ignored native/verification evidence so the reviewed tree stays frozen.

Continuation self-retro: a catalogue insertion conflict needs an additive union
and a byte-preservation check, not a rebase or a mechanical-merge exemption.
The shared single predicate remains the smallest adequate repair; no production
or test logic was added during integration.
