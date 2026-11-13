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

Moved to [the reader guide](../../packages/core/docs/guide/how-to/build/customize-the-starter.md#edit-and-refresh).

On macOS or Linux, after extracting the application and preparing its package
artifacts and dependencies as described below, run `npm run dev`. Optionally
pass `-- --configuration coffee --port 4320` (the default port is 4319).
The command builds the browser assets and starts the existing loopback host
only after a successful build. It rebuilds edited client code and restarts the
host when its imported configuration changes. Refresh the browser manually to
see the result. It does not run the database-backed composition.

## Current candidate

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md).

The installed native catalogue and account stores use the runtime connection.
The composition root binds guest checkout, sandbox payment and customer
subscription address and lifecycle changes through public native factories. Host and browser
purchase/recovery proofs run on real PostgreSQL in both configurations. `./lifecycle up` installs
the packaged PostgreSQL history and fictional catalogue before starting the UI.
Final release pins and lockfile wait for the selected set.
The unchanged required purchase spec must run against installed PostgreSQL;
the default database-less UI host cannot satisfy it. See [proof](docs/proof.md).

No generic contact form; the partner inquiry is the durable intake.
With the native runtime connection, public partner submissions use the native
idempotency, contact deduplication and rate limits. Operator partner list and
status transitions use the existing native human operator session. Public review
read/submit require an order review grant; operator review list/moderation use
that same operator authority. Positive review submission/read, moderation, revocation and grant ownership
belong to the later review journey after delivered-shipment reads. Grants retain
the native bearer-capability semantics. Their fixed thirty-day expiry has no
application time seam; this contribution claims no additional review proof.
Tester applications are public durable writes through the native acquisition
case port and an install-seeded adopter-owned opaque registry. Research needs
case ownership and ingest needs a complete native binding; those two actions
remain unmounted and refuse `host_binding_required`.
Support is a static contact page; see [contact configuration](docs/customization.md#support-contact).

## Order controls and documents

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md#account-and-operator-bindings).

## Start from an exact source archive

Moved to [the reader guide](../../packages/core/docs/guide/how-to/build/customize-the-starter.md#prepare-the-application).

The release route is a source archive, followed by the small extraction script.
No generator package or author checkout is required. Select the exact public
release and its source commit; do not use a floating main archive. The final
release reference is pending; the following shows the shape, not a published
artifact claim:

```sh
# Download the source archive for your selected immutable release commit.
# Extract it into a staging directory using your normal archive tool.
node /path/to/extracted-release/examples/neutral-store/extract.mjs /path/to/empty-store
cd /path/to/empty-store
```

The script requires Node 24 and Git. It refuses a nonempty destination, copies
only application-owned and managed inventory entries (not source-only extraction
tooling or its tests), creates a new `.git` directory and
materializes the application agent guide. It never searches a parent directory,
copies the monorepo configuration or resolves workspace packages.

During candidate development, supply only the three selected tarballs as
described in [candidate artifacts](artifacts/README.md). The application manifest
contains exact `file:` references to those bytes. Candidate import records their
names, equal set version and SHA-256 identities. It does not certify publication.

## Run the local application

Moved to [the reader guide](../../packages/core/docs/guide/how-to/build/customize-the-starter.md#run-the-local-demonstration).

```sh
./lifecycle up
```

With the selected local candidate artifacts and generated lockfile in place,
Compose builds the application, starts pinned PostgreSQL 16, runs the one-shot
installed migration runner and fictional seed, then serves the application at
`http://127.0.0.1:4319`. No manual key provisioning, source edits or manual migration are needed.
A healthy application does not by itself establish a completed sandbox purchase.

```sh
npm ci
npm run build
npm start
```

```sh
npm start -- --configuration coffee
```

Stop the running process before restarting on the same port. For the eventual
Compose path, use `./lifecycle up --configuration coffee`. With no flags,
`./lifecycle up` uses the owned default.
`./lifecycle down` stops this Compose project without deleting persistent data.

## Host origin and local sessions

Moved to [the reader guide](../../packages/core/docs/guide/how-to/build/customize-the-starter.md#protect-local-sessions-and-messages).

`StoreConfig.publicOrigin` is an optional owned input. Without it, the host
accepts only `127.0.0.1:<listening-port>` and `localhost:<listening-port>` over
HTTP. With it, the host accepts exactly that origin's canonical Host authority
and requires its exact scheme, host and port in Origin on every method other
than GET/HEAD. The request marker and JSON content type remain required.
Unknown or ambiguous Host/Origin headers refuse; forwarded headers grant no
trust. A TLS terminator must pass the original Host through. This setting opens
no port and provides no deployment qualification: the demonstration Compose
publication stays loopback-only, and its passwordless HBA is never a deployment
recipe. See [customization](docs/customization.md#public-origin).

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

The demonstration captured mailbox is `.context/captured-messages/identity.jsonl` inside
the application container, readable only with that runtime's filesystem
access. The container runs as `node` in `/application`; read the 0600
file with this exact command from the extracted application directory:

```sh
docker compose exec -T --user node application cat /application/.context/captured-messages/identity.jsonl
```

This demonstration mailbox is not a real mailbox. It is never served by HTTP or
printed in application logs. Native redemption accepts
its token through `auth.verify` or `auth.callback`; `auth.operator` accepts email
for a challenge and token for redemption. The native stores must already contain
the contact client from checkout or an invited operator. There is no public operator bootstrap.
After activation, support reads require the [owner roster step](#operator-support-roster-and-catalogue-authoring), including its deactivation recipe.
Opaque sessions are limited to a single process, expire after one hour, have a
capacity of 1000 and are lost on restart. This is not a production session store;
operator membership and customer ownership are rechecked on requests.
Cookies are host-only, HttpOnly, SameSite=Lax, scoped to `/api/actions`, and Secure
exactly for a configured HTTPS origin. The local mailbox is a demonstration
transport, not proof of access to a real mailbox.

With `publicOrigin` set, a probe using the ordinary loopback Host receives
`starter_local_host_required`. Lifecycle's internal probe connects privately and
sends the configured Host; any external health probe must also send that Host.

## Customize and upgrade

Moved to [the reader guide](../../packages/core/docs/guide/how-to/build/customize-the-starter.md).

Read [customization](docs/customization.md), [ownership](docs/ownership.md) and
the generated application agent guide. The typed input lives in
`owned/store.config.ts`; localized general copy lives in `owned/copy.ts`; three
named UI fragments live in `owned/fragments.ts`.

`./lifecycle verify` and `./lifecycle upgrade` delegate to the installed public
CLI when it exists. They refuse explicitly before that capability is shipped.
They do not replace it with an application-owned upgrade engine. A real
`openlup upgrade apply` preservation witness remains required.

## Install-only fictional catalogue

Moved to [the reader guide](../../packages/core/docs/guide/concepts/starter-ownership.md#own-configuration-and-data-onboarding).

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

Moved to [the reader guide](../../packages/core/docs/guide/how-to/build/customize-the-starter.md#configure-subscription-editing).

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
cadence choices preserve explicit counts. See the [named limits](docs/limits.md).

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

## Reset an interrupted first install

Moved to [the reader guide](../../packages/core/docs/guide/how-to/build/customize-the-starter.md#reset-an-interrupted-first-install).

An interruption after database creation but before its demonstration marker is
written leaves an unmarked database. Startup refuses it with
`starter_seed_demonstration_database_required`; it never adopts or marks it.
To discard that interrupted **local demonstration**, run from its extracted
application directory with the same Compose project selection used to start it:

```sh
./lifecycle down
docker compose down --volumes
./lifecycle up
```

`docker compose down --volumes` explicitly removes the named demonstration
volumes and destroys all local demonstration data. It must never be run against
anything else. A fresh startup creates and marks a new demonstration database.

## Data boundary

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md).

All identities, contacts, catalogue entries, labels and prices are fictional.
The supplement catalogue contains no health claim or consumption advice. No
money is charged, real parcel sent or real invoice issued. Use `.test` addresses
and fictional contacts only. The browser cart is convenience state, not an order.

## Pages and proof

Moved to [the reader guide](../../packages/core/docs/guide/reference/starter-routes.md).

## Neutral inputs and local transport

Moved to [the reader guide](../../packages/core/docs/guide/how-to/build/customize-the-starter.md#run-the-local-demonstration).

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

Moved to [the reader guide](../../packages/core/docs/guide/how-to/build/customize-the-starter.md#provision-operator-rosters).

Activate a native human operator through the native invitation and challenge
redemption described in [Host origin and local sessions](#host-origin-and-local-sessions)
first. On the operator page (`/admin` or `/pl/admin`), enter the invited email
and request a sign-in token. Read the token from the private demonstration mailbox
with the documented `docker compose exec -T --user node application cat
/application/.context/captured-messages/identity.jsonl` command above, then enter
the exact 43-character URL-safe token in the separate operator token form and
sign in. The password field hides the token and clears after successful
redemption; the response does not echo it. Keep mailbox access private.
There is no HTTP bootstrap or roster writer. The database owner then runs
this **one owner-connection step**, never with the runtime login or application
connection. From the extracted demonstration application directory:

```sh
docker compose exec -T database psql -U starter_install -d neutral_store
```

```sql
SELECT p.principal_id, p.email, m.role, m.membership_state
FROM public.platform_human_principals p
JOIN public.platform_human_memberships m USING (principal_id)
WHERE lower(btrim(p.email)) = lower(btrim('operator@example.test'))
  AND m.membership_state = 'active' AND m.role = 'admin'
  AND NOT EXISTS (SELECT 1 FROM public.platform_control_operators o
                  WHERE o.principal_id = p.principal_id);
```

Require exactly one row. Copy its `principal_id` unchanged below; this is exactly
the principal passed by the host as `operatorRef`, never a customer/client ID:

```sql
INSERT INTO public.platform_communication_operators (principal_id, active)
VALUES ('<activated-principal-id>'::uuid, true)
ON CONFLICT (principal_id) DO UPDATE SET active = true, updated_at = now();
```

```sql
UPDATE public.platform_communication_operators
SET active = false, updated_at = now()
WHERE principal_id = '<activated-principal-id>'::uuid;
```

This roster is an additional native support precondition, not human membership
or sign-in authority. The host checks active native human membership on every
request **before** the support action. A roster row alone admits no request;
no session, customer sessions, inactive human members and supplied actor IDs
cannot become operators. Do not seed this table during installation: the human
principal does not yet exist. Native `customer_support_read_failed` intentionally
hides the SQL cause; the UI names the roster prerequisite without asserting that
every read failure means not provisioned. No second authority is built here.

#### Commerce operator roster for hold and release admission

Moved to [the reader guide](../../packages/core/docs/guide/how-to/build/customize-the-starter.md#provision-operator-rosters).

```sql
INSERT INTO public.commerce_operators (id, label)
VALUES ('<activated-principal-id>'::uuid, 'Human administrator')
ON CONFLICT (id) DO NOTHING;
```

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

Moved to [the reader guide](../../packages/core/docs/guide/how-to/build/customize-the-starter.md#replace-acquisition-location-choices).

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

Moved to [the reader guide](../../packages/core/docs/guide/concepts/starter-ownership.md#checkout-continuation-and-recovery).

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
The committed continuity proof consists of the source continuity test and the
clean-index root proof, which needs only npm ci and the three-package build,
without a starter build or browser. A real-browser second-submit check was
confirmed in a local run that is not part of the committed suite.
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

The first-subscription offer is not offered yet and comes in a later part of this release. Sandbox outcomes
are `captured`, `refused`, `expired` and `indeterminate`; other values refuse.
No real-money provider is selected by this composition.

## Native quote and acquisition composition

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md#purchase-composition-boundaries).

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

Moved to [the reader guide](../../packages/core/docs/guide/concepts/starter-ownership.md#checkout-continuation-and-recovery).

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

Moved to [the reader guide](../../packages/core/docs/guide/how-to/build/customize-the-starter.md#run-a-bounded-background-pass).

The application owns [renewal configuration](owned/renewal.config.ts), including
its explicit disabled default, population, cadence, batch and lease values. The
installer and public configuration use the same object. After the selected
installation is complete, an existing local scheduler may invoke
`./lifecycle renewal --configuration <id> --database-url <restricted-runtime-url>`.
This one-shot lifecycle entry runs one bounded paid-mail outbox pass and selects
the native renewal service once; it creates no timer or second HTTP server.
The renewal enable flag gates renewal claims; the paid-mail pass also runs when
renewals are disabled. Structurally unready renewal invocations do not claim renewals. Population session exclusion and the durable job ledger serialize
selected executors, including a callback longer than its lease interval.
Returned batches record actual checked, updated, failure and deferred counts.
An invocation that throws without a batch result marks counts unavailable; it
does not guess partial progress. Lease configuration must stay within the native
ledger's 60–3600 second range; unsupported values refuse before any claim.

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

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md#paid-order-message-capture).

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

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md#subscription-care).

```sh
./lifecycle care --configuration supplements --database-url <restricted-runtime-url>
```

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

### Candidate changes

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md#subscription-care).

### Checkout and account candidate changes

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md#account-and-operator-bindings).

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

```sh
./lifecycle checkout-recovery --configuration supplements --database-url <restricted-runtime-url>
```

Use `--port` for this local host's actual listening port, or the configured public
origin. The invocation composes the native job lease, first/final wave producer,
canonical expiry and initial-checkout sweeps, reconciliation and the existing
outbox handlers. Private messages reuse the atomic local capture protocol.
Only confirmed capture in the selected profile qualifies the final wave.
Checkout expiry links inspect the source and recovery lineage. Live pending-order
links support original-order sandbox continuation payment. Dedicated token pay,
exact cookie-authorized inline retry and the embedded-browser buyer-link control
are bound to native sandbox execution. The scheduled mail pass never mints a cookie.

The operator reads the current order and parcel before requesting a replacement
or complete fulfillment cancellation. Replacement shows the frozen destination,
reason and exception-hold consequences and requires confirmation. Cancellation
also requires confirmation; the native command owns provider fences and recorded
reservation release. These actions do not confirm arrival, dispatch a real
parcel, create a refund or move a subscription cycle earlier.
Unpaid cancellation and completed external-refund marking use the native order
commands. Shipment label, handoff and tracking evidence are also bound to native
operator commands; N3 order notes and order-address corrections remain unavailable.

```sql
INSERT INTO public.commerce_operators (id, label)
VALUES ('<activated-principal-id>'::uuid, 'Demonstration administrator')
ON CONFLICT (id) DO NOTHING;
```

Run the candidate portal journeys with `./lifecycle browser
browser/acquisition.spec.ts --grep 'portal '`, or include them in the complete
`./lifecycle browser` recipe. Both configurations and languages run on real
PostgreSQL with one worker and traces, screenshots and video off. No production,
provider or release activation is included.

## Expired checkout recovery and order holds

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md#expired-checkout-recovery-and-order-holds).

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

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md#unpaid-cancellation-and-manual-refund-records).

Each command and replay rechecks the human admin and resolves the existing Commerce
operator row. Caller identities, missing confirmation, invalid reasons, stale
order status and conflicting commands refuse. Reasons use the package's trimmed
1–2,000 character contract. Native durable receipts own replay. The two formerly
unavailable actions are bound; physical-return, tracking and account limits stay separately
listed until their own complete bindings exist.

## Return requests and decisions

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md#return-requests-and-decisions).

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

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md#optional-payment-guidance).

## Operator shipment evidence

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md#operator-shipment-evidence).

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

The existing paid-capture document policy is unchanged. The optional handoff
accounting wrapper is only for an adopter that selects a handoff issue policy;
any such callback belongs after the committed shipment transaction and remains
fail-soft according to that wrapper's policy.

## Saved addresses and scoped preferences

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md#saved-addresses-and-scoped-preferences).

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

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md#sandbox-token-payment-and-exact-continuation).

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

The owned `embeddedCheckoutBrowserMarkers` constant in `owned/quote-copy.ts`
contains display hints only and grants no payment or delivery authority.
Only detected embedded browsers show the buyer send/send-again control after real
continuation exists. Detection is a display hint, never authority. The native
cookie-only handler obtains order/client from verified claims, uses the saved
checkout recipient, and deduplicates sends in its unchanged ten-minute bucket.
The sent confirmation survives panel remounts while sending again remains reachable;
failure offers a neutral retry. Delivery rechecks the native buyer authorization
and captures the link in the existing private mailbox. The source marker
distinguishes the buyer landing. Enqueue, capture and payment are separate facts.

## Billing profiles and frozen invoice buyers

Moved to [the reader guide](../../packages/core/docs/guide/reference/limits.md#billing-profiles-and-frozen-invoice-buyers).

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
