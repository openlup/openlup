# Customize the starter store

Change the starter's identity, presentation and offer rules in your application.
Start with owned configuration and fragments; take ownership of a page when the
change reaches its structure or workflow.

## Prepare the application

The starter is separate application source. Choose an immutable source archive
and extract it before running the following command from that archive's root.
Use Git and the toolchain pinned in the [starter source entry](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/examples/neutral-store/README.md#neutral-store);
the destination must be empty.

```sh
node examples/neutral-store/extract.mjs ../my-store
cd ../my-store
```

The extractor copies the owned and managed inventory, creates an independent Git
repository and materializes its application agent guide. It refuses a nonempty
destination with `starter_extract_directory_not_empty`.

The application manifest expects local package archives. Set `CORE_ARCHIVE`,
`OUTBOX_ARCHIVE` and `PLATFORM_ARCHIVE` to the full paths of your selected package
archives, then import them in this order:

```sh
./lifecycle candidate "$CORE_ARCHIVE" "$OUTBOX_ARCHIVE" "$PLATFORM_ARCHIVE"
npm ci
```

Import checks package names and equal versions, records artifact digests and
generates the lockfile. These are local candidate inputs, not registry pins.
For an application consuming npm packages directly, use
[Adopt OpenLup from npm](../../start/adopt-from-npm.md) instead.

## Run the local demonstration

For a database-backed demonstration, install Docker with Compose and run from
the prepared application directory:

```sh
./lifecycle up
```

This builds the image, starts PostgreSQL, applies the packaged migration history
and fictional seed, then serves the application on the [starter's loopback listener](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/examples/neutral-store/README.md#run-the-local-application).
Pass `--configuration <id>` to select another owned configuration.
`./lifecycle down` stops the project while preserving its data. Keep the
passwordless demonstration network and its database isolated; do not reuse this
Compose file or its database authentication rules for a deployed application.
Use fictional contacts and `.test` addresses. A healthy configuration response
does not establish a completed purchase; read the [starter limits](../../reference/limits.md).

For a database-free presentation preview, run:

```sh
npm run build
node --experimental-strip-types host/server.ts
```

This host does not compose the database-backed actions. Pass `--configuration`
and `--port` to select your configuration and listener; the [host CLI](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/examples/neutral-store/host/server.ts)
owns their defaults. Stop with Ctrl-C before reusing the port. Use the
[edit loop](#edit-and-refresh) while changing the presentation.

## Reset an interrupted first install

An interruption after database creation but before its demonstration marker is
written leaves an unmarked database. Startup refuses with
`starter_seed_demonstration_database_required` rather than adopting it.
To discard only that local demonstration, use its application directory and the
same Compose project selection:

```sh
./lifecycle down
docker compose down --volumes
./lifecycle up
```

The volume removal destroys all data in that demonstration project. A fresh
startup creates and marks a new demonstration database.

## Edit and refresh

From the root of your extracted application, with dependencies prepared, run:

```sh
node --experimental-strip-types dev.mjs
```

The local edit loop runs on macOS and Linux. Edit configuration, fragments or
`client/style.css`, wait for a successful client build or host restart, then
refresh the browser manually. If the terminal reports an error, resolve it and
wait for the host to listen before refreshing. With the starter's `build` and
`start` package scripts, restart the host after a configuration edit and rebuild the client
after a fragment edit. Changes to public media need a manual refresh; they are
not watched. The watcher polls even while idle. A restart loses process-local
sessions, and client and configuration changes do not reload atomically.

## Select your configuration

Add a configuration satisfying `StoreConfig` from `shared/config.ts` to the
owned registry and choose its ID as the default. The [registry contract](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/examples/neutral-store/docs/customization.md#one-input-and-three-fragments)
identifies its exports. The host and
lifecycle use that default unless you pass `--configuration <id>`; an unknown ID
refuses with `starter_configuration_unknown`. IDs use lowercase letters and
digits separated by single hyphens, within the length bound checked by
`assertConfig`.

The configuration contains identity, localized copy, theme colors, media,
products, offer rules, subscription cadences and market inputs. Preserve these
required settings when adding a configuration:

| Setting | Required content |
| --- | --- |
| `documents.sandbox` | An `enabled` boolean and a nonempty `providerRef` |
| `returns.reasons` | Nonempty choices with unique codes and English and Polish labels |
| `orderControls.holdReasons` | Nonempty choices with unique native hold reason codes and English and Polish labels |

Invalid document, return or hold settings refuse with
`starter_order_controls_configuration_invalid`. A control being absent from a
page does not make its configuration optional.

## Change identity and an offer rule

Edit `brand.name`, its localized `brand.strapline`, `offer.layout` (`list` or
`cards`) and `offer.minUnits`. Refresh after the build or restart. Try a selection
below the new minimum: both the builder and host admission use `validateCart`
and refuse with `minimum_units`. Do not duplicate the minimum in a click handler.
The host also validates SKU, quantity, purchase mode, cadence and accepted terms;
a stale or unaccepted terms revision refuses with `starter_terms_required`.
Changing displayed amounts cannot change the authoritative package quote or
settle a payment.

Add product images below `public/media/`, update the product's `media` and
localized `mediaAlt`, and add the file to the owned inventory. Product media
must start with `/media/`; remote product images refuse with
`starter_product_invalid`. Theme colors use the required hexadecimal color shape; invalid tokens
refuse with `starter_theme_invalid`. The starter uses system fonts.

Keep configured cadence days and their default within the native whole-day
bounds. Cart validation also bounds selected lines, units per line and the
configured total. Stock and seeded per-mode prices must fit PostgreSQL integers,
and each offered mode needs a positive price. Keep tax legal-basis text and the
trimmed, nonempty legal revision within `assertConfig`'s limits. Configuration
validation runs before composition; do not rely on browser controls to enforce
these limits.

Read the [configuration validator](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/examples/neutral-store/docs/customization.md#one-input-and-three-fragments)
and [cart validator](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/examples/neutral-store/docs/customization.md#acquisition-location-choices) for exact
text, color, cadence, cart, stock and price bounds.

## Replace a presentation fragment

Edit the `fragments` object in `owned/fragments.ts`:

Select the fragment for the offer introduction, product presentation or
checkout summary using the [fragment inventory](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/examples/neutral-store/docs/customization.md#one-input-and-three-fragments).

Each function receives `PageContext` and returns a DOM element; the card also
receives its product and the summary its quote. Keep fragments about
presentation. Hiding a button grants no authority. Use the DOM helpers' text
nodes for configuration and copy rather than interpreting them as HTML.

## Configure subscription editing

`owned/subscription-editing.ts` builds `StoreConfig.subscriptionEditing`. Change
classic minimum base units, plan choices and quantity or line bounds there.
Size-aware settings include the core minimum, allowed cadences, group and line
limits, preferred and nominal physical sizes, portion modes and factors, and
synthetic need and exclusion facts. The extra editor catalogue is installed for
servicing; it does not add a size-aware purchase flow to checkout.

Installation writes `subscription_minimum_base_units` as text in
`commerce_settings`, together with the introductory phase policy and synthetic
subject facts. The editor resolves those installed facts for the authenticated
customer and locks them when applying a change. An explicit `currentExclusions`
array takes precedence over inherited exclusions, even when empty. Do not
substitute browser-supplied facts. Demand-driven resizing refuses with
`starter_subscription_resize_unconfigured`; there is no need-entry form.

The demonstration supplies grouped variants, physical sizes, demand units,
exclusions, verified product documents and fictional stock through the native
stock writer. Replace the fictional data and fact resolvers for your own
application. Product labels and illustrative coverage are not usage advice.

## Set the support contact

Set optional `supportEmail` in the owned configuration, for example
`help@example.test`, then restart the host. Invalid input refuses with
`starter_support_email_invalid`; use a bounded ASCII email address without
whitespace, HTML or a URL scheme. Omit the field to show the unconfigured-contact
message. Both localized support pages display the value as plain text and link
to the account page; they add no email link or contact form.

## Set the public origin

For your TLS terminator, set `publicOrigin` to the external origin, such as
`https://store.example.test`. Preserve the original `Host` header. Forwarding
headers do not establish the admitted origin. Restart after an edit; setting
this field does not publish the application or provision DNS or a certificate.
The lifecycle validates configuration before starting containers and the host
validates it again on startup.

Use canonical lowercase ASCII or already encoded punycode, within the
[origin parser's input bound](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/examples/neutral-store/docs/customization.md#public-origin). A root slash and an
explicit default port normalize to the URL origin. Userinfo, whitespace,
wildcards, trailing dots, paths, query strings, fragments, other schemes and
parser repairs such as uppercase or Unicode host input refuse. Host matching
is exact, including IPv6 brackets and nondefault ports. Choose the full external
origin, including a mapped port; writes send its canonical form without a slash
or explicit default port.

Non-loopback HTTP requires `allowInsecurePublicOrigin: true`; prefer HTTPS.
The HTTP exemptions are exactly `localhost`, `127.0.0.1` and `[::1]`, without a
DNS lookup. IP literals and loopback origins on another port can be selected.
Both optional fields belong to your owned configuration.

| Refusal | Check |
| --- | --- |
| `starter_public_origin_invalid` | Invalid URL shape or input length |
| `starter_public_origin_not_canonical` | Input requires an unaccepted parser repair |
| `starter_public_origin_flag_invalid` | Insecure-origin opt-in is not boolean |
| `starter_public_origin_tls_required` | Non-loopback HTTP lacks the opt-in |
| `starter_local_host_required` | Host is absent, ambiguous or outside the selected authority |
| `starter_same_origin_required` | Ambiguous Origin, or a write without the exact Origin, `X-Starter-Request: 1` and JSON content type |

All methods other than GET and HEAD receive write admission, including paths
outside the action API. Missing, null or mismatched Origin cannot authorize a
write. A duplicate or comma-separated Origin also refuses on reads.

## Change a page or add a route

For complete layouts, checkout structure, account workflows, operator navigation
or application-specific routes, follow
[starter page ownership](../../concepts/starter-ownership.md#take-ownership-of-a-page).
Copy only the affected page, update its imports and inventory, and maintain its
security, accessibility, compatibility and future fixes yourself.

For a new `/about` route, create `owned/about.ts` with a page function accepting
`PageContext`. Take ownership of `client/main.ts` and `shared/routes.ts`, moving
their exact paths from `managed` to `owned` in `ownership.json`, and register the
new file. Add localized paths such as `/about` and `/o-nas`, dispatch, navigation
and checks for both paths. The host serves extensionless application paths.

Put a rule that fits the offer input there. For a new shared application input,
extend the type and its validator together. Report a missing package extension
seam to its owner; keep installed engines and their algorithms in the packages.

## Check preservation when upgrading

Record hashes of owned files and commit your application's customization before
upgrading. Use the installed application's upgrade procedure, then compare the
owned files, restart, and repeat a below-minimum refusal and an admitted sandbox
purchase. Record package and schema identities and the observed browser result.
Unchanged copied bytes alone do not establish working behavior. See
[Upgrade application files](../../upgrade/application-files.md).

## Protect local sessions and messages

Sessions are held in process memory; restarting loses them. The [session store](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/examples/neutral-store/host/sessions.ts)
owns expiry and capacity; a full store refuses with
`starter_session_capacity_exceeded`. Customer ownership and operator membership are rechecked against
native stores. Replace this session storage for a production application.

The demonstration captures sign-in messages privately rather than sending mail.
Read `identity.jsonl` through the application container's filesystem as its
`node` user; the [capture binding](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/examples/neutral-store/host/native-composition.ts)
defines its private location.
The [capture binding](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/examples/neutral-store/host/native-composition.ts)
creates the file with owner-only permissions. Access exposes sign-in tokens; keep it
private. HTTP serves only built assets, not the mailbox.

The separate quote-acceptance keyring is generated only for a marked
demonstration database. The same container reuses it on restart; recreation
requires fresh quotes. Supply your own private keyring with
`--quote-acceptance-key-file` outside served assets and browser configuration
when composing your own environment.

## Separate catalogue drafts from offers

The installer seeds live products, SKUs, price lists, prices and promotions.
The starter has no runtime writer for those seed inputs, and checkout promotion
codes refuse with `starter_promotion_codes_unsupported`. A human operator can
administer catalogue drafts and bundle composition, target prices and activation
through native writers. Neither draft authoring nor bundle activation adds a
product to the starter's configured storefront or checkout selection.

Replace the fictional `starter:item@1` registry and content validator in
`owned/catalogue.ts` for your application. Draft payloads cannot install
executable validators. The operator can create, revise, abandon, list and read
drafts; the host supplies the actor and command key. Provision and deactivate
support access through the [operator roster](#provision-operator-rosters).

## Replace acquisition location choices

`owned/acquisition-addresses.ts` contains fictional choice IDs, localized labels
and opaque source, reference, revision and provenance tuples. Keep IDs unique
and stable. The browser submits a choice ID, email and explicit consent; the
host selects the tuple and refuses extra fields. Applicant names are not
collected. Submission persists through the native acquisition port.

Load your own registry and onboarding through the database owner connection.
The demonstration installer admits only its install identity and marked
database. An identical tuple can be installed again; changed provenance or an
inactive row refuses with `starter_acquisition_seed_conflict` and rolls back
the transaction. Editing the list grants no runtime registry writer or delivery
qualification.

## Provision operator rosters

Activate an invited native human administrator through the operator sign-in
page first. Request a challenge with the invited email, read its token privately
from the demonstration mailbox, then redeem it in the operator token form.
The host provides no public operator bootstrap or roster writer.

From the extracted demonstration application, open the database owner connection;
never provision rosters through the runtime login:

```sh
docker compose exec -T database psql -U starter_install -d neutral_store
```

Find the activated administrator by the normalized invitation email:

```sql
SELECT p.principal_id, p.email, m.role, m.membership_state
FROM public.platform_human_principals p
JOIN public.platform_human_memberships m USING (principal_id)
WHERE lower(btrim(p.email)) = lower(btrim('operator@example.test'))
  AND m.membership_state = 'active' AND m.role = 'admin'
  AND NOT EXISTS (SELECT 1 FROM public.platform_control_operators o
                  WHERE o.principal_id = p.principal_id);
```

Require an unambiguous matching administrator and substitute its unchanged principal UUID below.
Support reads require the additional communications roster entry:

```sql
INSERT INTO public.platform_communication_operators (principal_id, active)
VALUES ('<activated-principal-id>'::uuid, true)
ON CONFLICT (principal_id) DO UPDATE SET active = true, updated_at = now();
```

Withdraw that support access through the same owner connection:

```sql
UPDATE public.platform_communication_operators
SET active = false, updated_at = now()
WHERE principal_id = '<activated-principal-id>'::uuid;
```

This roster does not grant membership or sign-in authority. The host rechecks
human membership before support access; `customer_support_read_failed` does not
identify every failure as a missing roster entry.

Hold, release and the other Commerce operator commands also require a Commerce
row for that same active human administrator:

```sql
INSERT INTO public.commerce_operators (id, label)
VALUES ('<activated-principal-id>'::uuid, 'Human administrator')
ON CONFLICT (id) DO NOTHING;
```

Never delete this row. Withdraw command authority by revoking the human
membership through the identity owner. Existing holds retain attribution to the
Commerce row; deleting it clears that attribution and can make a human
`fulfillment_exception` hold eligible for automatic release. Each command and
replay rechecks authority. A distributor or a roster row alone cannot authorize
these administrator commands.

## Run a bounded background pass

After installation, set `CONFIGURATION` to the selected owned configuration ID
and `RUNTIME_URL` to its reachable restricted runtime connection. From the
application directory, choose the pass you need:

| Command | Work selected |
| --- | --- |
| `./lifecycle renewal --configuration "$CONFIGURATION" --database-url "$RUNTIME_URL"` | Drain paid-order mail, then attempt a bounded sandbox renewal pass when enabled. |
| `./lifecycle care --configuration "$CONFIGURATION" --database-url "$RUNTIME_URL"` | Run auto-resume, subscription notices and winback when care is enabled. |
| `./lifecycle checkout-recovery --configuration "$CONFIGURATION" --database-url "$RUNTIME_URL"` | Reconcile reminders, enqueue eligible waves, expire checkouts and process recovery mail. |

These commands change the demonstration database and private message captures;
they install no timer or HTTP endpoint. An existing scheduler may invoke them.
Messages are captured locally, which does not establish delivery to recipients.

`owned/renewal.config.ts` controls renewal enablement, population, retry timing,
batch limits and leases. Renewal is disabled by default; paid-order mail still
runs in that case. Keep renewal and care lease durations within the validator's
bounds. The native job ledger and session exclusion prevent overlapping renewal
or care invocations for the same selection.

For recovery links, pass `--port` when the host uses a nondefault port;
a configured `publicOrigin` takes precedence. Care links also use that configured
origin when present. Keep the [retention and consent limits](../../reference/limits.md#subscription-care)
in view when selecting care behavior.
