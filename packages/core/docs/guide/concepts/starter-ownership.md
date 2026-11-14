# Who owns what in the starter

Use the starter's ownership inventory to decide which application files you
customize and which updates need review.

## Read the inventory

`ownership.json` lists exact application-relative paths in `owned` and `managed`.
It also identifies generated output and fictional demonstration data. The
extractor copies the owned and managed files into an independent application;
source-only tooling stays outside it. No implicit parent repository or glob
expands that list.

| Class | Responsibility |
| --- | --- |
| Owned | Your identity, configuration, general copy, media, named presentation fragments and application agent instructions |
| Managed | Starter host, pages, shared validation and data shapes, application checks, lifecycle wrapper and documentation |
| Source only | Archive extraction tooling and package/compiler checks retained by the source release |
| Generated | Local provenance, artifact identities, installation lockfile and build or browser output |

The candidate installation lockfile is ignored; released or reconstructed
extraction commits its registry lockfile. Both remain generated and outside
owned/managed upgrade snapshots.

`demoData` is a subset of owned files; it does not make the fictional data safe
for a customer environment. Replace its data, authority, policies and external
bindings for your application. `sourceMappings` maps the non-loading instruction
template to the extracted application's `AGENTS.md`; preserve your local rules
outside its managed instruction block.

Managed files are candidates for a reviewed starter update. The inventory does
not promise automatic overwrite or upgrade preservation. `./lifecycle ownership`
prints it without changing files; lifecycle verification and upgrades delegate
to the installed CLI. Follow [Upgrade application files](../upgrade/application-files.md)
for that CLI's actual file ownership procedure.

## Take ownership of a page

Use configuration or a named fragment for the changes they cover. A complete
layout or navigation change, new checkout or account workflow, operator workflow,
or application-specific route needs owned source. Copy only the affected managed
page into an owned path, update its imports, and move the relevant exact paths
from `managed` to `owned` in `ownership.json`. Record why in your application's
change history. New routes also need owned shell and routing files.

You then maintain security, accessibility, compatibility, checks and manual
porting of later fixes for that page. An owned copy receives no automatic
platform fix. Keep package engines as installed dependencies, with their
lockfile integrity and matching guidance. See
[Customize the starter store](../how-to/build/customize-the-starter.md#change-a-page-or-add-a-route)
for the route-edit steps.

## Own configuration and data onboarding

Your owned inputs include the configuration registry and default, public origin
and insecure-HTTP opt-in, support contact, editor values and copy, offer shipping
fee and free-delivery threshold, catalogue type registry, acquisition choices,
and renewal and account policies. Editor localization lives in
`owned/editor-copy.ts`. Origin admission, sessions, page models and
native host composition remain managed.

`owned/demo-seed.ts` builds fictional catalogue, price, editor and subject data.
The managed installer runs outside the HTTP host and requires the installation
login, current role and database demonstration marker. It refuses an unmarked
existing database and never turns it into a demonstration database. Only the
installation container receives the privileged socket; the host receives a
restricted runtime connection. Missing migration composition refuses with
`starter_installation_binding_required`.

Use your own onboarding for a customer environment. The demonstration installer
uses native stock writers, installs verified product documents and loads the
fictional acquisition registry. It does not seed customers, editable
subscriptions, renewal terms or payment-method state; purchase creates those
through native writers. Checkout never imports the install-only seed.

Catalogue drafts and bundle activation do not change the configured storefront
offer. Support reads and catalogue administration use native operator bindings;
support access has a separate owner-provisioned roster. The installer and runtime
host provide no roster provisioning endpoint.

## Protect generated private state

Captured messages, process sessions and the demonstration quote keyring are
runtime state, separate from owned configuration and installed engines. Treat
captures as personal data and credentials. Keep them outside built assets,
browser configuration, logs and public reports. Your application owns retention,
access and authorized cleanup, including backups and transferred copies.

The demonstration reuses its quote keyring across a restart of the same
container. Recreating the container requires fresh quotes. Supply your own
private keyring in your environment. For setup details, see
[local sessions and messages](../how-to/build/customize-the-starter.md#protect-local-sessions-and-messages).

## Checkout continuation and recovery

Checkout does not require sign-in. A typed email alone cannot obtain a link to
an existing order. Signed-in recovery rechecks order ownership; a recovery link
grants neither account access nor subscription-command authority.

New checkout issues a cryptographically random recovery token through the native
store, which persists only its hash. The creating response and separate private
checkout message carry the token. Authentication messages and account events do
not. Completion removes a URL token from history synchronously before loading
configuration. Memory and session storage allow reloads; native inspection
still decides authority. A repeated response without a token preserves the
existing token only for the same order. Replacing tab storage does not revoke
other links.

Initial checkout, reminder and signed-in recovery links end continuation at the
order's configured checkout deadline. Expiry-notice links retain the terminal
source for the longer recovery window. An operator-issued link revokes earlier
links for that order and expires at the earlier of its own lifetime or the
order's recovery deadline. Payment prevents further payment through a link;
other links still obey their expiry and revocation. Payment-case links rotate separately, invalidating their predecessor.

Use the [recovery issuer contract](https://github.com/openlup/openlup/blob/openlup-core-v0.41.0/examples/neutral-store/docs/ownership.md#application-ownership)
for token construction and exact continuation, recovery and operator-link deadlines.

A pending order can continue sandbox payment and retry a decline. Expired orders,
including system-abandoned initial checkouts, can offer a replacement within the
recovery window. The source itself cannot be paid. Frozen re-quoting, unchanged
supported content, stock admission and proven prior non-settlement precede
replacement payment. Paid or manually cancelled orders, revoked grants, changed
commercial facts and unsupported content cannot start it. Paid presentation
takes precedence over an old attempt.

Durable draft, lineage and execution receipts keep repeated recreation on the
same replacement and attempt. Reload can read that dispatched replacement's
execution independently of the source link's continuation lifetime. Captured
executions show no simulator controls. The ordinary simulator cannot start an
attempt on a recreated target; explicit token pay or exact-cookie retry can act
on the same pending replacement. Token hash lookup carries no constant-time
guarantee.

Re-quoting uses the email in the original immutable private checkout capture,
selected by the root order. Current account email, profile edits or later notices
cannot replace it. A missing, erased or malformed capture refuses with
`starter_recovery_unavailable` before quote, draft or payment work. Deleting the
capture therefore disables future recreation. The starter supplies no mailbox
export or erasure workflow; implement your privacy policy around those files.

## Checkout admission limits

Attempt quotas and command-identity bindings are process-local and reset on
restart. Before resolving a contact, checkout checks configured email and
requester quotas, retention and capacity. Exact replay keeps the same command
key, normalized email and requester without another quota count. Changing the
identity under a retained key refuses even with a replacement quota callback.
Capacity failure closes admission; denied quota attempts add no quota count.
Your host owns retention of unpurchased contacts.

Purchase and sign-in share the bounded `purchase.inputLimits.email` setting;
overlong purchase email
refuses with `starter_email_invalid` before contact resolution. Checkout and
subscription-address fields use the configured phone and postal limits within
native destination bounds. The [configuration validator](https://github.com/openlup/openlup/blob/openlup-core-v0.41.0/examples/neutral-store/docs/ownership.md#application-ownership)
owns the exact limits. Browser field limits do not replace host validation.

## Paid-order messages and shipping

`owned/renewal-copy.ts` supplies localized paid-message subjects and labels.
The managed paid-mail entry selects paid-order email and captures the recipient
and rendered body privately, including a size-aware parcel note where applicable.
It runs a bounded pass without starting a scheduler or sending real mail.
Subscription notices have a separate entry.

Shipping fee and free-delivery threshold are owned offer values passed to the
native shipping policy. Purchase retains the accepted shipping agreement for
renewals. There is no `renewalShippingMinor` override: editing today's
configuration cannot replace retained terms or a frozen cycle's shipping amount.

## Subscription care

`owned/renewal.config.ts` supplies timing, cancellation reasons, notice windows,
operator caps and retry offsets. General portal and care-message copy belongs
in `owned/copy.ts`. Native ports own lifecycle effects and transactional
receipts. The account reads winback status, refusal and receipt reference;
that read grants no consent writer. The starter leaves the native default
retention gate in place. Arbitrary future-term edits refuse with
`subscription_command_unsupported_action`.

## Recurring payment recovery

The recurring-payment repair page captures its entry token before application
requests or sign-in, then rechecks the signed-in customer's owned payment case,
obligation, renewal operation and order. Browser-supplied method or payment facts
cannot authorize recovery. Confirming recovery schedules the same unpaid
obligation and returns pending state; execution and native readback must establish
that it recovered. Initial-checkout reads, simulator completion and acquisition
activation refuse recurring obligations, including for the matching owner.

## Account and operator authority

`owned/acquisition-policy.ts` supplies account validation and checkout link and
reminder timing. The host derives the actor from the accepted session and the
command key from the request. Caller-supplied identities and command keys in
action bodies refuse. Account reads expose owned event metadata rather than
private payloads. Profile writes and event appends have separate commits;
correction requests retain their native append-only repeated-key behavior.

The separate checkout-recovery mail entry selects only recovery and expiry
handlers. A captured send's native receipt gates the final reminder; enqueueing
or skipping a send does not establish delivery. Paid messages and subscription
notices use separate selections.

For holds, unpaid cancellation, manual refund records, return decisions and
parcel cancellation or replacement, provision the durable `commerce_operators`
row through the database owner, using the human admin's native principal ID.
Keep it for attribution; withdraw access by revoking identity membership rather
than deleting the row. The communications roster is separate. A distributor,
missing Commerce row or revoked membership cannot gain these powers from a body
field. Every command and replay rechecks human admin admission. A locked
upcoming cycle refuses a fresh destination change. Direct address changes expose
`payment_blocked`; saved-address selection exposes `starter_payment_blocked`.
Existing order and parcel destinations remain unchanged.

## Cancellation, refund records and returns

Read the exact order, enter a reason and confirm the consequence before unpaid
cancellation or manual refund marking. Unpaid cancellation releases held purchase
reservations; dispatched, indeterminate or captured payment evidence can refuse
it. It cancels neither a subscription nor a dispatched parcel. Manual refund
marking records an externally completed refund; it moves no money, sends no
refund mail, creates no fiscal reversal and changes no subscription. Execute
real refunds through their own owner. Invalid reasons, missing confirmation,
stale status and conflicting commands refuse; native receipts own replay. Reasons
use the native trimmed-text boundary in the [order control schemas](https://github.com/openlup/openlup/blob/openlup-core-v0.41.0/packages/platform/README.md#commerce-contracts).

Signed-in customers request returns for positive quantities from their own paid
or fulfilled orders using configured reason codes. Keep the returned request
reference: the operator approves or rejects that exact reference, without a
returns list or detail reader. Each decision rechecks the human admin and
Commerce row. Full, partial and no-refund modes record intent; partial requires
an amount and can include zero. A repeated decision preserves its original note.
These controls do not receive goods, restock, execute refunds or alter a
subscription.

## Payment guidance and sandbox continuation

Optional payment guidance rechecks a live order bearer against the native
order, customer, intent and attempt snapshot. It issues no credential, payment
or notification. A sandbox decline supplies generic refusal evidence, without
inferring an instrument, method, operation or consecutive refusal count.
Missing or unsupported evidence, indeterminate attempts, observed success and
read failures leave the ordinary presentation unchanged; raw evidence and
attempt history stay private.

Token pay uses the explicit synthetic method registry. Native admission follows
the latest owned recovery descendant and refuses expired or revoked authority,
renewals, terminal orders and unresolved attempts. A new explicit retry can
dispatch another attempt on the same pending replacement. Real payment
execution, method setup and card replacement refuse with
`native_prepared_attempt_store_unsupported`.

A fresh dispatched sandbox attempt can issue a continuation cookie binding the
order, customer, intent, attempt and execution rail. Checkout creation cannot
issue it. The codec uses the private keyring's current root; keep it stable
across restarts, since rotation invalidates old cookies. Missing signing material
leaves cookie-only controls unavailable. Browser storage grants no such
authority. Cookies retain Secure, HttpOnly, SameSite=Strict and Path=/ attributes;
keep keys, cookies and tokens out of logs and reports.

Inline retry needs the actual transport cookie, exact failed predecessor, native
guidance and a stable retry nonce. Bearer or body identity cannot widen it.
Unregistered method references cannot authorize it; a live token can still use
token pay. Native admission fences competing nonces, stale attempts and terminal
orders. Replaying a lost response returns the same dispatched attempt and rotates
its cookie. The starter selects no payment-method hold policy.

Detected embedded browsers show send and send-again controls only after verified
continuation exists. Detection changes display, not authority. The cookie-only
handler derives identity from claims, uses the saved checkout recipient and
deduplicates sends within the configured time bucket. The
[continuation composition](https://github.com/openlup/openlup/blob/openlup-core-v0.41.0/examples/neutral-store/docs/ownership.md#sandbox-token-payment-and-exact-continuation)
owns its duration. Confirmation survives panel
remounts; failures offer retry. Delivery rechecks buyer authorization and captures
the marked buyer link privately. Enqueue, capture and payment are separate facts.

## Shipment evidence and retention

Read the exact parcel and confirm each label, handoff or tracking action. These
commands and replays require an active human admin; the native principal provides
attribution. The host refuses body identities and command keys, validates through
public handlers and runs the native command in a READ COMMITTED transaction.

Label correlation uses an explicit provider namespace and tracking number.
Cross-order reuse within that namespace and unattributed conflicting history
refuse. Same-order reassignment and raw label-key replay keep native receipts.
Handoff consumes only the parcel's recorded reservations once. Historical missing
associations report `reservationDisposition: reservations_not_recorded` and
consume no current stock.
Fresh tracking checks native state and any same-order reference. Terminal replay
and earlier chronology repair retain their native rules. A delivered event means
actual arrival; an explicit-zone time can repair chronology earlier. Later input
cannot postpone arrival, replace its receipt or move the next cycle earlier.
An undelivered replacement remains outstanding. There is no separate
replacement-arrival confirmation control.

Label URLs and complete provider payloads remain durable operator evidence.
Authorized operation detail may show label URLs; complete requests and raw events
stay in private receipts. URL expiry does not erase stored bytes. No automatic
purge is supplied: you own authorized retention and cleanup. Customer pages,
account reads and public tracking do not expose these receipts; public tracking
refuses with `starter_tracking_access_unavailable`.

The starter keeps its paid-capture document policy. If your application selects
the optional handoff issue policy, invoke its accounting callback after the
shipment transaction commits and retain that wrapper's fail-soft policy.

## Saved addresses, billing and preferences

The signed-in account can read, create, edit and delete its saved addresses.
Native formatting and default clearing apply. Address writes, default clearing
and account events have separate commits: reload after a failed save before
retrying. An admitted command key returns the current book without another
write. Deleting a missing or foreign row acknowledges zero deletions and returns
only the caller's book; editing a foreign row refuses. Use by an active or paused
subscription prevents deletion.

An active or paused subscription can select an owned shipping or combined
address. The native command owns its pointer, subscription and account events,
and outbox. A locked cycle refuses a fresh selection; an admitted key replays
before saved-ID parsing and returns the current pointer. Null recipients stay
null. Editing a saved row affects future destinations; retained renewal
operations and existing parcels keep immutable destinations. Cadence, commercial
terms and billing do not change.

Payment and delivery preferences have one-time, subscription or any scope.
They do not install an instrument, activate a payment provider, charge or append
account events. Renewal selects subscription scope before any scope and keeps
an explicit delivery selection. An incomplete locker pickup address can be saved
but is skipped when choosing renewal delivery.

Billing profiles use a session-scoped native reader and handler for create,
read, edit and delete, including company identity and the owned tax policy.
Default clearing, profile writing and account events have separate commits;
billing command keys do not deduplicate those writes or events. Foreign edits
refuse; deleting a missing or foreign profile acknowledges zero deletions.
Address-book responses include owned billing profiles. Default snapshots expose
redacted selection hints without installing an instrument or applying a profile
to an existing order. The fictional country, phone prefix and numeric checksum
do not certify a real market. Separate private and combined profile views are
not supplied by these account bindings.

## Frozen invoice buyers and privacy

Install the complete package migration history before running the host. Missing
buyer-capture composition refuses with `starter_billing_installation_required`.
The demonstration lifecycle installs that history; historical invoices and duties
are not backfilled by this composition.

Initial checkout records the order destination before sandbox capture; recreation
and renewal use native destination owners. On first owed-duty capture the invoice
owner freezes explicit order buyer facts if present. Otherwise it independently
selects the default or latest owned profile and billing or combined address,
falling back to the shipping address when no billing address exists. With neither
profile nor billing address it marks the shipping fallback. The snapshot keeps
the second address line and provenance. Recreation preserves explicit buyer facts
only when present in the source. Later profile or address changes cannot alter a
captured buyer, installed invoice facts or issued document bytes. Customer history
checks ownership before reading the snapshot; operator summary rechecks the admin.

Sandbox capture paths validate retained renewal availability before recording
capture and activate an initial subscription after native payment ingress.
Capture and activation have separate transaction boundaries; an outage between
them is not atomic.

The host registers billing, saved-address, preference and parcel-contact privacy
contributors. Supply identity and subscription coverage yourself; the registry
reports missing contributors. Account-event retention still needs an application
policy. No customer HTTP export or erasure endpoint is composed. Complete that
workflow and private-capture cleanup under your own policy; saved preferences do
not establish privacy coverage. Erased checkout captures are never reconstructed
from current profile or billing data.
