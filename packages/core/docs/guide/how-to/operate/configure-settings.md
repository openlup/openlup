# Configure settings

Find the renewal stock protection horizon or other business settings before
choosing how to change them. The [Settings catalogue](settings-catalogue.md)
covers platform settings, capabilities and invariants. Use your application's
settings script to discover settings declared by the app. This discovery surface
is experimental.

## Find a setting

From an extracted starter with matching packages installed, use the settings
script shown in its `AGENTS.md`. The script supplies the application binding, so
list includes both packaged settings and settings declared by the starter.
Without an application binding, discovery covers the packaged catalogue.
Try these arguments:

- `list --goal "renewal stock protection horizon"`
- `show inventory_renewal_protection --json`
- `explain commerce_setting_unknown`

The commands work offline. For settings with a value, `show` includes the value
schema where available, the default and its source, the effect on future
decisions and the records that keep their current values. For a capability or
invariant, it gives the reason and where to read about the limit. To discover these pages from the installed guide,
run `./node_modules/.bin/openlup-context search "renewal stock protection horizon"`.

## Read the effective behavior

Offline `show` for package keys returns catalogue metadata. For a declared
app setting with a reported value, `show` also returns a file observation with
the configuration selected by the binding and the value it reports. For
inventory and reminders, a connected `show <key> --database-url <read-capable-url>` also reports the
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

For connected `show` and `preview`, supply a `postgres://` or `postgresql://`
URL that exactly matches the URL parser's serialization. Omit whitespace and dot
segments that would change its serialization. Supply one TCP host, a username,
an optional password and one non-empty database path segment. Omit the colon for an empty password.
For a DNS host, use lowercase letters, digits, dots and hyphens. Each label
must begin and end with a letter or digit and can have up to 63 characters.
The whole name can have up to 253 characters, including any trailing dot.
The final label cannot be all digits, `0x` alone, or `0x` followed only by
hexadecimal digits. For IPv4, use four decimal octets from 0 to 255 separated
by dots, without leading zeros. Use brackets and lowercase hexadecimal without
leading zeros for IPv6, compress the first longest run of two or more zero
fields to `::`, and write a single zero field as `0`. An omitted port uses
5432. Write an explicit port from 1 to 65535 without leading zeros. The command
decodes the username, password and database name once. Use valid UTF-8 escapes
and omit control characters, including escaped controls. The decoded username
and database name each have a limit of 63 UTF-8 bytes. Omit fragments and omit
the query entirely unless it is exactly `?sslmode=disable`, `?sslmode=require`
or `?sslmode=verify-full`. `require` and `verify-full` verify the server
certificate against the named host using Node's trust store. `disable` or an
omitted mode uses plaintext. The launcher's pool removes `PG`-prefixed
environment variables immediately before creating each client. It supplies an
empty password if the URL omits one, so password files are skipped. Unset
`NODE_PG_FORCE_NATIVE` to use the JavaScript driver for connected reads.
Applications that replace the driver or pool, change the environment after
cleanup, or preload the driver in another mode manage their own connections.

## Check owned configuration before proposing a change

1. Pass `list --goal <words>` to your application’s settings script.
2. Run `check --configuration <id>` with the starter's settings script to read
   values from the selected owned configuration and find their locations.
3. Edit the owned configuration and rerun `check`.
4. For an installed setting with preview support, run a separate connected
   `preview` if you need to estimate the effect on a store. Open a pull request
   with the file change and the check results.

Check uses the settings app binding offline. It opens no database connection
and performs no writes. Installed rows say “Store: not checked.” The starter
checks installed policies for drift at boot. Check includes a file location on
a reported value when the binding supplies one.

Check reports the application's startup validation when supplied. It uses the
packaged schema for known package values and the supplied Zod schema for an
app declaration. A value without an executable schema is marked
`not-validated` for that row.
The starter checks its reported configuration ID against the registry and runs
`assertConfig`. The actual launch and install check their command-line
arguments and installer package availability. Seed preparation runs after
database bootstrap.
A file value that cannot be represented as JSON is reported as unreportable
and fails check without a schema verdict. For a value-only entry with no packaged
key, list and check name the missing declaration on stderr. Add its descriptor
as shown below. Declared app rows use the effect and location from the declaration.

With `--json`, check emits one version-1 document. Exit 0 means checked and
exit 1 means invalid. If importing the selected module or calling its binding
factory throws, check exits 1 with the configuration rejection and a bounded
single-line cause. A missing module or binding factory exits 74 with a hint
to check the path and export. Invalid arguments and unknown configurations
exit 64.

Exit 2 means the binding has no `file` member. Add
`file: { configuration, entries }` to the return value of your existing
`createSettingsBindings` and rerun. Use `validate` on that member to call the
same assertion the app runs at startup. For connected effects, use
`preview` with `--database-url`.

## Declare a setting of your own

Keep the value and its business rule in your application's owned code.
When a declared value is undefined, the key stays discoverable, show returns its
descriptor with an offline observation, and check marks its value not reported. For a
gift wrapping fee, put this in `owned/gift.config.ts` and call
`quoteGiftOrderMinor` from your gift quote code.

```ts
const wrapFeeMinor = 150;
if (!Number.isSafeInteger(wrapFeeMinor) || wrapFeeMinor < 0) {
  throw Error("gift.wrapFeeMinor requires whole nonnegative minor units.");
}
export const gift = { wrapFeeMinor };
export const quoteGiftOrderMinor = (subtotal: number, wrap: boolean) =>
  subtotal + (wrap ? gift.wrapFeeMinor : 0);
```

In `owned/settings-host.ts`, import `gift` and add one entry to the
`file.entries` returned by your existing `createSettingsBindings`. Keep its
configuration selection, installed readers and startup validation. Use
`satisfies SettingsFileEntry` to typecheck the entry as you write it. Choose an
unused key and give its file and symbol so an agent knows where to edit.

```ts nocheck
// The relative import resolves after you create the application file above.
import type { SettingsFileEntry } from "@openlup/platform/operations/server";
import { gift } from "./gift.config.ts";

const entries = {
  "gift.wrapFeeMinor": {
    value: gift.wrapFeeMinor,
    location: { file: "owned/gift.config.ts", symbol: "gift.wrapFeeMinor" },
    descriptor: {
      domain: "gift", goal: "Set the gift wrapping fee in minor units.",
      effect: { appliesTo: "New gift quotes use this fee after deployment.", impact: "money", frozenOn: [] },
    },
  } satisfies SettingsFileEntry,
};
```

From the application root, pass the owned binding to the installed command.

```sh
./node_modules/.bin/openlup settings --app ./owned/settings-host.ts list --goal "gift wrapping fee"
./node_modules/.bin/openlup settings --app ./owned/settings-host.ts show gift.wrapFeeMinor --json
./node_modules/.bin/openlup settings --app ./owned/settings-host.ts check
```

List finds the new key by goal. Show reports the file observation and where to
edit the value. Check reports the app row and runs the existing app validation.
In this example, change 150 to -1 to exercise the assertion. Check exits 1 and
includes this line. Restore a valid amount and rerun check before opening your
pull request.

```text
Application configuration rejected while loading — gift.wrapFeeMinor requires whole nonnegative minor units.
```

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
The binding can supply `file` entries for offline discovery and an optional
startup validator for `check`. Connected commands use readers, previewers or a
stock source key from the binding. If the requested configuration ID is unknown, return
`{ configurationIds: [...] }` with the available IDs. The CLI owns the
database connection and calls the module without a pool when resolving
`--configuration` offline. The module must avoid starting the application,
writing data or printing to stdout. Pass an explicit
`--app` only for application code you trust.

List, show and explain work for platform keys without an app or database. With a
PostgreSQL URL, the built-in stock policy reader can show the installed horizon.
A stock preview needs the application's stock source. A connected reminder
show needs the application's checkout wave policy. A connected show of any
installed setting requires a reader for that key. Supply `--app` to read app
declarations or to provide a binding for a connected read. Omit the URL to
discover settings offline.

Use `--value -` to read one JSON value from stdin. Use `--value=-1` when
passing a negative number directly. The command exits with 0 on completion,
including a preview that reports an invalid policy, 1 for a refusal, 64 for
invalid syntax or input, and 74 for an unavailable operation or app module.
Use `--json` to get one settings document with `schemaVersion: 1` on stdout.

## Modes and runtime levels

A domain keeps an executable descriptor in code and exports it from a
non-browser entry. The generator reads descriptive entries from the domain's
data file. These platform entries make up the packaged catalogue.

A `code` setting is supplied by the adopter's application. A `callback`
setting binds host-owned code. An `installed` setting has a store-specific
policy row when explicitly configured. A capability gap (`cap`) or platform
invariant (`invariant`) has no editable setting value. Find `code` settings with
the application's settings script or with `openlup settings --app <module> list`.

`read-only` covers discovery. `preview` allows inspection of a proposed
change, and `ready` requires qualification for runtime changes. `show` gives the runtime
level, its reason when present and the existing change mechanism for the selected
key. Renewal stock protection is at `preview`; the host installer still
owns changes.

## Refusals

Preview wraps a refusal in a document with `schemaVersion: 1` on both surfaces. The
`refusal` object carries `code`, `path`, `rule`, `hint` and `remediation`.
Pass `explain <refusal-code>` to the settings script for the recheck command
and whether retrying can help.

| Code | Next step |
| --- | --- |
| `commerce_setting_unknown` | Run `list` with your application’s settings script for app keys, or use an unbound `list` for platform keys. |
| `commerce_setting_refusal_unknown` | Check the exact refusal code from this version. |
| `commerce_setting_read_input_invalid` | Check the arguments with `--help`. |
| `commerce_setting_read_unavailable` | For a connected read, verify the store connection, read access and installed value. For a binding failure, check the application binding named in the refusal. |
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
