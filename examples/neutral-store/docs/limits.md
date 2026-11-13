# Portable sandbox limits

Status: moved to the [OpenLup guide](../../../packages/core/docs/guide/reference/limits.md); the starter's canonical limits table is shared/limits.ts. Sections marked "Evidence" are frozen historical records.

`owned/demo-seed.ts` builds demonstration rows from typed configuration. `installation/install.ts` runs the transactional seed with the install connection after bootstrap; stock observations use the native stock writer. Do not replace purchase or renewal truth with application rows.

The portable rail has **no lot traceability, locations or stock movements**.
Readers of the supplement and coffee configurations may expect these features;
the examples provide none of them and make no health or compliance claim.
The same statement is visible in both locales on the limits page.

Other explicit boundaries: monetary refund creation, receiving/restocking
returns and catalogue publication are unavailable; no legacy participant source
exists; media bytes need a proper storage binding. Reduced OMS reads do not
stand in for rich projections. Review grants do not establish account sessions,
and account sessions do not establish authority over an arbitrary research case.

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
orders. Placing and releasing order holds require an active human admin and a
provisioned Commerce operator. Every invocation, including replay, repeats those
checks. Release targets the exact hold reference.

The operation catalogue in `shared/limits.ts` supplies the same code and exact
localized explanation to action results and the limits page. Named deferred
actions remain unbound and refuse after customer/operator admission, before any
native routine. Return forms retain reason codes, order-item quantities and
refund intent. No operator returns list or detail; the operator approves or
rejects by the return reference the customer receives. Authenticated customers request returns for owned paid or fulfilled orders. Active
human admins approve or reject the exact request reference; these decisions record
intent only. Receiving, restocking and financial refund execution remain unavailable. The removed `operator.returns` route returns
HTTP 404 with `starter_operation_unknown`.

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
Operator label, handoff and tracking evidence commands are bound. Owned account tracking needs
its separate account composition proof. Signed unsubscribe retains its separately
owned pending binding. Other absent bindings return `host_binding_required` after
admission. An invalid-grant example does not
prove a valid grant works.

Both example catalogues price in `XTS` test units for fictional market `ZZ` at
`UTC`. These choices make no real tax, shipping or compliance claim. The selected
configuration is a non-secret `--configuration` argument. The one-command
installation target defaults from the owned registry. CLI transport does not
supply an installation capability.

| Limit | Actions | Named refusal |
| --- | --- | --- |
| N8 | Demand-driven plan-length and portion resizing are unconfigured; the seven exact commands are API-only | `starter_subscription_resize_unconfigured` |

Sandbox payments only are in scope on this rail. Real-money commerce currently needs a
separately qualified rail and provider; this app does not claim real-money
provider independence. An existing subscription is never paused or frozen by
these refusals. The starter does not expose confirmation of an undelivered
replacement parcel.

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

The host exports `composeSizedPaidEmailNote` using frozen order quantities,
exact physical identity and frozen renewal cadence. The lifecycle renewal entry
mounts the paid-email handler through `host/paid-mail.ts` with this callback.
Its private captured receipts include proven sized renewal parcel notes when the
stored subscription binding is sized at send time. Classic bindings, acquisition
receipts and unprovable parcel facts omit the note.

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

No generic contact form; the partner inquiry is the durable intake.
Support is static and shows optional validated `supportEmail` as plain text,
with an account link. Missing contact configuration is stated explicitly.
The application declares 70 operations (66 bound with a runtime connection). With a runtime connection, the partner
submit/list/transition and review read/submit/list/moderation actions are mounted.
Without that connection they remain unbound, like the other native actions.

Partner requester quotas use a hash of the socket peer, never the email or a
forwarded header. A proxy therefore shares one requester quota across its users;
this local host does not establish trusted proxy admission. Native quotas are
five requester attempts and three email attempts per 60-minute window; command
replay precedes the quotas, and repeated contact submits conflict. The native
contact deduplication has no time-based expiry. Public success returns only the
case reference; contact details are visible through the authorized operator view.

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

Research remains `host_binding_required` until the host can authorize ownership
of the research case (`authorizeResearchCase`); normalized ingest also remains
`host_binding_required`. Neither action is mounted merely to return a refusal.

Catalogue drafts write only isolated authoring tables (packages/platform/sql/20260908100000_catalog_draft_foundation.sql:1-9); bundle activation sets the native bundle status to active (packages/platform/sql/20260812210000_bundle_operator_write_boundary.sql:493), while this application’s storefront and checkout use typed configuration through evaluateOffer (examples/neutral-store/shared/offer.ts:40). An activated bundle is not purchasable in this release and comes in a later round.

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

These localized boundaries also appear on the shared limits page. The guest
flow describes the contact-client composition; checkout creation uses the public contact registrar after attempt admission. No demonstration clients are installed as seed.
An admitted new checkout issues a 256-bit recovery token through the native
PostgreSQL port. Only its SHA-256 hash is stored. Checkout creation, reminder
waves and signed-in recovery issue links whose continuation authority ends 24 hours after order
creation; these issuers preserve earlier links. Links in checkout-expiry notices instead
expire 30 days after order creation and retain the terminal source order.
Eligible expiry can start a replacement through the single Pay action; the
source order itself cannot be paid. An operator-issued checkout link revokes all earlier links
for that order; its continuation authority ends at the earlier of issuance plus
24 hours or order creation plus 30 days. Payment prevents further payment through any link;
other links remain subject to their own expiry and the operator revocation rule.
Payment-case links rotate separately, leaving one live link per case.
The token is returned only in the creating response and a separate private
captured checkout-recovery message, never an authentication challenge or event.
The completion page reads the URL token once and replaces history synchronously
before configuration fetch or rendering. Request bodies carry the token; memory
and session storage preserve reload convenience but grant no authority. An unchanged repeated submit for the same order keeps its existing token when the replay response omits it. A different order never inherits that token. A new token replaces the token stored in this tab; this storage update does not revoke other links. Operator issuance revokes them through the native issuer.
Live pending-order links support sandbox continuation payment of the original
order, including retry after a decline. Dedicated token pay and exact cookie-authorized
inline retry are also bound for the explicit synthetic sandbox choices. Real-provider
method switching and instrument setup remain unavailable.
Expired-policy inspection can offer recreation of a fresh order until 30 days
after the source order was created, including system-abandoned initial checkouts.
Frozen re-quoting, unchanged supported content, stock admission and proven prior
payment non-settlement remain required. Manual cancellation, paid orders and
revoked or unavailable links cannot start payment. Paid presentation has priority
over any stored attempt. Fresh recreation uses its transition and replay receipt. Dedicated token or
exact-cookie retry can then act on its same pending replacement; the ordinary
sandbox action cannot start an attempt on that replacement. Indexed hash lookup makes no constant-time claim.
Owning sessions retain order ownership checks. An email alone mints no link for
an existing order. Recovery grants no account or subscription-command access.

Address changes render the native result: `applied` says “Shipping address
updated.” / “Adres dostawy został zmieniony.” The result
`applied_from_next_parcel` says “This address change applies from the next parcel.
A parcel already in flight keeps its current address.” / “Zmiana adresu obowiązuje
od następnej przesyłki. Przesyłka będąca już w drodze zachowuje dotychczasowy adres.”
The native customer branch returns the next-parcel outcome. Current-parcel
operator correction is not offered through this customer action.

The starter runs on its local demonstration database only; a hosted database connection is not part of this release and comes in a later round.
The first-subscription offer is not offered yet and comes in a later part of this release.
A purchase needs no account; checkout keeps a contact record for the e-mail; the customer signs in with that e-mail to see the purchase.

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

The configured subscription rate and rounding quantum resolve each unit before
quantity is applied. Quote lines and installed subscription price entries carry
that actual unit price. A `mode_discount` component explains the included benefit;
there is no order promotion or second deduction. First-subscription acquisition
is a separate later offer. `shared/offer-estimate.ts` owns this temporary rule;
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
The demonstration Compose container generates its private quote key only for a
database carrying the demonstration marker. It reuses that file on restart;
container recreation rotates it, so unsubmitted subscription quotes must refresh.
Customer environments supply their own keyring. A host without the key-file
flag refuses subscription quotes with `starter_quote_acceptance_key_required`;
one-time checkout remains available.
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

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#paid-order-message-capture).

The one-shot lifecycle renewal command also drains only paid-order email events,
including when renewal execution is disabled. A paid order with its emitted
paid-mail event and contact yields one private filesystem message record;
unpaid and cancelled purchases emit no paid-mail event. The record dedupes
reclaimed sends, and processed outbox state prevents another claim. No real mail
provider is active. This adds no other event dispatcher, transport, SQL or grant.
Subscription notices retain their separate native owner and existing limits.
The sibling settlement event is known but unclaimed: it remains pending without
delivery or a message record, and does not hold the paid receipt behind it.

## Subscription care

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#subscription-care).

Skip, slide, pause, resume, cancellation with save offers, order now and
reactivation use the native command adapter. The host supplies trusted timing;
no browser value establishes charge eligibility. Pause and cancel remain
available with an open payment case, subject to the native in-flight fence.
The scheduled care entry selects finite auto-resume, native notices and winback
only. Its capture is local; it establishes no real email delivery.

Winback keeps the unseeded default retention gate ON and writes no settings row.
The portal displays native refusal and host-recorded delivery outcomes. It has
no retention-consent capture; newsletter/offers do not authorize retention.
A trusted host may record consent through the native routine. Adopter policy
changes follow the [owning section](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#composed-subscription-module).
Private-profile views, real payment methods and signed unsubscribe retain
their separately named boundaries. No generic edit verbs are mounted.

Evidence (historical record, 2026-11-13):

The finite auto-resume host is bound and proved in both configurations after a
synthetically delivered first order. A clock past the finite pause and renewal
date produces an active subscription, a date rolled forward by whole cadences
and one locally captured resumed confirmation, including replay. The fixture
supplies its own external fulfillment facts; operator tracking commands have a separate witness.

## Account and operator bindings

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#account-and-operator-bindings).

N4 and N7 are closed: both replacement and complete fulfillment cancellation,
and customer name/phone editing, now use the installed native ports. Replacement
arrival confirmation remains absent. N5 retains private/profile views. Saved addresses, subscription
destination selection and scoped preferences use their native ports. N9 retains rich reports/analytics and
saved account draft resume; operator checkout links are bound separately.

Account event history excludes private payloads.

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

Expired checkout entry inspects the original order and its latest recovery
lineage. Paid and manually cancelled orders have no Pay control. Eligible
expired orders retain a single Pay action: native frozen re-quote validation,
prior sandbox non-settlement evidence and stock admission precede replacement
payment start. Changed commercial facts, unsupported starter content and stock
refusals cannot start payment. Durable draft, lineage and attempt receipts keep
replay on one replacement and one attempt. Replacement-attempt simulator controls
remain bound to the inspected bearer, lineage and durable execution receipt;
reload reads the same attempt, independently of the recreation source link's
continuation lifetime. Captured executions show no simulator controls. Dedicated token pay, exact inline retry and the embedded-browser buyer-link
control are bound for sandbox attempts; real-provider execution remains unavailable.

Recovery re-quoting uses the email in the original immutable private checkout
capture, keyed by the source checkout's root order. It never substitutes the
current account email or a later profile edit. Missing, corrupt or erased capture
refuses recreation before a quote, draft or payment starts. This is the starter's
owned frozen-source binding, separate from bearer authorization. The capture
file is personal data. This starter supplies no private-mailbox export or erasure
procedure. The application owner handles access, retention and deletion under
their own privacy policy. Deleting that capture file makes future recreation
refuse; no account, profile or later notice reconstructs it. Private captures remain outside served
assets, logs, traces and public reports.

Hold and release resolve the human administrator before every command and replay.
The database owner provisions one `commerce_operators` row per human admin, with
`id` equal to the native principal ID. Never delete this row: holds retain its
attribution. Withdraw access by revoking the membership through the identity
owner. Distributors and admins without the Commerce row cannot issue or replay
these commands. A locked upcoming cycle refuses an address change with
`payment_blocked`; existing order and parcel destinations remain unchanged.

Evidence (historical record, 2026-11-13):

The additional real-PostgreSQL journeys run in the `recovery extension ` group
from the single shared `browser-groups.mjs` source. Each group uses a fresh
installation pair, one worker and traces, screenshots and video off. Checkout
quota and all runner guards remain unchanged.

## Unpaid cancellation and manual refund records

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#unpaid-cancellation-and-manual-refund-records).

The operator first reads the exact order, enters a reason and confirms the shown
consequence. Unpaid cancellation uses the native unpaid-order command and releases
only held purchase reservations. Dispatched, indeterminate and captured payment
evidence can refuse it. It does not cancel a subscription or a dispatched parcel.
Manual refund marking records a paid order as refunded after the operator confirms
that the refund was completed outside this application. This command moves no
money, sends no refund email, creates no fiscal reversal and changes no subscription.
Genuine provider-refund duties retain their existing owners.

Each command and replay rechecks the human admin and resolves the existing Commerce
operator row. Caller identities, missing confirmation, invalid reasons, stale
order status and conflicting commands refuse. Reasons use the package's trimmed
1–2,000 character contract. Native durable receipts own replay. The two formerly
unavailable actions are bound; physical-return, tracking and account limits stay separately
listed until their own complete bindings exist.

## Return requests and decisions

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#return-requests-and-decisions).

Signed-in customers submit configured reason codes and positive quantities for
items from their own paid or fulfilled order. Native ownership, quantity and
canonical replay checks own admission. The customer retains the returned request
reference. There is no operator returns list or detail: an active human admin
uses that exact reference to approve or reject. Every decision and replay resolves
the existing Commerce operator after fresh membership admission. Full, partial
(including zero) and no-refund modes record intent; partial requires an amount.
A repeated decision receipt preserves the original note. These operations do not
receive goods, restock, execute a refund or change a subscription.

## Optional payment guidance

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#optional-payment-guidance).

The ordinary completion reader may add safe payment guidance for an exact live
order bearer. A native atomic snapshot rechecks token authority and binds the
order, client, intent and current attempt. The optional reader issues no credential. The sandbox can establish a verified generic decline; it cannot identify
a method, instrument, operation or consecutive same-method refusal count. The
localized notice explains that limit; synthetic choices use the explicit sandbox
registry rather than an inferred provider method. Missing, unreadable or unsupported evidence, ineligible orders,
indeterminate attempts, observed success and read failures leave the existing
presentation unchanged. No raw evidence or attempt history reaches the browser.
Sandbox token pay, exact inline retry and the embedded-browser buyer control
have separate mutation bindings. Real-provider methods remain unavailable. This optional read creates no payment,
notification or mutation.

## Operator shipment evidence

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#operator-shipment-evidence).

Shipment commands run in a host-owned READ COMMITTED transaction. An optional handoff accounting callback belongs after that transaction commits, and retains the wrapper’s fail-soft policy; paid-capture document policy is unchanged.

The operator reads the exact parcel and confirms each label, handoff or tracking
action. Every command and replay rechecks an active human admin session; the
native human principal supplies audit attribution. Caller identities and command
keys in the body refuse. Public package handlers own request validation and the
native command runs in a host-owned READ COMMITTED transaction. Existing order,
hold and return commands retain their separate Commerce operator provisioning.

Label evidence includes an explicit provider namespace and tracking number.
Native correlation refuses cross-order reuse in the same namespace and refuses
unattributed conflicting history rather than guessing. Same-order reassignment
and raw label-key replay retain the native receipt behavior. Handoff consumes
only the recorded parcel reservation IDs once. Historical missing associations
report `reservations_not_recorded` and never acquire today's stock. Before a fresh nonterminal tracking event, native state and any supplied
same-order reference must be admitted. Terminal replay and earlier chronology
repair retain their native rules. A delivered event
records actual arrival. Explicit-zone occurrence times can repair chronology
earlier; later inputs cannot postpone recorded arrival, replace the original
receipt or move the next cycle earlier. An undelivered replacement remains an
outstanding obligation. There is no separate replacement-delivery attestation control.

Label URLs and full provider payloads are durable operator/service evidence.
URLs may appear in authorized operator operation detail; complete label requests
and raw tracking events remain in private operator receipts. URL expiry does not
erase their stored bytes. No automatic purge or TTL is supplied: the application
owner controls retention and authorized cleanup, including backups and transferred
copies. Customer pages, account reads and public tracking do not expose this
operator evidence. Public tracking authorization remains unavailable.

## Saved addresses and scoped preferences

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#saved-addresses-and-scoped-preferences).

The account page reads, creates, edits and deletes the signed-in customer's saved
addresses, with native formatting, default clearing and account events. Default
clearing, address writes and event append are separate commits: a failed save can
leave earlier changes committed, so reload before retrying. An admitted command
key returns the current book without another write. Deleting a missing or foreign
row acknowledges a zero-row deletion and returns only the caller's book; updating
a foreign row refuses. Active or paused subscription use prevents deletion.

An active or paused subscription can select an owned shipping/both address.
The native command owns the saved pointer, subscription/account events and outbox.
A locked upcoming cycle refuses a fresh selection; an admitted key replays before
saved-ID parsing and returns the current pointer. Null recipients remain null.
Editing a saved row affects future destination materialization, while a retained
renewal operation and existing parcel keep their immutable destination. Cadence,
commercial terms and billing are unchanged.

Payment and delivery selections use one-time, subscription or any scope. These
preferences do not install an instrument, activate a provider, charge, or append
account events. Native renewal preparation uses subscription scope before any
scope and preserves an explicit delivery selection. Incomplete locker pickup
addresses can be saved but are skipped when a renewal chooses a delivery.

Billing profiles are bound through the native session-scoped reader and mutation
handler. The portal supports create, read, edit and delete, including the native
company identity fields and the owned tax normalization/checksum policy. Default
clearing, profile writing and account-event append remain separate commits: a
later failure can leave earlier writes committed, and billing command keys do not
deduplicate writes or events. Foreign edits refuse; deleting a foreign or missing
row acknowledges a zero-row deletion. Address-book responses include real owned
billing profiles. Default snapshots expose redacted, unapplied selection hints;
they install no instrument and do not apply a profile to an existing order.
Private and combined-profile views remain limited under N5. The fictional country,
phone prefix and numeric tax checksum are demonstration validation, not real-market
certification.

The saved addresses and preferences contain personal data. Application owners
compose the native privacy contributors with identity, subscription and account
event coverage and own retention and access. This starter supplies no customer
export or erasure endpoint; saving a preference does not establish that workflow.

## Sandbox token payment and exact continuation

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#sandbox-token-payment-and-exact-continuation).

Completion can start dedicated token payment for a live checkout continuation with
one of two explicit synthetic demo choices. Native admission reuses the existing
latest owned recovery descendant, intent and reservation and refuses expired/revoked authority, renewals,
terminal orders and unresolved attempts. Fresh recreation retains its lineage/receipt transition. A later explicit token
retry may dispatch another attempt on that same replacement, while the ordinary
simulator remains fenced from creating attempts on recreated targets. No real-provider or instrument capability is implied.

Only an actual fresh dispatched sandbox attempt can mint the native continuation
cookie. Its private claims bind the real order, client, intent, attempt and rail;
this composition uses the native order UUID for the opaque checkout journey. The
codec purpose-derives its signing key from the existing private host keyring's
current root, supplied by `--quote-acceptance-key-file`. Keep that root stable across a host restart; rotating it invalidates
old continuation cookies. No key, raw cookie or token belongs in logs or public
reports. The cookie keeps its native Secure, HttpOnly, SameSite=Strict and Path=/
attributes and lifetime. Checkout creation mints no continuation. Browser storage
is reload convenience and never grants this authority. Missing signing material
leaves cookie-only controls unavailable; it does not fabricate a credential.

An exact failed predecessor and native guidance admit inline retry with a stable
retry nonce. The actual transport cookie is required: a bearer token or body
identity cannot widen the entry. Registered demo references supply synthetic
method identity; the sandbox evidence normalizer still reports method, operation
and provider advice as unknown. Opaque, unregistered attempt references do not
authorize inline retry; a still-live recovery token can use dedicated token pay
instead. No method identity is guessed for an older/default attempt. Atomic native admission owns competing nonces,
current-attempt checks and replay. Response-loss replay returns the one dispatched
replacement attempt without another dispatch and rotates its cookie. Terminal,
captured, technically expired and stale targets refuse before simulator effects.
No payment-method hold policy is selected by this application; the public hold
wrapper receives that explicit unconfigured policy. Real-provider execution,
method setup and card replacement keep their named refusals.

Only detected embedded browsers show the buyer send/send-again control after real
continuation exists. Detection is a display hint, never authority. The native
cookie-only handler obtains order/client from verified claims, uses the saved
checkout recipient, and deduplicates sends in its unchanged ten-minute bucket.
The sent confirmation survives panel remounts while sending again remains reachable;
failure offers a neutral retry. Delivery rechecks the native buyer authorization
and captures the link in the existing private mailbox. The source marker
distinguishes the buyer landing. Enqueue, capture and payment are separate facts.

## Billing profiles and frozen invoice buyers

Moved to [Starter limits](../../../packages/core/docs/guide/reference/limits.md#billing-profiles-and-frozen-invoice-buyers).

Install the complete ordered package history required by the billing and recovery owners. Payment capture and subscription activation keep separate transaction boundaries. Compose the native billing, address, preference and parcel-contact privacy contributors with application-owned identity/subscription coverage; account-event retention is unresolved.

Install the complete ordered package history through
`20261110280000_checkout_recovery_buyer_snapshot` before starting this composition.
The host requires the slot-27 first-duty buyer-capture entry; slot 28 preserves
absence of explicit buyer facts during recreation. `./lifecycle up` installs the
complete history. No duty or historical invoice is backfilled.

Before sandbox payment capture, initial checkout records its owned order
destination; native recreation and renewal record theirs through their native
owners. On the first owed-duty capture, the invoice owner freezes explicit order
buyer facts when present. Otherwise it selects the default or latest owned profile
and billing/both address independently, using the recorded shipping address when
no billing address exists. With neither profile nor billing address, it records the
marked shipping fallback. The frozen address keeps line2 and source provenance. Recreation copies explicit buyer facts
only when the source has them; absent facts remain absent so first-duty selection
can use an owned profile or the marked fallback. Later profile/address edits or
deletions cannot change a captured buyer, installed invoice facts or issued bytes.
Customer invoice history checks ownership before reading this snapshot; operator
summary requires current human-admin authorization.

`payment.simulate`, `checkout.payment` and recreated `checkout.recovery` simulation
share one capture/activation helper. Retained acquisition renewal availability
validates before a capture observation is recorded. After successful native ingress,
an initial subscription declaration activates through its native acquisition or
classic renewal branch. Capture and activation keep their existing transaction
boundaries; a cross-transaction outage is not an atomicity guarantee.

The Node host composes customer-billing, saved-address, preference and parcel-contact
privacy contributors. Its programmatic registry requires identity and subscription
coverage from the application owner and reports missing contributors; account-event
retention remains unresolved. It supplies no HTTP export/erasure workflow. Owners
must complete these boundaries and retain authorized cleanup of private captures.
Erasure or corruption of the original immutable checkout capture refuses recovery
re-quoting; it is never reconstructed from current billing or profile data.
