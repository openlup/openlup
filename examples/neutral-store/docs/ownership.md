# Application ownership
Moved to [Who owns what in the starter](../../../packages/core/docs/guide/concepts/starter-ownership.md#read-the-inventory).

Status: moved to the [OpenLup guide](../../../packages/core/docs/guide/concepts/starter-ownership.md); this page keeps its headings so links resolve. Sections marked "Evidence" are frozen historical records.

`ownership.json` is the machine-readable split. Its `owned` and `managed`
arrays contain exact application-relative paths. `sourceMappings` maps application
`AGENTS.md` to archive `AGENTS.template.md` and application `README.md` to archive
`README.template.md`; extraction materializes both destination files.
`generated` names local output (a trailing slash denotes a directory), and
`demoData` identifies fictional seed/media files already classified as owned.
`sourceOnly` lists archive tooling and source-release witnesses, never copied
into an application.
No glob, parent checkout discovery or implicit workspace inheritance is needed.
`demoDataNote`, `pageCopyRequiredFor` and `pageCopyRule` preserve the customer
environment boundary and explain which changes require taking ownership of a page.

The extractor materializes both templates; its `sourceOnly` exclusions keep
them out of the application's copied source inventory. `./lifecycle ownership`
reads the inventory, while verify/upgrade delegate to the installed CLI.

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

`owned/acquisition-addresses.ts` is owned demonstration data beside the catalogue
seed. It contains fictional opaque registry tuples and localized choice labels.
The acquisition foundation migration header, lines 16-17, permits an adopter to load its own
replaceable registry through the database owner connection; the managed installer
uses that contract only after its existing install-identity and demonstration
marker admission. Its insert names every column and verifies provenance/active
state after a keyed conflict. The runtime host only reads the owned list, maps a
choice ID and submits through the native port; it never loads the registry.
The earlier acquisition-only slice left support and catalogue composition unbound;
`host/operator-composition.ts` now supplies those separate bindings.

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

Evidence (historical record, 2026-11-13):
The extracted repository retains the inventory, but not its `sourceOnly` files.
Its `npm test` runs application tests only. Source-release `npm test` additionally
runs extraction and refusal coverage, including the materialized test command.

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

## Paid-order message ownership

Moved to [Who owns what in the starter](../../../packages/core/docs/guide/concepts/starter-ownership.md#paid-order-messages-and-shipping).

Shipping fee and free-delivery threshold are owned offer values. The managed
quote binding passes them to the installed shipping policy; it owns no threshold
calculation. The purchase binding retains the accepted shipping agreement for
renewals. There is no separate `renewalShippingMinor` setting: current configuration
cannot override retained terms or a frozen cycle's shipping amount.

`browser/renewal.proof.ts` is a managed, fixture-backed local recipe. Its source
PostgreSQL runner supplies the private mailbox and expected account/order values;
the customer uses only sign-in and account read controls. Fixture files and
Playwright configurations under `.context/` are generated private state.

Evidence (historical record, 2026-11-13):
`browser/renewal.proof.ts` is a managed, fixture-backed local recipe. Its source
PostgreSQL runner supplies the private mailbox and expected account/order values;
the customer uses only sign-in and account read controls. Fixture files and
Playwright configurations under `.context/` are generated private state.

## Subscription care ownership

Moved to [Who owns what in the starter](../../../packages/core/docs/guide/concepts/starter-ownership.md#subscription-care).

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

Evidence (historical record, 2026-11-13):
`./lifecycle browser` is the managed local PostgreSQL recipe for the
database browser configuration. Its private fixture connections and host state
live under `.context/care-browser`, never in the archive. It owns and removes
only its newly created containers and child processes. The installed package
migration runner owns the database schema; no starter migration or grant is added.

## Account, checkout and parcel controls

Moved to [Who owns what in the starter](../../../packages/core/docs/guide/concepts/starter-ownership.md#account-and-operator-authority).

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

Moved to [Who owns what in the starter](../../../packages/core/docs/guide/concepts/starter-ownership.md#checkout-continuation-and-recovery).

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

Evidence (historical record, 2026-11-13):
The additional real-PostgreSQL journeys run in the `recovery extension ` group
from the single shared `browser-groups.mjs` source. Each group uses a fresh
installation pair, one worker and traces, screenshots and video off. Checkout
quota and all runner guards remain unchanged.

## Unpaid cancellation and manual refund records

Moved to [Who owns what in the starter](../../../packages/core/docs/guide/concepts/starter-ownership.md#cancellation-refund-records-and-returns).

Each command and replay rechecks the human admin and resolves the existing Commerce
operator row. Caller identities, missing confirmation, invalid reasons, stale
order status and conflicting commands refuse. Reasons use the package's trimmed
1–2,000 character contract. Native durable receipts own replay. The two formerly
unavailable actions are bound; physical-return, tracking and account limits stay separately
listed until their own complete bindings exist.

## Return requests and decisions
Moved to [Who owns what in the starter](../../../packages/core/docs/guide/concepts/starter-ownership.md#cancellation-refund-records-and-returns).

## Optional payment guidance
Moved to [Who owns what in the starter](../../../packages/core/docs/guide/concepts/starter-ownership.md#payment-guidance-and-sandbox-continuation).

`host/checkout-recovery.ts` composes the optional native guidance reader.

## Operator shipment evidence

Moved to [Who owns what in the starter](../../../packages/core/docs/guide/concepts/starter-ownership.md#shipment-evidence-and-retention).

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

The existing paid-capture document policy is unchanged. The optional handoff
accounting wrapper is only for an adopter that selects a handoff issue policy;
any such callback belongs after the committed shipment transaction and remains
fail-soft according to that wrapper's policy.

## Saved addresses and scoped preferences

Moved to [Who owns what in the starter](../../../packages/core/docs/guide/concepts/starter-ownership.md#saved-addresses-billing-and-preferences).

An active or paused subscription can select an owned shipping/both address.
The native command owns the saved pointer, subscription/account events and outbox.
A locked upcoming cycle refuses a fresh selection; an admitted key replays before
saved-ID parsing and returns the current pointer. Null recipients remain null.
Editing a saved row affects future destination materialization, while a retained
renewal operation and existing parcel keep their immutable destination. Cadence,
commercial terms and billing are unchanged.

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

## Sandbox token payment and exact continuation

Moved to [Who owns what in the starter](../../../packages/core/docs/guide/concepts/starter-ownership.md#payment-guidance-and-sandbox-continuation).

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

## Billing profiles and frozen invoice buyers

Moved to [Who owns what in the starter](../../../packages/core/docs/guide/concepts/starter-ownership.md#frozen-invoice-buyers-and-privacy).

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

Evidence (historical record, 2026-11-13):
Install the complete ordered package history through
`20261110280000_checkout_recovery_buyer_snapshot` before starting this composition.
The host requires the slot-27 first-duty buyer-capture entry; slot 28 preserves
absence of explicit buyer facts during recreation. `./lifecycle up` installs the
complete history. No duty or historical invoice is backfilled.
