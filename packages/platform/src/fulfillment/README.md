# Fulfillment contracts and status canon

Development preview. Import runtime helpers from `@openlup/platform/fulfillment`
and browser-shareable types from `@openlup/platform/fulfillment/contracts`.
The contracts entry emits no runtime values and imports no server entry.

P1 owns the [status map](statusMap.ts), [core fact parser binding](normalizedFulfillmentFacts.ts)
and [injected capability selection](providerCapabilities.ts). It provides contracts,
not an executor, persistent store, provider adapter, HTTP route or activation.
The reference application's existing mapper and integrations remain unchanged until
an explicit later composition step. The display mapper's substring fallback and
rank rules are preserved; a display step never constitutes arrival evidence.

The [dispatch contract](contracts/dispatch.ts) keeps a nullable pre-create parcel,
frozen recipient/line input and explicit provider/carrier/service selection.
Contact revision is not a global order revision. The adapter supplies a digest of
its actual command bytes and host-owned opaque keys; neutral-envelope hashing must
not change persisted identities. [Store operations](contracts/store.ts) keep
prepare, claim, begin, finalize, acceptance ACK and readback separate. An unknown
external outcome forbids blind re-POST; accepted evidence can repair a lost local ACK.

[Labels](contracts/label.ts) separate durable object references from transient
host-signed download responses. Missing PDF does not mean missing parcel;
proceedable cleanup does not confirm deletion. [Observations](contracts/observation.ts)
keep event identity separate from the core fact fingerprint, first receipt separate
from nullable occurrence, and correlation/tracking separate from safe diagnostics.
Authenticate untouched bytes before parsing. Token authentication alone establishes
no signed freshness. Stock contention, annotation and recovered receipt details
remain typed. Never persist raw bytes, headers, provider commands, signed URLs,
credentials or copied recipients in evidence records.

[Readback](contracts/readback.ts) distinguishes found, exact scoped absence with
proof, unknown and unsupported. Empty pages and missing local rows prove no external
absence. [Sync ports](contracts/sync.ts) retain collection identity, nullable source
revision, freshness, sanitized continuation, movement/lot/expiry, replay/readback,
conflicts and resolution. They leave inventory availability/reservations and catalog
facts with their existing owners; no local SKU creation or overwrite is implied.

[Capabilities](contracts/capabilities.ts) separate support, host selection and
readiness. Each unsupported operation states a reason. Provider selection is never
inferred from carrier or service. Empty or absent selection is a typed refusal,
with no simulator alias. Host-storage label read is independent of provider support.
Direct-carrier support remains inert until explicitly selected and ready; no I/O is
performed by the selector. Notification ownership and stock authority are explicit.

[Delivery alignment](contracts/alignment.ts) preserves this rule: late delivery
extends the next cycle, never stacks deliveries or moves it earlier. A replacement
may settle alignment as `aligned` only after reaching the customer. Its superseded
predecessor is no longer outstanding, but an in-flight or undelivered replacement
still is. Never call `subscription_delivery_alignment_confirm_replacement` for a
replacement that did not arrive: it records the customer-facing fact "Parcel
delivered" and shifts the cycle later. The existing note-only operator attestation
is unchanged; this module adds no caller. Native alignment implementation/proof is
reserved for P4; P1 establishes no native continuity claim.

The seven semantic cases in [contracts](../../test/fulfillment/contracts.test.ts),
[status parity](../../test/fulfillment/statusMap.test.ts) and
[port fit](../../test/fulfillment/portFit.test.ts) are the focused falsifiers.
Package boundary rows and the installed cold consumer additionally verify isolation.
See the [programme record](../../../../docs/platform/plans/oss-m08-fulfillment-physical-delivery.md)
for provenance, declared adaptations and remaining phases.
