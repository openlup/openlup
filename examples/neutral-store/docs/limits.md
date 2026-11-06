# Portable sandbox limits

Status: local PostgreSQL host and browser purchase/recovery evidence; release qualification remains separate.

The app's `/limits` and `/ograniczenia` pages render the same canonical table as
the visible action buttons (`shared/limits.ts`). A refusal is an observed
unavailable action, never a simulated success. Codes beginning `starter_` name
application composition limits; they are not claims of exported package errors.

| Limit | Actions | Named refusal |
| --- | --- | --- |
| N1 | Live products, SKUs, price lists, price entries and promotions are seed data: one owned demo-seed step with the install connection, no runtime writer for them and no checkout promotion codes. Bundle drafts, compositions, target prices and activation, and catalogue drafts, are administered by a native human operator through their native writers. | `starter_promotion_write_unavailable` |
| N2 | Operator email/phone correction and account linking | `operator_subscription_authority_unavailable` |
| N3 | Order note and order-address correction | `starter_order_correction_unavailable` |
| N4 | Replacement request and complete fulfillment cancellation | `host_binding_required` |
| N5 | Saved addresses, billing profiles, delivery preferences, payment preferences, private-profile views and the profile/address/billing/private-profile views action | `starter_account_preferences_unavailable` |
| N6 | Real PSP, payment method setup, card replacement and unsupported money recovery | `native_prepared_attempt_store_unsupported` |
| N7 | Customer profile edit | `starter_profile_edit_unavailable` |
| N8 | Exact generic recipe/mix/portion commands | `subscription_command_unsupported_action` |
| N9 | Rich OMS, commercial analytics, payment links and saved draft resume | `starter_rich_oms_unavailable` |
| N10 | Google sign-in | `oauth_not_supported` |
| Inventory boundary | Lot traceability, locations and stock movements | `starter_inventory_traceability_unavailable` |

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
Clients, stock and settings must use their native writers; never seed them. Purchase, renewal terms and
method states are never replaced by hand-written application rows.

The portable rail has **no lot traceability, locations or stock movements**.
Readers of the supplement and coffee configurations may expect these features;
the examples provide none of them and make no health or compliance claim.
The same statement is visible in both locales on the limits page.

Every N5 action is visible on both account and limits pages in Polish and English and
refuses with `starter_account_preferences_unavailable`, including private-profile
views and the combined profile/address/billing/private-profile views action.

Sandbox payments only are in scope on this rail. Real-money commerce currently needs a
separately qualified rail and provider; this app does not claim real-money
provider independence. An existing subscription is never paused or frozen by
these refusals. The starter does not expose confirmation of an undelivered
replacement parcel.

Other explicit boundaries: monetary refund creation, receiving/restocking
returns and catalogue publication are unavailable; no legacy participant source
exists; media bytes need a proper storage binding. Reduced OMS reads do not
stand in for rich projections. Review grants do not establish account sessions,
and account sessions do not establish authority over an arbitrary research case.

Reviews, acquisition, research and partners are limited to their declared ports.
Partner inquiry does not grant marketing consent, convert a customer or provide
partner privacy export/erasure. Risk is off. Market inputs are not tax-compliance
certification. Normalized ingest has no real marketplace connector.

Demonstration sessions run in a single process, expire after one hour, have
capacity 1000 and are lost on restart. This is not a production session store.
The capture is a developer mailbox with no real recipients. Its files stay in
the git-ignored `.context` directory with 0700 mailbox directories and 0600 files.
Tokens, recovery URLs and recipient email addresses require private filesystem
access and stay out of application logs and recovery responses.

With the runtime URL supplied by lifecycle, native customer challenges and
opaque host sessions bind reduced profile/subscription-control reads, selected
owned order headers/detail, newsletter read/withdraw and reduced OMS order
list/detail. Full account projection sources remain unavailable
(`starter_account_projection_binding_required`); newsletter grants and other
purposes wait for the consent lifecycle and refuse `host_binding_required`.
The account order response does not claim a rich customer-order projection.
Native detail preserves `native_account_order_money_unavailable` when a historical
order lacks captured money; it never reconstructs purchase truth.

Purchase creation uses the native contact-client factory. Customer invoice history
and owned captured PDF downloads use the native session principal. Documents are
explicitly non-fiscal sandbox artifacts. Operator invoice summaries authorize
before querying local history, duty, retry and delivery evidence, including guest
orders. Placing and releasing an order hold are unavailable in this release.
Both operations stay unbound and return `starter_order_hold_unavailable` after
operator admission with zero effects. Their typed forms retain configured hold
reasons and the exact hold-reference release target. The later order-control
composition closes this boundary alongside cancellation and external refund
marking.

The operation catalogue in `shared/limits.ts` supplies the same code and exact
localized explanation to action results and the limits page. Named deferred
actions remain unbound and refuse after customer/operator admission, before any
native routine. Return forms retain reason codes, order-item quantities and
refund intent. No operator returns list or detail; the operator approves or
rejects by the return reference the customer receives. Approval and rejection
are unavailable in this release. The removed `operator.returns` route returns
HTTP 404 with `starter_operation_unknown`.

The catalogue covers 14 declared named-refusal operations. The removed reader
retains its separate HTTP 404 protocol.

| Operations | Named refusal |
| --- | --- |
| `return.request` | `starter_return_request_unavailable` |
| `operator.returnApprove`, `operator.returnReject` | `starter_return_decision_unavailable` |
| `operator.hold`, `operator.release` | `starter_order_hold_unavailable` |
| `operator.cancelUnpaid` | `starter_order_cancellation_unavailable` |
| `operator.externalRefund` | `starter_external_refund_mark_unavailable` |
| `operator.label`, `operator.handoff`, `operator.delivery` | `starter_shipment_mutation_unavailable` |
| `tracking.read` | `starter_tracking_access_unavailable` |
| `subscription.command` | `starter_subscription_command_unavailable` |
| `research.submit`, `ingest.submit` | `host_binding_required` |

Shipment list/detail use the native commerce reader in one repeatable-read,
read-only snapshot after native human-admin authorization on each request.
Unknown input fields and invalid selectors refuse before shipment I/O.
The destination view never prepares or pins a shipment. A pinned parcel retains
its destination when the order's current destination changes. This reduced
projection keeps the captured fulfillment client id, provider kind, parcel-line
ids and saved-address id null, item reservation links empty, and reservation
locations null. It supplies
no contact revision, digest, correction target or baseline comparison. Tracking
and operation evidence retain the native reader's limits; missing required facts
refuse rather than omit a selected shipment. See the canonical
[native read limits](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#native-parity-boundaries).
Shipment mutations remain unavailable. Owned account tracking needs
its separate account composition proof. Signed unsubscribe retains its separately
owned pending binding. Other absent bindings return `host_binding_required` after
admission. An invalid-grant example does not
prove a valid grant works.

Both example catalogues price in `XTS` test units for fictional market `ZZ` at
`UTC`. These choices make no real tax, shipping or compliance claim. The selected
configuration is a non-secret `--configuration` argument. The one-command
installation target defaults from the owned registry. CLI transport does not
supply an installation capability.

## Partner intake and reviews

No generic contact form; the partner inquiry is the durable intake.
Support is static and shows optional validated `supportEmail` as plain text,
with an account link. Missing contact configuration is stated explicitly.
The application declares 51 operations. With a runtime connection, the partner
submit/list/transition and review read/submit/list/moderation actions are mounted.
Without that connection they remain unbound, like the other native actions.

Partner requester quotas use a hash of the socket peer, never the email or a
forwarded header. A proxy therefore shares one requester quota across its users;
this local host does not establish trusted proxy admission. Native quotas are
five requester attempts and three email attempts per 60-minute window; command
replay precedes the quotas, and repeated contact submits conflict. The native
contact deduplication has no time-based expiry. Public success returns only the
case reference; contact details are visible through the authorized operator view.

Review read and submit require an accepted, unexpired native order review grant.
Invalid references do not prove positive grant behavior. Positive review submit/read, publish/hide, revocation and grant ownership move
to the later review journey after delivered-shipment reads. Ownership retains
the native bearer-capability semantics. The issuer fixes expiry at thirty days
and provides no application time seam. This purchase contribution claims no
additional review proof beyond the earlier intake composition.
Operator list/moderation admission reuses native human membership, rechecked on
requests; a customer session supplies no operator authority.

Tester application submission is a public durable write through the native
acquisition case port. The adopter-owned seed follows the owner-loaded registry
contract in the acquisition foundation migration header, lines 16-17. The owned
fictional address registry is loaded only by the install connection in the same
marked demonstration transaction as the catalogue seed. Repeating installation
verifies the existing tuple; a changed provenance or inactive row fails with
`starter_acquisition_seed_conflict` and rolls back. The browser submits a choice
identifier, email, explicit consent and locale only. The host refuses extra fields
including raw reference/source/revision/provenance, supplies the tuple, policy
revision and fixed source path, and derives requester identity exactly as partner
intake does. Native replay, contact conflict and peer/email quotas still apply.
Names are not collected or stored. Public success exposes only the case reference;
no operator acquisition endpoint is declared.

The following paragraph records the acquisition-only baseline before support
and catalogue composition. Current support and catalogue bindings follow the
owner-roster recipe and amended N1 above; those earlier unbound statements do
not describe the combined application.

Operator customer search and detail remain unbound: the native support journey
reader additionally requires an active communications operator roster entry,
which the human session does not provision. No second operator authority is
seeded or inferred. Bundle and catalogue administration remains unbound; N1 is
unchanged.

Research remains `host_binding_required` until the host can authorize ownership
of the research case (`authorizeResearchCase`); normalized ingest also remains
`host_binding_required`. Neither action is mounted merely to return a refusal.

Catalogue drafts write only isolated authoring tables (packages/platform/sql/20260908100000_catalog_draft_foundation.sql:1-9); bundle activation sets the native bundle status to active (packages/platform/sql/20260812210000_bundle_operator_write_boundary.sql:493), while this application’s storefront and checkout use typed configuration through evaluateOffer (examples/neutral-store/shared/offer.ts:40). An activated bundle is not purchasable in this release and comes in a later round.

See the [operator roster recipe](../README.md#operator-support-roster-and-catalogue-authoring) for support provisioning and deactivation through the owner connection.


## Purchase composition boundaries

The starter runs on its local demonstration database only; a hosted database connection is not part of this release and comes in a later round.
For now this release does not charge shipping on one-off orders.
For now this release does not charge shipping on renewals.
The first-subscription offer is not offered yet and comes in a later part of this release.
A purchase needs no account; checkout keeps a contact record for the e-mail; the customer signs in with that e-mail to see the purchase.

Starter działa wyłącznie na lokalnej demonstracyjnej bazie danych; połączenie z bazą hostowaną nie należy do tego wydania i pojawi się w późniejszej rundzie.
Na razie to wydanie nie pobiera opłat za dostawę zamówień jednorazowych.
Na razie to wydanie nie pobiera opłat za dostawę odnowień.
Oferta na pierwszą subskrypcję nie jest jeszcze dostępna i pojawi się w późniejszej części tego wydania.
Aktywowanego pakietu nie można kupić w tym wydaniu; taka możliwość pojawi się w późniejszej rundzie.
Zakup nie wymaga konta; przy zakupie zapisujemy kontakt dla podanego e-maila; klient loguje się tym e-mailem, aby zobaczyć zakup.

These localized boundaries also appear on the shared limits page. The guest
flow describes the contact-client composition; checkout creation uses the public contact registrar after attempt admission. No demonstration clients are installed as seed.
An admitted new checkout issues a 256-bit recovery token through the native
PostgreSQL port. Only its SHA-256 hash is stored. PostgreSQL fixes expiry at
order creation plus 24 hours; this is a database rule, not a configurable value.
One live link per order: a new link ends the previous link of the same order.
The token is returned only in the creating response and a separate private
captured checkout-recovery message, never an authentication challenge or event.
The completion page reads the URL token once and replaces history synchronously
before configuration fetch or rendering. Request bodies carry the token; memory
and session storage preserve reload convenience but grant no authority. An unchanged repeated submit for the same order keeps its existing token when the replay response omits it. A different order never inherits that token, and a new token replaces the previous one.
Native inspection allows payment only for an active pending order, recognizes
an already-paid order without payment controls, and refuses expired, cancelled
or unavailable links. Indexed hash lookup makes no constant-time claim.
Owning sessions retain order ownership checks. An email alone mints no link for
an existing order. Recovery grants no account or subscription-command access.

Address changes render the native result: `applied` says “Shipping address
updated.” / “Adres dostawy został zmieniony.” The result
`applied_from_next_parcel` says “This address change applies from the next parcel.
A parcel already in flight keeps its current address.” / “Zmiana adresu obowiązuje
od następnej przesyłki. Przesyłka będąca już w drodze zachowuje dotychczasowy adres.”
The native customer branch returns the next-parcel outcome. Current-parcel
operator correction is not offered through this customer action.

Generic subscription commands remain unmounted pending a complete native fit.
Authenticated payment recovery authorizes the same native unpaid obligation.
The selected native installation includes the command receipt-lock completion.
Operator recovery passes the committed real-HTTP proof in both configurations and
revalidates active human membership and support authority on replay. No refusal
pauses or freezes an active subscription or confirms an undelivered replacement.


## Interim subscription mode price

The configured subscription rate and rounding quantum resolve each unit before
quantity is applied. Quote lines and installed subscription price entries carry
that actual unit price. A `mode_discount` component explains the included benefit;
there is no order promotion or second deduction. First-subscription acquisition
is a separate later offer. `shared/interim-pricing.ts` owns this temporary rule;
the later installed quote-engine composition replaces it.

The owned seed writes distinct one-time/subscription price entries. Repeating an
identical seed inserts no new entries. A different authored price under the same
identity refuses with `starter_price_seed_conflict` and rolls back; it never
silently rewrites installed price truth. A customer environment needs its own
onboarding. Demo stock quantities/timestamps, input bounds, reservation lifetime,
sandbox template choices and fictional tax inputs live in typed owned config.
These are local demonstration values, not provider or compliance qualification.
The accepted origin/session boundary retains its separate limits.

Attempt limits live in one process's memory and reset on restart.
Limity prób działają w pamięci jednego procesu i resetują się po ponownym uruchomieniu.
Checkout applies the configured attempt window, e-mail and requester counts, retention and capacity before contact resolution. Exact replay means the same command key, normalized e-mail and requester; it is free of further quota counts. A retained key with a changed identity is refused before contact resolution, including with a replacement quota callback. The synchronous host binding keeps identity digests within the same retention and capacity bounds; it fails closed when full. Denied quota attempts add nothing to the quota counts. Both process-local records reset on restart. Unpurchased contact retention belongs to the host.

Purchase and sign-in share `purchase.inputLimits.email`, capped at 160 characters
by configuration validation. Both demonstrations use 160. Longer purchase e-mails
receive `starter_email_invalid` before contact resolution. Checkout and subscription
address changes share the configured phone and postal-code limits; configuration
cannot exceed the native destination bounds. Browser fields use those same limits.


Configured subscription cadences and their default are whole days from 1 through
120, matching the native checkout. Checkout admits at most 50 selected lines and
99 units per line within the configured total. Stock and seeded unit prices fit
PostgreSQL integers; each offered mode must have a positive seeded unit price.
Tax legal-basis text is at most 200 characters and the shared legal revision is
trimmed, nonempty text of at most 64 characters. Configuration rejects values
outside these native boundaries before composition.

## Paid-order message capture

The one-shot lifecycle renewal command also drains only paid-order email events,
including when renewal execution is disabled. A paid order with its emitted
paid-mail event and contact yields one private filesystem message record;
unpaid and cancelled purchases emit no paid-mail event. The record dedupes
reclaimed sends, and processed outbox state prevents another claim. No real mail
provider is active. This adds no other event dispatcher, transport, SQL or grant.
Subscription notices retain their separate native owner and existing limits.
