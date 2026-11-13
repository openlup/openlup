# Portable sandbox limits

Status: moved to the [OpenLup guide](../../../packages/core/docs/guide/reference/limits.md); the starter's canonical limits table is shared/limits.ts. Sections marked "Evidence" are frozen historical records.

`owned/demo-seed.ts` builds demonstration rows from typed configuration. `installation/install.ts` runs the transactional seed with the install connection after bootstrap; stock observations use the native stock writer. Do not replace purchase or renewal truth with application rows.

Reader guidance: [Starter limits](../../../packages/core/docs/guide/reference/limits.md).

Session implementation pins are a one-hour lifetime and capacity 1000. The
private developer mailbox uses git-ignored `.context` storage with 0700 mailbox
directories and 0600 files. Tokens, recovery URLs and recipient email addresses
require private filesystem access and stay out of application logs and recovery
responses.

The operation catalogue in `shared/limits.ts` supplies the same code and exact
localized explanation to action results and the limits page. The removed
`operator.returns` route retains HTTP 404 with
`starter_operation_unknown`.

The catalogue covers three declared named-refusal operations. The removed reader
retains its separate HTTP 404 protocol.

| Operations | Named refusal |
| --- | --- |
| `tracking.read` | `starter_tracking_access_unavailable` |
| `research.submit`, `ingest.submit` | `host_binding_required` |

Shipment list/detail use the native commerce reader in one repeatable-read,
read-only snapshot after native human-admin authorization on each request.
Unknown input fields and invalid selectors refuse before shipment I/O.
The destination view never prepares or pins a shipment. A pinned parcel retains
its destination when the order's current destination changes. This reduced
projection keeps the captured fulfillment client id, parcel-line
ids and saved-address id null. Provider kind and tracking number come from the same
parcel-correlated reference; historical unknown namespaces remain null. It keeps item reservation links empty, and reservation
locations null. It supplies
no contact revision, digest, correction target or baseline comparison. Tracking
and operation evidence retain the native reader's limits; missing required facts
refuse rather than omit a selected shipment. See the canonical
[native read limits](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#native-parity-boundaries).

Both example catalogues price in `XTS` test units for fictional market `ZZ` at
`UTC`. These choices make no real tax, shipping or compliance claim. The selected
configuration is a non-secret `--configuration` argument. The one-command
installation target defaults from the owned registry. CLI transport does not
supply an installation capability.

| Limit | Actions | Named refusal |
| --- | --- | --- |
| N8 | Demand-driven plan-length and portion resizing are unconfigured; the seven exact commands are API-only | `starter_subscription_resize_unconfigured` |

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

The lifecycle renewal entry mounts `composeSizedPaidEmailNote` through
`host/paid-mail.ts`, deriving the note from frozen quantities, physical identity
and renewal cadence.

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

The install connection loads the acquisition address registry in the marked
demonstration seed transaction. Preserve tuple provenance on reinstall. Operator
support uses the communications roster provisioned/deactivated through its owner
connection; see the [roster recipe](../README.md#operator-support-roster-and-catalogue-authoring).

`composeExistingCapabilities` binds native partner and review ports only with a
runtime connection. The acquisition host injects the owned address tuple, legal
revision, fixed source path and socket-peer requester hash. Research ownership
and normalized-ingest composition remain unbound. Catalogue drafts use isolated
authoring tables; bundle activation writes native status, while storefront and
checkout read typed configuration through `evaluateOffer`.

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

Checkout creation composes the contact registrar after attempt admission, with
no demonstration clients seeded. The completion bootstrap owns token scrubbing. Recovery issuers and payment-case rotation retain
separate native owners. Hash lookup uses an index without a constant-time claim.
The customer address action maps the native next-parcel result; it mounts no
current-parcel operator correction.

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

`shared/offer-estimate.ts` delegates catalogue estimates to the package unit-price
primitive; installed quotes own checkout money. The seed owns distinct one-time
and subscription price entries. Stock, timestamps, bounds, reservation lifetime,
sandbox choices and fictional tax inputs stay in typed application configuration.

The demonstration Compose container writes its private quote key only for a
marked demonstration database, reuses the file on restart and rotates it on
container recreation. Synchronous attempt-identity digests retain the quota
store's capacity and retention bounds independently of a replaced callback.
Input configuration is checked against native destination, integer-money,
cadence and tax-text constraints before composition.

## Paid-order message capture

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#paid-order-message-capture).

The lifecycle entry composes the paid-mail event filter and processor through
`host/paid-mail.ts`. Deduplication belongs to the filesystem-artifact and outbox
owners. The composition adds no transport, SQL or grants; subscription notices
retain their native owner.

## Subscription care

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#subscription-care).

The host supplies trusted command timing and composes finite auto-resume, native
notices and winback in the care entry. Retention settings remain unseeded.
Policy changes follow the
[composition owner](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#composed-subscription-module).

Evidence (historical record, 2026-11-13):

The finite auto-resume host is bound and proved in both configurations after a
synthetically delivered first order. A clock past the finite pause and renewal
date produces an active subscription, a date rolled forward by whole cadences
and one locally captured resumed confirmation, including replay. The fixture
supplies its own external fulfillment facts; operator tracking commands have a separate witness.

## Account and operator bindings

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#account-and-operator-bindings).

Replacement, complete fulfillment cancellation, customer name/phone edits, saved
addresses, subscription destinations and scoped preferences bind installed
native ports. Operator checkout links retain their separate binding.

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

The frozen recovery source reads the original immutable private checkout capture
under the root order, separately from bearer authorization. Private-capture
storage retains its own source owner. The owner provisions
`commerce_operators.id` from the human principal and preserves the row for audit
attribution, revoking access through identity membership rather than deletion.

Evidence (historical record, 2026-11-13):

The additional real-PostgreSQL journeys run in the `recovery extension ` group
from the single shared `browser-groups.mjs` source. Each group uses a fresh
installation pair, one worker and traces, screenshots and video off. Checkout
quota and all runner guards remain unchanged.

## Unpaid cancellation and manual refund records

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#unpaid-cancellation-and-manual-refund-records).

The two command bindings re-resolve human membership and the existing Commerce
operator row on replay. Native durable receipts own command identity; genuine
provider-refund duties retain their existing owners.

## Return requests and decisions

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#return-requests-and-decisions).

The host resolves the existing Commerce operator after fresh membership
admission for every decision and replay. Native ownership, quantity and command
receipts remain the return admission owners.

## Optional payment guidance

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#optional-payment-guidance).

The completion reader composes the native atomic guidance snapshot and the
sandbox evidence normalizer. Token pay, inline retry and buyer-link sending
retain separate mutation bindings.

## Operator shipment evidence

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#operator-shipment-evidence).

Shipment commands use a host-owned READ COMMITTED transaction. Optional handoff
accounting runs after commit under the wrapper's fail-soft policy; paid-capture
policy is unchanged. Public handlers own validation; order/hold/return commands retain separate
Commerce-operator provisioning. The private receipt store owns label/tracking
payload persistence.

## Saved addresses and scoped preferences

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#saved-addresses-and-scoped-preferences).

Native saved-address, billing-profile and scoped-preference handlers bind the
signed-in session. The host supplies fictional country, phone-prefix and tax
checksum validation.

## Sandbox token payment and exact continuation

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#sandbox-token-payment-and-exact-continuation).

The continuation codec purpose-derives its key from the current private host
keyring root supplied by `--quote-acceptance-key-file`; the native order UUID
provides the opaque checkout journey. Registered demonstration references supply
synthetic method identity. The payment hold wrapper receives an explicitly
unconfigured policy. Buyer-link delivery rechecks native authorization and
captures through the private mailbox; its source marker distinguishes landing.

## Billing profiles and frozen invoice buyers

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#billing-profiles-and-frozen-invoice-buyers).

The composition requires the complete ordered history through
`20261110280000_checkout_recovery_buyer_snapshot`, including slot 27 first-duty
capture. `./lifecycle up` installs that history. Initial checkout, native recreation
and renewal retain their respective destination writers.

`payment.simulate`, `checkout.payment` and `checkout.recovery` share the
capture/activation helper. Acquisition renewal availability is checked before
recording capture; successful ingress selects acquisition or classic activation.
The Node host registers billing, address, preference and parcel-contact privacy
contributors. Identity/subscription coverage and account-event retention remain
application composition.
