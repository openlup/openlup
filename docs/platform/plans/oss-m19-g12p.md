# Native OMS list predicate repair

Status: bounded queue-failure continuation; focused checks and fresh full
review precede READY_FOR_VERIFY; development preview.

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

The initial native review started at cycle 0, with two fresh independent
reviewers required. The frozen candidate and subsequent actual reports, finding
closure, cycle and expiry live in `.context/scratch/agent-review/`. At that initial
review stage, no canonical final verification, PR, merge or release was claimed. The lead names the verification
and landing slot after review; the same G6 dependency applies to G12's record.

Self-retro: focused admission waits (30–213 seconds observed per stage)
dominated elapsed work. Reusing one untyped fixture parameter as both UUID and
text caused the avoidable setup failure; distinct idempotency input is simpler
than adding casts or retry logic. Trace native foreign keys and use real runtime
proof before calling a source-only read ready. The direct shared predicate needs
no fallback, compatibility relation, retry join or new abstraction.

## Authorized integration and landing continuation

In the prior landing round, the programme lead named this row for final
verification and delivery. The supervisor explicitly authorized merging current main, resolving only the
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

## Queue failure and bounded synchronization continuation

Current policy and merged main: `4c7afd2590dc6998e22464153fca70a92eecfeb2`.
The approved continuation adds only a synchronization wait in
`src/public-reference/browserIdentity.test.tsx` and this record, with two fresh
full reviews against the new base. Stop at READY_FOR_VERIFY: canonical verify,
push, PR-description update, receipt and queueing wait for the next named slot.
This is ordinary repair accounting, cycle 2 of 3. No integration-delta shortcut,
mechanical exemption or inherited PASS is used. The prior integration reports
were recorded at 2026-11-02T00:06:27.904Z and :28.042Z; their inherited source
expiry was 2026-11-02T21:28:01.056Z. The new full-review candidate gets its own
24-hour clock from its earliest counted PASS, recorded in the existing native
session evidence after review. Historical reports are retained, not copied.

The merge preflight refused the old head. The actual merge had one textual
conflict, `config/openlup-publication-catalog.json`: adjacent additions for this
record and the integration-trailer plan. Manual additive union kept both plan
rows in sorted order and every other main byte; removing this task's existing
two row blocks reproduces main byte for byte. No other conflict existed.
Merge commit: `ff76a33c` (first parent `a65c902b`, second parent `4c7afd25`).
The native adapter and both OMS test files are byte-equal to `a65c902b`.

Stable patch-id evidence, excluding this task record, before the browser fix:
`git diff 09cd599b a65c902b -- . ':!docs/platform/plans/oss-m19-g12p.md'`
piped to `git patch-id --stable` gives
`09bff96174caf525622a0da4f06aff70eb211d3d`; the corresponding diff of
`4c7afd25` to `ff76a33c` gives `4b0ad8f16475069314ec1ae60a1ef46ea4e35360`.
These context-bearing IDs differ because the adjacent catalogue context changed;
this is not mechanical proof. With `git diff --unified=0` on each same range,
both stable patch IDs are `0aa42eb4e6a1645347eedcf9d55b70b59a6dd754`.
The additive-union byte check and unchanged adapter/test blobs establish the
actual merge content independently. The subsequent browser test edit is an
intentional additional delta, not claimed patch-equal to the old candidate.

Merge-queue run `41367542443` failed one test in
`src/public-reference/browserIdentity.test.tsx`, at old line 132: the account
bearer assertion received undefined. Dependent aggregate jobs also failed.
The synchronization cause is a CANDIDATE and was NOT reproduced: source PR run
`41366544248` passed and the failed group run had the identical tree
`37ba29b31da2bcf6d5dde0d3965768e68bf7eb12`; 20 of 20 gated isolated runs and
one full shard 2/4 run passed on main
`09cd599bfef6bff74f4431b0cf7a00ebf80f1e6a`. The full shard passed 553 files
and 5301 tests with two declared skips. One earlier ungated isolated pass was
disclosed and excluded from those 20 runs. The old assertion is unchanged since
2026-10-18 (`02118d53`). In the latest 100 Published Tree CI runs inspected
(68 successful, 3 failed, 27 skipped, 2 cancelled), no other failure of this test
was found in the failed-run logs; all 23 main-push runs succeeded, although those
can reuse exact merge-group evidence. This does not establish a failure rate on CI.

The source gap is specific: the test awaits the account heading at old line 130
and immediately reads the fetch and query cache at old lines 132-133.
`SubscriptionAccount.tsx:119-127,160-173` renders that heading independently of
account-query readiness; `useAuthenticatedAccountLifecycle.ts:62-70` starts its
read through React Query. The query subscription is effect-backed
(`@tanstack/react-query/src/useBaseQuery.ts:107-112`,
`@tanstack/query-core/src/queryObserver.ts:95-100`). The heading alone therefore
does not establish fetch/cache readiness. That is source evidence of a gap,
not an observed trace of the failed CI interleaving or proof of an OMS cause.

The browser-only fix awaits `waitFor` on the exact bearer and cache conditions
before the original assertions. Every original assertion and expected value
remains unchanged. No production code, setup, timeout, retry setting, exclusion
or skip changes. This is a synchronization fix and does not claim to remove a
reproduced fault. Passing focused runs after the edit do NOT prove the fix,
because the original failure never reproduced. No injected-delay experiment is
claimed. If the same test fails again in a merge group, stop and report without
retrying. The browser-identity test owner owns any further diagnosis or repair;
queue decisions remain with the delivery supervisor.

The PR description, updated only after a later authorized push, must retain the
same candidate/not-reproduced wording, identical-tree comparison, main-run
counts, source-gap explanation and historical limits above. It must also retain
the native OMS repair description, no SQL/grant/migration and package +0-byte
scope, and the existing capture-after-cancellation ingest dependency.

Fix commit: `7c46bc57` changes exactly one file by adding the four-line wait.
Removing that block reproduces every original byte of the browser test.
After the intentional fix, the final change against `4c7afd25`, excluding this
record, has stable patch ID `341eff71b7997b2dd022b624860f0fe75b33259c`
(or `e7ff7dbe7593d4f9005462620e342964dae05f28` with zero context).
This additional test delta is explicitly not asserted equal to the old patch.
The adapter and existing OMS test content remain unchanged.

Documentation policy/navigation generation passes with three accepted scoped
no-impact answers. The two existing OMS unit digests remain current; the added
reference-test unit has digest
`sha256-abdac7eb1d4483996ed3f23609b4f913da533437e6274e166bd243f17642f323`
in the fix commit. Its owner, runtime/self-hosting's disposable-reference section,
and the linked browser-identity guidance still accurately describe the same
bearer, cache, logout and runtime boundaries. No documentation control or public
claim changes. Package-source delta against current main is 0 files, +0 bytes.

Current focused evidence before fresh full review (Node 24.21.0, npm 11.19.0,
Vitest 4.1.12, macOS, existing install): all seven independent invocations of
`CI=true npm test -- --config vitest.config.ts --project dom src/public-reference/browserIdentity.test.tsx`
passed, 24 tests each, 168/168 executions. Five used the ordinary worker
selection; two additionally used `--maxWorkers=1`. Each invocation followed its
own successful focused-gate admission. Vitest durations were 1.32-1.99 seconds.
These passes do NOT prove the synchronization fix: the original fault was not
reproduced. No injected-delay experiment, broad shard rerun, test retry or
canonical verify was run in this continuation.

`npx --no -- ast-grep scan --error=no-suppress-all --error=unused-suppression`:
PASS. `npm run oss:published-tree -- --typecheck`: PASS across all five projects,
zero unresolved edges and consumer errors. `npm run lint`: PASS, zero errors and
33 warnings. Typecheck and lint each followed their own focused-gate admission,
serialized after the browser runs. `npm run oss:published-tree -- --policy --docs-update`:
PASS with all three documentation obligations answered. The initial invocation
reported the new reference obligation; its delta-bound trailer in the fix commit
resolved it without changing owner prose. Raw command logs and exit records
remain under this worktree's ignored `.context/scratch/g12p-cycle2-*` paths.

The committed real-PostgreSQL visibility/refusal matrix, restricted-runtime
checks and reduced-detail witness remain in the full-review packet, unchanged
from the actual prior qualified-v2 proof. No fresh database execution is claimed
in this continuation; canonical verification remains a later named-slot duty.
The new full-review source identities, actual reports and own expiry are retained
in the append-only native session after this record is committed. No report is
copied, no earlier expiry is renewed and no repair cycle is refunded.

Continuation self-retro: focused admission dominated elapsed time (lint alone
waited 361 seconds), while each browser execution took under two seconds.
Check supported runner flags before scheduling optional variants. The smallest
adequate synchronization is the direct existing `waitFor` on both values that
the original assertions read; no helper, production seam or timeout increase is
needed. A plausible source gap must retain its not-reproduced evidence limit.
