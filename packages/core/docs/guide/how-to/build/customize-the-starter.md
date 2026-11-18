# Customize the starter store

Change the starter's identity, presentation and offer rules in your application.
Start with owned configuration and fragments; take ownership of a page when the
change reaches its structure or workflow.

## Prepare the application

Start from the 1.1.0 demo store (`openlup/demo-store` on GitHub) or use
release-matched starter inputs when available. The starter is separate
application source that you can customize in your own repository.

For the historical **0.43.0 starter recipe** below, use Node 24, npm 11.19.0,
Git, curl and tar. Start in a directory with no application named `my-store`.
The extractor refuses a nonempty destination.

This historical recipe selects the 0.43.0 source commit
`6facc3e72441ade5813397f65ac7edbe34fd1d0f` and the manifest/lock pair from input commit
`87dadb251b27b72a18718b08ac39951dd4f1fdd0`. The inputs were added after the release;
they are ordinary public source files, not release assets. Keep the pair and
source revision together. No author checkout, workspace install or package
packing is needed.

Use the [repository's released-starter entry](https://github.com/openlup/openlup/blob/openlup-core-v1.2.0/examples/neutral-store/README.md#start-from-an-exact-source-archive)
for the download commands in `examples/neutral-store/README.md`, under “Start
from an exact source archive”. Those commands download the exact source archive
and both inputs at the commits above. In the download directory, after unpacking
the archive, run:

```sh
node openlup-6facc3e72441ade5813397f65ac7edbe34fd1d0f/examples/neutral-store/extract.mjs ../my-store \
  --mode released --set-version 0.43.0 \
  --source-revision 6facc3e72441ade5813397f65ac7edbe34fd1d0f \
  --manifest manifest.json --lockfile starter-package-lock.json
cd ../my-store
npm ci
```

The extractor copies only owned and managed files, materializes `AGENTS.md` and
creates an independent Git repository with an initial commit. It pins the exact
npm set and commits the supplied lock unchanged. `.starter-origin.json` must
record `mode: released`, `setVersion: 0.43.0` and the source revision above;
archive revision verification is recorded as `supplied`. Extraction checks the
manifest revision, complete package set, npm integrities and lock root, but does
not verify archive origin or package provenance. Follow the
[adoption identity checks](../../start/adopt-from-npm.md#compare-at-first-adoption-and-upgrade)
for those separate obligations.

The release preflight also uses candidate extraction with retained, complete
local packs verified by their manifest and SHA-256/SHA-512 digests. That mode
admits local resolutions only for the verified set entries and records
`candidate, local digest-verified`; it does not weaken the released recipe
above or establish published provenance.

A mismatch refuses with `starter_release_*`; a nonempty destination refuses
with `starter_extract_directory_not_empty`. Stop and check the selected source
and input pair. Do not silently replace them with local tarballs, regenerate the
lock or switch to candidate mode. The source archive and installed 0.43.0 docs
retain their original instructions; use this recipe for acquiring this pair.
Local candidates belong to the source starter README's separate contributor
workflow; they do not replace these released inputs.

## Run the local demonstration

For a database-backed demonstration, install Docker with Compose and run from
the prepared application directory:

```sh
./lifecycle up
```

This builds the image, starts PostgreSQL, applies the packaged migration history
and fictional seed, then serves the application at `http://127.0.0.1:4319`.
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
and `--port` to select your configuration and listener; the [host CLI](https://github.com/openlup/openlup/blob/openlup-core-v1.2.0/examples/neutral-store/host/server.ts)
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
owned registry in `owned/store.config.ts`, which exports `configurations`,
`defaultConfigurationId` and `selectConfiguration`. The host and
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
| `returns.reasons` | Nonempty choices with unique codes and labels for every configured locale |
| `orderControls.holdReasons` | Nonempty choices with unique native hold reason codes and labels for every configured locale |

Invalid document, return or hold settings refuse with
`starter_order_controls_configuration_invalid`, except a missing or blank
return or hold label for a configured locale, which refuses with
`starter_locale_copy_missing`. A control being absent from a
page does not make its configuration optional.

In the 1.2.0 starter, set `market.locales` and `market.defaultLocale`
in `owned/market.config.ts`, composed by `owned/store.config.ts`; the starter
derives its `Locale` type and required copy locales from this registry. The list
must be nonempty and unique (`starter_locales_invalid`), use only platform-supported
`en`/`pl` (`starter_locale_unsupported`), and contain the default
(`starter_default_locale_invalid`). Supply every configured locale in UI, product,
email and notice copy; startup refuses missing or blank text with
`starter_locale_copy_missing`, naming the key and locale. A Polish-only registry
`{ locales: ['pl'], defaultLocale: 'pl' }` works; requests fall back to the configured
default, and notice preferences outside the list do too. Restart after editing.
Adding a platform language requires a separate audit of durable SQL constraints.

## Keep business configuration owned

In the 1.2.0 starter, set
`subscriptionCreation: { editWindowHours: 72 }` in `owned/store.config.ts` to
choose the edit cutoff for newly activated subscriptions. Startup requires an
integer from 1 through 720 and refuses with
`starter_subscription_creation_invalid`; the supplied default is 72. Ordinary
checkout, acquisition and recovered checkout activation pass this trusted host
value, including when it equals 72, so the starter opts in to the new SQL
functions and their EXECUTE requirement. It freezes on each subscription row,
so changing configuration leaves existing subscriptions unchanged.
See [activation and edit windows](../../concepts/subscriptions.md#freeze-the-edit-window-at-activation)
for the required native migration and cutoff semantics.

The source starter also owns `checkoutRecoveryReminders` in `owned/store.config.ts`:
abandoned-cart stages default to `first` at 1h, `gentle` at 24h and `last` at 72h;
checkout recovery defaults to `first` at 1h and `last` at 20h. The explicit
installation step installs this schedule; startup reads it and refuses
`starter_installed_policy_drift` on revision, stage or hour differences. After
editing, deliberately reinstall before starting. See [reminder stages and
hours](checkout-recovery.md#install-reminder-stages-and-hours) for the 1.2.0
migration, runtime grant and independent checkout-window limits.

In the current source candidate, keep one owned configuration entry per domain,
such as `owned/renewal.config.ts` or `owned/quote.config.ts`, and compose it in
`owned/store.config.ts`. Browser and host read that same input. Managed policy
helpers hold selection and validation mechanics, with business values in owned
files. `shared/policy.ts` supplies `set`, `range` and text `choice(default, ...allowed)`;
`assertChoice` checks a nonempty, duplicate-free subset of the domain vocabulary
whose default belongs to that subset. These helpers remain starter-local.

Use static data for maps, sets, ranges, windows and ladders. Use a side-effect-free
callback only for an algorithm that normalizes or refuses input; it must not
authorize, write or read mutable state. Keep such callbacks in an owned module
imported by the host, outside `StoreConfig`. Each domain assertion runs once
from `assertConfig` at startup and refuses invalid data or unsupported database
bounds with a named error code.

For saved-address formats in the 1.2.0 starter, edit
`savedAddressValidation` in `owned/acquisition-policy.ts`, already imported by
the host. Its `local` callbacks accept fictional postal codes with two letters
followed by four digits and phones with eight digits for the configured country
(`ZZ` in the demonstration).
Keep those algorithms outside `StoreConfig`; the platform retains country
aliases, length bounds, foreign formats and field messages. Callback throws
refuse the affected field. See [saved-address policy and defaults](../../concepts/starter-ownership.md#saved-addresses-billing-and-preferences).

## Configure cancellation offers

In the current source candidate, edit `subscriptionCare.retention` in
`owned/renewal.config.ts`, composed through `renewal` in `owned/store.config.ts`:

```ts
const retention = {
  offerByReason: { too_much_product: 'skip', delivery_issue: 'reschedule' },
  defaultOffer: 'pause',
} as const;
```

These defaults preserve the starter's existing offers. Every other configured
reason uses `defaultOffer`. Keys must belong to `retentionReasons`; values and
the default must be `skip`, `reschedule` or `pause`. `assertRetention`, called
from `assertConfig`, refuses unknown keys or kinds with
`starter_retention_configuration_invalid`. The browser uses the same map for
the displayed offer and its submitted kind. Reason codes, accepted-offer IDs
and native command authorization keep their existing meaning.

## Configure account actions and pauses

In the 1.2.0 starter, `renewal.subscriptionCare` is composed from
`owned/renewal.config.ts`. Its `actions.active`, `actions.paused` and
`actions.cancelled` lists choose account controls; `whilePaymentBlocked` and
`whilePaymentExpired` narrow those choices during payment recovery. Use only
`skip`, `slide`, `order_now`, `pause`, `cancel`, `resume` and `reactivate`.
Empty lists disable choices. Unknown or duplicate actions and missing lists
refuse startup with `starter_subscription_actions_invalid`.

Set `pausePresets` with the starter-local `choice(default, ...allowed)` helper.
The native preset vocabulary is `2_weeks`, `1_month` and `indefinite`; durations
still come from owned lifecycle `terms`. `assertChoice` refuses an empty,
duplicate or unknown selection, or a default outside it, with
`starter_pause_presets_invalid`. Both pause forms offer `allowed`. The account
pause form preselects `default` (`2_weeks` in the demonstration); the
cancellation save offer preselects `retention.pausePreset` (`1_month`), which
must be allowed and falls back to `default` when omitted.

The managed host binds the same data through
[command admission](../../concepts/subscriptions.md#admit-account-commands).
Fresh disabled actions throw `starter_subscription_action_not_admitted` and
unavailable presets throw `starter_pause_preset_not_admitted` before any write;
the host returns these named refusals. Completed matching receipts replay even
after you remove a choice. Restart after changing owned configuration; no
installation write is needed. Keep managed host, shared and account-page files
unchanged when customizing these values.

Native state and payment fences still apply. Reactivation keeps its own payment
and confirmation checks and remains available for a cancelled subscription
despite historical account payment messages. The starter's saved-address
selector is a separate port, outside this action vocabulary. No skip-count
limit is introduced.

## Configure subscription offers

In the current source candidate, edit `subscriptionOffers` in
`owned/store.config.ts`. The released archive above retains its original behavior;
these additions need the matching source candidate and admission ports.
The managed `shared/policy.ts` helper accepts sets and stepped ranges:

```text
{ days: set(28, 56), defaultDays: 28, minimumBaseUnits: 6,
  checkoutMinimumBaseUnits: 1, maximumUnits: 120,
  maximumBaseLines: 6, maximumAddonLines: 12,
  bySku: {
    'SAMPLE-A': [{ days: set(28), quantities: set(1, 2) },
      { days: set(56), quantities: set(2, 4) }],
    'SAMPLE-B': [{ days: set(28, 56), quantities: range(1, 99, 1) }],
  } }
```

Each line must satisfy both the plan's cadence domain and its concrete SKU rule.
List each variant explicitly; missing rules refuse. Overlapping cadence rules
and defaults outside the domain refuse configuration. Optional `checkoutDays`
and `preferredDays` distinguish acquisition choices and visible recommendations
within `days`. Defaults and recommendations never grant admission. One-time
purchases keep their own purchase-mode and cart limits.

Startup accepts `offer.maxUnits` up to 100 and each SKU quantity domain up to
99; exceeding either refuses with `starter_units_above_representation`.
In each subscription offer, `maximumBaseLines + maximumAddonLines` may total
50; exceeding it refuses with `starter_lines_above_representation`.
These are fixed [representation bounds](../../reference/limits.md#quantity-and-line-representation);
choose lower business limits in owned configuration. Completed receipts and
paid-order reads remain valid after those limits are lowered.

The same input derives checkout choices, editor candidates and quantity controls,
and admits the full resulting set through the classic, exact and sized ports.
Changing cadence preserves quantities. Existing active commitments remain as
agreed; completed matching receipts replay before fresh offer admission. New
commands still require current rules, authentication, locks and quote/fact guards.
Graduation retains its own cadence and must admit the purchased lines separately.

Reapply the demonstration installation and restart after changing the servicing
minimum; runtime admission refuses installed-minimum drift. The current source
starter admits whole-day cadences from 1 through `MAX_CADENCE_DAYS` (3660).
Apply the complete native catalogue, including
`20261122190000_subscription_cadence_bound.sql`, before using longer cadences.
This forward is unreleased; use the matching installed package's migration guide.

## Compose shipping quotes

In the current source candidate, `owned/quote-shipping.ts` owns shipping quote
composition. The released 0.43.0 archive above retains its original managed
composition; use the matching candidate for this hook. `host/quote-composition.ts`
calls the typed factory and stays managed, as does `shared/config.ts`.

The default factory wires `createQuoteShippingPromotions` to the host's promotion
ports and the shipping policy from `offer.shippingMinor`,
`offer.freeShippingFromMinor` and `quote.policy.effectiveFrom`. The free threshold
uses the product amount after discounts. The quote retains shipping terms for
acceptance and later delivery pricing.

Keep carrier configuration and clients in the owned server file or its
application-owned adapters. Read credentials from private runtime inputs there;
never commit their values or expose them to the browser. The starter request
carries destination input in `request.checkout`; validate its country and resolve
trusted weight facts before carrier I/O. To mount a resolver, set the factory's
`resolver` default to your application resolver using its `config` and `deps` arguments.
Its typed return binds the existing public `resolveQuoteShippingPromotions`
callback; no managed-source copy or shared configuration extension is needed.
That callback replaces shipping **and** promotion evaluation. Compose the
automatic and code policies, free threshold and retained shipping/acquisition
terms deliberately; returning a carrier fee alone drops those policies.
`ShippingRateDataPort` manages an administrative flat rate and audit, not a
carrier quotation. See [carrier quote composition](../extend/provider-adapters.md#quote-a-carrier-shipping-rate-by-weight-at-checkout)
for the public contract and trusted destination/weight responsibilities.

From the extracted application with its selected packages installed, run
`node --experimental-strip-types --test test/quote-shipping.test.ts`.
Keep its frozen default transcript unchanged when relocating composition.
An offline adapter must prove the rate
in the final total for both purchase modes and refuse an unsupported country
before any carrier or data-port call in its resolver. The public quote engine
reads catalogue and prices before invoking this hook; that resolver witness
does not establish zero database reads for the whole checkout request.

## Compose post-renewal policy

In the current source candidate, `owned/renewal-policy.ts` is the second and last
owned composition hook, beside shipping. Edit its exported `renewalPolicy`
callback to select application policy after native renewal and retry work.
The released 0.43.0 archive retains its original managed composition; use a
matching candidate for this hook. `host/renewal-job.ts` and
`host/scheduled-renewal.ts` stay managed.

The default callback does nothing: it adds no query, pause or other business
effect. Renewal remains disabled until selected in `owned/renewal.config.ts`.
The scheduled host supplies `db` (the session holding population exclusion),
`result` (the completed native pass), `createCommands` (the public
`createPostgresSubscriptionCommands` factory) and `withTransaction` (a lazy
transaction on that same session). These are trusted server dependencies,
never request fields. The hook runs under both the population advisory lock
and ledger claim, before `finishJobRun`.

For pause after exhaustion, copy the complete transaction-bound
[`owned/renewal-policy.ts` recipe](../../concepts/subscriptions.md#pause-a-subscription-after-failed-renewal-retries-are-exhausted),
derived from the PostgreSQL witness `neutralStoreRenewalPolicy.test.ts`.
It includes native lock order, durable recheck, replay keys and refusal rollback.
Authorize candidate selection through trusted application evidence. The
population lease does not fence customer recovery; a native pass result or a
null retry alone cannot authorize a pause. Read the
[retry-timing boundary](../../concepts/subscriptions.md#durable-retry-timing)
before selecting a cadence: `retryBackoffHours` reaches fresh native failure
recording, while provider-result recording still uses the SQL default ladder.

An exception escapes the hook and marks the run failed; native work already
committed before the hook remains committed. A later run can retry the policy.
Keep provider execution and SQL definition changes outside this callback.

From the extracted application with selected packages installed, run
`node --experimental-strip-types --test test/renewal-policy.test.ts test/renewal.test.ts`.
Keep a frozen default run transcript and query count. Add local PostgreSQL
witnesses for actual pause, command replay, concurrent repair/recheck and
refusal rollback when composing your application policy. Mocks do not
establish those transaction and locking guarantees.

## Change identity and an offer rule

Edit `brand.name`, its localized `brand.strapline`, `offer.layout` (`list` or
`cards`) and `offer.minUnits`. Refresh after the build or restart. Try a selection
below the new minimum: both the builder and host admission use `validateCart`
and refuse with `minimum_units`. Do not duplicate the minimum in a click handler.
The host also validates SKU, quantity, purchase mode, cadence and accepted terms;
a stale or unaccepted terms revision refuses with `starter_terms_required`.
Changing displayed amounts cannot change the authoritative package quote or
settle a payment. A valid selection below the minimum stays in the browser cart
across reloads and storage updates. It remains ineligible for checkout until
the minimum is met; saved selection state is not an order quote.

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

Read the configuration validator in `shared/config.ts`
and cart validator in `shared/offer.ts` for exact
text, color, cadence, cart, stock and price bounds.

## Replace a presentation fragment

Edit the `fragments` object in `owned/fragments.ts`:

Select `offerIntro`, `productCard` or `checkoutSummary` for the offer introduction,
product presentation or checkout summary.

Each function receives `PageContext` and returns a DOM element; the card also
receives its product and the summary its quote. Keep fragments about
presentation. Hiding a button grants no authority. Use the DOM helpers' text
nodes for configuration and copy rather than interpreting them as HTML.

## Configure subscription editing

`owned/subscription-editing.ts` derives `StoreConfig.subscriptionEditing` from
the owned subscription offers above. Keep physical-size preferences, portion modes
and synthetic need/exclusion facts in that file. The extra editor catalogue is installed for
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

## Edit a customer subscription

Open the appropriate editor from the signed-in customer's subscription card.
In the classic editor, change exact base quantities or add selectable base
products. Remove an agreed extra, then use its restore control to put it back
at its saved quantity. The minimum banner and edit-window, payment and cycle
notices explain why a change cannot proceed.

Choose review before confirming. Review shows the server's current and new
recurring prices, their signed difference and the effective next-cycle date.
Confirmation submits the whole desired set with the accepted quote and then
reads the account again. The recurring price applies from the shown cycle;
it excludes the one-time introductory promotion.

A classic customer can enter the size-aware invitation without changing the
subscription. Even unchanged contents require priced review and explicit opt-in
consent. Leaving the invitation keeps classic servicing. In the size-aware
editor, select a group's exact size for its full count, change counts separately,
or change cadence while keeping counts. Repair conflicting selections before
review. The coverage summary uses synthetic fixture units and gives no usage advice.

Refreshing the size-aware catalogue clears confirmation while retaining
recoverable quantities. Review the refreshed selection again before applying.
After an uncertain save, read the account before requesting another preview;
a failed response alone does not establish whether the change committed.
The size-aware editor attempts that readback and blocks review until it succeeds.
The classic editor clears its review after an error; return to the account and
check the saved subscription before retrying an uncertain result.

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
origin parser's 256-character input bound. A root slash and an
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

Sessions are held in process memory; restarting loses them. The [session store](https://github.com/openlup/openlup/blob/openlup-core-v1.2.0/examples/neutral-store/host/sessions.ts)
owns expiry and capacity; a full store refuses with
`starter_session_capacity_exceeded`. Customer ownership and operator membership are rechecked against
native stores. Replace this session storage for a production application.

The demonstration captures sign-in messages privately rather than sending mail.
Read `identity.jsonl` through the application container's filesystem as its
`node` user; the [capture binding](https://github.com/openlup/openlup/blob/openlup-core-v1.2.0/examples/neutral-store/host/native-composition.ts)
defines its private location.
The [capture binding](https://github.com/openlup/openlup/blob/openlup-core-v1.2.0/examples/neutral-store/host/native-composition.ts)
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
batch limits and leases. Startup requires exactly three `retryBackoffHours`
entries or refuses with `starter_database_retry_budget`: database guards exhaust
on attempt four. This does not install a provider ladder; provider-recorded
failures retain the SQL default `[24,72,168]` hours described under
[durable retry timing](../../concepts/subscriptions.md#durable-retry-timing).
Renewal is disabled by default; paid-order mail still
runs in that case. Keep renewal and care lease durations within the validator's
bounds. The native job ledger and session exclusion prevent overlapping renewal
or care invocations for the same selection.

For recovery links, pass `--port` when the host uses a nondefault port;
a configured `publicOrigin` takes precedence. Care links also use that configured
origin when present. Keep the [retention and consent limits](../../reference/limits.md#subscription-care)
in view when selecting care behavior.

In the 1.2.0 starter, own `inventory.renewalProtection` in
`owned/store.config.ts` (`{ revision: 'starter-1', renewalProtectionDays: 14 }`
in each demo configuration). Its explicit installation step installs that policy;
application startup only reads it and refuses with `starter_installed_policy_drift`
when either the revision or days differ. Change the owned value, deliberately run
the installation step with installation authority, then restart. An absent database
key has revision `default`, so it does not match `starter-1` until installed.
See [native stock priority](../../concepts/checkout.md#native-stock-priority) for
validation, privileges and the request horizon contract. This 1.2.0 addition
does not alter the historical 0.43.0 recipe above.
