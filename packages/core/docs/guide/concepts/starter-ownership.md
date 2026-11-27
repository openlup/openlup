# Who owns what in the starter

Use the starter's ownership inventory to decide which application files you
customize and which updates need review.

For a starter upgrade, follow the per-release owned-file migration linked from
[Upgrade application files](../upgrade/application-files.md).

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

A plain local extraction ignores its installation lockfile. Released,
reconstructed and digest-verified candidate extractions commit theirs. Either
way the lockfile stays generated and outside owned/managed upgrade snapshots.

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

Use the [recovery issuer contract](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/examples/neutral-store/docs/ownership.md#application-ownership)
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

The default attempt quotas survive restarts on the same PostgreSQL database.
Command-identity bindings remain process-local and reset on restart. Before
resolving a contact, checkout checks configured email and requester quotas,
retention and capacity. A repeat under an existing checkout key counts once
more: in a separate requester bucket and against `maxPerEmail` for that one
key, never against the buyer's email. Changing the identity under a retained
binding refuses even with a replacement quota callback. Denied quota attempts
add no quota count. Your host owns retention of unpurchased contacts.

A host behind a trusted proxy can pass `requesterKey` to
`composeNativeBindings`: a function that returns a lowercase 64-hex SHA-256
digest of the verified client, or `undefined`. A value that is not a function is
refused at composition; a returned value that is not such a digest makes every
request answer 503 `starter_dependency_unavailable`, and the host logs
`OPENLUP_E_STARTER_REQUESTER_KEY_INVALID` to stderr.

For `starter_attempt_limited`, wait for the quota window or retained attempts
to age out. A limited repeat of a completed order still returns the order,
without a new token. A repeat that completes an interrupted creation passes the
same first-attempt limiter and requester binding as a fresh create, so it can
answer `starter_attempt_limited`. For
invalid input, use the normal checkout submit path. Correct invalid deployed
limits and restart. If the database could not admit an attempt, verify the
[database forward](../upgrade/database-migrations.md#check-application-compatibility)
and restore database service before retrying.

Purchase and sign-in share the bounded `purchase.inputLimits.email` setting;
overlong purchase email
refuses with `starter_email_invalid` before contact resolution. Checkout and
subscription-address fields use the configured phone and postal limits within
native destination bounds. The [configuration validator](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/examples/neutral-store/docs/ownership.md#application-ownership)
owns the exact limits. Browser field limits do not replace host validation.

## Checkout key continuation

One checkout key addresses one order for its whole life. The key is the
`Idempotency-Key` header value of `checkout.create`. The host stores only a
digest derived from it and the signed-in principal, never the value itself.

Repeat `checkout.create` with the same key and the same details after a lost
response. The host returns the first order with `replayed: true`. While the
order is unpaid, the response also carries a further continuation `token`.
Earlier tokens stay valid, and a repeat never sends mail. A refreshed quote
acceptance for the same stored terms counts as the same purchase. Changed
details are never applied: under a version 4 UUID key the host answers
`starter_checkout_changed`, `starter_checkout_paid` or
`starter_checkout_not_payable`. Other released key formats keep
`starter_command_conflict`, because they have no continuation.

`checkout.continuation` continues or abandons the order under a key without
the original details. Send the same header with a version 4 UUID value and the
body `{ "action": "resume" | "abandon", "locale": "<locale>" }`. Any other
field or key format answers `starter_input_invalid`. A guest is authorised by
the key value alone, so treat it as a credential: make it random, never log it
and never reuse it for another operation.

| Order under the key | `resume` | `abandon` |
| --- | --- | --- |
| None | `starter_checkout_not_found` | `{ abandoned: false }` |
| Unpaid, creation complete | `{ orderRef, status, total, token }`, `replayed: true` | Cancels it: `{ abandoned: true, orderRef }` |
| Unpaid, creation not complete | `starter_checkout_in_progress` | `starter_checkout_in_progress` for a minute after the order was created; then cancels it, as above |
| Paid | `{ orderRef, status, total }`, `replayed: true` | `starter_checkout_paid` |
| Cancelled, expired or closed | `starter_checkout_not_payable` | `{ abandoned: false, orderRef, status }` |

Abandon of an unpaid order refuses with `starter_checkout_not_abandonable` once
a payment attempt was ever made, including one still in flight. A paid order
answers `starter_checkout_paid`. A cancelled order carries the reason
`checkout_started_over`. A limited `resume` returns the order without a token; a
limited `abandon` answers `starter_attempt_limited`. An unpaid order older than
its 24-hour link lifetime gets no new token: `resume` answers
`starter_checkout_expired`. If no payment attempt was made, `abandon` it,
then start a new key. Otherwise the order has a payment attempt that the store
must settle. Do not start a new key on your own. The managed checkout page
leaves that choice to the buyer, as described below. Ask the store to check the
payment and cancel the order (`operator.cancelUnpaid`). The store can cancel only once no
payment is in flight; until then the order may still be paid, and the cancel
answers `starter_order_transition_conflict`. After the store cancels, this key
answers `starter_checkout_not_payable`, and a new key works, including for the
same first subscription. While the unpaid draft exists, a new first
subscription for the same contact answers `starter_command_conflict`. An
abandon that cancels nothing because the host was busy, because the order
changed while it was being cancelled, or because the platform
forward `20261128230001_checkout_abandonment_safety_execute_grant.sql` is
missing, answers `starter_purchase_unavailable`; repeat it, and apply the
forward if it persists. An unknown key is answered before metering. Refusals
use HTTP 409. A missing or malformed header answers HTTP 400 with
`starter_command_identity_required`, and a body that is not a JSON object
answers HTTP 400 with `starter_input_invalid`.

The token from `resume` authorises the same operations as the creating
response: `checkout.read`, `checkout.recovery` `inspect` and `pay`,
`checkout.payment` `inspect` and `simulate`, `checkout.tokenPay` and
`payment.simulate`. A key holder can therefore start a payment attempt, which
makes the order not abandonable.

A client that owns its checkout page follows three rules:

1. Keep one key for the whole purchase, including reloads and retries.
2. Never start a new key after a transport error; repeat or `resume` instead.
3. Treat "no order under this key" as final only once more than your own
   request timeout plus 15 seconds have passed since the last unanswered
   create. `shared/storefront-bindings.ts` applies this rule for the starter's
   tab record and its `createPurchaseContinuation` bindings. The rule assumes
   per-tab storage (`sessionStorage`): a record shared across tabs can end a
   key while another tab's create is still on its way. A
   create that obtains the key lock later than 15 seconds after the host
   received it answers `starter_checkout_request_stale` and writes nothing.
   The bound starts when the host receives the request, so a client behind a
   buffering proxy adds that proxy's own timeout to its wait. This refusal can
   also reach the managed pages when the host is busy.

The managed checkout page follows these rules through `createPurchaseContinuation`
and `shared/storefront-bindings.ts`; it sends no `checkout.create` of its own. It
stores one key per purchase in tab storage, under
`neutral-store:checkout-continuation:v1:<configuration>`, before the first create
leaves the browser, and reuses it after a reload. A create whose answer was lost
is repeated once by the page, under the same key, with a 10-second deadline. It
starts a new key only after the host confirmed that the earlier order is closed,
or that no order exists and none can still arrive. Changed details while that
order may exist send nothing: the page opens a panel and shows
`starter_checkout_changed` itself when the order was last seen payable, the code
that last named it not payable, expired or paid, or otherwise that an order may
exist. It keeps that knowledge beside the record, under
`neutral-store:checkout-order-state:v1:<configuration>`, from every answer that
names the order's state, the payment-status page's included. A record written before the bindings takes the current
details on its first submit, under the same key. The panel also appears on load
when the tab holds an earlier order or an uncertain create. It offers "Complete
payment for the earlier order" (`resume`) and "Cancel the earlier order and start
over" (`abandon`). Whenever an answer names the earlier order as not payable
(`starter_checkout_not_payable`, `starter_checkout_paid`,
`starter_checkout_not_abandonable`, `starter_checkout_expired`, an expired
order, or a paid one), it also offers "Start a different purchase". That explicit
buyer choice starts a new key while the earlier order stays open until the store
settles it, and a payment already started for it may still complete. The
payment-status page clears the record only when it shows the order paid or
cancelled; an expired order keeps it, because a payment under it may still
settle. When "Cancel the earlier order and start over" finds no order before "no
order" is final, the page raises `starter_checkout_in_progress` itself, and `starter_checkout_session_changed` when an answer belongs to
another sign-in state. A browser that blocks tab storage, or refuses a write
after load (`starter_checkout_storage_unavailable`, nothing sent), shows
`starter_storage_unavailable`: the page keeps the purchase in its own memory
under the same key until a reload, and "Start a new action" starts a new one.
The status line carries the `storefrontAnchor` state with visible text, and the
panel's choices carry `continue_payment` and `start_over`.

The key is derived from the principal, so a guest key does not survive sign-in
or sign-out. Resolve the purchase before either; a retry after sign-in finds no
order and creates a second one. See the [refusal rows](../reference/limits.md#subscription-mode-price).

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

`owned/acquisition-policy.ts` supplies account validation and checkout link
timing; the installed `checkoutRecoveryReminders` schedule in
`owned/store.config.ts` sets reminder hours and stages. The host derives the actor from the accepted session and the
command key from the request. Caller-supplied identities and command keys in
action bodies refuse. Account reads expose owned event metadata rather than
private payloads. Profile writes and event appends have separate commits;
correction requests retain their native append-only repeated-key behavior.

The separate checkout-recovery mail entry selects only recovery and expiry
handlers. When the schedule has a first stage, a captured send's native receipt gates the
final reminder; enqueueing
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
use the native trimmed-text boundary in the [order control schemas](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/platform/README.md#commerce-contracts).

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
dispatch another attempt on the same pending replacement. The default starter
leaves real payment execution, method setup and card replacement unconfigured;
these actions refuse with
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
[continuation composition](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/examples/neutral-store/docs/ownership.md#sandbox-token-payment-and-exact-continuation)
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
Default clearing and the host's `CustomerSavedAddressValidationPolicy` apply.
See the [saved-address validation catalogue entry](../how-to/operate/settings-catalogue.md#savedaddressvalidation)
for the host callback and its effect.
In 1.2.0, `createCustomerSavedAddressRequestSchemas`
from `@openlup/platform/shipping` accepts optional `local` callbacks:
`normalizePostalCode`, `isValidPostalCode` and `normalizePhone`. They run only
when the selected country resolves to the policy's `country`, including its
aliases. Without `local`, the compatible built-in rules remain: five postal
digits become `NN-NNN`; nine phone digits gain `phonePrefix`, and an existing
prefix is retained. Removing those defaults is separate future work.

The platform trims fields, collapses whitespace and uppercases postal input
before local normalization, then validates the normalized postal result.
Phone callbacks receive trimmed input with collapsed whitespace; a null result
refuses a supplied phone, while an absent or blank phone stays null. Postal
input and output remain bounded to 24 characters, phone input and local output
to 64. Both normalizers must return a nonempty string within those bounds and
`isValidPostalCode` must return literal `true`; any other result refuses the
field. Foreign postal rules and the 6–32 character foreign phone rule bypass
the callbacks. Country aliases, field bounds and message keys remain platform
mechanics. Callbacks must be effect-free: no I/O, authorization or mutable-state
reads; normalization may run more than once per parse. A callback throw refuses
its field with `messages.postalCode` or `messages.phone`, rather than escaping
as a server error. Missing or nonfunction
callbacks in a supplied `local` refuse schema creation with
`saved_address_policy_invalid`.

The current starter host imports `savedAddressValidation` from
`owned/acquisition-policy.ts`. Its fictional country uses postal codes with two
letters followed by four digits, and eight phone digits normalized with `+999`;
edit that owned algorithm outside
`StoreConfig` for another local format. These formats do not establish a real
country or phone jurisdiction.

Address writes, default clearing and account events have separate commits:
reload after a failed save before
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
