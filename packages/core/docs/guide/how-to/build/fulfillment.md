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

## Bind provider intake and reconciliation

After installing the complete catalogue through
`20261120120000_fulfillment_provider_intake.sql`, construct
`createPostgresFulfillmentProviderIntake` from the native entry. Supply a selected
capability and selection, a SQL executor, observation and page ports, tracking
codecs, and durable stock, handoff, tracking, exception and acceptance keys.
Reuse the acceptance keys used by dispatch. The executor must commit each call
before resolving; never wrap provider reads or invoicing in its transaction.
Construction installs no route or schedule. Disabled or incomplete bindings
refuse before provider access. Polling-only capabilities refuse webhook intake.

Pass untouched request bytes, headers and receipt time to `ingest`. The selected
adapter authenticates before parsing and translates status, occurrence identity
and recovery policy into `intake` facts. Native intake retains the first durable
webhook envelope and restores it before correlation, ACK or effects. Correlation
uses provider identity first. Without a provider match, every recorded merchant,
adapter-mapped order and native parcel association must name the same order;
ambiguity refuses as `fulfillment_observation_correlation_conflict` before ACK or
effects. Parcel ordering applies only within that order, and all matches check
the adapter's outbound order identity. Contradictory references also refuse. It
never parses merchant-number suffixes or treats provider identifiers as native
UUIDs. Old receipts without a typed fact/evidence pointer require manual recovery.

Early stages write evidence only. Packed evidence consumes the accepted parcel's
frozen reservations and records packing without inventing a label. Shipping
commits stock, handoff and each admitted tracking reference before accounting.
Each reference retains nullable carrier, service and approved public URL data.
Provider exceptions create occurrence-idempotent holds without changing parcel
status. Newer eligible evidence can release only a proven machine exception hold;
terminal exceptions, unknown chronology and human holds remain manual cases.

A delivered observation with no admitted tracking reference records status but
writes no arrival or alignment. It can still heal an eligible hold. An authorized
operator tracking/delivery command, or a later observation with a reference, is
the manual completion path. Delivered evidence suppresses a late dispatched
notice; a handoff with zero references creates no dispatched notice key.

Call `reconcile` from your existing scheduler with its job ledger, job name,
invocation and page size. It claims the lease, reads the latest terminal
checkpoint, then calls the provider. Full pages advance even when an item fails;
short and empty pages reset to zero. Missing, malformed or resized checkpoint
metadata starts at zero. A checkpoint-read failure makes no provider call and
finishes without replacing pagination metadata. This native composition resets
a fatal zero-scan failure to zero; the generic page helper retains its existing
pre-traversal retry rule. Sequential cursor translation belongs to the adapter.

Pass the selected adapter's `orderIdentity` mapping to native intake when its
outbound merchant identity differs from the stored number. This optional mapping translates an echoed outbound
merchant number into a native order lookup reference and computes the expected
outbound number from the recorded order identity. After provider lookup, all
recorded fallback associations must agree on one order before selecting its
newest parcel, or its explicitly named native parcel. A new
provider reference can repair an interrupted acceptance through the existing ACK
operation; intake never submits another order. Contradictory identities refuse.

Keep original occurrence bytes in `intake.occurredAt`, separately from the
normalized fact. Tracking passes those bytes to the existing arrival writer:
explicit-zone values with seconds supply delivery time; compact offsets, minute
precision, missing zones and missing original evidence use receipt time. Webhook retries retain
those original bytes with the first envelope. A terminal tracking regression is
settled as superseded; unfinished prerequisites keep the webhook retryable.
Historical status evidence with null classification cannot prove recovery.

Polling applies current page snapshots, so revised tracking can take effect for
a repeated status occurrence. Stored chronology is checked before status and
physical effects; off-track rows retain eligible evidence without ACK or effects.
Optional accounting runs after physical commits: webhook errors are fail-soft,
while polling classifies transient failures separately from permanent refusals.
The returned `commands` expose the existing operator label, handoff and tracking
factory methods; authenticate their actors in your host. Unbound fallback ports
remain inert. This recipe and its conformance witnesses are offline evidence;
provider activation and hosted qualification remain separate.

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

## Bind replacement and customer alignment

Install the complete catalogue through
`20261120130000_fulfillment_alignment_arrival_chronology.sql`. Select
`createPostgresFulfillmentOperatorPort(executor, { providerRef, stockSourceKey })`
and bind its `requestReplacementShipment` to the replacement handler. The host
authenticates the actor and supplies the stock binding. Creation commits a queued
parcel with fresh counted reservations, frozen contact, destination and lines;
it performs no dispatch, arrival confirmation or notification. Same-key replay
returns that parcel. Another request refuses while a replacement is in `created`
or `label_pending`; other states do not trigger that queue fence.

Select the existing `nativeDispatch` composition for replacement dispatch. Each
parcel gets its own preparation, claim, submission and acceptance identity.
Optional frozen line lot/expiry fields remain dispatch data; this adds no lot or
location management. Adapters own number formatting from `parcelSequenceNo`;
customer order numbers remain unchanged. Keep the adapter's `orderIdentity`
bound to intake for echoed replacement numbers.

Bind `createPostgresCustomerAlignmentRowsReader(executor)` as
`readCustomerAlignmentRows`, then pass it and the current next-cycle map to
`readFulfillmentDelay`. The reader returns only protected/aligned rows, newest
update first, with string dates. The mapper hides historical aligned rows when
the current schedule advances. Absence means no current banner. Authorize the
subscription IDs before reading. Do not substitute the account-support reader,
which uses a different ordering.

Select `createPostgresFulfillmentCommerceReadPort` for reduced list/detail using
the existing policy and order-mode mapping. `getShipmentsOverview` still requires
host-owned overview data and returns `host_binding_required` when unbound. Keep
`createNativeUnsupportedFulfillmentPorts` as the inert fallback for unbound
surfaces. See the [execution limits](../../reference/limits.md#fulfillment-execution-limits).

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

The delivery trigger processes a changed non-null arrival timestamp. Earlier
tracking repair updates a still-protected case; later tracking replay is ignored.
All unsuperseded parcels must arrive before settlement. The target is the maximum
parcel arrival plus cadence, clamped to the existing next cycle; replay and repair
never add repeated cadence or move the cycle earlier. A settled case retains its
aligned target even when later evidence changes a parcel timestamp. Never call
replacement confirmation automatically or attest to an undelivered parcel.

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
