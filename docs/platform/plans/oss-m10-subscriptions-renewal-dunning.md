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
Native generic bundle commands and command-bound receipts arrive with a later native command lifecycle;
until then, the descriptor refuses them. Multi-cycle
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
