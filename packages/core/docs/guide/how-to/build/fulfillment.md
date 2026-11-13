# Compose native fulfillment

Prepare shipments from authoritative application facts, exercise dispatch with
synthetic captures, and bind label, handoff and tracking commands to authorized
operator handlers.

## Choose the imports

Use `@openlup/platform/fulfillment/native` for native bindings and stores; see
its [API report](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/api/fulfillment-native.api.md). Use
`@openlup/platform/fulfillment` for dispatch composition and captures,
`@openlup/platform/fulfillment/contracts` for request and port types, and
`@openlup/platform/composition` for contribution composition. Consult the
[API report](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/api/fulfillment.api.md), [contracts report](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/api/fulfillment-contracts.api.md)
and [composition report](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/api/composition.api.md) for those inventories. Install the
[complete selected catalogue](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/docs/platform/DATA_AND_MIGRATIONS.md#compatibility-lifecycle),
including the operator shipment routines, before selecting native commands.

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
