# Subscription renewal and dunning design

Status: development-preview design. This page grants no activation or release authority.

## Contract and placement

Use only `@openlup/platform/subscriptions` and its type-only browser contracts
subpath. Reuse core subscription arithmetic. Preserve original schedule text,
identity/key bytes, complete frozen snapshot and claim fencing. Delivery
admission can defer without terminal refusal and retain a durable case reference.
Verified payment evidence retains ambiguity, late-positive identity, nullable
money and occurrence/first-recorded clocks. Logical cycle numbering is correlated
by evidence, separately from native counters and activation.

## Transaction and execution design

The native graph atomically prepares cycle/order/items/settlement/reservation and
attempt, and atomically applies settlement/outcome/schedule/counter/reservation.
Recovery must settle the original obligation with receipt/case/counter updates
in one transaction. The managed graph retains separate create/prepare and failure
RPC units. External execution occurs once outside SQL transactions. Ambiguity or
missing acknowledgement permits readback, never redispatch. The generic runner
is default off with one executor and mandatory delivery admission. Host
composition supplies policy and stores.

## Continuity and capabilities

Automatic payment exhaustion leaves active subscriptions active, with an open
repair case and deliberate null retry. Recovery authorizes method and rung before
scheduling the same cycle. Nothing automatically pauses an active subscription.
Late actual delivery extends the next cycle using a monotonic maximum, never
earlier or stacked. Never confirm replacement arrival before customer receipt.

Stock wait retains the original frozen binding, deficit/notice state and fair
candidate scan. All-line reacquisition shares the wait transition transaction;
stock-only reset refuses prepared, acknowledged, ambiguous or money-owned work.
Future-term commands preserve the frozen current obligation and require actor,
key and actual-command receipts committed with their events and term writes.
N2 is designed to bind generic bundle commands and command-bound receipts in
one native transaction after N1, with a separately persisted preview quote.
Future prices lock until edit without proration; existing claims remain frozen. Multi-cycle
prepaid is unsupported with a named refusal. Existing native lifecycle commands remain.
M04 owns delivery of host-described lifecycle facts; providers, account
aggregation, private pricing/copy and scheduling hosts remain outside the module.

## Verification boundary

[Port fit](../../../packages/platform/test/subscriptions/portFit.test.ts) covers the
contract amendments. [Current-prefix PostgreSQL](../../../tests/postgres/subscriptionContinuityBaseline.test.ts)
proves arrival maximum/no stacking and native exhaustion without pause. With mode
off and no captured case, renewal proceeds without an admission RPC.
After rollback to `off`, shadow cases are admitted. Captured protected cases
still go through admission and defer until actual arrival: `protect` releases
the case; `auto_align` settles as `aligned` using the latest arrival plus cadence
with the outer maximum, never earlier or stacked. `manual_review` cases, including
protected cases whose arrival meets open dunning or a successor cycle, keep
deferring until resolved.
Subsequent stores require their own
transaction, replay, contention and refusal proofs before serving composition.
The [package owner](../../../packages/platform/README.md#subscription-contracts-and-renewal-port)
and [canonical contract](../CANONICAL_CONTRACTS.md#subscription-port-boundary)
own public behavior; this design does not certify implementation or adoption.

## Unchanged hosted contribution and naming map

The hosted mechanism comes from the donor source pinned at `52ecb4d45`.
These input paths are relative to that donor, not the platform tree:

```text
server/domains/subscription/renewalCycleMechanism.ts
server/domains/subscription/renewalCycleRefusalMechanism.ts
server/domains/subscription/renewalCycleFailureMechanism.ts
src/domains/subscription/renewalCycleContracts.ts
```

The refusal and failure helpers are required dependencies of the cycle mechanism;
include them together before any later refactor or serving-facade rebinding.
Preserve their callback receivers, getter/await timing, error identity, original
key policies, durable occurrence time and intentional null retry. Admission,
channel and mandate checks precede order, stock, intent, prepare, execute and
finalize. Prepared replay never executes again; finalization stays outside the
execution catch. The hosted compatibility result for blocked admission remains
`skipped`; native admission's separate `deferred` contract is not cast into it.

The complete naming and placement adaptation is:

- Move the three executable source basenames unchanged into
  `packages/platform/src/subscriptions/`; redirect their donor contract imports
  to “./contracts/renewal.js” and keep helper imports local.
- Place the donor hosted contracts in [contracts/renewal.ts](../../../packages/platform/src/subscriptions/contracts/renewal.ts) alongside the
  distinct native envelopes. Rename only donor `RenewalDue` to
  `HostedRenewalDue` to prevent conflating hosted RPC and native claim carriers.
- Replace the donor payment-port import with a local structural projection of
  M07's `PreparedAttemptPrepareInput`, `PreparedAttemptPersistenceResult`,
  `PreparedAttemptFinalizeInput` and `PreparedAttemptPersistencePort`, each
  prefixed `Renewal`. These type-only shapes retain every field, generic bound
  and nullability; the contracts subtree imports only itself and public core.
  This avoids a new cross-module edge or a second payment implementation.
- Reuse `@openlup/core/payment` types and
  `@openlup/core/subscription.nextRetryAttemptAt` unchanged. Snapshot records
  remain opaque host policy inputs in the hosted compatibility seam, and M07's
  existing request/response DTOs retain their payload fields. Native envelopes
  retain concrete frozen snapshots; no raw store or provider response is added.
- Retain both donor characterization suites in
  [renewalCycleMechanism.test.ts](../../../packages/platform/test/subscriptions/renewalCycleMechanism.test.ts): redirect local imports,
  use the existing inventory entry's identical error class, apply the same
  `HostedRenewalDue` rename and isolate the failure suite's fixture in a block.
  Preserve every test body and assertion. Export the contributed functions and
  policy types explicitly from the server entry and hosted carriers explicitly
  as types from the contracts entry.

No vendor name, persisted value, error code, key byte or executable expression
requires neutralization. Further behavior changes need their own contract and
characterization decision; later native stores do not inherit hosted readiness.


## P2 design and declared adaptations

P2 carries only pinned N1, in native version order before N2 and N3. Its F16
repair uses the same obligation through decline, retry and authorized recovery.
The shared PostgreSQL selection checks exact-prefix restart, catalog rollback,
ACLs, replay, contention, atomic prepare failure, exhaustion and each captured
alignment rollback branch. It is not a serving or activation receipt.

The application hosted charge/failure facades bind the P1 mechanisms to existing
M07 ports and existing policy functions. Their order, persisted reasons, durable
failure instant, deliberate null retry and idempotency keys remain unchanged.
Native orchestration follows the donor's claim/resume/admit/reserve/prepare/
execute/ACK/readback/handoff order with these declared H1–H7 adaptations:

- Native carriers use P1's frozen pricing/order/template envelopes and separate
  evidence-bound logical cycle from native renewal counter (H2, H7). The codec
  preserves the original wire snapshot, key and fingerprint dialect.
- Execution input, validation, provider failure classification and key policy
  are injected (H3); normalized explicit failure reason/class survives the
  payment port. M07 still owns execution and truth.
- Readback consumes verified evidence identity, observation/first-recorded time,
  ambiguity and nullable money (H4). Missing positive money or occurrence cannot
  settle or authorize a new charge.
- G23 deferral keeps its case reference (H1). Existing native transaction units
  and the N1 retry receipt fence remain intact (H5, H6).

The initial native binding opens the existing donor-keyed dunning case first,
then records terminal outcome, N1 bookkeeping and the same-case link in one
local transaction. Initial failure handoff never calls N1's apply-failure route;
its terminal binding applies bookkeeping only after the original outcome.
Subsequent retry failures retain apply-before-case order. A synthetic failure
between terminal recording and bookkeeping must roll back both; replay after
recovery must remain idempotent. This resolves N1's wrapper precondition without
changing its pin, introducing another case store, or executing payment in SQL.


## P3b managed continuity and declared expectation changes

P3b lands only reviewed managed M1 `20261024155000` and M2 `20261024160000`
on native N1. The SQL bytes match the CTL fixtures. M1 is the approved minimal
lifecycle-only adaptation: refund settlement preserves subscription status,
cycle payment history and activation facts while retaining the existing
first-cycle stock-release guard. M2 preserves active service and an open case
with deliberate NULL retry at exhaustion. Token consumption, durable payment
method and current cycle/rung must converge before same-cycle recovery; replay
cannot grant another retry or charge. The core compatibility function retains
its signature but no longer pauses or emits an event on exhaustion.

The managed proofs are
[refund independence](../../../supabase/tests/refunds_preserve_subscription_lifecycle_test.sql),
[dunning continuity](../../../supabase/tests/subscription_dunning_continuity_test.sql)
and [delivery alignment](../../../supabase/tests/subscription_continuity_delivery_alignment_test.sql).
Their currency, region, city and payment-provider fixtures are synthetic; the
refund proof uses the existing generic settlement boundary without F17 evidence.
They exercise only M1/M2: runtime-role calls, exhausted repair, token/method/rung
arrival order, stale authority, replay, failed/successful same-cycle settlement,
refund independence and late-arrival maximum without stacking. Core lifecycle
witnesses describe active service after new exhaustion. Example expired-payment
copy also serves preserved legacy paused/expired episodes, so it describes payment
completion and subscription continuation without asserting service status or which
cycle the recovery link pays.

Every changed incumbent or characterization expectation is enumerated below.
Paths are repository-relative; the table is also the pull-request body ledger.

| Incumbent witness | Changed expectation or setup | Why the new value is correct |
| --- | --- | --- |
| `packages/core/test/subscriptionDunningPause.test.ts` | Custom-ladder exhaustion returns `active`; exhausted transition preserves the entire subscription and emits `[]`, including replay. Historical resume fixtures seed `paused` explicitly. | Exhaustion never suspends service; existing paused records retain their separate recovery path. |
| `supabase/tests/subscription_apply_result_guards_test.sql` A3 | First-cycle refund leaves subscription `active`, cycle `paid` and original `paid_at`; inventory remains `released`. | M1 removes lifecycle reversal while retaining the existing stock-release effect and paid history. |
| `supabase/tests/subscription_apply_result_guards_test.sql` R6 | Final case `open`, `expired_at` NULL, subscription `active`, pause events `0`, token `repair_payment`; NULL retry, final notice and due-list count `0` remain. | M2 stops automatic retries without expiring or pausing service; explicit repair authorizes the original obligation. |
| `supabase/tests/subscription_dunning_open_without_retry_test.sql` | Exhausted arm becomes `open`/NULL expiry/`active`/`0` pause events/`repair_payment`; both arms now have equal open status. Final notice and 30-day exhausted window remain distinct from the early 14-day arm. | An absent retry never pauses service, regardless of rung; rung-specific communication and token windows remain. |
| `supabase/tests/subscription_hard_do_not_retry_terminates_test.sql` arm D | Exhaustion becomes `open`/`active`/`0` pause events and a 30-day `repair_payment` token. | M2 changes exhaustion only; early hard-stop and ordinary retry arms keep their assertions. |
| `supabase/tests/subscription_renewal_preflight_ladder_test.sql` | Final case `open`, subscription `active`, one unrevoked `repair_payment` token instead of one resume token. | Current-rung repair replaces automatic pause/resume; earlier rung tokens are revoked and the final notice remains. |
| `supabase/tests/payment_recovery_sha256_test.sql` | Both historical exhausted fixtures explicitly seed `expired`, `expired_at` and `paused`; recovery assertions remain unchanged. | New exhaustion cannot manufacture a historical episode; M2 leaves stored history and its recovery compatibility intact. |
| `supabase/tests/subscription_resume_after_expired_dunning_test.sql` | Explicitly seed historical `expired`/`expired_at` before the existing paused fixture; retain the expired precondition and resume assertions. | The historical resume contract still applies, but current exhaustion no longer creates its preconditions. |
| `src/domains/subscription/emails/subscriptionEmailContent.test.ts` | English/Polish expired-payment renders cover legacy `resume_subscription` and current `repair_payment` links, with/without amounts or a link, and assert no service-status or cycle claim. Failed-payment retry/no-retry renders retain their own assertions, including absent/future dates. | P3B-R2-1: the expired notice serves both preserved paused/expired episodes (resume starts a fresh cycle) and new open exhaustion (same-cycle repair); shared copy cannot assume either state or cycle. Non-expired failed notices retain their scheduled-retry or explicit no-retry meaning. |
| `scripts/reviewed-batch-forward.test.ts` | Add the N1+M1+M2 landed replay case using the existing rail iteration. Plant changed M1 bytes beneath landed M2 and require CI/release refusal. | Folded E retains M10-2's interleaving-aware replay and adds the landed-prefix witness; folded D exercises earlier same-rail digest refusal without altering admission policy. |
| `src/lib/subscriptionDunningBoundary.test.ts` | Effective failure body keeps exhausted dunning `open`, issues `repair_payment` and contains no pause or `payment_failed_expired` write; payment-table and provider-name refusals remain. | M2 replaces automatic pause with open exhaustion and original-cycle repair authority; the witness must inspect the newest function contract. |
| `src/domains/communications/email/__snapshots__/templateParity.test.ts.snap` — `subscriptionPaymentExpiredEmailContent` | Whole-content/render digest changes from `50bf6af1…` to `cbe65ef6…` (repair 2 replaces `a5c8a46e…`); repair 2 changes only this golden. | P3B-R2-1: bilingual expired-payment copy now describes unsuccessful payment and a link to complete payment/continue the subscription, truthfully covering both legacy resume and current repair without a service-status or cycle claim. |
| `src/domains/communications/email/__snapshots__/templateParity.test.ts.snap` — `subscriptionPaymentFailedEmailContent` | Whole-content/render digest changes from `f5e8dd75…` to `f6c90164…`; other template digests remain unchanged. | The non-expired failed-payment template announces a scheduled final retry and active service if it fails under M2. Its separate retry/no-retry branches remain truthful; repair 2 leaves this copy and golden unchanged. |
| `tests/postgres/reviewedBatchForwards.test.ts` | Unchanged from M10-2: the existing inline replay partition handles interleaved files. | No P3b helper extraction or catalog-gate change is needed to land M1/M2. |

Folded scope: **E-gate-replay-loop-landed-untested** retains M10-2's existing
interleaving-aware replay and adds the Docker-free landed N1/M1/M2 case.
The rail helper and PostgreSQL gate remain unchanged from M10-2.
**D-earlier-pin-digest-unplanted** adds only the changed-earlier-M1 refusal plant.
Neither changes registry pins, fixture bytes or permitted catalog effects.

Cuts register honored: C2 and C93 retain refund/lifecycle independence with
explicit cancellation separate; C3–C8 leave refund-evidence parity to F17;
C9–C13 retain the minimal M2 adaptation, explicit projections and later M4
stock-wait exclusion; C49 leaves historical paused/expired/refund-cancelled
records untouched. No history repair, stock-wait, winback-floor, native refund
capability or adopter characterization change is included. The staged ATP,
stock-wait and lifecycle-message/winback tests remain with P5/P6; policy-data
seed tests belong to that later prefix. No F17-only proof is imported.

Migration notes: apply M1 then M2 through the managed chain. Existing exhausted
rows are not rewritten or reactivated. New exhaustion keeps service active,
with no scheduled retry until authorized same-cycle repair. Refunds no longer
cancel the subscription or erase paid-cycle history. Explicit lifecycle commands
remain separate. No executor, scheduler, release or adopter activation is granted.
