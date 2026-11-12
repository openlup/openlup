# Application ownership

Status: draft explicit file inventory for extraction and lifecycle consumption.

`ownership.json` is the machine-readable split. Its `owned` and `managed`
arrays contain exact application-relative paths; `sourceMappings` only maps the
archive's non-loading instruction template to the new repository's `AGENTS.md`.
`generated` names local output (a trailing slash denotes a directory), and
`demoData` identifies fictional seed/media files already classified as owned.
`sourceOnly` lists archive tooling and source-release witnesses, never copied
into an application.
No glob, parent checkout discovery or implicit workspace inheritance is needed.
`demoDataNote`, `pageCopyRequiredFor` and `pageCopyRule` preserve the customer
environment boundary and explain which changes require taking ownership of a page.

| Class | Responsibility |
| --- | --- |
| Owned | Identity, configuration, general copy, media, named UI fragments and the application's agent guide |
| Managed | Starter host, pages, shared validation and DTOs, test recipes, lifecycle wrapper and documentation |
| Source only | Extraction script/test, instruction template and selected package/compiler-backed editor witnesses; the source release retains their coverage |
| Generated | Local source provenance, artifact identities, lockfile during candidate preparation and build/browser output |

Managed means eligible for a reviewed starter update, not automatic overwrite.
The package CLI owns its actual upgrade plan/apply semantics. This draft does
not claim that the pending CLI already reads this inventory. The starter's
`./lifecycle ownership` exposes it without mutating files. The wrapper delegates
verify and upgrade to the installed CLI and never adds another upgrader.

In the public source tree, the instructions remain `AGENTS.template.md` so they
do not govern monorepo contributors. Extraction creates the new application's
`AGENTS.md`. Local application rules outside the managed instruction block
must survive subsequent guide updates.

When taking ownership of a page, move its file from `managed` to `owned` and
record why in that application's normal change evidence. Resolve the full
import and security boundary; a copied page receives no automatic platform fix.
Do not move package engines into the application. The installed npm artifacts
are the engine, and their lockfile/integrity and version-matched guidance remain
part of adoption.

During candidate work, the three `.tgz` files and `artifacts/identity.json` are
ignored local inputs. Final release preparation must replace candidate `file:`
pins with one exact published set, remove the candidate lockfile ignore, move
`package-lock.json` from generated to managed and commit the independent app's
registry lockfile. Until then the generated candidate lockfile is ignored and
used for reproducible local `npm ci`, not presented as final release pins.
The source archive, npm publication and an application deployment are different
delivery boundaries; this starter authorizes none of them implicitly.

The extracted repository retains the inventory, but not its `sourceOnly` files.
Its `npm test` runs application tests only. Source-release `npm test` additionally
runs extraction and refusal coverage, including the materialized test command.

`owned/demo-seed.ts` is both owned and demo data. It builds the four catalogue
and price row sets from `StoreConfig`. `installation/install.ts` is managed and
reachable only from lifecycle installation, never the HTTP host; it requires the
install login/current role and a database-level demonstration marker. The
bootstrap runs the complete packaged history in a one-shot container. Only that
container receives the privileged Unix socket; the host receives the runtime
TCP URL only. The missing installed API refuses
`starter_installation_binding_required`, and an existing unmarked database is
never adopted or marked. A customer environment must use its
own data onboarding, never this seed or demonstration marker. The installer uses
the native stock writer and installs editor settings, synthetic subject facts,
opaque variant documents and identifiers. Clients, editable templates, renewal
terms and method states are purchase truth, not demo seed inputs.

The optional public origin and insecure-HTTP opt-in are owned configuration and
upgrade inputs. Origin policy, session handling and native composition stay
managed. The private captured mailbox and process sessions are generated local
runtime state, not owned configuration or installed package sources.
The demonstration container's quote-acceptance keyring is also private generated
state under `.context/`, admitted only by the existing database demonstration
marker. The same container reuses it on restart; container recreation discards
it. Customer environments provision their own keyring outside served assets.

The optional `supportEmail` is owned configuration. Managed support rendering
uses text nodes only. Partner/review host composition is managed and reuses the
same request admission and native operator authority as other operator reads.

`owned/catalogue.ts` owns the fictional catalogue-draft type registry. Managed
`host/operator-composition.ts` composes support and catalogue native ports. Native
human membership precedes each operator action; the owner alone provisions and
deactivates the separate support roster as documented in the README. No runtime
roster writer or installer roster seed exists. Drafts and bundle activation do
not replace the owned storefront offer configuration. The managed real-database
browser recipe is `browser/native-operator.proof.ts`.

Acquisition ownership below was established before support and catalogue
composition; its final scope statement describes that earlier contribution only.

`owned/acquisition-addresses.ts` is owned demonstration data beside the catalogue
seed. It contains fictional opaque registry tuples and localized choice labels.
The acquisition foundation migration header, lines 16-17, permits an adopter to load its own
replaceable registry through the database owner connection; the managed installer
uses that contract only after its existing install-identity and demonstration
marker admission. Its insert names every column and verifies provenance/active
state after a keyed conflict. The runtime host only reads the owned list, maps a
choice ID and submits through the native port; it never loads the registry.
Support customer reads and catalogue administration remain unbound. Their
composition is outside this acquisition change.


`host/purchase-composition.ts` composes public native drafts, stock, holds,
compensation, sandbox settlement, renewal attachment and destinations. Its typed
contact-client dependency is injected at this root, never reimplemented as
application INSERTs. Checkout does not import the install-only seed.
`host/checkout-recovery.ts` composes the separate private recovery mailbox;
the host owns and closes the native token transaction lane.
The host names its single role-free lane after its capability, checkout recovery tokens, owns it and closes it.
`client/purchase.ts` owns tab continuation and visible-response redaction. Neither
is an account authority. No demo customer seed or mandatory purchase sign-in exists.

`playwright.database.config.ts` is the managed real-database UI recipe. Its
ignored `.context/database-ui-hosts.json` contains two non-secret loopback UI
origins, never database URLs or capabilities. The proof operator starts those
hosts with installed runtime connections. Browser tracing is disabled because
request bodies carry private capabilities. The required purchase spec remains
byte-identical. Focused regressions live in `test/checkout-recovery.test.ts`.

Editor values and localization are owned in `owned/subscription-editing.ts` and
`owned/editor-copy.ts`. Editor pages/models and the host's session admission,
catalogue verification, package ports and frozen-order parcel-note callback are
managed. `playwright.editors.config.ts` selects synthetic component witnesses;
the database configuration selects the separate real-purchase editor/API journeys.
Each database host entry also names its proof-owned `composeProject` for these
journeys. No database connection or private mailbox token belongs in that JSON.

Four editor witness files in `test/` are source-only: the compiler contract,
package-backed models, host routes and parcel-note callback witnesses. They use
the source release's built package contracts/compiler. The raw extracted app's
dependency-free test phase excludes them; the materialized app retains the
browser recipes and its ordinary tests. This classification does not replace
the source-release witnesses or claim a native database result.


The one temporary mode-price function is managed in `shared/offer-estimate.ts`.
Its rate/quantum and demonstration purchase values are owned typed configuration;
`owned/demo-seed.ts` uses the same function for distinct per-mode price entries.
The installer compares existing authored price facts and refuses a changed-price
conflict. This changes no native schema and introduces no runtime price writer.
The later installed quote-engine composition removes this temporary function.

Attempt limits live in one process's memory and reset on restart.
Checkout applies the configured attempt window, e-mail and requester counts, retention and capacity before contact resolution. Exact replay means the same command key, normalized e-mail and requester; it is free of further quota counts. A retained key with a changed identity is refused before contact resolution, including with a replacement quota callback. The synchronous host binding keeps identity digests within the same retention and capacity bounds; it fails closed when full. Denied quota attempts add nothing to the quota counts. Both process-local records reset on restart. Unpurchased contact retention belongs to the host.

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

Purchase and sign-in share `purchase.inputLimits.email`, capped at 160 characters
by configuration validation. Both demonstrations use 160. Longer purchase e-mails
receive `starter_email_invalid` before contact resolution. Checkout and subscription
address changes share the configured phone and postal-code limits; configuration
cannot exceed the native destination bounds. Browser fields use those same limits.

## Paid-order message ownership

[The paid-mail host](../host/paid-mail.ts) is managed application composition of
the installed commerce handler and public outbox claim/process rail. Its registry
selects only the paid-email event and composes the store-owned sized parcel note
for private renewal receipts. [The versioned artifact](../host/paid-mail-artifact.ts)
uses the existing atomic private capture protocol; recipients and rendered bodies
remain private generated data. [Owned locale copy](../owned/renewal-copy.ts)
supplies the paid subject and line labels through shared configuration validation.
The lifecycle command runs one bounded pass without starting a scheduler or a
real mail provider. Native subscription notices keep their existing owner.


Shipping fee and free-delivery threshold are owned offer values. The managed
quote binding passes them to the installed shipping policy; it owns no threshold
calculation. The purchase binding retains the accepted shipping agreement for
renewals. There is no separate `renewalShippingMinor` setting: current configuration
cannot override retained terms or a frozen cycle's shipping amount.

`browser/renewal.proof.ts` is a managed, fixture-backed local recipe. Its source
PostgreSQL runner supplies the private mailbox and expected account/order values;
the customer uses only sign-in and account read controls. Fixture files and
Playwright configurations under `.context/` are generated private state.


## Subscription care ownership

`owned/renewal.config.ts` owns neutral timing, cancellation taxonomy,
notice windows, operator caps and retry offsets.
General portal and care-message copy remains in `owned/copy.ts`. The managed
portal, command binder and scheduled care entry compose installed native owners.
The private care capture reuses the existing filesystem protocol and native
transactional receipts. Run summaries and message bodies are generated state.
The account's owned read includes native winback status/refusal and receipt
reference; it provides no consent writer. The native default retention gate ON
is retained without seeding settings. Generic edit commands remain unmounted.

`./lifecycle browser` is the managed local PostgreSQL recipe for the
database browser configuration. Its private fixture connections and host state
live under `.context/care-browser`, never in the archive. It owns and removes
only its newly created containers and child processes. The installed package
migration runner owns the database schema; no starter migration or grant is added.


## Account, checkout and parcel controls

`owned/acquisition-policy.ts` owns account validation, fictional phone and checkout
wave/link timing values. English and Polish copy stays in `owned/copy.ts`. The managed account
and operator pages bind native capabilities through `host/e4-composition.ts` and
`host/native-composition.ts`. The host derives identity and command keys from the
accepted session/request. Profile update and event append retain their separate
native commits; correction requests retain their append-only repeated-key behavior.
The account reads only owned event metadata, never private event payloads.

`host/paid-mail.ts` additionally owns a separate bounded checkout-recovery entry
using the native job lease, producer and scoped outbox authorization. It registers
only checkout recovery and expiry handlers in that invocation. Paid receipts and
subscription notices keep their separate selections. Captures are generated
private state, never tracked configuration or served assets. A captured send's
native profile receipt gates the final wave; an enqueue or skipped send does not.

Human admins require the documented owner-provisioned Commerce operator row for
parcel operations, plus the separate communications roster for operator links.
Neither the runtime host nor installer provisions those rows. Never delete a
Commerce operator row; withdraw by revoking membership. Native ports own provider,
stock, fingerprint and replay fences. No arrival attestation caller exists.
Fresh sandbox attempt dispatch can issue continuation; the embedded-browser
buyer control uses that exact cookie. Checkout creation never issues it.


## Expired checkout recovery and order holds

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

Hold and release resolve the human administrator before every command and replay.
The database owner provisions one `commerce_operators` row per human admin, with
`id` equal to the native principal ID. Never delete this row: holds retain its
attribution. Withdraw access by revoking the membership through the identity
owner. Distributors and admins without the Commerce row cannot issue or replay
these commands. A locked upcoming cycle refuses an address change with
`payment_blocked`; existing order and parcel destinations remain unchanged.

The additional real-PostgreSQL journeys run in the `recovery extension ` group
from the single shared `browser-groups.mjs` source. Each group uses a fresh
installation pair, one worker and traces, screenshots and video off. Checkout
quota and all runner guards remain unchanged.


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

## Unpaid cancellation and manual refund records

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

The existing paid-capture document policy is unchanged. The optional handoff
accounting wrapper is only for an adopter that selects a handoff issue policy;
any such callback belongs after the committed shipment transaction and remains
fail-soft according to that wrapper's policy.


## Saved addresses and scoped preferences

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

Install the complete ordered package history through
`20261110280000_checkout_recovery_buyer_snapshot` before starting this composition.
The host requires the slot-27 first-duty buyer-capture entry; slot 28 preserves
absence of explicit buyer facts during recreation. `./lifecycle up` installs the
complete history. No duty or historical invoice is backfilled.

Before sandbox payment capture, initial checkout records its owned order
destination; native recreation and renewal record theirs through their native
owners. On the first owed-duty capture, the invoice owner freezes explicit order
buyer facts when present, otherwise the default or latest owned billing profile
with a billing/both address, otherwise the marked shipping fallback. The frozen
address keeps line2 and source provenance. Recreation copies explicit buyer facts
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
