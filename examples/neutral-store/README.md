# Neutral store

This starter is an application inside the OpenLup source repository, separate
from its npm workspaces. It combines public package entries with application-owned
configuration, browser pages and a local demonstration host.

From this checkout's root, using Node.js 24 and npm 11.19.0 after installing the
root dependencies and building the packages, run:

```sh
cd examples/neutral-store
npm run build
npm start
```

This serves the database-free UI at `http://127.0.0.1:4319`. Stop with Ctrl-C.
For a different configuration or port, use
`npm start -- --configuration coffee --port 4320`. On macOS and Linux,
`npm run dev` provides the [watched edit loop](../../packages/core/docs/guide/how-to/build/customize-the-starter.md#edit-and-refresh).
This preview does not bind database-backed purchase or account actions.

Read the [guide](../../packages/core/docs/guide/README.md), follow the small
[npm tutorial](../../packages/core/docs/guide/start/tutorial.md), or prepare an
[independent starter application](../../packages/core/docs/guide/how-to/build/customize-the-starter.md#prepare-the-application).
Use [starter customization](../../packages/core/docs/guide/how-to/build/customize-the-starter.md),
[routes](../../packages/core/docs/guide/reference/starter-routes.md),
[limits](../../packages/core/docs/guide/reference/limits.md) and
[ownership](../../packages/core/docs/guide/concepts/starter-ownership.md) for reader guidance.
The [execution record](docs/proof.md) retains development evidence.

The headings below preserve existing links to moved guidance.

## Local UI edit loop

`dev.mjs` owns the polling watcher, separate client build and Node host restart.
The database-free preview does not compose native database actions.

## Current candidate

The installed native catalogue and account stores use the runtime connection.
The composition root binds guest checkout, sandbox payment and customer
subscription address and lifecycle changes through public native factories. Host and browser
purchase/recovery proofs run on real PostgreSQL in both configurations. `./lifecycle up` installs
the packaged PostgreSQL history and fictional catalogue before starting the UI.
Default extraction retains local tarball pins; released extraction below selects
an exact npm set and supplied lockfile.
Review grants retain the native fixed thirty-day expiry, with no application time seam.
The unchanged required purchase spec must run against installed PostgreSQL;
the default database-less UI host cannot satisfy it. See [proof](docs/proof.md).

## Start from an exact source archive

`extract.mjs` requires Node 24 and Git, copies only owned/managed inventory and
materializes `AGENTS.md` and `README.md` through `sourceMappings`. It creates an
independent Git repository without ancestor lookup or workspace resolution.
`lifecycle.mjs` binds the selected tarball names, equal set versions
and SHA-256 identities to the candidate's exact `file:` references.

For a released development-preview set, run from the matching source tree's root:

```sh
node examples/neutral-store/extract.mjs ../my-store --mode released \
  --set-version <version> --source-revision <full-source-commit> \
  --manifest ./pack-manifest.json --lockfile ./starter-package-lock.json
```

Supply the existing pack producer's v2 manifest (`schemaVersion: 2`, `commit`,
`packages` with `name`, `version` and `integrity`; artifact filename/hash fields
are retained). This is an explicit expected-integrity input, not a publication
receipt. Its complete package set and revision must match the source inventory.
Every source package must have the selected exact version. The supplied npm v3
lockfile must describe the extracted application's dependencies with those exact
versions and public `https://registry.npmjs.org` resolutions. Missing, extra,
duplicate, version or integrity mismatches refuse with `starter_release_*` names.

Prepare that lockfile in a separate copy of the application's `package.json`:
replace every `@openlup/*` dependency with the exact set version and run
`npm install --package-lock-only --ignore-scripts --registry=https://registry.npmjs.org`.
Extraction itself performs no install and makes no registry request. It rewrites
the application's package pins, removes the lockfile ignore and creates an initial
Git commit including `package-lock.json` and `.starter-origin.json`, using the local
identity `Starter extraction <starter@localhost>`. This establishes extraction
identity; qualification on the actual public artifacts is separate evidence.

The identity records mode, set version, supplied source revision, lockfile SHA-256
and content SHA-256. The content digest is SHA-256 of UTF-8 JSON containing sorted
`[relativePath, fileSha256]` pairs for every extracted owned/managed file, after
rewrites; it excludes the lockfile, identity file and Git metadata. The revision
must equal `git rev-parse HEAD` for a source checkout (recorded as `verified`);
for an archive it is recorded as `supplied`. HEAD verification alone does not
verify an archive's origin or establish that checkout files are unmodified.

For source that predates released extraction, invoke this newer extractor with
`--source <old-source-tree>/examples/neutral-store --mode reconstructed` and the
same inputs plus `--reason <explanation>`. The output retains that reason and
cannot claim original released-starter provenance. The 0.41.0 to 0.42.0 development
comparison is a labelled reconstruction; a later released pair needs its own proof.
Without release flags, candidate extraction preserves the copied bytes and legacy
identity, ignores its generated local lockfile, and creates no initial commit.
Both generated identity files stay outside owned/managed upgrade snapshots;
the upgrade CLI installs nothing. These modes do not establish stable-framework
or supported-installation status.

Candidate extraction retains baseline mechanics, metadata and non-documentation
file bytes; the extracted README, ownership and proof notes describe both modes.
The committed released lockfile stays generated and outside upgrade snapshots;
the upgrade CLI installs no dependencies. Install the exact public-registry set
separately from its committed lockfile with `npm ci`.
The extraction schema marker lives in the source-only extractor,
and schema version 2 is recorded in the generated released identity.

Run the source-only offline identity checks from `examples/neutral-store`:

```sh
node --experimental-strip-types --test test/extract.test.ts
```

These fixtures cover named lock refusals, npm aliases, Git source verification,
reconstruction, every non-documentation candidate file's baseline bytes and
deterministic hashes. Only `README.md`, `docs/proof.md` and `docs/ownership.md` are
exempt from that byte comparison. These fixtures make no network request and do
not qualify any released set.

## Run the local application

`compose.yaml` pins PostgreSQL 16 and publishes the application only at
`http://127.0.0.1:4319`. The lifecycle starts its one-shot installed migration
runner and seed before the application container.

## Host origin and local sessions

The default Host authorities are `127.0.0.1:<listening-port>` and
`localhost:<listening-port>`. `StoreConfig.publicOrigin` replaces that selection;
its validation owner is `assertPublicOrigin` in `shared/config.ts`. The demonstration HBA and
loopback-only Compose publication remain separate from origin selection.

`./lifecycle up` supplies the passwordless runtime URL as a non-secret host
argument; the application receives no install connection or socket. `npm start`
without `--database-url` is still the UI-only preview with pending bindings.
The native runtime composition binds customer challenge request/redemption,
sign-out, reduced customer profile/subscription-control and owned order reads,
newsletter read/withdraw, and the reduced operator order control-plane view.
Invoice history, owned captured PDF access, operator document summaries and
shipment reads are also bound, alongside authenticated recovery, scheduled sandbox
renewal and private transactional notices. The full account projection remains a
named refusal. The remaining N3 order notes and order-address corrections retain their named limit.
Guest purchase, account and operator order reads have committed source and
real-HTTP proofs. Separate local real-browser evidence passes the unchanged
required journey and recovery checks in both configurations; those browser runs
are not a committed root-job witness.

`host/native-composition.ts` writes the private captured mailbox to
`/application/.context/captured-messages/identity.jsonl` as `node`, mode 0600.

The native action bindings are `auth.verify`, `auth.callback` and `auth.operator`;
there is no public operator bootstrap. `host/sessions.ts` limits opaque sessions
to one process, one-hour expiry and capacity 1000; restart loses them. Native
stores recheck operator membership and customer ownership on requests.
Cookies are host-only, HttpOnly, SameSite=Lax, scoped to `/api/actions`, and Secure
exactly for a configured HTTPS origin. The local mailbox is a demonstration
transport, not proof of access to a real mailbox.

With `publicOrigin` set, a probe using the ordinary loopback Host receives
`starter_local_host_required`. Lifecycle's internal probe connects privately and
sends the configured Host; any external health probe must also send that Host.

## Customize and upgrade

`owned/store.config.ts`, `owned/copy.ts` and `owned/fragments.ts` own typed
configuration, localized general copy and the named presentation fragments.

`./lifecycle verify` and `./lifecycle upgrade` delegate to the installed public
CLI when it exists. They refuse explicitly before that capability is shipped.
They do not replace it with an application-owned upgrade engine. A real
`openlup upgrade apply` preservation witness remains required.

## Install-only fictional catalogue

`./lifecycle up` calls `installation/install.ts` in a one-shot container before
starting the host. The installed bootstrap obtains a dedicated install connection and
applies one transaction using `owned/demo-seed.ts` and the owned acquisition
registry. The catalogue builder reads the same
`StoreConfig` as the UI: deterministic product/SKU/list/price identifiers and
parameterized catalogue upserts populate `catalog_products`, `catalog_skus`,
`price_lists` and `price_entries`. Repeating installation updates the same rows.
Live products, SKUs, price lists, price entries and promotions are seed data: one owned demo-seed step with the install connection, no runtime writer for them and no checkout promotion codes. Bundle drafts, compositions, target prices and activation, and catalogue drafts, are administered by a native human operator through their native writers.

The bootstrap must mark a newly created demonstration database with database
comment `openlup-neutral-store-demo-v1`. The applier reads that marker from
PostgreSQL, checks both login and current role against the dedicated install
identity, refuses either runtime identity and closes the connection after its
transaction. It never marks an arbitrary existing database as a demo.
`starter_installation_binding_required`, `starter_seed_runtime_role_forbidden`,
`starter_seed_install_role_required` and
`starter_seed_demonstration_database_required` name the refusal boundaries.
The missing-binding refusal applies only when the installed migration API is absent.
The complete history uses explicit `qualified-v2` / `installer-managed` selection.
Only PostgreSQL and the one-shot installer mount the Unix socket that permits
privileged local logins. The application has only the restricted runtime TCP
URL, no socket, install credential or privileged connection environment. The
database has no published port; its HBA admits only the runtime login over TCP
and rejects all other logins. This passwordless local demonstration is isolated
by container mounts and networking; it is not a customer authentication recipe.
No deployment recipe may reuse this Compose file or its HBA.
An existing unmarked database fails closed before role or schema changes. Only
a successful database creation in that invocation can set the marker. An
interruption between creation and marking deliberately leaves a refused database.

The install writes one product document per catalogue product, with a `variants`
list shared by checkout and the editors. Each variant carries its SKU identity,
physical trade-item facts, demand per unit and exclusions; sizes share the same
catalogue product. Both readers verify the selected SKU against the current
product document. The install also supplies exact physical SKU facts and identifiers. It writes the configured
`subscription_minimum_base_units`, `subscription_sized_intro_phase` and the
demonstration subject fixture to `commerce_settings`. The public native stock
writer records the configured fictional observations. Clients are not seeded.
Subscription renewal terms, term lines and method states belong to the native
purchase path and must never be hand-written by this application. After the
catalogue seed, purchase uses zero hand-written business rows. This data step
is not a schema installer, price editor, promotion engine or customer import.

## Customer subscription editors

The host mounts `subscription.preview`, `subscription.command` and
`subscription.catalog` under the existing customer session. Preview/apply receive
`{ request: <package request> }`; the session supplies actor/client identity and
the `Idempotency-Key` header supplies command identity. The account response adds
the narrow `subscriptionEditors` projection, including stored composition
constraint, offer version, frozen line amounts and edit eligibility. This is
separate from the still-unavailable full account projection. The host checks the
selected offer again under its transaction's subscription lock before pricing.

Seven exact commands are API-only: `swap_base_line`, `add_addon`,
`remove_addon`, `update_addon_quantity`, `update_base_mix`, `update_plan_length`
and `update_portion`. There are no portal controls for them. Demand-driven
plan-length and portion resizing refuse with
`starter_subscription_resize_unconfigured`; classic plan choices and size-aware
cadence choices preserve explicit counts. See the [named limits](../../packages/core/docs/guide/reference/limits.md).

`owned/subscription-editing.ts` builds the typed neutral values carried by
`StoreConfig.subscriptionEditing`: minimums, bounds, plan choices, sizes,
cadences, portion identifiers/factors and seeded subject facts. The fixture's
explicit current-empty exclusions override inherited exclusions. Candidate,
preview and apply read that installed fixture; the apply port locks its row and
compares exact snapshots on the same transaction connection. It also rereads
all selected SKU catalogue facts through the shared document reader and compares
them in canonical UUID order with sorted exclusion keys. Catalogue rows remain
read-only and unlocked; this comparison does not serialize concurrent catalogue
publication (the named publication-fence limit). There is no need-entry form. Classic candidates are unfiltered because this demonstration
has no classic exclusion facts.

`host/editor-mail.ts` exports `composeSizedPaidEmailNote`, compatible with the
paid-email handler's `describeParcel` callback. It composes quantities and exact
physical identities from the frozen order and the renewal cycle's frozen
cadence. Unprovable facts omit the note. The lifecycle renewal entry mounts the
paid-email handler through `host/paid-mail.ts` with this callback. Proven sized
renewal parcel notes appear in its private captured receipts when the stored
subscription binding is sized at send time. Classic bindings and acquisition
receipts omit the note.

The editor proof includes 68 focused source tests, 42 component cases and 34
database-backed browser/API journeys (17 per configuration), all passing locally.
Native subscription purchase materializes its editable lines and price context.
Existing subscriptions without that template refuse with
`starter_subscription_template_unavailable`; there is no fallback read or
fixture backfill. See [editor proof](docs/proof.md#subscription-editor-proof).

## Neutral inputs and local transport

Both fictional catalogues use the ISO test currency `XTS`, fictional country
`ZZ` and timezone `UTC`. Amounts are illustrative test units, with no exchange,
pricing, tax or jurisdiction claim. Polish and English remain UI content; money
formatting uses the selected locale ID directly.

The starter reads no environment configuration. For direct host use, pass
`--configuration <id>`, `--port <number>` and `--listen <address>` after `npm start --`.
The port defaults to 4319 and listen address to 127.0.0.1. The only other supported
listen address is 0.0.0.0 for explicit container transport. Unknown/duplicate flags,
missing values, invalid ports/addresses and unknown configurations refuse by name.
Compose passes the container listen/port flags and publishes only host loopback.
Lifecycle accepts the optional configuration flag for `up`; the same selected ID
reaches the one-shot installer through arguments and the child host through a
stdin Compose command override.
The documented no-flag `./lifecycle up` remains the one-command target.

## Operator support roster and catalogue authoring

`host/operator-composition.ts` passes the activated human principal as
`operatorRef`. Native support additionally checks
`platform_communication_operators(principal_id, active)`; the database owner
owns that roster. Installation cannot seed it before the human principal exists.

This roster is an additional native support precondition, not human membership
or sign-in authority. The host checks active native human membership on every
request **before** the support action. A roster row alone admits no request;
no session, customer sessions, inactive human members and supplied actor IDs
cannot become operators. Do not seed this table during installation: the human
principal does not yet exist. Native `customer_support_read_failed` intentionally
hides the SQL cause; the UI names the roster prerequisite without asserting that
every read failure means not provisioned. No second authority is built here.

#### Commerce operator roster for hold and release admission

Require active `admin` membership and no `platform_control_operators` row of any
state; distributors do not qualify. The resolver never inserts this row. Never
delete the Commerce row: withdraw access by revoking the human membership through
the identity owner instead. `commerce_order_holds.created_by` uses ON DELETE SET
NULL; deleting the row would make a human `fulfillment_exception` hold appear
system-created and eligible for automatic release. This existing hazard is
reported, not repaired. The starter resolves this roster before every hold or
release command and replay.

With the runtime connection, operator customer search/detail and bundle
list/detail/commands plus catalogue draft list/detail/create/revise/abandon are
composed. Bundle commands and catalogue draft writes are restricted to a native
human admin session, rechecked per request; actor identity and command
key come only from the accepted host context. `owned/catalogue.ts` owns the
fictional authoring type. The support port is constructed per request for that
operator and closed in `finally`, including failed reads; it has no operator cache.

Catalogue drafts write only isolated authoring tables (packages/platform/sql/20260908100000_catalog_draft_foundation.sql:1-9); bundle activation sets the native bundle status to active (packages/platform/sql/20260812210000_bundle_operator_write_boundary.sql:493), while this application's storefront and checkout still use typed configuration through evaluateOffer (examples/neutral-store/shared/offer.ts:40), so neither creates a new purchasable storefront offer.

## Acquisition and unbound operator actions

With the runtime connection, acquisition.submit is a public durable write through
the native acquisition case port and an install-seeded fictional location choice.
Only email, application
consent and the choice are collected; names are not stored. The owned registry
in `owned/acquisition-addresses.ts` follows the acquisition migration's
owner-loaded opaque reference contract in
`packages/platform/sql/20260816140000_acquisition_case_foundation.sql:16-17`.
It is applied only in the marked demo
installation, never by the runtime host. Conflicting registry data fails install
loudly. Replace this fictional registry and its onboarding for a customer environment.

## Guest purchase and later sign-in

The native recovery port issues 256-bit tokens and stores only SHA-256 hashes.
Initial-checkout, reminder and signed-in recovery continuation expires 24 hours
after order creation. Expiry-notice recovery ends 30 days after creation.
Operator issuance revokes earlier checkout links and caps authority at the earlier
of issuance plus 24 hours or creation plus 30 days; payment-case rotation is
separate. Indexed hash lookup makes no constant-time guarantee.

The committed continuity proof consists of the source continuity test and the
clean-index root proof, which needs only npm ci and the three-package build,
without a starter build or browser. A real-browser second-submit check was
confirmed in a local run that is not part of the committed suite.

## Native quote and acquisition composition

The native host uses the installed quote engine with current catalogue documents,
exact price-list entries, a canonical subscription policy and native promotion
reads. Catalogue, builder, cart and checkout projections read `offer.validate` on the
native host. Failed refreshes withhold the previous money. The local preview
estimator remains available only for explicit database-less one-time estimates
and configuration characterization; it delegates unit arithmetic to the package. The install seed
retains compatibility mode-price entries for every seeded SKU and adds one immutable
policy revision, current shared product-document pointers, physical trade-item facts and one standalone
acquisition definition. Conflicting policy, document or promotion initialization
refuses and rolls back. This is a fresh demonstration install, not policy rotation.

`owned/quote.config.ts` supplies neutral acquisition rates, effective dates,
document identity and graduation cadence. Product physical facts remain owned
catalogue data. `owned/store.config.ts` sets shipping to 640 minor units and the
free-delivery threshold to 1,000 minor units in both demonstrations. The native
quote evaluates product payable after product discounts; equality is free.
Renewals retain the accepted shipping agreement and freeze each cycle's calculated
amount. Current configuration cannot reprice a retained agreement.
The second-delivery display uses the retained quote's list basis and configured
promise through the package adjustment engine.

The browser explicitly declares `subscription-acquisition.v1`. Unsupported
subscription callers receive `acquisition_terms_capability_required` before
contact, order or payment effects. A private host keyring file may be supplied
with `--quote-acceptance-key-file`; it contains the existing helper's `current`
and optional `previous` keys, each at least 32 characters. Keep it outside served
assets and browser configuration; never commit it. Customer environments supply
their own keys. In the demonstration Compose installation, the application
container checks the existing database demonstration marker, creates a private
`.context/quote-acceptance-keyring.json` with mode 0600 if absent, and passes its
path to the host. Restarting the same container reuses the file. `down` followed
by `up` recreates the container and generates a new key; unsubmitted old quotes
then require refresh. The key is generated at runtime, never in the image.
A host started without the key-file flag refuses subscription quotes with
`starter_quote_acceptance_key_required`; one-time checkout still works.
Acceptance binds the request, money,
policy, second promise and delivery terms; changed terms clear consent and require
refresh even if the total is unchanged. Expired observations withhold money.
After an uncertain checkout response, an unchanged retry retains the submitted
acceptance proof and command key so the host can recover the saved receipt.
Changing the input or explicitly starting a new action prepares a fresh quote;
the server still validates acceptance before any new draft is admitted.

The local predecessor seam loads the package eligibility and transactional
admission factories. Missing exports refuse admission by name. All mounted checkout modes use the
transaction adapter; acquisition terms never reach a direct lower-level writer. Alias evidence cannot grant a customer session or
account reads. The host freezes the installed retained-renewal contract in the
server quote: original mode-price units and full line evidence, the second-delivery
amount/rate/basis, configured minimum and graduation cadence, and the accepted shipping agreement.
Acceptance binds those promise values; observation timestamps are not promise
identity. The full retained evidence is excluded from the browser projection.
After sandbox capture, the installed purchase-renewal writer records those terms
before activation. Missing or inconsistent retained evidence refuses creation
with `starter_quote_refresh_required`. This composition does not itself qualify later renewal or invoicing.

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

Replayed checkout uses its saved quote and compares the complete request binding;
current observation times cannot silently alter its draft fingerprint. Renewal
registration uses original quote line prices rather than allocated paid prices.
Order UUID matching and the native response spelling remain unchanged.

## Recovery admission and private capture

The capture is a developer mailbox with no real recipients. Rendered messages
stay under the git-ignored `.context/captured-messages` directory. Operator and
scheduled notices share [NoticeArtifactV1](host/notice-artifact.ts), with one
version, kind discriminator and validating reader/writer through private capture. The filename is the SHA-256 of the message key; permissions
are 0700 for the directory and 0600 for each file. Publication uses an exclusive
temporary file, file sync, exclusive link and directory sync, followed by
committed readback. Identical writes reuse the artifact; differing or corrupt
material refuses. A later claim must refuse a missing artifact and cannot
regenerate its bearer. Preserve these private files separately when moving a
store; database transfer alone does not preserve them.

### Scheduled sandbox renewal checkpoint

The installer and public configuration share [the owned renewal configuration
object](owned/renewal.config.ts). Structurally unready renewal invocations do not
claim renewals. Returned batches record actual checked, updated, failure and
deferred counts. An invocation that throws without a batch result marks counts
unavailable; it does not guess partial progress. The native ledger's lease
range is 60–3600 seconds; unsupported values refuse before any claim.

[Sandbox composition](host/renewal-sandbox.ts) uses frozen renewal money and the
current server-owned method. A retry begins an attempt on the original intent,
persists a simulator observation and reads that exact attempt before handing
source evidence to the native recovery owner. An ambiguous prepared attempt is
read again after restart and never dispatched again. This is local simulation;
it does not qualify a real payment method or provider.

The account response adds a narrow `renewal` projection from owned action,
payment, alignment and frozen/retained charge facts. Charge dates are distinct
from promised arrival; unavailable arrival promises remain explicitly unavailable.
Effective address outcomes come from the owning native event. Other rich account
sections keep their existing refusal.

The [notice binder](host/lifecycle-notices.ts) renders configured English/Polish
copy through the separately owned private capture module and M04 receipt owner.
It preserves one artifact and frozen token expiry per native notice command;
access-grant references contain the native token UUID. The one-shot care command mounts the native lifecycle dispatcher with this binder. No parallel
subscription-notice outbox handler is registered. The separate paid-order
handler below does not dispatch subscription notices. Signed opt-out retains its separate pending binding. The care command also selects native reminders, at-risk warnings and operator escalation with owned timing and caps; it activates no other retention planner.

### Private paid-order receipts

The same `./lifecycle renewal` invocation mounts the package's paid-order email
handler through [the paid-mail host](host/paid-mail.ts). Only
`commerce.order.paid.email` is claimable. Other known event types stay untouched.
The Core vocabulary includes the sibling `commerce.settlement.settled` fact.
It stays pending without a handler or message record and cannot block the paid
receipt even when it sorts first on the same order aggregate. This uses the
known-type claim policy; no host override, acknowledgement or dormant seed is added.
For a paid order with a resolvable contact and its emitted paid-mail event, the
pass produces one [private receipt record](host/paid-mail-artifact.ts) under
`.context/captured-messages`. It reads the order's contact, frozen lines and
catalogue/discount/charged totals from the installed native tables. Replay and
reclaimed events reuse the original record. No real mail provider is active.

Subject and summary labels live in the per-locale `paid` values in
[owned notice copy](owned/renewal-copy.ts). Locale selection uses the same
`renewal.notices.locale` and `countryLocales` as subscription notice copy.
Both English and Polish copy must be complete and nonempty. All other email
send methods refuse with `starter_paid_mail_method_not_selected`.

## Subscription care candidate

The command invokes finite auto-resume, drains the native notice dispatcher and
runs winback only. It creates no timer or HTTP endpoint. A session lock and the
native job ledger exclude another care invocation. Message bodies and bounded
run outcomes are private files in `.context/captured-messages`; native delivery
receipts retain idempotency. No real email provider is active. Operator escalation
uses active native critical-notification recipients and a narrow binder containing
only the notification, template and case references. Recipient provisioning remains
the existing native operator capability, never a starter seed or a customer action.

Captured reminders link to the localized account with the owned subscription
selected. At-risk links also open its payment section. Sign-in preserves that
local account destination and rechecks ownership. Captured winback links open the
localized account, where a cancelled subscription requires the same reactivation
confirmation. The account displays the native recorded winback status, refusal
and delivery reference, including `consent_missing`.

From this application directory, with the selected package set installed, run
`./lifecycle browser`. It reads the selections from `browser-groups.mjs`. Each
group gets a fresh pair of throwaway PostgreSQL 16 databases with the public
qualified installation and owned demo catalogue, plus two restricted hosts.
The seven groups are subscription care; portal; recovery extension; combined
operator operations, returns portal and shipment operations; combined payment
guidance, account preferences, embedded browser and billing profiles; payment
retry; and the remainder. They run every test selected by `playwright.database.config.ts` once,
with one worker. The command
creates both the UI-origin file and the private
`.context/care-browser/fixtures.json` required only by the database subscription
care group. The default preview browser command excludes that group. It tears down
only its own hosts and containers; database storage is temporary. Docker, Node 24,
Chromium and the application dependencies are prerequisites. Captures and fixture
connections stay in private `.context/care-browser` files. Traces, screenshots and
video are off. Fixture clocks adjust timestamps in these synthetic databases;
subscriptions and payment cases are created through their native purchase and
renewal commands. Separate operator/document proof recipes retain their own
fixtures and scope. The candidate changes below retain the local-preview release boundary.

### Checkout and account candidate changes

The account now edits first name, last name and phone through the installed
account mutation port. Email remains read-only. Failed saves keep the draft;
profile replay returns current state. The demonstration phone policy accepts
nine local digits under fictional calling code 999. These values in `owned/acquisition-policy.ts` make no
real-market claim. Current invoice entries offer a correction request with
reason, requested fields and optional note. The response acknowledges a stored
account event; it does not issue a correction, refund or operator ticket.
Repeated invoice request keys intentionally create separate events.

Owned pending orders offer signed-in recovery. The native actor entry selects
the exact order or initial declaration and supplies the account/fresh-checkout
fallback. It sends no mail and preserves earlier checkout links. Operator
order detail offers copy or queued email, expiry and refusal results. Eligible
expired one-time orders must match a fresh native quote before a link is issued. Its native
issuer deliberately revokes earlier checkout links and caps the new link at
issuance plus 24 hours or order creation plus 30 days, whichever comes first.
The communications operator
roster documented above is also required for this command. Queued email is not
a delivery claim.

`host/paid-mail.ts` composes the native job lease, first/final wave producer,
canonical expiry and initial-checkout sweeps, reconciliation and the existing
outbox handlers. Private messages reuse the atomic local capture protocol.
Only confirmed capture in the selected profile qualifies the final wave.
Checkout expiry links inspect the source and recovery lineage. Live pending-order
links support original-order sandbox continuation payment. Dedicated token pay,
exact cookie-authorized inline retry and the embedded-browser buyer-link control
are bound to native sandbox execution. The scheduled mail pass never mints a cookie.

Run the candidate portal journeys with `./lifecycle browser
browser/acquisition.spec.ts --grep 'portal '`, or include them in the complete
`./lifecycle browser` recipe. Both configurations and languages run on real
PostgreSQL with one worker and traces, screenshots and video off. No production,
provider or release activation is included.

## Expired checkout recovery and order holds

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

## Unpaid cancellation and manual refund records

Each command and replay rechecks the human admin and resolves the existing Commerce
operator row. Caller identities, missing confirmation, invalid reasons, stale
order status and conflicting commands refuse. Reasons use the package's trimmed
1–2,000 character contract. Native durable receipts own replay. The two formerly
unavailable actions are bound; physical-return, tracking and account limits stay separately
listed until their own complete bindings exist.

## Sandbox token payment and exact continuation

The continuation codec purpose-derives its signing key from the private
keyring root supplied by `--quote-acceptance-key-file`. This composition uses
the native order UUID for the opaque checkout journey. The owned
`embeddedCheckoutBrowserMarkers` constant in `owned/quote-copy.ts` contains
presentation hints only.


## Billing profiles and frozen invoice buyers

Install the complete ordered package history through
`20261110280000_checkout_recovery_buyer_snapshot` before starting this composition.
The host requires the slot-27 first-duty buyer-capture entry; slot 28 preserves
absence of explicit buyer facts during recreation. `./lifecycle up` installs the
complete history. No duty or historical invoice is backfilled.

`payment.simulate`, `checkout.payment` and recreated `checkout.recovery` simulation
share one capture/activation helper. Retained acquisition renewal availability
validates before a capture observation is recorded. After successful native ingress,
an initial subscription declaration activates through its native acquisition or
classic renewal branch. Capture and activation keep their existing transaction
boundaries; a cross-transaction outage is not an atomicity guarantee.
