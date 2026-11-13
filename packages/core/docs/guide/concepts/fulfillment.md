# Fulfillment and delivery

Distinguish a shipment command from evidence of what happened to the parcel.
Use [Compose native fulfillment](../how-to/build/fulfillment.md) for preparation,
operator commands and tracking; use
[subscription delivery alignment](subscriptions.md#subscription-delivery-alignment)
for renewal protection and control modes.

## Shipments and dispatch

Native shipments belong to orders and retain their own status and packing,
handoff and arrival timestamps. The shipment rail checks legal transitions and
label ownership: a fulfillment partner that does not own label creation can
hand off a packed parcel, while a label-owning carrier must pass through label
creation. Invalid progression refuses with
`fulfillment_advance_shipment_invalid_transition`; incompatible label or handoff
commands refuse with `fulfillment_advance_shipment_archetype_forbids_label` or
`fulfillment_advance_shipment_archetype_forbids_handover`.

Dispatch acceptance is an acknowledgement of submission, not proof of physical
packing or arrival. Native parcel progress does not advance the order status;
see [Orders](orders.md#order-state-and-money).
Check [Maturity](../reference/maturity.md) and [Limits](../reference/limits.md)
for capability selection.

## Observations and chronology

A normalized fulfillment fact carries canonical status, provider or operator
provenance, nullable `occurredAt`, `receivedAt` and a pointer to separately held
raw evidence. Parsing that fact authorizes no transition or external effect.
Keep the referenced raw evidence under application-owned access and retention
policy; receipt time does not establish when the provider event occurred.

Verified ingress records the observation receipt before applying lifecycle
writes. An observation that cannot find a local dispatch reference is recorded
as ignored with `local_missing`. For a correlated observation, a missing external
reference in both observation and dispatch refuses with
`fulfillment_dispatch_acceptance_external_ref_missing` and leaves processing
unfinished.

Reconciliation skips status evidence and progression effects for an observation
whose known occurrence is older than the latest stored status occurrence.
For parcels that are neither locally cancelled nor in exception,
`acknowledgeDispatchAcceptance` runs before the staleness check; a stale
observation can still invoke `issueAccountingInvoice` when that callback is
provided and handover is already recorded.
For locally cancelled or exception parcels, a non-stale recognized observation
records status evidence without applying progression effects. Receipt storage,
status evidence and completed effects therefore answer different questions.

## Arrival and subscriptions

Subscription alignment reads durable `delivered_at`, not status text or an
outbox timestamp. Where automatic alignment applies, the latest parcel arrival
plus cadence can extend the next cycle under a later-only clamp; it never moves
the cycle earlier or stacks deliveries. A replacement supersedes its predecessor
as the outstanding obligation but remains outstanding until it reaches the
customer.

Replacement creation alone records no arrival. Use
`subscription_delivery_alignment_confirm_replacement` only after actual customer
arrival: it attests delivery and can extend the schedule. The
[alignment concept](subscriptions.md#subscription-delivery-alignment) owns the
eligibility, split-shipment and manual-review rules; the
[tracking recipe](../how-to/build/fulfillment.md#record-handoff-and-arrival-accurately)
owns timestamp fallback and delivered replay.
