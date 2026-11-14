# Compose native fulfillment

Prepare shipments from authoritative application facts, exercise dispatch with
synthetic captures, and bind label, handoff and tracking commands to authorized
operator handlers.

## Choose the imports

Use `@openlup/platform/fulfillment/native` for native bindings and stores; see
its [API report](https://github.com/openlup/openlup/blob/openlup-core-v0.41.0/packages/platform/api/fulfillment-native.api.md). Use
`@openlup/platform/fulfillment` for dispatch composition and captures,
`@openlup/platform/fulfillment/contracts` for request and port types, and
`@openlup/platform/composition` for contribution composition. Consult the
[API report](https://github.com/openlup/openlup/blob/openlup-core-v0.41.0/packages/platform/api/fulfillment.api.md), [contracts report](https://github.com/openlup/openlup/blob/openlup-core-v0.41.0/packages/platform/api/fulfillment-contracts.api.md)
and [composition report](https://github.com/openlup/openlup/blob/openlup-core-v0.41.0/packages/platform/api/composition.api.md) for those inventories. Install the
[complete selected catalogue](../../upgrade/database-migrations.md#check-application-compatibility),
including the operator shipment routines, before selecting native commands.

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
`preparation.readAuthoritative`, selected service options, version and required
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
`prepare` and `editAuthoritative`. Missing the transaction lane or authoritative
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
`20261120100000_fulfillment_intake_channel.sql` before composing this store.
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

Supply `FulfillmentAdapterTestSubject.certification` with profile `adapter`.
Supported dispatch requires compared `accepted` and `not_dispatched` results,
plus an `unknown` result whose replay was invoked, compared and made no second
provider call. Both profiles require a compared preparation refusal. In either
mode, a refused preparation must omit `expectedDispatch` and `replay`: dispatch
will not run for that fixture. Supported label create/read/void methods require
success and refusal pairs. Dispatch scenarios index the subject's executed
baseline array entries: address refusal before submission,
definitive rejection after submission, transport failures before and after
submission, and HTTP 5xx. Bind the scripted fault at the actual boundary: a
before-submission script injected into fetch has already crossed that boundary.
Supply the fake's live append-only `calls` log. The runner accepts a fault only
from the log delta around that indexed dispatch, excluding preparation, replay
and other operations. It checks the actual result's `submissionAttempted` and
`mayHaveSucceeded`, plus an unchanged provider-call count before submission and
an increased count after submission. A script's metadata alone proves neither.
The before-submission address fixture must contain valid items and a blank
required address field; an empty-items refusal does not exercise that scenario.

Observation indices select an exact duplicate, a newer then older occurrence
with explicit timestamps for the same shipment, and an authentication refusal.
The runner invokes each duplicate and out-of-order pair explicitly in tuple
order, comparing each actual result with its independent expectation, including
the older occurrence delivered after the newer one. Duplicate inputs must match.
Authentication may be
a token check; passing it does not establish body-signature verification.
Readback requires compared found and unknown results, including a local-missing
unknown result; authoritative absence is required when declared supported.
Returned parcels and loss recovery input each require a coarse exception.
The kit does not manufacture an
unknown provider status into a loss event or start a replacement. Numbered page
fixtures cover full, short, empty, exhausted and failing pages. A cursor-based
provider maps its cursors to sequential page numbers inside its adapter; the
public page port carries no opaque cursor and this kit adds none.

Supply success/failure pairs for each supported stock and product sync method;
stock movements are required unless `stockMovements: false` is declared. A
`success` fixture has `{ input, expected }` and a `failure` fixture has
`{ input, throws }`, where `throws` is the declared typed sync refusal. The types
exclude the opposite key; the runner also rejects mixed or contradictory roles
before invoking either fixture, including for untyped JavaScript callers.
One credit rule checks every operation's expectation and observed invocation.
For discriminated result unions, only a success discriminant earns success and
only a refused or failed discriminant earns refusal or failure. A `created` or
`available` label result carrying `refusal`, or a refused result carrying success
payloads, fails with the named `contradictory result` reason and earns neither
role. The same rule covers dispatch, observation, readback, paging and native
refusal probes. Label void uses its declared `canProceed` boolean. Sync success
must return the expected contract-positive value; sync failure must throw the
declared typed refusal. A returned value cannot satisfy a throwing failure slot.
Paging expectations are typed to the slot's result kind, and positive
`ensureProduct` expectations require `replayed: false`. Scenario claims also
check dispatch witnesses and invocation-bound log or I/O-count deltas.
Positive sync witnesses must include a stock snapshot,
movement, addressable product pack or nonblank stocked SKU for the corresponding
read. `ensureProduct` must return `{ replayed: false }`; skipped `null` and replayed
results can be additional fixtures. `addProductPack` succeeds by returning `void`
without throwing. Empty or rejected-only reads can be additional fixtures but
cannot supply the required positive witness. The
`snapshotOnly` callback invokes the real snapshot-only worker and returns its
movement refusal; its counter counts only movement calls. Native selection probes
invoke the shipped refusal paths for non-PDF labels, label creation/voiding,
provider cancellation, independent splits, provider-owned reservations and
pickup-point/locker execution. These are native execution limits, separate from
adapter metadata flags. Unsupported label methods must also be invoked through
the actual adapter with no provider call. Full qualification fails if an applicable
fixture is missing; it never silently skips one.

The transportless captured adapter can qualify profile `dispatch-only` only when
dispatch is its sole supported operation. It proves compared `accepted` and
`not_dispatched` results, an executed `unknown` replay and a preparation refusal.
Accepted and not-dispatched replays are checked when requested by their fixtures.
It earns no label, observation, readback or sync certification.
Existing one-argument calls retain baseline mode;
opt into full mode explicitly when qualifying an adapter.

Offline evidence establishes adapter results and the named native refusal
probes. It does not certify database locks, durable deduplication, cancellation
races, replacement transactions or delivery alignment. Those require the real
PostgreSQL host witnesses. An offline status replay does not establish one durable
host effect, and no replacement is confirmed unless it reached the customer.
