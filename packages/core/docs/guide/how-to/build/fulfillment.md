# Compose native fulfillment

Prepare shipments from authoritative application facts, exercise dispatch with
synthetic captures, and bind label, handoff and tracking commands to authorized
operator handlers.

## Choose the imports

Use `@openlup/platform/fulfillment/native` for native bindings and stores; see
its [API report](https://github.com/openlup/openlup/blob/openlup-core-v0.42.0/packages/platform/api/fulfillment-native.api.md). Use
`@openlup/platform/fulfillment` for dispatch composition and captures,
`@openlup/platform/fulfillment/contracts` for request and port types, and
`@openlup/platform/composition` for contribution composition. Consult the
[API report](https://github.com/openlup/openlup/blob/openlup-core-v0.42.0/packages/platform/api/fulfillment.api.md), [contracts report](https://github.com/openlup/openlup/blob/openlup-core-v0.42.0/packages/platform/api/fulfillment-contracts.api.md)
and [composition report](https://github.com/openlup/openlup/blob/openlup-core-v0.42.0/packages/platform/api/composition.api.md) for those inventories. Install the
[complete selected catalogue](../../upgrade/database-migrations.md#check-application-compatibility),
including the native dispatch outcome routines, before selecting native commands.

## Select shipping rules

Call `resolveShipping` from `@openlup/core/shipping` with your cart, rules and
explicit resolution time. It selects active rules matching the cart's region,
currency and validity window, preferring an exact cart mode over `any`. Within
the same mode, lower `priority` wins. If no rule matches, it returns `null`;
your application decides how to report or handle missing shipping terms.

The result snapshots the shipping amount and VAT rate. Meeting or exceeding
`free_threshold_minor` makes shipping free; otherwise `fixed_cost_minor` applies,
with `null` meaning free. For VAT, `fixed` uses the rule's `vat_rate_bps`,
`inherit_main_goods` uses the most frequent line rate, and `highest_in_cart` uses
the highest line rate. With no line rates, either cart-based policy falls back
to the rule's rate.

The selected rule supplies a carrier kind and delivery estimate; it does not
choose or call a carrier adapter. Your host owns carrier selection, pickup
points, labels and shipment execution. Continue below to compose those effects.

## Provide preparation and dispatch ports

Pass `createNativeFulfillmentBinding` a capability-local transaction lane,
`nativeDispatch: { portKey, providerRef }` (or explicit
`preparation.readAuthoritative` and candidate listing), selected service options, version and required
schema metadata. The reader receives the locked transaction executor and returns
the candidate dispatch request and its authoritative withholding flag. Service
options supply selection, capability, provider, readiness, candidate listing,
key derivation, dispatch configuration and an optional clock. Your host closes
the transaction lane.

Set `enabled: true` explicitly. Preparation acquires the dispatch advisory lock
before the shipment row lock, reads authoritative facts in that transaction and
synchronizes redacted context. Use `editAuthoritative` for edits to those facts:
your callback must enforce host authorization and replay handling in the same
transaction. Nonblank actor and key values are attribution, not authorization.

The result contains `services`, `version`, `requiredSchema`, `dispatch`,
`prepare` and `editAuthoritative`. Missing the transaction lane or both native selection and an authoritative
reader leaves `dispatch` null. Construction mounts no routes or schedules.
For a contribution descriptor, pass the returned metadata and
`{ dispatch: binding.dispatch }` as `fulfillment` to
`createFulfillmentContribution`, with empty handlers, schedules and routes.

Disabled services refuse with `disabled`. Missing selection refuses with
`selection_required`; missing native store/provider bindings produce
`host_binding_required` when required by the selected mode. Preparation throws
`fulfillment_preparation_shipment_missing` for a missing shipment,
`fulfillment_preparation_identity_invalid` for inconsistent candidate identity,
and `fulfillment_preparation_attribution_required` for an empty edit actor/key.
Map these before serving your own entry points.

The selected capability can declare `intakeMode: "polling"`; the native binding
then records `poll` ACK evidence. Omitted or `webhook` intake records `push`.
Install the complete native SQL catalogue through
`20261120110000_fulfillment_dispatch_outcomes.sql` before composing this store.
Existing accepted receipts keep their original channel on replay.

Declare `transportSelection: "provider"` when the provider selects transport:
native parcel preparation, capture and readback preserve null carrier/service.
Saved customer preferences still require strings; use explicit host parcel
selection for this model. Omission preserves the warehouse requirement, and
`transportSelection: "merchant"` requires carrier/service for any role.

Omitted inventory declarations preserve local reservations and finished-picking
consumption. Provider reservations and other consumption policies refuse during
readiness. Independent splits, standalone pickup-point/locker execution, label
create/void, remote cancellation and non-PDF documents have
[named limits](../../reference/limits.md#fulfillment-execution-limits).
Pickup-point selection data and multiple tracking references remain available.
Pass `stockMovements: false` to the stock worker for snapshot-only synchronization;
inspect `movementRefusal` separately from snapshot success. Omission retains the
movement-read requirement; neither mode introduces movement writes.

Adapters can add `receiptKey` equal to legacy `labelKey` and neutral observation
status aliases `code`/`detailCode` alongside `primary`/`subStatus`. Neutral event
kinds are `shipment.preparing`, `shipment.packed`, `shipment.in_transit` and
`shipment.delivered`. Preserve existing event keys and receipts when adopting
these aliases.

## Exercise captured dispatch

Call `createCapturedFulfillmentAdapter` with `providerRef`, explicit
`selected: true` and synthetic `captures`. Each capture pairs a complete
`FulfillmentDispatchRequest` with `accepted` and an `externalRef`,
`not_dispatched`, or `unknown`.

For each request, call `dispatch.prepare(request)`, require a `prepared` result,
then pass its evidence to `dispatch.dispatch(request, evidence)`. Fingerprints
cover the complete command, sort object keys by code unit and retain array
order. Use a lowercase opaque `providerRef`; accepted external references must
also satisfy the opaque-ID grammar. A changed or unknown request, skipped
preparation or mismatched evidence refuses with `not_dispatchable` before
submission. Invalid provider IDs throw `captured_fulfillment_provider_invalid`;
duplicate keys or invalid captures throw `captured_fulfillment_command_invalid`
during construction.

Results are copied and replay does not add another submission.
`readSubmissionCount()` counts distinct synthetic submissions, including captured
negative and unknown outcomes. The adapter has no transport, credentials or
durable ledger. An accepted capture proves no packing, label creation, handoff
or arrival. Only dispatch is exposed; label operations, readback, observation
verification, synchronization, cancellation and pickup operations are unavailable.

## Bind operator commands and reads

Supply a structural SQL executor to
`createPostgresFulfillmentShipmentCommandPort`. Bind
`recordCommerceFulfillmentLabel`, `handOffCommerceFulfillmentOrder` and
`recordCommerceFulfillmentTrackingEvent` to your authenticated operator handlers.
Derive `actorUserId` on the server and retain command keys for replay. The port
makes no carrier call and supplies no operator UI. Use READ COMMITTED
transactions; stronger isolation refuses with
`inventory_admission_isolation_unsupported` before writing.

Label recording commits evidence, tracking correlation, actor and operation
together. Same-key replay returns the original parcel's current status. A
provider/tracking-number pair on another order refuses with
`commerce_fulfillment_tracking_ref_conflict`; unattributed historical tracking
on another order refuses with `commerce_fulfillment_tracking_reference_unattributed`.
Same-order reuse attributes the reference to the selected parcel. The shared
evidence writer also requires `metadata.providerKind` for tracking references,
otherwise refusing `fulfillment_record_evidence_provider_kind_required`.

Keep label URLs, raw provider payloads and raw tracking events private. Initial
label and tracking requests remain in operator receipts; runtime roles cannot
select those receipts directly. Label URLs also appear in operation payloads
returned by operator reads. Treat them as sensitive, potentially expiring access
information. The native commerce read port does not authenticate: supply its
executor, eligibility `policy` and `orderMode`, optionally a destination reader,
and bind it only behind operator authorization. It refuses missing destination
facts with `native_fulfillment_destination_unavailable`. Customer order history
omits operation payloads. Your host owns retention and cleanup, including backup
and transfer copies; these commands install no automatic TTL or purge. Replay
preserves the original receipt.

## Record handoff and arrival accurately

Handoff accepts packed or labelled parcels and consumes only frozen purchase or
renewal reservation IDs, committing stock effects and audit together. Inspect
`reservationDisposition` and `consumedReservationCount`; absent recorded
reservations are reported as `reservations_not_recorded`. Treat missing historical
stock or tracking facts as an authorized manual-resolution case. Terminal handoff and
recorded-command replay do not consume stock again. An exact recorded command
also replays after an exception and relabel without changing status, timestamps
or audit. Other states refuse with
`commerce_fulfillment_handoff_requires_label`.

If invoicing follows handoff, wrap the committed command port with
`withAccountingInvoiceShadowTrigger` from `@openlup/platform/invoicing`. Supply
the accounting port, provider kind, duty keys and channel policy reader. An outer
transaction must commit before its handoff method returns to the wrapper. Leave
`failOnAccountingError` false for document failure to preserve successful handoff.

Tracking requires label/handoff state and an active same-order reference when
one is supplied. Preserve `commerce_fulfillment_tracking_before_label_forbidden`,
`commerce_fulfillment_tracking_before_handoff_forbidden`,
`commerce_fulfillment_tracking_ref_not_active` and
`commerce_fulfillment_tracking_after_delivered_forbidden` refusals.
Delivered parcels cannot regress. A usable, explicitly zoned `rawEvent.occurredAt`
supplies delivery chronology; otherwise the first delivery uses receipt time.
Delivered replay may repair arrival earlier, never later, without repeating
delivery alignment. Confirm a replacement's arrival only when it reached the
customer. A label or in-transit observation is not arrival evidence; a late actual
arrival may extend the next subscription cycle.

## Protect parcel contacts

Preparation keeps recipient and delivery-selection snapshots in the private
parcel contact store, outside dispatch evidence and public commerce reads.
Compose `createFulfillmentParcelContactPrivacyContributor` from
`@openlup/platform/identity` in the identity privacy registry and require
`fulfillment-parcel-contacts`, alongside identity and the subscription veto.
Erasure removes the contact payload and retains a marker that prevents legacy
inference from recreating it. Finite native-store transfer must carry both live
contacts and those markers. Install the complete native catalogue before
selecting this preparation path.

## Replay stock evidence

With the complete catalogue installed, a matching-fingerprint stock alert
replay preserves identity, first-seen time and historical resolver metadata,
refreshes severity/quantities, reopens the alert and clears `resolved_at`.
A different fingerprint refuses with
`fulfillment_stock_evidence_idempotency_conflict` (SQLSTATE `23505`). Earlier
whole-input fingerprints are not rewritten: resolving an alert does not make
its key available for changed input.

## Compose local commerce operations

Bind `createPostgresFulfillmentCommerceMutationPort(db, { portKey, providerRef,
stockSourceKey })` behind host operator authorization. Creation commits a local
obligation only; dispatch is a separate explicitly enabled invocation. Operator
attempt recording is first-write audit evidence, separate from command attempts;
replaying its key returns the original parcel and its current status.
Cancellation composes the existing stock-release transaction and dispatch fences.

Pass a pure `shadowCommandFingerprint` callback in services to hash the adapter's
actual serialized command without I/O. The same identity then survives shadow
promotion. Draft refresh is allowed across invocations; one invocation retries
stale contact once. Historical data is never backfilled. Missing recorded mode,
settlement or reservation associations refuses or withholds the row. Failed and
uncertain outcomes remain durable and do not cause a second provider call.
Accepted proof can repair locally even when current contact is unavailable.
These local witnesses establish no deployed-target or provider qualification.

## Certify a fulfilment adapter offline

For adapter authors using this development preview, the experimental
`@openlup/platform/fulfillment/testing` entry re-exports the existing runner and
captured dispatch adapter. `createScriptedFulfillmentFake` supplies per-operation
FIFO scripts with `enqueue`, `invoke`, `calls` and `assertDrained`. It records only
operation keys and outcome kinds. Use neutral operation keys; keep credentials,
raw captures and customer data out of scripts and expectations. The kit bundles
no capture corpus and makes no network calls, timers or retries.

```ts
import {
  createScriptedFulfillmentFake,
  runFulfillmentAdapterConformance,
} from "@openlup/platform/fulfillment/testing";
import type { FulfillmentAdapterTestSubject } from "@openlup/platform/fulfillment/testing";

const fake = createScriptedFulfillmentFake<{ submit: Response }>();
fake.enqueue("submit", { kind: "success", value: new Response("{}") });
// Consume this illustrative script; in an adapter bind invoke at its injected fetch boundary.
await fake.invoke("submit");
fake.assertDrained();

export async function certify(adapterSubject: FulfillmentAdapterTestSubject) {
  return runFulfillmentAdapterConformance([adapterSubject], { mode: "full" });
}
```

Supply `FulfillmentAdapterTestSubject.certification` and opt into `{ mode: "full" }`.
The runner reads the mode once and snapshots capabilities, fixtures and certification
data before any adapter call. One closed schema validates these copies. Inputs,
expectations and results are data: proxies, accessors, hidden properties,
unknown fields, contradictory branches and malformed values fail validation.
Each invocation receives a fresh input copy; its outcome is copied before it is
classified or compared. An expectation must exist independently before the call.
This is a data-validation and invocation-evidence boundary, not remote attestation.

Only the runner's invocation ledger grants coverage. A supported capability needs
an executed contract-positive success and an executed typed failure or refusal.
The actual and independent expected results must have the same kind and be deeply
strictly equal. A discriminant alone is insufficient: created labels need a
parcel reference and document field, available labels need a URL and expiry field,
and label void needs its complete boolean branch. Unsupported cannot serve as the
failure witness for a supported operation. Sync success returns a positive
snapshot, movement, addressable product pack, nonblank SKU, `{ replayed: false }`
for product creation, or `undefined` for a pack write. Sync failures use
`{ input, throws }`; successes use `{ input, expected }`. Mixed roles fail validation.
Empty, skipped, replay-only and rejected-only results may be additional baseline
fixtures but cannot supply positive coverage. Full or short pages containing only
unknown or unmapped rows cannot supply a positive page witness.

Supported dispatch requires compared accepted and definite non-dispatch results,
an executed unknown replay without a second submission, and a preparation refusal.
Refused preparations must omit `expectedDispatch` and `replay` in either mode.
Dispatch scenarios use distinct integer indices into the validated fixture array:
invalid address with valid items before submission, address rejection after
submission, transport failure before and after submission, and HTTP 5xx. Bind the
fake at the actual adapter boundary; a before-submission fault injected into fetch
has already crossed that boundary. Supply a read-only `fake.calls` snapshot as the
transport handle. The runner authenticates it against the fake's private log and
reads only the delta around that dispatch. Caller arrays earn no fault evidence.
Before-submission witnesses require zero provider calls; each claimed submission
requires exactly one. Replays require zero additional calls.

Observation scenarios use distinct indices for the duplicate pair, newer-then-older
pair and authentication refusal. Duplicate inputs and results must match. The
runner invokes each pair in tuple order and compares both outcomes, preserving
same-shipment occurrence time and identity. Token authentication proves only the
configured token check. Readback requires found and unknown witnesses, including
local missing data; exact absence additionally needs its own authoritative absence
and failure invocations. Returned and lost-coarse exceptions use separate slots;
neither starts recovery or manufactures a loss event. Numbered paging covers full,
short, empty, exhausted and failed pages. Cursor providers map cursors to sequential
numbers inside their adapter; the public page port has no opaque cursor.

The required executed refusal probes cover non-PDF label formats, label creation
and voiding, provider-side cancellation, independent splits, provider-owned
reservations, stock movements in snapshot-only mode, and pickup-point/locker
execution. Each refusal requires an unchanged provider-call count. Label refusals
execute the adapter methods. The other named native limits execute the platform
paths; they do not certify provider cancellation or successful split workflows.
Set `snapshotOnly: true`: the runner itself calls `runFulfillmentStockSyncWorker`
with an isolated snapshot-only provider/store and checks that movements were never
requested. Caller-supplied worker callbacks are rejected. Unsupported callable
observation, readback, sync, dispatch and label operations also need explicit
refusal witnesses. A missing or malformed applicable fixture fails full mode.

The closed port-less list currently contains only `courierPickup`. When unsupported,
evidence records `{ capability: "courierPickup", declared: "unsupported", probe:
"no_port" }`; no probe is required because the contract has no provider-reaching
path. Declared support fails with `capability_not_certifiable`. A contract pin test
requires revisiting this list when a port is added. Supported provider cancellation
also fails by that name because its native path only refuses. Pickup-point delivery
support needs adapter dispatch success and failure witnesses in addition to the
native execution-limit probe.

Only adapters branded by `createCapturedFulfillmentAdapter` can use `dispatch-only`.
The factory deeply freezes the adapter, its capabilities, dispatch port and method
slots. Qualification checks the exact factory-created port and methods it invokes;
copies or replacement methods cannot inherit the narrower profile.
The runner derives the profile and checks any supplied profile assertion. Dispatch
must be that adapter's sole supported operation; its qualification covers only
preparation and dispatch, and earns no other capability certification. Other
adapters use the adapter profile. Evidence records mode, derived profile, capability
digest, sanitized invocation ledger and port-less declarations, without inputs,
raw outcomes, credentials or transient URLs. Existing one-argument calls retain
baseline mode, with shared data validation and no full-coverage claim.
Baseline mode also retains available host-storage label reads when adapter label
reading is unsupported; full mode requires an executed unsupported refusal.

Offline evidence does not certify database locks, durable deduplication,
cancellation races, replacement transactions or delivery alignment. Those require
real PostgreSQL host witnesses. No replacement is confirmed unless it reached
the customer.
