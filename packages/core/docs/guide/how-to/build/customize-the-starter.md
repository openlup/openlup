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

Use the [repository's released-starter entry](https://github.com/openlup/openlup/blob/openlup-core-v1.3.0/examples/neutral-store/README.md#start-from-an-exact-source-archive)
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
To use another free local port, export `OPENLUP_STARTER_PORT=4320` in the shell
that runs `./lifecycle up` and `npm run catalogue:apply`. Use a decimal port
from 1024 to 65535. With the default origin, exclude [ports blocked by Fetch](https://fetch.spec.whatwg.org/#port-blocking).
An unset or empty value uses 4319. A Compose-only `.env`
value does not configure either lifecycle command. Use a separate application
directory, `COMPOSE_PROJECT_NAME`, and port for each concurrent demo.
A configured `publicOrigin` still governs request authority.

The runtime credential file must stay in owner-only configuration. The starter
validates it at start. The adopter-owned `.context/compose-project` file
reserves the selected project for this directory. To switch projects, run
`./lifecycle down` for the recorded project to clear the record, then start
the new project. From a running application's directory, load the recorded
name before running the local Compose commands below.

```sh
PROJECT=$( (cd .context && cat compose-project) 2>/dev/null) && [ -n "$PROJECT" ] ||
  { printf '%s\n' 'Run ./lifecycle up first.' >&2; exit 1; }
```

Use `./lifecycle up --json` for the final installation report on stdout. Progress
goes to stderr. The report lists adopter packs as `installed` or `unchanged`.
On a refusal, `packs: []` means there is no confirmed install report. The SQL
transaction may already have committed.
Use `./lifecycle refusals` or `./lifecycle refusals --json` to look up remedies.
Restore a missing rules bundle before rerunning the
[pack installation recipe](../extend/catalogue-extension.md#install-a-pack-in-the-starter).
For a disposable demonstration with damaged storage, see
[Reset an interrupted first install](#reset-an-interrupted-first-install).
`./lifecycle down` stops the project while preserving its data. Use the demo’s
Compose file for local operation only.
Use fictional contacts and `.test` addresses. A healthy configuration response
does not establish a completed purchase; read the [starter limits](../../reference/limits.md).

For a database-free presentation preview, run:

```sh
npm run build
node --experimental-strip-types host/server.ts
```

This host does not compose the database-backed actions. Pass `--configuration`
and `--port` to select your configuration and listener; the [host CLI](https://github.com/openlup/openlup/blob/openlup-core-v1.3.0/examples/neutral-store/host/server.ts)
owns their defaults. Stop with Ctrl-C before reusing the port. Use the
[edit loop](#edit-and-refresh) while changing the presentation.

## Database login

Save the existing Compose project name before stopping the application. Follow
the [adjacent-release starter upgrade](../../upgrade/README.md#starter-upgrade-order)
and reconcile locally changed Compose or installation files. Run the updated
`./lifecycle up` with `COMPOSE_PROJECT_NAME` set to the saved name to provision the
runtime credential with the existing database volume. Verify application health.
If startup reports a credential-source problem, restore access to the private
project credential and retry with the same project and volume. Run connected
settings and the local renewal, care, and checkout recovery jobs through the
recorded project.

To rotate the runtime credential, first load `PROJECT` from
`.context/compose-project` as shown above. Use an exclusive maintenance window.
Keep the same port and configuration if you set them for the original startup.

```sh
COMPOSE_PROJECT_NAME="$PROJECT" ./lifecycle down &&
  rm -- "$HOME/.local/state/openlup/neutral-store/$PROJECT/runtime-password" &&
  COMPOSE_PROJECT_NAME="$PROJECT" ./lifecycle up
```

Verify application health and a fresh database read. If startup fails after
updating the database, retry with the updated starter and the same volume.

## Reset an interrupted first install

An interruption after database creation but before its demonstration marker is
written leaves an unmarked database. Startup refuses with
`starter_seed_demonstration_database_required` rather than adopting it.
From its application directory, set `PROJECT` to the exact name selected for
the failed startup. Read `.context/compose-project` if it exists. The example
uses the default name. Substitute the name selected for a custom project.

```sh
PROJECT=neutral-store
COMPOSE_PROJECT_NAME="$PROJECT" ./lifecycle down
docker compose --project-name "$PROJECT" down --volumes
COMPOSE_PROJECT_NAME="$PROJECT" ./lifecycle up
```

The volume removal destroys all data in that demonstration project. A fresh
startup creates and marks a new demonstration database. Use this procedure
only with the owner's approval for a disposable demonstration, including
when correction of an invalid seed issuer changes its retained digest.

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

## Set seeded product physical facts

In `owned/store.config.ts`, set each seeded product's `physical` field to its
original gram weight and primary unit identifier.

```ts
import type { CatalogQuantity } from '@openlup/core/catalog';

const physical = {
  netContent: { dimension: 'mass', unit: 'openlup:g', unscaled: '250', scale: 0 } satisfies CatalogQuantity,
  primaryUnitIdentifier: { scheme: 'gs1:gtin', issuer: 'demo', value: '0000000000017' },
};
```

Use a decimal digit string for `unscaled`, from `'1'` through `'2147483647'`,
with no leading zero. Supply a valid GTIN check digit and keep all authored
digits, including leading zeros. The issuer must contain 1 to 240 UTF-16
code units with no surrounding whitespace, NUL or unpaired surrogate.
In `owned/subscription-editing.ts`, use the same gram range as a number for
each editor catalogue `physicalSize`.

Both physical-fact findings identify the affected SKU as Subject.

During upgrade, replace a pristine `owned/store.config.ts` with the candidate
copy. In a customized file, convert each old `netWeightG`, `unitGtin` and
`issuer` in place using the shape above. Keep the weight, GTIN digits and
issuer exactly as authored where the values satisfy the new domain. The
installer projects these inputs into the existing product documents, so an
unchanged entry can replay against the retained document.

For `OPENLUP_E_STARTER_PRODUCT_PHYSICAL_INVALID`, migrate the relevant entry
and correct its values from verified facts. If correcting the issuer changes
a retained digest, see [Reset an interrupted first install](#reset-an-interrupted-first-install)
for an owner-approved rebuild of that disposable demo in the same Compose
project. The procedure removes all data in the demo volume. For
`OPENLUP_E_STARTER_SYNTHETIC_PHYSICAL_SIZE_INVALID`, correct the named SKU's
`physicalSize` from the verified whole-gram size. Restart and recheck
`/api/config` after either repair.

## Make the store ready to publish

Run `./lifecycle up` for the marked demo. The installer preserves its base
prices and closes the exact old explicit subscription entries, retaining their
history. On a fresh demo, it seeds the bases and the subscription policy.
Checkout derives the same subscription unit prices from that policy. The
installer also installs the one-time bundle and tries to register the starter
catalogue watchdog control-plane principal. The database-backed host starts
the promotion claim sweep and watchdog in the background. It continues serving
requests when either job is unavailable. Allow the initial pair to finish
before trying Publish.

A fresh marked demo passes Publish readiness when both jobs provide current
evidence. A price refusal on a retained demo can mask a sweep or watchdog
refusal. Recheck after repairing the price list.

For an unmarked installation, the owner can register the non-human watchdog
principal from the installed starter using the authenticated installer
`psql` connection. Set `configuration` to the owned configuration ID.

```sh
configuration=coffee
if principal_id="$(node --input-type=module -e '
  import { selectConfiguration } from "./owned/store.config.ts";
  import { catalogueWatchdogPrincipalId } from "./host/catalogue-readiness-jobs.ts";
  process.stdout.write(catalogueWatchdogPrincipalId(selectConfiguration(process.argv[1])));
' "$configuration")"; then
psql -X -v ON_ERROR_STOP=1 -v principal_id="$principal_id" <<'SQL'
BEGIN;
INSERT INTO public.platform_control_operators (principal_id, active)
SELECT :'principal_id'::uuid, true
WHERE NOT EXISTS (
  SELECT 1 FROM public.platform_human_principals WHERE principal_id=:'principal_id'::uuid
)
ON CONFLICT (principal_id) DO NOTHING;
SELECT principal_id AS verified_principal
FROM public.platform_control_operators
WHERE principal_id=:'principal_id'::uuid AND active
  AND NOT EXISTS (
    SELECT 1 FROM public.platform_human_principals WHERE principal_id=:'principal_id'::uuid
  )
\gset
COMMIT;
SQL
else
  printf '%s\n' 'Could not resolve the watchdog principal. Check the configuration ID.' >&2
  false
fi
```

An inactive principal or a human identity collision stops the recipe. Ask the
control-plane owner to reconcile that identity before rechecking. For
`starter_price_seed_conflict`, restore the original owned price, discount and
rounding inputs if you changed them after seeding. Ask the pricing owner to
reconcile divergent retained rows, close other active or open explicit rows,
or withdraw pending rows while preserving price history. You can also rebuild
a disposable demo. Use `./lifecycle up --json` or `./lifecycle refusals` for
the remedy. For `starter_promotion_seed_conflict`, ask the promotion owner to
reconcile the retained demo data, then rerun the installer.

For a Publish refusal at `pricing.readiness`, follow its fix and recheck.
Use these steps for the marked demo.

| Reason | Starter step |
| --- | --- |
| `bundle_5_policy_invalid` | Run `./lifecycle up` to install the marked demo bundle. Ask the promotion owner to reconcile conflicting retained definitions before rerunning it. |
| `catalog_1490_legacy_1340_invalid` | Verify the effective list and each eligible SKU’s base and subscription prices with the pricing owner. |
| `promotion_claim_sweep_not_ready` | Verify `promotion-claim-sweep` is enabled with the `scheduler` driver. Wait for the next scheduled tick on the database-backed host and verify a successful run. |
| `promotion_watchdog_not_ready` | Verify the starter catalogue watchdog control-plane principal using the recipe above. Repair any failed jobs using the table below and verify a healthy watchdog run. |

For failed job names in `promotion_watchdog_not_ready`, load the recorded
project name and set `CONFIGURATION` to the matching owned ID.

| Failed job | Action |
| --- | --- |
| `subscription-renewal:<owned-population>` | `docker compose --project-name "$PROJECT" exec -T application ./lifecycle renewal --configuration "$CONFIGURATION"` |
| `subscription-care:<id>` | `docker compose --project-name "$PROJECT" exec -T application ./lifecycle care --configuration "$CONFIGURATION"` |
| `starter-checkout:<id>` | `docker compose --project-name "$PROJECT" exec -T application ./lifecycle checkout-recovery --configuration "$CONFIGURATION"` |
| `promotion-claim-sweep`, `platform-watchdog` | Wait for the next scheduled tick on the database-backed host. A restart starts an initial tick. |

For a nondefault local port, add `--port "$OPENLUP_STARTER_PORT"` to `care`
and `checkout-recovery` so locally generated links use that port. A configured
`publicOrigin` takes precedence.

Run an auxiliary job still in use until its latest ledger status is
`success`. Ask the job owner to identify failures with no reported name or
an ambiguous renewal population. Only the job owner can disable the exact
ledger control for a retired job or a job disabled in owned configuration.
For `job_disabled` or `inactive_driver` on the sweep or watchdog, the job owner
checks ownership and lease state before restoring enablement or assigning
`scheduler`.

If a restart interrupted a job, the first tick may skip it while the previous
lease expires. The lease lasts up to five minutes. Look for fresh evidence
after the next scheduled run.

After the repair, wait for a successful tick.
Recheck by sending the same approved Publish body and command key while the
approval, draft and head still match. Sweep evidence must be successful
within 15 minutes and watchdog evidence must be healthy within six hours.

## Show published products in the starter

Set `presentation.title` in the builder input or `product.sharedContent.presentation.title`
in a saved draft to a nonblank product name. Use the optional `shortName` map for
localized display names. The starter uses the title when
a locale has no short name. Set `mediaRef` to a local `/media/` filename to
show an image with the display name as its alt text. Start the filename with
an ASCII letter or digit and use only letters, digits, dots, underscores and
hyphens thereafter. Omit `mediaRef` to show the product without an image.

For example, use this presentation for an article with an English short name
and an existing starter image.

```json
{
  "title": "Published article",
  "shortName": { "en": "Article with image" },
  "mediaRef": "/media/collection.svg"
}
```

The platform also admits `routePath`, `advertisedWeightsG` and `accent`.
The starter uses its own product routes and display layout. Treat all
authored presentation fields as public.

After activation into `classic`, open the catalogue and select a SKU. Reload
its product URL with `?sku=<encoded SKU>`, add it to the cart and check the
same SKU and currency in the server quote. See the [published catalogue limits](../../reference/limits.md#published-starter-catalogue-limits)
for capacity and document schema.

Published SKUs need one-time selling enabled and a positive tax-inclusive
one-time price in the market currency. The starter excludes a SKU without
one-time selling with `starter_catalogue_one_time_required`. The shipped home
and catalogue cards show the one-time amount in either cart mode. The product
and cart use the server quote for the selected mode.

If you copied an earlier managed storefront page into application source,
reconcile its product selection and cart with the installed version. Keep the
SKU query parameter in localized links, preserve the saved SKU through a failed
read and verify the server's SKU, quantity and currency before showing amounts.
Owned `productCard(context, product)` customizations still receive a `Product`.
Use the exact localized `productPath(product.slug, context.locale)` as the card's
anchor `href` so the starter can append `?sku=<encoded SKU>`.

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

Before editing a business setting, search platform and starter keys by goal by
passing `list --goal "<goal>"` to your starter's `settings` script (or running
`./node_modules/.bin/openlup settings --app ./owned/settings-host.ts list --goal "<goal>"`)
and inspect the key's owner, schema and frozen-record rules. After editing owned
configuration, pass `check --configuration <id>` to the same script to validate
the change offline before restarting or running full tests. See
[Configure settings](../operate/configure-settings.md) for discovery, check,
preview and MCP usage.

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

In starter releases from 1.1.0 onward, keep one owned configuration entry per domain,
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

Edit `subscriptionCare.retention` in `owned/renewal.config.ts`. Run
`npm --silent run settings -- show renewal.subscriptionCare.retention --json`
in your extracted app to see the effective policy and the source location.

Omit `offerPresentation` for `ask_permission_first`. After a customer chooses
Yes, the native account requests one offer of the configured `defaultOffer`
kind (`skip`, `reschedule`, or `pause`). Set `offerPresentation: 'off'`
to turn off the prompt. Use `retentionReasons` for optional reason-only
feedback after cancellation in either mode. Keep `offerByReason` for any legacy
composition that uses it. Its keys must still belong to `retentionReasons`.

The native server returns the eligible pause presets with their configured
durations. It falls back to the first admitted choice when the preferred one
is unavailable. Reschedule adds `rescheduleOfferDays` in UTC days to the exact
retained date and offers the result only within the current slide bounds.
A save offer requires dates in 1970–9999. The offer path also limits its timing
operands to 36,500 days, 1,200 months and 876,000 edit-window hours. Existing
values above those limits can stay in your settings. For those values the
account receives no offer.

Cancel stays available for active and paused subscriptions, including during
dunning, independently of the configured action lists. Native payment and
lifecycle fences continue to apply. A lost response can be recovered with the
original request and key. If feedback reports
`starter_cancel_feedback_setup_required`, apply the native forward or restore
the runtime's permission to execute the feedback routine, then retry feedback.

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
`starter_pause_presets_invalid`. The ordinary pause form preselects `default` (`2_weeks` in the demonstration).
If set, `retention.pausePreset` must belong to `allowed`. The native save offer
uses that choice or the ordinary default, subject to the offer admission above.

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

In starter releases from 1.0.0 onward, edit `subscriptionOffers` in
`owned/store.config.ts`. The released archive above retains its original behavior;
these additions need the matching starter release and admission ports.
Since 1.1.0, the managed `shared/policy.ts` helper accepts sets and stepped ranges:

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
minimum; runtime admission refuses installed-minimum drift. Since 1.1.0, the
starter admits whole-day cadences from 1 through `MAX_CADENCE_DAYS` (3660).
Apply the complete native catalogue, including
`20261122190000_subscription_cadence_bound.sql`, before using longer cadences.
Use the matching installed package's migration guide.

## Compose shipping quotes

Since 1.0.0, `owned/quote-shipping.ts` owns shipping quote
composition. The released 0.43.0 archive above retains its original managed
composition. Use the matching starter release for this hook. `host/quote-composition.ts`
calls the typed factory and stays managed, as does `shared/config.ts`.

The default factory wires `createQuoteShippingPromotions` to the host's promotion
ports and the shipping policy from `offer.shippingMinor`,
`offer.freeShippingFromMinor` and `quote.policy.effectiveFrom`. The free threshold
uses the product amount after discounts. The quote retains shipping terms for
acceptance and later delivery pricing. To retain the threshold when reusing the
quote helper in a replacement resolver, supply the `commerceSettingsPort` with
the threshold in its shipping policy.

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

## Validate a checkout destination

Use `destinationV2Capabilities` from `@openlup/platform/commerce/server/destinations`
with the host rail and actual installation and issuance state. Readiness
discovery must use the same registry that runs privacy operations: set up the
[personal-data contributor registry](../../concepts/personal-data.md#personal-data-coverage)
with `destination-receipts` and `destination-documents` as required contributors
and pass it as `privacyRegistry`. The experimental schema and policy validator
run offline. Fresh v2 destination issuance requires
an installed native writer. A native host reports `destination_v2_unavailable`
for `destinationAddressV2` until the writer is installed, issuance is enabled
and both required destination contributors are registered.
Managed hosts continue to support v1 checkout and saved addresses. They report
`destination_v2_unsupported_rail` for `destinationAddressV2`. Keep installed
readers and exact replay available when disabling fresh issuance.

`savedAddressV2` reports `destination_v2_unsupported_rail` on every rail. Use the
v1 address book. Versioned saved addresses are not available in this release.

1. Parse `commerce.checkout_command.v2` with `createCheckoutCommandV2Schema` and
   the host's SKU schema. The command uses `line1`, optional `line2`, `city`,
   optional `subdivisionCode`, `postalCode` and `countryCode` under `shippingAddress`.
   `line1`, `city` and `postalCode` are always required.
2. Select one immutable `AddressPolicyV1` by market and destination country in
   server composition. Run `npm run settings -- show shipping.addressPolicy` to
   find the binding instructions.
   Set the revision on the policy data. Postal alternatives are full-length
   sequences of `"digit"`, `"letter"` or literal tokens such as `{ literal: "-" }`,
   where a literal is any single printable ASCII character, subject to normalization.
   A lowercase literal with `upperAscii` enabled, a space literal with
   `stripAsciiSpaces` enabled, or a space at either end makes an alternative unreachable.
   Keep alias source keys out of `allowedSubdivisionCodes` after ASCII case
   normalization and point each alias to an allowed code. A classification rule
   uses a `key` with either a canonical `subdivisionCode` from
   `allowedSubdivisionCodes` or a literal `line1Prefix`.
   Each operand except an alias source must be reachable within its normalized
   field bounds, with at least one reachable postal alternative and prefixes
   that start without a space and leave room for a byte after any trailing space.
   Every required field must be satisfiable, so requiring `subdivisionCode` needs
   a nonempty allowed set.
3. Call `validateDestinationAddressV2` from `@openlup/platform/shipping` with the
   submitted address and selected policy. Use the normalized address, policy
   reference and revision, and sorted classification keys on success.

For `destination_dialect_invalid`, submit the advertised checkout version. For
`address_invalid_input`, correct the reported field and resubmit. For
`address_policy_unavailable`, bind a policy for the requested market and country.
For `address_policy_invalid`, correct the selected policy definition and reload
the binding. For `address_subdivision_required` or
`address_subdivision_unrecognized`, enter a policy-admitted subdivision. For
`address_postal_invalid`, correct the full postal code for the destination.

### Read a retained order destination

Use the experimental native destination port in server code after authenticating
the order owner. Supply the host's executor, the authorized destination context
and the binding recorded with the original order.

```ts
import {
  createPostgresDestinationPortV2,
  type DestinationBindingV2,
  type DestinationContextV2,
  type DestinationQueryExecutor,
} from "@openlup/platform/commerce/server/destinations";

export async function readRetainedDestination(
  db: DestinationQueryExecutor,
  context: DestinationContextV2,
  orderId: string,
  originalBinding: DestinationBindingV2,
) {
  const port = createPostgresDestinationPortV2(db);
  const result = await port.read(context, "order", orderId, originalBinding);
  if ("outcome" in result && result.outcome === "refused") {
    return { status: "refused", code: result.code, field: result.field, fix: result.fix } as const;
  }
  return { status: "verified", evidence: result } as const;
}
```

If the binding differs, recover the original binding from the order's sealed
checkout evidence through the authorized order workflow and repeat the read.
Keep destination documents, original commands, receipts and infrastructure
causes server-side. For `OPENLUP_E_DESTINATION_INFRASTRUCTURE`, use the error's
checklist to verify the native binding, driver, connection and TLS, runtime
`CONNECT`, schema `USAGE`, function `EXECUTE` and installed migrations. Retry
the same operation after fixing the cause.

Keep fresh issuance disabled. For exact snapshot replay, submit the original
command and digest. The validated projection can be omitted, and an authorized
erased receipt can return only `{ evidenceDisposition: "erased" }`. Run
`snapshot` and `registerOrder` in the host's own `READ COMMITTED` transaction.
Use `registerOrder` only to replay an existing order binding. Roll back any
outer transaction before publishing a refusal. Fresh claim and fresh-order
binding are unavailable to adopters and stay disabled.

## Compose post-renewal policy

Since 1.0.0, `owned/renewal-policy.ts` is the second and last
owned composition hook, beside shipping. Edit its exported `renewalPolicy`
callback to select application policy after native renewal and retry work.
The released 0.43.0 archive retains its original managed composition. Use a
matching starter release for this hook. `host/renewal-job.ts` and
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

Sessions are held in process memory; restarting loses them. The [session store](https://github.com/openlup/openlup/blob/openlup-core-v1.3.0/examples/neutral-store/host/sessions.ts)
owns expiry and capacity; a full store refuses with
`starter_session_capacity_exceeded`. Customer ownership and operator membership are rechecked against
native stores. Replace this session storage for a production application.

The demonstration captures sign-in messages privately rather than sending mail.
Read `identity.jsonl` through the application container's filesystem as its
`node` user; the [capture binding](https://github.com/openlup/openlup/blob/openlup-core-v1.3.0/examples/neutral-store/host/native-composition.ts)
defines its private location.
The [capture binding](https://github.com/openlup/openlup/blob/openlup-core-v1.3.0/examples/neutral-store/host/native-composition.ts)
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

### Change a product rule

To add a product type for the demonstration, follow
[Install a pack in the starter](../extend/catalogue-extension.md#install-a-pack-in-the-starter).

In a fresh extraction of the starter, edit
`owned/catalogue-rules.cjs` and add an accepted and a refused example to
`owned/catalogue-rules.test.cjs`. If your upgraded application still uses
`owned/catalogue.ts` to validate drafts, copy both rule files from a fresh
extraction of your target version and move your content checks into the
bundle's `validateContent` hook.

The test loads your rule bytes with `loadCatalogRules` under the same execution
limits as installation. Keep hooks pure and bundle dependencies ahead of time. Use the
supplied evaluation context for time, locale or time zone and pass locale and
time zone explicitly when formatting. Tests can pass a fixed evaluation context
as the second argument to `loadCatalogRules`. Hooks have no access to
`require`, Node process or filesystem APIs, `Date`, `Math.random`, or runtime
code generation.

From the extracted application root, run the rule test:

```sh
node --test owned/catalogue-rules.test.cjs
```

After each change, run `npm run typecheck` from the extracted application root.
The bundled test accepts a draft with a title such as `Fictional item` and
expects `title_required` for a blank title. In the publication-shaped example,
the hook reports `presentation.title` within the shared content.

Run `./lifecycle up` from the same directory to install the updated rule
version in the demonstration database and start the host. Sign in as an
operator, open **Catalogue drafts**, and choose **Load draft example**. To
check the bundled title rule, clear `product.sharedContent.presentation.title`
in the JSON and choose **Save**. Expect `title_required` at that field. Restore
the title, save, and choose **Prepare saved draft** with the saved draft ID and
revision. Earlier saved drafts keep their installed rule version.

### Release, price and activate a demo product

With dependencies installed, run this from the extracted application root to
compute the `starter:item` publication version from the local owned definition
and rules bytes. You can do this offline before starting the demo.

```sh
node --experimental-strip-types --input-type=module -e '
  import { readStarterCatalogueRules, starterCataloguePack } from "./host/editor-catalogue.ts";
  const rules = readStarterCatalogueRules();
  if (!rules) throw new Error("Restore owned/catalogue-rules.cjs and retry.");
  console.log(starterCataloguePack(rules).types[0].version);
'
```

The result predicts the installed version for those source bytes. Run
`./lifecycle up` on the same tree after editing the rule sources. To verify a
running demo, sign in and choose **Load draft example** under **Catalogue drafts**
to read `product.type.version`.

In `owned/catalogue.ts`, keep the installed pack declaration, add the example
below, and export `const catalogueProduct = demoCatalogueProduct(version)` using
the computed number. Keep the draft UUID stable and reserve an unused internal
GTIN sequence. For variants, see [Author a product](../extend/catalogue-extension.md#author-a-product).

```ts
import { catalogInternalGtin, type CatalogProductInput } from "@openlup/platform/catalog";

export function demoCatalogueProduct(version: number) {
  const grams = (unscaled: string) => ({ dimension: "mass", unit: "openlup:g", unscaled, scale: 0 } as const);
  const product = {
    namespace: "starter", type: { key: "starter:item", version },
    slug: "field-notebook", name: "Field notebook", presentation: { title: "Field notebook" },
    skus: [{ code: "FIELD-NOTEBOOK", title: "Field notebook", options: {},
      netContent: grams("100"), grossMass: grams("120"),
      identifiers: [{ scheme: "gs1:gtin", issuer: "starter:internal",
        value: catalogInternalGtin(203), packagingLevel: "unit" }],
      sell: { oneTime: true, subscription: false }, logisticsRef: "starter:fulfilment/notebook" }],
  } satisfies CatalogProductInput;
  return {
    draftId: "d9176a9d-274b-4a4a-90d8-2a0db738f181",
    product,
    basePrices: { "FIELD-NOTEBOOK": 1900 },
    copyPresentation: { title: "Field notebook, second edition" },
  };
}
```

Give each authored SKU exactly one initial gross one-time price in minor units.
To include an image, put it in the starter's `public/media` folder and set
`product.presentation.mediaRef` to its local path, for example
`/media/field-notebook.png`. Run `./lifecycle up` after adding the file so the
running demo has the same image when you apply.
Run `npm run --silent catalogue:check:source` to check the pack fixtures offline.

Both apply variants require an interactive terminal, a running marked demo and
verified administrator sign-in. Start the demo with `./lifecycle up`. On a fresh
demo, use the same Compose project and a trusted terminal to run
[first-administrator bootstrap](../../concepts/identity.md#first-administrator-bootstrap).

```sh
docker compose --project-name "$PROJECT" exec -T --user node application node --input-type=module -e '
  import { runtimeConnectionString } from "./host/runtime-database.ts";
  import { createPostgresOperatorIdentityStore } from "@openlup/platform/identity";
  const operators = createPostgresOperatorIdentityStore({ connectionString: await runtimeConnectionString() });
  try { await operators.bootstrapFirstAdministrator({ email: process.argv[1] }); }
  finally { await operators.close(); }
' operator@example.test
```

Bootstrap creates the invitation. Normal mailbox sign-in activates it and
creates the session. On an initialized demo, use an existing administrator or
the [invitation recovery procedure](../../concepts/identity.md#first-administrator-bootstrap).

Run the selected apply command below with the same `--configuration` as the
running host when using a nondefault configuration. Apply checks the demo marker
before requesting a challenge. Enter the email for the active administrator
account or its current invitation. After requesting a token, re-read the
mailbox from a separate private terminal in the same Compose project.

```sh
docker compose --project-name "$PROJECT" exec -T --user node --workdir /application/.context application cat captured-messages/identity.jsonl
```

If a new matching message appears, enter its token at the hidden prompt within
ten minutes. If none arrives, confirm the address and retry with the same apply
flags once both rolling limits allow it. The limits are one issued challenge per
minute and five per hour per address.

- `npm run catalogue:apply -- --prepare-only` signs in, then on a fresh proposal
  saves and prepares the Release draft. It writes the draft and stops before
  approval, publication and price writes.
- `npm run catalogue:apply -- --json` runs the full workflow. Check the saved
  revision, expected head, currency and proposed gross one-time amounts for
  each SKU. Type `approve` when you intend to publish Release and again when you
  intend to publish Activation. Check the reported initial price receipts
  between the two publications. On refusal, use the reported fix and recheck and
  confirm the selected price list and affected SKU before resuming.

After Activation, the default command verifies the publication receipts and
live prices and reports the effective subscription figures.
Use `--copy` to review and publish the first presentation-only successor.
Declared amounts must match the live amounts. To keep the live prices, restore
those declarations and retry. To change them, follow the
[authorized price-change procedure](#change-a-products-price). Use
`npm run --silent catalogue:apply -- --json` for a single machine-readable
report on stdout.

After a readiness refusal, follow its Fix and Recheck. Exact `catalogue:apply`
retry requires the original administrator and unchanged proposal bytes. After
Release, the CLI cannot recover a proposal with changed evidence. If a
promotion job is unready, check its readiness before running the command again.
A missing initial price can be supplied through the authorized price action. Retry the same approved
Publish body and key once the intended price is ready.

- `catalog_publication_media_readiness_unproven` means the reviewed media
  evidence could not be verified. Check the selected draft's media reference,
  asset list and exact image bytes, including filename case. If the running
  image is stale, rebuild the same demo with `./lifecycle up` using the reviewed
  bytes, then retry the unchanged proposal.
- `starter_catalogue_media_invalid` calls for a nonempty local file under
  `public/media` that matches the reference and its case. For
  `catalog_publication_media_validation_unavailable`, check file access and
  retry once verification is available.

### Change a product's price

Any active administrator can change an eligible SKU's live gross base price
after Release and Activation, including for SKUs sold by subscription.

1. In `owned/catalogue.ts`, edit the SKU's amount in `catalogueProduct.basePrices`.
   Use whole minor units.
2. From the extracted application directory, run
   `npm run catalogue:apply -- --reprice` in a terminal and sign in to the
   marked demo. Use the same `--configuration` as the running host.
3. Review the live bases, replacement amounts and labelled subscription
   estimates. Type `approve` to authorize the base amounts.
4. Check each receipt for its effective subscription figure and policy revision.
   Verify the current figures with the same flags, omitting only `--reprice`.

During price review, the command reports SKU-local price findings and checks
the remaining SKUs. Other refusals end the run immediately. Either kind of
finding prevents writes from that review. Once approved, the batch stops at
the first refusal and retains its confirmed receipts.
If an apply or its readback fails, follow the cause-specific guidance and the
commands in the report to verify committed prices read-only, then review any
remaining change. For example, if
you used `--configuration coffee`, run `npm run catalogue:apply -- --configuration coffee`
to verify, then `npm run catalogue:apply -- --configuration coffee --reprice` to
start a fresh review. Keep any other flags from the original invocation. For
machine-readable output, keep `--silent` on npm and `--json` after `--`. A receipt
marked “committed; figure not verified” needs this readback.

If the session cannot be verified, use the printed restart command with the
same flags under an active administrator. A receipt tied to another administrator
requires its original issuer. The report retains publications and prices whose
checks have completed.

### Publish a saved catalogue draft

If you change an input, follow [Change a product rule](#change-a-product-rule)
or [Correct a price-list refusal](#correct-a-price-list-refusal) for its checks.

Run `./lifecycle up` to install the catalogue rules and provision the private
publication connection for the demonstration host. Sign in as a human
administrator. The following actions use the same verified operator session as
the draft editor. Send JSON to `POST /api/actions/<operation>` from the starter
origin with the matching `Origin`, `X-Starter-Request: 1`,
`Content-Type: application/json` and an `Idempotency-Key` header. Use a fresh
UUID for each new request unless retrying a command.

1. Send `{action: "get", draftId}` to `operator.catalogDrafts` to read the saved
   version 3 draft and its revision. Send `{action: "prepare", draftId, expectedRevision}`
   to `operator.catalogDrafts` using the saved revision. Review the returned
   `issues` and `preparation`. The response includes the `expectedHead` resolved
   from the saved product. Prepare reports a missing or ineffective price list
   in `issues` at the affected field, for example
   `skus.0.priceOperations.0.priceListId`. Correct the issue before approval.
2. Have the administrator review the proposed effects and send
   `{action: "approve", productId, candidateRef, candidateDigest, postStateDigest}`
   to `operator.catalogPublication`. Use the product ID and digests from
   preparation. Keep the decision receipt.
3. Send `{action: "publish", productId, candidateRef, candidateDigest, expectedHead, changes: []}`
   to the same operation with a distinct publication key. Keep the request body
   and its key until you have the publication receipt. **Load draft example**
   returns the release payload, which publishes a draft SKU. The example omits
   `grossMass` and `logisticsRef`, so its description needs both before you build
   a product for activation. For a product you intend to activate, supply a valid
   `grossMass` and a nonempty `logisticsRef` on each SKU in the original description
   before building both artifacts. The [product authoring recipe](../extend/catalogue-extension.md#author-a-product)
   shows how to publish the release, set prices, then prepare, approve and publish
   the activation.
4. If the response is lost, sign in and send
   `{action: "receipt", productId, commandKey}` with the original publication
   key in the body. Use a fresh transport header for the lookup. The authorized
   result is `found` with the full receipt or `absent`. Retry with the same
   issuing administrator, original publish body and original header key. A
   committed command returns the same receipt with `replayed: true`.
5. Use `{action: "current", productId}` to read the current head. Send
   `{action: "exact", head, cursor: null}` with the receipt's head to get the
   schema-version 2 product and SKU facts as issued. Continue with `nextCursor` and the same head
   until the cursor is null. Read newest-first receipt summaries with
   `{action: "history", productId, cursor: null}` and its continuation cursor.

### Correct a price-list refusal

Prepare reports `price_list_not_found` for a missing list or
`price_list_not_active` for a list that is inactive, outside its validity window,
or for a different settlement region or currency. Each issue names the field
with zero-based SKU and operation indexes, such as
`skus.0.priceOperations.0.priceListId`. Publish also refuses the list, and a
`price_list_not_found` publish response identifies the rejected ID as `subject`.
Find the effective list for the selected configuration in `owned/demo-seed.ts`.
The demonstration's `buildDemoSeed(config).priceLists[0].id` is derived from
the configuration ID and market currency. Revise the affected operation to use
that list and a fresh price operation `commandKey`.
When changing lists, set `expected.entryId` and `expected.unitPriceMinor` from
the SKU's current one-time base price on the destination list, using `null` for
both when there is no current entry, and resolve any pending base price there
before publishing.
After each change, run `npm run typecheck` from the extracted application root.
Send `{action: "revise", draftId, expectedRevision, payload}` to
`operator.catalogDrafts` with the corrected draft as `payload`. Prepare and
approve the new revision, publish with a fresh publication key, then read the
issued facts as described in [Publish a saved catalogue draft](#publish-a-saved-catalogue-draft).

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
docker compose --project-name "$PROJECT" exec -T database psql -X -U starter_install -d neutral_store
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

From the application directory, load the recorded project name and set
`CONFIGURATION` to the selected owned configuration ID. Choose the pass you need.

| Command | Work selected |
| --- | --- |
| `docker compose --project-name "$PROJECT" exec -T application ./lifecycle renewal --configuration "$CONFIGURATION"` | Drain paid-order mail, then attempt a bounded sandbox renewal pass when enabled. |
| `docker compose --project-name "$PROJECT" exec -T application ./lifecycle care --configuration "$CONFIGURATION"` | Run auto-resume, subscription notices and winback when care is enabled. |
| `docker compose --project-name "$PROJECT" exec -T application ./lifecycle checkout-recovery --configuration "$CONFIGURATION"` | Reconcile reminders, enqueue eligible waves, expire checkouts and process recovery mail. |

For a nondefault local port, add `--port "$OPENLUP_STARTER_PORT"` to `care`
and `checkout-recovery` so locally generated links use that port. A configured
`publicOrigin` takes precedence.

These commands change the demonstration database and private message captures.
A standalone scheduler can invoke `./lifecycle renewal|care|checkout-recovery`
with the same `--configuration "$CONFIGURATION"` and its existing restricted
`--database-url "$RUNTIME_URL"` binding. Select one command per invocation.
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
