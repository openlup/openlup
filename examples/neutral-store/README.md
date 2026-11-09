# Neutral store

Status: local application draft. Candidate compilation, installed PostgreSQL
bootstrap and local sandbox purchase/recovery browser journeys are checked.
Release and upgrade qualification remain pending. This is not a stable or supported framework.

This is an application, not an npm package or a monorepo workspace. It uses the
three OpenLup packages through public entries, ordinary TypeScript, a small
browser UI, system fonts and application-owned configuration. The fictional
supplement and coffee catalogues use the same pages, validation and host seams.

## Local UI edit loop

On macOS or Linux, after extracting the application and preparing its package
artifacts and dependencies as described below, run `npm run dev`. Optionally
pass `-- --configuration coffee --port 4320` (the default port is 4319).
The command builds the browser assets and starts the existing loopback host
only after a successful build. It rebuilds edited client code and restarts the
host when its imported configuration changes. Refresh the browser manually to
see the result. It does not run the database-backed composition.

Build errors appear in the terminal; correct the source and wait for a
successful rebuild before refreshing. Configuration or port errors can leave
the Node watch process waiting for a corrective save; a running command does
not mean the host is listening. A restart may clear process-local sessions.
Changes to public media are not watched, and client and configuration changes
are not an atomic reload. The build watcher polls for file changes, which uses
resources even while idle. Stop the command with Ctrl-C.

## Current candidate

The installed native catalogue and account stores use the runtime connection.
The composition root binds guest checkout, sandbox payment and customer
subscription address and lifecycle changes through public native factories. Host and browser
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

## Order controls and documents

Hold and release retain their typed forms and configured reasons. Both remain
unbound and return `starter_order_hold_unavailable` after operator admission.
The host composes
customer invoice history, owned captured PDF downloads and local operator
document summaries. The session supplies the actor and invoice
owner. The captured provider produces explicitly non-fiscal sandbox documents.
The download stays behind authenticated POST, Origin admission and no-store.
The browser saves the decoded PDF through a short-lived local object URL.
Deferred operations share one bilingual catalogue with the limits page and stay
unbound. The operator returns reader is removed. Shipment list/detail compose
the native nonmutating reader under the human-admin read boundary; the reduced
projection retains its explicit unavailable facts. See [limits](docs/limits.md).

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
`http://127.0.0.1:4319`. No manual key provisioning, source edits or manual migration are needed.
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
Invoice history, owned captured PDF access, operator document summaries and
shipment reads are also bound, alongside authenticated recovery, scheduled sandbox
renewal and private transactional notices. The full account projection remains a
named refusal. Deferred order and shipment mutations retain their named limits.
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
provision that authority. Operator payment recovery is bound through the native
human-authority command; other unbound actions retain their named refusals;
see [limits](docs/limits.md). Acquisition proves no purchase journey.


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
Checkout links for the same order coexist until expiry or payment; issuing
another link does not revoke an earlier checkout link. Payment-case links still
rotate, leaving one live link per case. The separate account actor issuer also
retains rotation.
The token is returned only in the creating response and a separate private
captured checkout-recovery message, never an authentication challenge or event.
The completion page reads the URL token once and replaces history synchronously
before configuration fetch or rendering. Request bodies carry the token; memory
and session storage preserve reload convenience but grant no authority. An unchanged repeated submit for the same order keeps its existing token when the replay response omits it. A different order never inherits that token. A new token replaces the token stored in this tab; earlier checkout links remain usable until expiry or payment.
The committed continuity proof consists of the source continuity test and the
clean-index root proof, which needs only npm ci and the three-package build,
without a starter build or browser. A real-browser second-submit check was
confirmed in a local run that is not part of the committed suite.
Native inspection allows payment only for an active pending order, recognizes
an already-paid order without payment controls, and refuses expired, cancelled
or unavailable links. Indexed hash lookup makes no constant-time claim.
Owning sessions retain order ownership checks. An email alone mints no link for
an existing order. Recovery grants no account or subscription-command access.

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

Authenticated recurring recovery captures its entry token synchronously before
application requests and the login trip, then uses the server-owned
case/obligation/operation/order chain. The route accepts no method or payment
facts from the browser. Authorization schedules the same unpaid obligation and
returns pending state; only native retry execution and readback establish
recovery. Initial checkout reads, simulator completion and acquisition
activation refuse a recurring relation for both guests and matching owners.

The human operator recovery action uses the native command and its eligible
customer/case rules. The selected native installation includes the command
receipt-lock completion. Committed real-HTTP proofs pass for both configurations,
including issuance, replay, missing/changed capture, restart and human revocation.
Active human authority is revalidated on replay. The
scheduled notice host reads the original operator artifact and preserves its
rendered content, token and expiry across process restarts.

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

The account page reads owned subscriptions and offers skip, reschedule, pause,
resume, cancellation, order now and reactivation. Cycle edits honor the native
payment, method, cycle and edit-window facts. Pause and cancellation remain
available during an open payment case; the native command still refuses an
in-flight charge. Pause defaults to two weeks and also offers one month or an
indefinite window. Cancellation asks for a reason, offers a skip, reschedule or
pause, and records acceptance or refusal through the native command. A
reschedule offer starts from the current renewal and displays its actual target.
Generic package, plan and bundle editing are outside this release.

Order now and reactivation require an explicit charge-timing confirmation.
Owned [care values](owned/renewal.config.ts) supply pause durations,
slide bounds and charge-eligibility delays. The owned renewal configuration
supplies retry hours. These enter trusted native constructors; request bodies
cannot replace them. A charge-eligibility date is not an arrival promise.

After local installation, an existing scheduler can run one bounded pass:

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

The retention-consent gate stays at its unseeded native default ON. The starter
writes no settings row and provides no retention-consent capture. With the
existing native subscriber-retention delivery control enabled, a trusted host
can record consent through the existing native routine; newsletter/offers choices
do not grant it. An adopter wanting the gate OFF follows the existing
[winback policy owner](../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#composed-subscription-module).
Local proof covers both the refused case and a separate host-authorized outcome.

From this application directory, with the selected package set installed, run
`./lifecycle browser`. It creates two throwaway PostgreSQL 16 databases, applies the public qualified installation,
loads the owned demo catalogue, starts both restricted hosts, then runs every
spec selected by `playwright.database.config.ts` with one worker. The command
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

This candidate adds lifecycle controls, cancellation save offers, charge-timing
confirmations and localized notice landings. Native care scheduling and private
capture are composed. The clock-driven auto-resume journey delivers the paid first
order, advances beyond the finite pause and renewal date, and proves whole-cadence
roll-forward plus one locally captured resumed confirmation in both configurations.
The disposable fixture records synthetic parcel transitions through the native
shipment rail and supplies the external host's fulfilled-order fact. No operator
delivery action, settings seed, real provider or release activation is included.
