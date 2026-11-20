# Configure settings

Find the renewal stock protection horizon or other business settings before
choosing how to change them. The [Settings catalogue](settings-catalogue.md)
lists each key, its owner and the expected effect. This discovery surface is
experimental.

## Find a setting

From an extracted starter with matching packages installed, use the settings
script shown in its `AGENTS.md`. Try these arguments:

- `list --goal "renewal stock protection horizon"`
- `show inventory_renewal_protection --json`
- `explain commerce_setting_unknown`

The commands work offline. For settings with a value, `show` includes the value
schema where available, the default and its source, the effect on future
decisions and the records that keep their current values. For a capability or
invariant, it gives the reason and where to read about the limit. To discover these pages from the installed guide,
run `./node_modules/.bin/openlup-context search "renewal stock protection horizon"`.

## Read the effective behavior

Without a reported file value, an offline result describes the catalogue
default. For inventory and reminders, a connected `show <key> --database-url <read-capable-url>` also reports the
observation. Use a connection authorized to read settings from the intended
store. The existing installed row may be an explicit override. An absent
inventory row uses the platform fallback. For unpinned reminder episodes, an
absent row uses the host call parameters for checkout recovery and the 1, 24 and
72 hour schedule for abandoned carts. The connected read shows the live setting
or fallback. For a pinned order and reminder kind, [the pin supplies timing](../build/checkout-recovery.md#install-reminder-stages-and-hours).
The result names the source and includes checkout offsets when the host
supplies a valid policy. If the effective host policy fails native
validation after defaults, the read returns `checkout_recovery_policy_invalid`
with remediation. To explain the absent-row behavior offline, pass
`explain checkout_recovery_reminders` to the settings script.

## Check owned configuration after an edit

From the starter root, run `npm --silent run settings -- check --configuration <id>`.
The command reads the selected configuration through the existing settings app
binding. It opens no database connection, performs no writes and leaves drift
checking to startup. For an installed key that supports preview, run `preview`
separately to estimate what the change would do against a store.

Use `show <key> --configuration <id>` to find a value before editing it.
For a reported key, `show` names the loaded file value and its location where
available. The JSON `observation.state` is `file` for an offline file value.
A connected installed read keeps its store value in `observation` and puts
the file value in `fileObservation`. When the app does not report the key,
offline text says “No file value reported.”

Check runs the application's startup validation when the binding supplies it
and shows its result separately. Each code or installed row reports whether a
file value was supplied, the packaged schema result and how the change takes
effect. Missing values and entries without an executable schema are not
validated against the catalogue. A passed check covers the reported values and
available checks, and installed rows say “Store: not checked.”

With `--json`, check returns one version-1 document. It exits 0 when checked
and 1 if startup or a reported value fails validation. Exit 2 means the binding
loaded without file values support. Add `file: { configuration, entries }` to
the return value of your existing `createSettingsBindings` function and rerun.
Use `validate` on that member to call the same assertion the app runs at startup.
Invalid usage and unknown configuration IDs exit 64. A binding that cannot be
loaded exits 74. Use `preview` instead if you need `--database-url`.

## Preview before changing a setting

From the extracted starter, preview the proposed inventory policy against the
intended store. Pass the value with `--value` and repeat `--sku` for each SKU to inspect.

Use `preview inventory_renewal_protection` with
`--value '{"revision":"store-1","renewalProtectionDays":21}'`,
`--database-url <read-capable-url>`, `--sku <sku>` and `--json`.

Use `--configuration <id>` to select a stock source when the app has multiple
configurations. Use `--as-of <UTC-ISO-instant>` to repeat an observation at the
same instant. The host can also compose the read-only MCP definition
`settings__preview` with `previewSetting` from `@openlup/platform/operations/server`.
Bind the inventory key to `previewRenewalStockProtection` from
`@openlup/platform/inventory` using the intended store's pool and stock source.
Pass through the options supplied by `previewSetting`.
The CLI decodes JSON once. Preview and the installer work from decoded values,
including finite JavaScript numbers and own JSON fields. For example,
`14.0000000000000001` decodes to `14` and previews as `14`. A raw PostgreSQL
numeric literal can retain more precision.

Both surfaces return the same version-1 preview document. Preview checks the
decoded value with the installer rules and the store database and reports one
validation outcome. A valid result includes the normalized value. An invalid
result explains how to correct the proposal. Preview observes settings and
stock in a read-only transaction. A refusal names the failed step and the next
command.

A longer horizon can only leave availability for new purchases equal or lower.
A shorter horizon can only leave it equal or higher. Existing reservations
keep their quantities and expiry times. For each named SKU, the version-1 document
reports current availability and a proposed estimate computed at the same instant
in the same snapshot. Recorded stock and demand can change. The proposed quantity
is null for an invalid proposal or missing SKU or stock source.

Default text shows each SKU's current quantity and proposed estimate, along with
the direction of change. Use `--json` for the same quantities in a preview
document, as returned by MCP and the platform library.

## Connect the command to your application

The starter's settings script calls the experimental package command and passes
`--app ./owned/settings-host.ts`. Set the script to
`openlup settings --app ./owned/settings-host.ts` in a composed app with the same
layout. The module exports one function, `createSettingsBindings({ db, configuration })`.
It can supply read-only readers, previewers, a stock source key and file values
for the selected configuration. If the requested ID is unknown, return
`{ configurationIds: [...] }` with the available IDs. The CLI owns the
database connection and calls the module without a pool when resolving
`--configuration` offline. The module must avoid starting the application,
writing data or printing to stdout. Pass an explicit
`--app` only for application code you trust.

Offline list, show and explain work without an app or database. With a
PostgreSQL URL, the built-in stock policy reader can show the installed horizon.
A stock preview needs the application's stock source. A connected reminder
show needs the application's checkout wave policy. A connected show of any
installed setting requires a reader for that key. Supply `--app` when the
command requests a binding, or omit the URL to read the catalogue offline.

Use `--value -` to read one JSON value from stdin. Use `--value=-1` when
passing a negative number directly. The command exits with 0 on completion,
including a preview that reports an invalid policy, 1 for a refusal or failed
check, 2 when check has no file binding, 64 for invalid syntax or input, and 74
for an unavailable operation or app module.
Use `--json` to get one settings document with `schemaVersion: 1` on stdout.

## Modes and runtime levels

A domain keeps an executable descriptor in code and exports it from a
non-browser entry. The generator reads descriptive entries from the domain's
data file. Installed consumers discover those entries in the packaged catalogue.

A `code` setting is supplied by the adopter's application. A `callback`
setting binds host-owned code. An `installed` setting has a store-specific
policy row when explicitly configured. A capability gap (`cap`) or platform
invariant (`invariant`) has no editable setting value.

`read-only` covers discovery. `preview` allows inspection of a proposed
change, and `ready` requires qualification for runtime changes. The current
catalogue gives the runtime level, reason and existing change mechanism for
each key. Renewal stock protection is at `preview`; the host installer still
owns changes.

## Refusals

Preview wraps a refusal in a document with `schemaVersion: 1` on both surfaces. The
`refusal` object carries `code`, `path`, `rule`, `hint` and `remediation`.
Pass `explain <refusal-code>` to the settings script for the recheck command
and whether retrying can help.

| Code | Next step |
| --- | --- |
| `commerce_setting_unknown` | Find the installed key with `list`. |
| `commerce_setting_refusal_unknown` | Check the exact refusal code from this version. |
| `commerce_setting_read_input_invalid` | Check the arguments with `--help`. |
| `commerce_setting_read_unavailable` | Follow the hint. Check the app module and its bindings for file reads, or the store connection and read access for a connected read. |
| `commerce_setting_preview_connection_required` | Use a read-capable connection to the intended store and supply the app bindings if requested. |
| `commerce_setting_preview_unsupported` | Use `show` for value details or a reason and reference. |
| `commerce_setting_preview_json_invalid` | Correct the proposed JSON. |
| `commerce_setting_preview_configuration_unknown` | Select one of the listed IDs. |
| `commerce_setting_preview_input_invalid` | Correct the named argument or run `preview --help`. |
| `commerce_setting_preview_policy_read_denied` | Ask for a connection that can read the installed policy. |
| `commerce_setting_preview_stock_read_denied` | Ask for a connection that can read stock and execute `inventory_new_purchase_stock_preview` for a proposed estimate. |
| `commerce_setting_preview_validation_denied` | Ask for a connection with permission to preview this setting. |
| `commerce_setting_preview_validation_missing` | Ask your store administrator to update the OpenLup installation and apply any database forward named in the hint. |
| `commerce_setting_preview_unexpected` | Retry once, then contact your store administrator if the same step still fails. |
| `commerce_setting_runtime_not_ready` | Read the key's runtime reason and existing change mechanism. |
| `inventory_renewal_protection_policy_invalid` | Check the value schema and examples using `show inventory_renewal_protection`. |
| `checkout_recovery_policy_invalid` | Correct the supplied host policy, including offset order after defaults, then repeat the connected read. |
