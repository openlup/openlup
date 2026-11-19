# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Stable APIs follow SemVer from 1.0.0; experimental symbols and test-support
subpaths retain their declared limits. This file keeps the current release and the two previous ones;
earlier releases are recorded verbatim in `CHANGELOG-HISTORY.md`
in the source repository. Pending source changes live in per-change fragments;
set preparation consolidates their migration notes here.

## [Unreleased]

## [1.2.0]

- Publishable on the npm `latest` dist-tag as `1.2.0`, from tag
  `openlup-core-v1.2.0`.

### Changed

- Document the source starter's owned language registry, configured default and named startup copy refusals. The current platform language set remains `en` and `pl`.

Migration: Existing source-starter adopters add `market.defaultLocale` and compose the owned `market` registry from `owned/market.config.ts`. Keep `locales: ['en', 'pl']` and `defaultLocale: 'en'` for the previous demonstration behavior. This documentation change adds no npm API or SQL migration.

### Starter applications from 1.1.0

Migration: Before applying this set's managed starter files, reconcile the
owned files below against a separate target extraction. Keep immutable managed
snapshots from both extractions. Add `owned/market.config.ts` **only to the
target snapshot**, using that extraction's exact bytes; it is a new owned file,
not a newly managed customization. The upgrade CLI then creates it with the
usual conflict refusal, interruption recovery and replay behavior. Leave every
other owned path out of both snapshots. After creation, keep the market file
application-owned and outside future managed snapshots.

For each uncustomized file in this table, take the target extraction's bytes
before applying managed files. For customized files, preserve local values and
apply the reconciliation described below. Do not overwrite a customized file
with the demonstration defaults.

| Owned path | Reconciliation |
| --- | --- |
| `AGENTS.md` | Merge the target's task routes, representation bounds and explicit inventory-policy installation guidance into local contributor instructions. |
| `owned/renewal.config.ts` | Add account actions and pause choices; use the configured default locale for notices. |
| `owned/store.config.ts` | Add subscription creation, the installed inventory policy and the checkout recovery reminder schedule to every configuration. Compose the locale registry. |
| `owned/acquisition-policy.ts` | Optionally adopt the local address callbacks; the existing callback-free policy remains valid. |
| `owned/copy.ts` | Keep all required application copy keys for each configured locale. |
| `owned/editor-copy.ts` | Keep all editor keys for each configured locale. |
| `owned/quote-copy.ts` | Keep quote and refusal keys for each configured locale and the explicit refusal allowlist. |
| `owned/renewal-copy.ts` | Keep all renewal notice keys, including nested paid-order text, for each configured locale. |
| `owned/demo-seed.ts` | Read product name and description with `config.market.defaultLocale` instead of `.en`. |

`AGENTS.md` is extracted from the source template. Its guidance changes have no
startup refusal of their own; preserve local authority and contribution rules
when reconciling it with the target.

#### Account actions and pause choices

In `demoSubscriptionCare()` in `owned/renewal.config.ts`, add
`subscriptionCare.actions` with all five keys. The target defaults are:

```text
actions: {
  active: ['skip', 'slide', 'order_now', 'pause', 'cancel'],
  paused: ['resume', 'cancel'],
  cancelled: ['reactivate'],
  whilePaymentBlocked: ['pause', 'cancel'],
  whilePaymentExpired: ['cancel', 'resume'],
}
```

Each value is an array without duplicates, containing only `skip`, `slide`,
`order_now`, `pause`, `cancel`, `resume` or `reactivate`; empty arrays disable
actions. Missing keys, unknown keys or invalid arrays refuse startup with
`starter_subscription_actions_invalid`. State admission applies to all actions.
The payment-state allowlists apply to actions other than `reactivate`.
To disable reactivation, remove `reactivate` from `actions.cancelled`.
Native command guards still apply.

Add `subscriptionCare.pausePresets` with
`{ allowed: ['2_weeks', '1_month', 'indefinite'], default: '2_weeks' }`.
The equivalent target helper is `choice('2_weeks', '2_weeks', '1_month', 'indefinite')`
from `shared/policy.ts`. The allowed array must be nonempty, unique and limited
to those three values, and must contain the default. Missing or invalid choices
refuse with `starter_pause_presets_invalid`.

The target also adds `subscriptionCare.retention.pausePreset: '1_month'`.
This member is optional: omission uses `pausePresets.default`. If present, it
must be one of the allowed presets or startup refuses with
`starter_retention_configuration_invalid`. Preserve the existing retention
reason mapping, local timing and three-rung retry ladder.

#### Subscription creation and representation bounds

In every configuration in `owned/store.config.ts`, add
`subscriptionCreation: { editWindowHours: 72 }`, or retain a deliberate local
whole-hour value from 1 through 720. Missing, fractional or out-of-range values
refuse startup with `starter_subscription_creation_invalid`. This is the
initial subscription snapshot's edit window; it does not rewrite existing
subscriptions or replace the separate editing policy.

No owned edit is needed for the target's existing representation defaults.
Check customized offers: `offer.maxUnits` is at most 100, each per-SKU
subscription quantity domain has maximum 99, and
`maximumBaseLines + maximumAddonLines` is at most 50. Violations refuse startup
with `starter_units_above_representation` or
`starter_lines_above_representation`, respectively. The target keeps
`maximumBaseLines: 6`, `maximumAddonLines: 12` and per-SKU quantities 1 through
99; the total `maximumUnits: 1782` is a separate commercial bound.

#### Install the renewal stock policy explicitly

In every configuration in `owned/store.config.ts`, add
`inventory: { renewalProtection: { revision: 'starter-1', renewalProtectionDays: 14 } }`.
A customized policy has exactly `revision` and `renewalProtectionDays`: a
nonblank revision and an integer day count from 1 through 3660. Missing or
invalid policy refuses startup with
`inventory_renewal_protection_policy_invalid`.

Apply the selected platform package's complete native catalogue, including
`20261123130000_inventory_renewal_protection_policy.sql`, using the database
migration procedure in this guide. Then, with a dedicated
write-capable installation connection, explicitly call
`installRenewalStockProtectionPolicy(connection, config.inventory.renewalProtection)`
from `@openlup/platform/inventory` for the configuration being installed.
Read it back with `readRenewalStockProtectionPolicy(connection)` and confirm
both revision and day count before restarting. In the disposable demonstration,
the explicit `./lifecycle up` installation step calls this installer before
the HTTP host starts; application startup itself only reads the installed
policy. Never use the demonstration seed to migrate a customer database.

An absent key reads as `{ revision: 'default', renewalProtectionDays: 14 }`;
even though the days match, it differs from `starter-1`. Startup refuses
`starter_installed_policy_drift` whenever either installed field differs from
the owned policy. Editing a file or applying file snapshots installs no policy.
For later changes, deliberately install the selected revision and days again
with installation authority, verify the readback, then restart.

#### Install the checkout recovery reminder schedule explicitly

In every configuration in a customized `owned/store.config.ts`, preserve local
values and add `checkoutRecoveryReminders` with exactly `revision`,
`abandonedCart` and `checkoutRecovery`. The target uses the historical waves.

```text
checkoutRecoveryReminders: {
  revision: 'starter-1',
  abandonedCart: [
    { stage: 'first', afterHours: 1 },
    { stage: 'gentle', afterHours: 24 },
    { stage: 'last', afterHours: 72 },
  ],
  checkoutRecovery: [
    { stage: 'first', afterHours: 1 },
    { stage: 'last', afterHours: 20 },
  ],
}
```

Use a nonblank revision and a nonempty array for each reminder kind. Each wave
has exactly `stage` and `afterHours`. Use strictly increasing integer hours
from 1 through 2147483647, with unique stages and `last` as the final stage in
each array. `abandonedCart` allows `first`, `gentle` and `last`.
`checkoutRecovery` allows `first` and `last`. Startup and installation refuse
a missing or invalid schedule with `checkout_recovery_reminder_schedule_invalid`.

Apply the target platform package's complete native catalogue, including
`20261123140000_checkout_recovery_reminder_schedule.sql`. Then run the
explicit installation step for the selected configuration. On a dedicated
write-capable installation connection, call
`installCheckoutRecoveryReminderSchedule(connection, config.checkoutRecoveryReminders)`
from `@openlup/platform/commerce/server`. Use
`readCheckoutRecoveryReminderSchedule(connection)` to confirm the revision and
both wave arrays before restarting. In the disposable demonstration,
`./lifecycle up` runs the installer before starting the HTTP host.

Database-backed startup reads the installed schedule and refuses with
`starter_installed_policy_drift` if the revision, stages or hours differ from
the owned configuration. An absent setting uses revision `default`, which
differs from `starter-1` even when the waves match. The managed
`host/paid-mail.ts` selects the recovery subject by stage and retains the
hour-based rule for legacy payloads that have no stage.

#### Locale registry and copy

The new `owned/market.config.ts` exports `market` with
`locales: ['en', 'pl']` and `defaultLocale: 'en'`. After its target-only creation,
a customized application may choose a nonempty unique subset of `en` and `pl`;
the default must be in that subset. Empty or duplicate locales refuse startup
with `starter_locales_invalid`, unsupported languages with
`starter_locale_unsupported`, and a missing or unconfigured default with
`starter_default_locale_invalid`.
Omitting the new file prevents module loading with `ERR_MODULE_NOT_FOUND`.

Import the owned `market` registry into `owned/store.config.ts` and
spread it into every `market` object, preserving local country, currency and
timezone. The target `owned/renewal.config.ts` sets `notices.locale` to
`market.defaultLocale`. A pristine file takes that change; a customized notice
locale may stay when it is in `market.locales`, otherwise notices fall back to
`market.defaultLocale`. Startup refuses unsupported notice locales or country keys
other than two uppercase letters with `starter_renewal_configuration_invalid`.
A country mapping to a platform-supported locale outside `market.locales`
passes startup validation. Notice delivery falls back to `market.defaultLocale`.
For example, mapping a country to `pl` in an English-only registry delivers notices
in English. Keep mappings within `market.locales` by removing or remapping
entries for dropped locales.

Change the two product text reads in
`owned/demo-seed.ts` to `name[config.market.defaultLocale]` and
`description[config.market.defaultLocale]`.

Preserve customized translations in the four copy files above. The target uses
`LocaleCopy` from `shared/locales.ts`; copy, editor and quote key types come
from `shared/copy-keys.ts`, and `RenewalNoticeText` comes from
`shared/renewal-config.ts`. Adopt those typed forms when adapting registries;
keep `CopyKey` exported from `owned/copy.ts` and use `quoteRefusalKeys` for
`isQuoteRefusalCode`, as in the target, so the refusal allowlist is independent
of a translation. Every configured locale must have nonblank strings for the
complete key inventory, including `renewalNoticeCopy`'s `paid` members. Extra
inactive translations may remain. The managed locale test checks coverage and
startup validation and accepts customized wording.

The same requirement applies to localized brand, store, media, product,
recovery message, return/hold choice and acquisition-address labels in owned
data, including `owned/catalogue.ts`, `owned/subscription-editing.ts` and
`owned/acquisition-addresses.ts`, even though those files need no default edit.
Missing or blank text refuses with `starter_locale_copy_missing`, naming its
path and locale. Malformed recovery state/message inventories still refuse
with `starter_recovery_configuration_invalid`.

#### Optional local address callbacks

The target's `savedAddressValidation()` in `owned/acquisition-policy.ts` adds
`local.normalizePostalCode`, `local.isValidPostalCode` and `local.normalizePhone`.
Its fictional defaults remove postal whitespace, accept two uppercase letters
and four digits, and normalize eight local phone digits to `+999` (also
accepting that prefixed form after removing whitespace, parentheses, plus and
hyphens). A customized policy may omit `local` to keep the existing fallback;
there is no new required owned member. If provided, all three callbacks must
be functions or construction refuses with `saved_address_policy_invalid`.
Use the application's own country formats. These callbacks run only when the
selected country resolves to the policy's configured country, including aliases.
Normalization can run more than once per parse. Keep the callbacks deterministic
and effect-free, without I/O, authorization checks or reads of mutable state.
The platform trims and collapses input whitespace and uppercases postal input
before normalization. Postal input and output are bounded to 24 characters and
phone input and local output to 64. Postal normalization must return a
nonempty string and `isValidPostalCode` must return literal `true` to accept;
any other result refuses the field. Return `null` to refuse a supplied phone.
A callback throw refuses the affected field with its configured policy message.

#### Managed tests that pin demonstration values

`test/e4-oms.test.ts` expects the demonstration postal and phone formats.
`test/renewal.test.ts` expects the demonstration account action lists, allowed
pause presets and both pause defaults. `test/address-outcomes.test.ts` matches
the demonstration wording for a change that applies from the next parcel.
`test/acquisition-quote.test.ts` requires the translations of three price
refusal codes to exceed 20 characters, although startup accepts any nonblank
translation. `browser/acquisition.spec.ts` ages a checkout by 21 hours and
expects two recovery reminder emails; a customized reminder schedule needs its
timing fixture and expected reminder count adapted.
`browser/acquisition.spec.ts` also uses the demonstration saved-address formats,
account actions and pause defaults. The browser specs (`browser/*.spec.ts`,
including `editor-components.spec.ts`, `e4.spec.ts`, `journey.spec.ts` and
`subscription-journeys.spec.ts`) locate controls by their demonstration labels,
such as "Back to account"; rewording owned copy requires updating those
locators. After extraction, these are application tests. If you keep the callback-free policy, narrow action lists, omit
`retention.pausePreset` or rewrite copy, adapt or replace the affected fixtures
and assertions in your application. Startup validation defines the configuration
contract.

`test/installation.test.ts` checks that installation writes the schedule from
the owned configuration and accepts valid customized waves.
`test/checkout-recovery-stage.test.ts` checks subject selection for explicit
stages and the historical hour rule for legacy payloads.

After reconciliation, apply the managed snapshots, install the target's exact
dependencies and run typechecking, build, application tests and startup checks.
Keep customized owned bytes outside the managed snapshots. Npm-only
applications have no starter-owned file migration.

## [1.1.0]

- Publishable on the npm `latest` dist-tag as `1.1.0`, from tag
  `openlup-core-v1.1.0`.

- docs: document the required owned-file migration from the 0.43.0 starter,
  using target-only snapshot entries and the existing installed upgrade CLI.
  The published 1.0.0 set did not pass exact-set qualification for starter
  upgrades and is superseded by 1.1.0; 1.1.0 qualification is recorded after
  publication. This migration guide changes no runtime or SQL.

Migration: Starter applications from 0.43.0 must add `owned/quote-shipping.ts`,
`owned/renewal-policy.ts` and `owned/catalogue.json` only to the target snapshot,
and migrate the contracts in `owned/store.config.ts`, `owned/quote-copy.ts`,
`owned/subscription-editing.ts` and `owned/catalogue.ts` before applying managed
files. Use the target extraction's bytes for pristine files; preserve local
values when adapting customized files. Follow the starter section in the
1.0.0 upgrade guide shipped with this set. Npm-only applications require no
owned-file migration. Starters targeting 1.1.0 also migrate
`owned/renewal.config.ts` with the required `subscriptionCare.retention`
mapping/default and the existing three-rung retry budget, as described in the
1.1.0 upgrade guide; this also applies when upgrading a 1.0.0 starter.

Align the current source starter and reader guidance with `MAX_CADENCE_DAYS`
(1..3660 whole days), removing the former starter database refusal above 90.
Applications continue to choose their offered cadences.

Migration: apply the matching platform package's complete native catalogue,
including `20261122190000_subscription_cadence_bound.sql`, before using longer
cadences. This change is unreleased. Checkout-command and saga-fallback replay
of stored cadence above 3660 can still quote before replay; that unreleased
development-data case remains a follow-up.

## [1.0.0]

- Preserve the experimental registry readiness code annotation in emitted declarations;
  the seven established readiness codes retain their stable contracts.

- Publishable on the npm `latest` dist-tag as `1.0.0`, from tag
  `openlup-core-v1.0.0`.
- Accept stable MAJOR.MINOR.PATCH package versions in readiness declarations;
  continue to refuse leading zeros and prerelease suffixes.

Label declaration occurrences as unverified public-import leads. Resolve the
selected application's reachable declared OpenLup packages and required Core
through Node's npm node_modules lookup, including workspace hoisting and linked
packages. Check selected versions against the owning npm lockfile and retain
application-only source scans. MCP reads accept only the selected package's
exact returned path and retain bounded ordinary-file and realpath checks.
Refuse Node package self-references instead of labelling checkout source as an
installed dependency.

Migration: no result fields or package exports change. Declaration hits do not
prove public imports; use the installed exports and examples. For hoisted npm
installs, use the installed-manifest executable recipe in the lookup README.

Add browser-safe exact catalogue quantities, canonical units, comparison and declared-unit conversion using decimal strings and BigInt. Inexact canonical values refuse without rounding.

Migration: additive exports on the existing catalog entry. Existing identifier schemas are unchanged. No database, subscription or capability change; target package set 0.44.0.

Add `cataloguePositionNetFromGross` and `allocateCatalogueDiscountedGrossTotals`
to the existing pricing subpath. They preserve the existing position arithmetic:
integer included-VAT net rounding and discount allocation by largest remainder,
with equal remainders resolved by input position.

Migration: These exports are additive and unbound. Existing quote arithmetic,
subscription agreements and independent invoice verification stay unchanged.
Callers explicitly compose the helpers with already validated position money
in one selected currency and preserve the original position order. The net
helper retains native integer-conversion errors; the allocator retains its
existing refusal messages. No data migration or activation is supplied.

- Mark unbound catalogue quantity, money and registry-observation symbols
  `@experimental`; retain the existing consumed quantity contract without the tag.

Migration: no runtime, signature or import change. The added TSDoc tags identify
experimental symbols for compatibility guidance.

Add opt-in catalogue definition/quantity/v1-draft checks, explicit refusal
fixtures and installed recipes with a copied stationery skeleton. Attribute/projection and combination fixtures reuse their owners; taxonomy, tax,
profile and promotion semantics remain explicitly pending.

Migration: Additive tooling for the next package set. Old imports and v1 canonical
bytes remain unchanged. The new Node-only `@openlup/platform/catalog/testing`
subpath and `openlup catalogue check --packs ./owned/catalogue.json --json` require
explicit JSON fixture text; the supplied file is never imported. No database migration, installation,
host wiring, publication or capability activation occurs. Upgrade all packages as
one exact set; an offline PASS is scoped evidence only.

Integrate attribute validation/projection and V2 combination owners into the
offline catalogue checker. Replace executable subjects with JSON text and the
copied executable skeleton with one static JSON fixture. Reference and refusal
observations are checked without invoking caller code; retained identities are
derived from fixture options and prove no persisted bytes or history.

Migration: For the unreleased 0.44.0 set, migrate module-based callers to
`await runCatalogExtensionConformance(JSON.stringify(subjectData))` and CLI files
to `openlup catalogue check --packs ./owned/catalogue.json --json`. Omit
`validateContent`; requested application content validation is unavailable (2).
Replace refusal callbacks with `observedCode` and `zeroEffects` records, reference
ports with resolution rows, and retained identity bytes with options. The single
entry retains report fields, deterministic ordering and the five CLI exits.
No SQL, publication, subscription changes or capability activation occurs.

Add optional inert catalogue registry observations to readiness, including the
`registry_missing_referenced_version` refusal for referenced type versions missing
from code or carrying a different digest.

Migration: additive `ReadinessInput.catalogRegistry` and `CatalogRegistryObservation`
exports on the existing readiness entry. Existing inputs keep their behaviour.
`complete: false` or a NULL installed definition digest yields existing `unknown`
readiness rather than treating hidden references as ready. The application owns observation and database identity; no boot hook, installer,
provider call or runtime activation is added. Target package set 0.44.0.

Document the unbound attribute owner beside the offline catalogue checker and
include its shared issue codes in the generated installed refusal-to-recipe links.
The recipe links include the per-slot UTF-8 text-index refusal
`attribute_projection_text_too_large`.
The checker retains its existing definitions, exact quantity and v1 draft scope;
attribute-value/projection integration remains pending.

Migration: documentation additions only. Existing APIs, strict v1 drafts and
checker exit/refusal behavior are unchanged. Owner availability and recipe links
grant no publication, serving or capability activation authority.

Declare per-subpath stable, experimental and test-support policies for the coherent 1.0.0 package set. Stable APIs follow SemVer with open unions and literal sets; symbols tagged `@experimental` remain outside the stable promise. Consumer evidence is explicitly first-party.

Migration: keep a default branch for unknown union and literal-set values. Check the generated maturity table for experimental and test-support subpaths before upgrading. No runtime behavior or package export changes.
- Allow intentional API snapshot updates with a new or modified package change fragment; retain changed `CHANGELOG.md` as a legacy route. Fragment contents are validated during release preparation.

Export `MAX_CADENCE_DAYS = 3660` from the existing browser-shareable
`@openlup/core/subscription` contract for fresh platform cadence admission.
The ten-year whole-day limit avoids the timestamp and settlement integer
overflows admitted by the former PostgreSQL integer maximum, with lateness margin.
Applications continue to own offered cadences.

Migration: fresh quotes, drafts and editor results above 3660 days now refuse.
Historical transport, stored data and completed receipts keep their integer
representation. Completed editor, native draft and renewal receipts replay before
current limits; replay above 3660 is not guaranteed on checkout-command or
saga-fallback paths that quote before replay. No released data can contain such
values: no published version admitted cadence above 120, and PR4a's widening is
unreleased. Existing SQL and starter guards still refuse above 90 pending a
separate migration.

## [0.43.0]

- Publishable on the npm `latest` dist-tag as `0.43.0`, from tag
  `openlup-core-v0.43.0`.

- Keep the shared fulfillment status facade and generated JSON neutral; provider dictionaries own translation. Canonical `packed` remains preferred and every historical display alias keeps its customer-step result.

Migration: shared status-map JSON no longer carries adapter trace columns. Consumers needing provider translation use adapter-owned dictionaries. Existing status tokens, ranks, effects and customer steps are unchanged.
