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
| `owned/store.config.ts` | Add subscription creation and installed inventory policy to every configuration; compose the locale registry. |
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
timezone. In `owned/renewal.config.ts`, use `market.defaultLocale` for
`notices.locale`. Startup refuses unsupported notice locales or country keys
other than two uppercase letters with `starter_renewal_configuration_invalid`.
A country mapping to a platform-supported locale outside `market.locales`
passes startup validation. Notice delivery falls back to `market.defaultLocale`.
For example, mapping `PL` to `pl` in an English-only registry delivers notices
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
phone input and local output to 64. Return `null` to refuse a supplied phone.
A callback throw refuses the affected field with its configured policy message.

#### Managed tests that pin demonstration values

`test/e4-oms.test.ts` expects the demonstration postal and phone formats.
`test/renewal.test.ts` expects the demonstration account action lists, allowed
pause presets and both pause defaults. `test/address-outcomes.test.ts` matches
the demonstration wording for a change that applies from the next parcel.
`browser/acquisition.spec.ts` also uses the demonstration saved-address formats,
account actions and pause defaults. After extraction, these are application
tests. If you keep the callback-free policy, narrow action lists, omit
`retention.pausePreset` or rewrite copy, adapt or replace the affected fixtures
and assertions in your application. Startup validation defines the configuration
contract.

After reconciliation, apply the managed snapshots, install the target's exact
dependencies and run typechecking, build, application tests and startup checks.
Keep customized owned bytes outside the managed snapshots. Npm-only
applications have no starter-owned file migration.
