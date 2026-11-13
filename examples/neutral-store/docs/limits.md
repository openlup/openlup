# Portable sandbox limits

Status: moved to the [OpenLup guide](../../../packages/core/docs/guide/reference/limits.md); the starter's canonical limits table is shared/limits.ts. Sections marked "Evidence" are frozen historical records.

`owned/demo-seed.ts` builds demonstration rows from typed configuration. `installation/install.ts` runs the transactional seed with the install connection after bootstrap; stock observations use the native stock writer. Do not replace purchase or renewal truth with application rows.

Evidence (historical record, 2026-11-13):

Status: local PostgreSQL host and browser purchase/recovery evidence; release qualification remains separate.

The starter has no runtime writer for live products, SKUs, price lists, price
entries or promotions. Bundle writers update their own catalogue and price tables. Under N1, `owned/demo-seed.ts` builds their
fictional rows from the same typed configuration; `installation/install.ts`
applies one transactional, idempotent step during `./lifecycle up`, using only
the install connection after installed bootstrap. It refuses absent bootstrap
(`starter_installation_binding_required`), a runtime login or current role
(`starter_seed_runtime_role_forbidden`), a different install identity
(`starter_seed_install_role_required`) and a database without the demonstration
marker (`starter_seed_demonstration_database_required`). The one-shot bootstrap
uses the complete installed history and refuses any pre-existing unmarked database.
Guest purchase, subscription activation and recovery have real-database host and browser proofs.
Promotions remain seed configuration, with no runtime administration.
The install writes editor settings and synthetic catalogue documents/identifiers;
fictional stock observations use the public native stock writer. Clients are
not seeded. Purchase, renewal terms and
method states are never replaced by hand-written application rows.

## Subscription editors

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#subscription-editors).

The host exports `composeSizedPaidEmailNote` from frozen order quantities, physical identity and renewal cadence. The lifecycle renewal entry mounts it through `host/paid-mail.ts`; classic, acquisition and unprovable parcel facts omit the note.

Evidence (historical record, 2026-11-13):

The classic editor, size-aware editor and reviewed opt-in use package preview
and apply factories. Swap, individual extra changes and fixed-total base mix are
available through the customer-session API; they have no portal buttons. Plan
and portion resize commands reach the named configuration limit after ownership
admission. Ordinary classic plan and sized cadence choices keep quantities.
New/increased sized SKUs require current active/subscription-sellable state in
the apply transaction. The host locks its owned subject/need fixture row and
rereads every selected catalogue fact, including stock and exclusion keys, on
that same connection. Catalogue reads do not acquire row locks; serializing
against concurrent catalogue publication and publication-head/membership fencing
remain the named publication-fence limit.
Entering, previewing or abandoning an invitation never binds sized. An acquisition
purchase's fixed introductory phase refuses sized opt-in; the servicing proof
completes that phase through native renewals before editing. Checkout and the
editors share one current product document with per-SKU variants, including
physical identity, demand per unit and exclusions.

## Partner intake and reviews

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#partner-intake-and-reviews).

The acquisition address registry is loaded only by the install connection in the marked demonstration seed transaction. Preserve the tuple provenance on reinstall. Operator support additionally requires a communications-operator roster entry; provision and deactivate it through its owner connection. See the [operator roster recipe](../README.md#operator-support-roster-and-catalogue-authoring).

Evidence (historical record, 2026-11-13):

Review read and submit require an accepted, unexpired native order review grant.
Invalid references do not prove positive grant behavior. Positive review submit/read, publish/hide, revocation and grant ownership move
to the later review journey after delivered-shipment reads. Ownership retains
the native bearer-capability semantics. The issuer fixes expiry at thirty days
and provides no application time seam. This purchase contribution claims no
additional review proof beyond the earlier intake composition.
Operator list/moderation admission reuses native human membership, rechecked on
requests; a customer session supplies no operator authority.

The following paragraph records the acquisition-only baseline before support
and catalogue composition. Current support and catalogue bindings follow the
owner-roster recipe and amended N1 above; those earlier unbound statements do
not describe the combined application.

Operator customer search and detail remain unbound: the native support journey
reader additionally requires an active communications operator roster entry,
which the human session does not provision. No second operator authority is
seeded or inferred. Bundle and catalogue administration remains unbound; N1 is
unchanged.

## Purchase composition boundaries

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#purchase-composition-boundaries).

Evidence (historical record, 2026-11-13):

Shipping is charged below the configured threshold on products after discounts;
at or above it shipping is free. Renewals use the accepted agreement and the
frozen cycle amount, including on replay. These remain local sandbox witnesses.

Lifecycle commands are mounted for owned subscriptions. Package and cadence edits
use the separate customer editors above; demand-driven plan-length and portion
resizing remain unconfigured.
Authenticated payment recovery authorizes the same native unpaid obligation.
The selected native installation includes the command receipt-lock completion.
Operator recovery passes the committed real-HTTP proof in both configurations and
revalidates active human membership and support authority on replay. No refusal
pauses or freezes an active subscription or confirms an undelivered replacement.

## Interim subscription mode price

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#subscription-mode-price).

## Paid-order message capture

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#paid-order-message-capture).

## Subscription care

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#subscription-care).

Evidence (historical record, 2026-11-13):

The finite auto-resume host is bound and proved in both configurations after a
synthetically delivered first order. A clock past the finite pause and renewal
date produces an active subscription, a date rolled forward by whole cadences
and one locally captured resumed confirmation, including replay. The fixture
supplies its own external fulfillment facts; operator tracking commands have a separate witness.

## Account and operator bindings

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#account-and-operator-bindings).

Evidence (historical record, 2026-11-13):

The local checkout-recovery pass captures first/final and expired notices.
Signed-in starts preserve checkout links and send no email; operator issuance
revokes earlier checkout links and optionally queues mail. A completed capture
is evidence for this demonstration transport only. Expired checkouts retain a
terminal source while eligible recreation can start a fresh order. Live pending-order
links support original-order sandbox continuation payment. Dedicated token pay,
exact inline retry and the embedded-browser buyer-link control use native sandbox
execution and its continuation codec. Every other separately named operation limit remains.
See the [candidate recipe and owner steps](../README.md#checkout-and-account-candidate-changes).

## Expired checkout recovery and order holds

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#expired-checkout-recovery-and-order-holds).

Provision a `commerce_operators` row whose ID matches each human administrator’s native principal. Holds retain this attribution: revoke membership through the identity owner rather than deleting the row.

Evidence (historical record, 2026-11-13):

The additional real-PostgreSQL journeys run in the `recovery extension ` group
from the single shared `browser-groups.mjs` source. Each group uses a fresh
installation pair, one worker and traces, screenshots and video off. Checkout
quota and all runner guards remain unchanged.

## Unpaid cancellation and manual refund records

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#unpaid-cancellation-and-manual-refund-records).

## Return requests and decisions

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#return-requests-and-decisions).

## Optional payment guidance

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#optional-payment-guidance).

## Operator shipment evidence

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#operator-shipment-evidence).

Shipment commands run in a host-owned READ COMMITTED transaction. An optional handoff accounting callback belongs after that transaction commits, and retains the wrapper’s fail-soft policy; paid-capture document policy is unchanged.

## Saved addresses and scoped preferences

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#saved-addresses-and-scoped-preferences).

## Sandbox token payment and exact continuation

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#sandbox-token-payment-and-exact-continuation).

## Billing profiles and frozen invoice buyers

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#billing-profiles-and-frozen-invoice-buyers).

Install the complete ordered package history required by the billing and recovery owners. Payment capture and subscription activation keep separate transaction boundaries. Compose the native billing, address, preference and parcel-contact privacy contributors with application-owned identity/subscription coverage; account-event retention is unresolved.
