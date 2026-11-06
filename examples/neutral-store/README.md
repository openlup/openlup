# Neutral store

Status: local application draft. Candidate compilation, installed PostgreSQL
bootstrap and local sandbox purchase/recovery browser journeys are checked.
Release and upgrade qualification remain pending. This is not a stable or supported framework.

This is an application, not an npm package or a monorepo workspace. It uses the
three OpenLup packages through public entries, ordinary TypeScript, a small
browser UI, system fonts and application-owned configuration. The fictional
supplement and coffee catalogues use the same pages, validation and host seams.

## Current candidate

The installed native catalogue and account stores use the runtime connection.
The composition root binds guest checkout, sandbox payment and customer
subscription address changes through public native factories. Host and browser
purchase/recovery proofs run on real PostgreSQL in both configurations. `./lifecycle up` installs
the packaged PostgreSQL history and fictional catalogue before starting the UI.
Final release pins and lockfile wait for the selected set.
The unchanged required purchase spec must run against installed PostgreSQL;
the default database-less UI host cannot satisfy it. See [proof](docs/proof.md).

An accepted native limit and a missing required purchase binding are different:
the former is documented acceptance, the latter still blocks completion.
See [limits](docs/limits.md) and [proof](docs/proof.md).

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

## Start from an exact source archive

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

Target prerequisites for the final cold path are Docker with Compose and an
exact release archive. The target command is:

```sh
./lifecycle up
```

With the selected local candidate artifacts and generated lockfile in place,
Compose builds the application, starts pinned PostgreSQL 16, runs the one-shot
installed migration runner and fictional seed, then serves the application at
`http://127.0.0.1:4319`. No keys, source edits or manual migration are needed.
A healthy application does not by itself establish a completed sandbox purchase.

For authorized UI development after importing the candidate and generating its
lockfile, use the application directory and its own toolchain:

```sh
npm ci
npm run build
npm start
```

The running app is the customization preview. It displays local-candidate and
sandbox notices. The host binds to loopback; the container publishes its port
only on loopback. Do not expose this local demonstration to a public network.
No external email provider, payment provider or marketplace connector is active.

To run the other configuration through the same code:

```sh
npm start -- --configuration coffee
```

Stop the running process before restarting on the same port. For the eventual
Compose path, use `./lifecycle up --configuration coffee`. With no flags,
`./lifecycle up` uses the owned default.
`./lifecycle down` stops this Compose project without deleting persistent data.

## Host origin and local sessions

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
Invoice artifacts, the full account projection and shipment reads remain named
refusals. Guest purchase, account and operator order reads have real-database
host and browser proofs. The database-backed suite passes the unchanged required
purchase assertion in both configurations; this is local preview evidence.

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

Read [customization](docs/customization.md), [ownership](docs/ownership.md) and
the generated application agent guide. The typed input lives in
`owned/store.config.ts`; localized general copy lives in `owned/copy.ts`; three
named UI fragments live in `owned/fragments.ts`.

A selection below the configured purchase minimum remains saved across browser
reloads and storage updates. The shared validator still refuses checkout until
that minimum is met; a saved partial selection is not an eligible order quote.

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

Clients, stock and settings use native writers; they are never seeded here.
Subscription renewal terms, term lines and method states belong to the native
purchase path and must never be hand-written by this application. After the
catalogue seed, purchase uses zero hand-written business rows. This data step
is not a schema installer, price editor, promotion engine or customer import.

## Reset an interrupted first install

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

All identities, contacts, catalogue entries, labels and prices are fictional.
The supplement catalogue contains no health claim or consumption advice. No
money is charged, real parcel sent or real invoice issued. Use `.test` addresses
and fictional contacts only. The browser cart is convenience state, not an order.

Do not point this demo database or its identities at customer infrastructure.
A customer environment needs its own authority, restricted runtime and migration
identities, terms, tax and shipping policy, operational controls and verified
provider bindings. A demonstration flag does not establish those.

## Pages and proof

The footer's message-links page lists every message destination in both locales.
Sample grant links deliberately use invalid values, which must refuse instead of
accessing another account. Local captured messages must supply real scoped
grants once their bindings exist. Follow [destination mapping](docs/destinations.md)
for the mounted paths and [proof](docs/proof.md) for required execution evidence.

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

These arguments contain only a public configuration ID, port and listen address.
There are no credential arguments, URLs, keys or passwords. The local one-shot
bootstrap uses only its isolated Unix socket; the runtime has only its fixed,
passwordless private-network URL. Neither connection is selected from starter
process environment reads. An absent installed migration API still refuses by
name. No customer environment is selected by a demonstration flag.

## Operator support roster and catalogue authoring

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

Find the activated principal using its normalized invitation email:

```sql
SELECT p.principal_id, p.email, m.role, m.membership_state
FROM public.platform_human_principals p
JOIN public.platform_human_memberships m USING (principal_id)
WHERE lower(btrim(p.email)) = lower(btrim('operator@example.test'))
  AND m.membership_state = 'active' AND m.role IN ('admin', 'distributor')
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

To withdraw support access through the same owner connection:

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

With the runtime connection, operator customer search/detail and bundle
list/detail/commands plus catalogue draft list/detail/create/revise/abandon are
composed. Bundle commands and catalogue draft writes are restricted to a native
human admin/distributor session, rechecked per request; actor identity and command
key come only from the accepted host context. `owned/catalogue.ts` owns the
fictional authoring type. The support port is constructed per request for that
operator and closed in `finally`, including failed reads; it has no operator cache.

Catalogue drafts write only isolated authoring tables (packages/platform/sql/20260908100000_catalog_draft_foundation.sql:1-9); bundle activation sets the native bundle status to active (packages/platform/sql/20260812210000_bundle_operator_write_boundary.sql:493), while this application's storefront and checkout still use typed configuration through evaluateOffer (examples/neutral-store/shared/offer.ts:40), so neither creates a new purchasable storefront offer.

The following acquisition baseline predates support and catalogue composition;
its unbound-operator statements describe that earlier baseline only. The current
operator composition and its prerequisites are documented above.

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

Operator customer search/detail remain unbound because the native reader
requires a separate communications operator roster entry. The host does not
provision that authority. Broader payment/operator recovery and catalogue administration remain unbound; see [limits](docs/limits.md). Acquisition proves no purchase journey.


## Guest purchase and later sign-in

A purchase needs no account; checkout keeps a contact record for the e-mail; the customer signs in with that e-mail to see the purchase.
Checkout creation uses the public contact registrar after attempt admission. Signed-in checkout uses the
session's native client, never a browser-supplied client identifier.

An unverified e-mail does not authorize reading an existing order or changing a
client. A guest purchase for an e-mail whose contact already has an account
attaches the order to that existing client, without an account read or rewrite.
The public answer does not depend on whether an account exists.

An admitted new checkout issues a 256-bit recovery token through the native
PostgreSQL port. Only its SHA-256 hash is stored. PostgreSQL fixes expiry at
order creation plus 24 hours; this is a database rule, not a configurable value.
One live link per order: a new link ends the previous link of the same order.
The token is returned only in the creating response and a separate private
captured checkout-recovery message, never an authentication challenge or event.
The completion page reads the URL token once and replaces history synchronously
before configuration fetch or rendering. Request bodies carry the token; memory
and session storage preserve reload convenience but grant no authority. An unchanged repeated submit for the same order keeps its existing token when the replay response omits it. A different order never inherits that token, and a new token replaces the previous one.
The committed continuity proof consists of the source continuity test and the
clean-index root proof, which needs only npm ci and the three-package build,
without a starter build or browser. A real-browser second-submit check was
confirmed in a local run that is not part of the committed suite.
Native inspection allows payment only for an active pending order, recognizes
an already-paid order without payment controls, and refuses expired, cancelled
or unavailable links. Indexed hash lookup makes no constant-time claim.
Owning sessions retain order ownership checks. An email alone mints no link for
an existing order. Recovery grants no account or subscription-command access.

For now this release does not charge shipping on one-off orders.
For now this release does not charge shipping on renewals.
The first-subscription offer is not offered yet and comes in a later part of this release. Sandbox outcomes
are `captured`, `refused`, `expired` and `indeterminate`; other values refuse.
No real-money provider is selected by this composition.

Duplicate or multi-valued Origin is refused even on GET and HEAD. An unambiguous
Origin on GET or HEAD is not compared. Writes require the exact configured
origin, the marker header and JSON. The accepted origin policy is unchanged.


## Native quote and acquisition composition

The native host uses the installed quote engine with current catalogue documents,
exact price-list entries, a canonical subscription policy and native promotion
reads. Catalogue, builder, cart and checkout projections read `offer.validate` on the
native host. Failed refreshes withhold the previous money. The local preview
estimator remains available only for explicit database-less one-time estimates
and configuration characterization; it delegates unit arithmetic to the package. The install seed
retains the six compatibility mode-price entries and adds one immutable policy
revision, current document pointers, physical trade-item facts and one standalone
acquisition definition. Conflicting policy, document or promotion initialization
refuses and rolls back. This is a fresh demonstration install, not policy rotation.

`owned/quote.config.ts` supplies neutral acquisition rates, effective dates,
document identity and graduation cadence. Product physical facts remain owned
catalogue data. Initial and renewal shipping retain the zero-charge interim. A nonzero initial
fee refuses with `starter_initial_shipping_unsupported` until that policy is qualified.
The second-delivery display uses the retained quote's list basis and configured
promise through the package adjustment engine.

The browser explicitly declares `subscription-acquisition.v1`. Unsupported
subscription callers receive `acquisition_terms_capability_required` before
contact, order or payment effects. A private host keyring file may be supplied
with `--quote-acceptance-key-file`; it contains the existing helper's `current`
and optional `previous` keys, each at least 32 characters. Keep it outside served
assets and browser configuration. This application does not provision keys.
Missing keys refuse acquisition quotes. Acceptance binds the request, money,
policy, second promise and delivery terms; changed terms clear consent and require
refresh even if the total is unchanged. Expired observations withhold money.

The local predecessor seam loads the package eligibility and transactional
admission factories. Missing exports refuse admission by name. All mounted checkout modes use the
transaction adapter; acquisition terms never reach a direct lower-level writer. Alias evidence cannot grant a customer session or
account reads. The host freezes the installed retained-renewal contract in the
server quote: original mode-price units and full line evidence, the second-delivery
amount/rate/basis, configured minimum and graduation cadence, and zero shipping.
Acceptance binds those promise values; observation timestamps are not promise
identity. The full retained evidence is excluded from the browser projection.
After sandbox capture, the installed purchase-renewal writer records those terms
before activation. Missing or inconsistent retained evidence refuses creation
with `starter_quote_refresh_required`. This composition does not itself qualify later renewal or invoicing.

Attempt limits live in one process's memory and reset on restart.
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

Replayed checkout uses its saved quote and compares the complete request binding;
current observation times cannot silently alter its draft fingerprint. Renewal
registration uses original quote line prices rather than allocated paid prices.
Order UUID matching and the native response spelling remain unchanged.
