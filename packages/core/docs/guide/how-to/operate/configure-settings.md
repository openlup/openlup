# Configure settings

The settings tool answers four questions before you change store behavior: what can be changed, where the value lives, what changing it does (including which existing records keep their original values) and how to check a proposed edit. It is available through two equivalent entry points: the command line (`openlup settings ...` or your starter's `settings` script) and a read-only MCP server (`openlup settings mcp`). It writes nothing: discovery, check and preview are strictly read-only. The [Settings catalogue](settings-catalogue.md) covers platform settings, capabilities and invariants; your application's settings script adds settings declared by the app. This discovery surface is experimental.

## Find a setting

From an extracted starter with matching packages installed, use the settings
script shown in its `AGENTS.md`. The script supplies the application binding, so
list includes both packaged settings and settings declared by the starter.
Without an application binding, discovery covers the packaged catalogue.
Try these arguments:

- `list --goal "renewal stock protection horizon"`
- `show inventory_renewal_protection --json`
- `explain commerce_setting_unknown`

Try `list --goal "payment retry policy"`, `list --goal "flat shipping"` or
`list --goal "pause presets"` to find settings the starter declares.
An application's own settings appear when its script passes the application
binding.

Each goal word matches the start of a word in the setting’s description, key,
domain or search terms, including words inside camelCase keys. A nonblank goal
with no letters or decimal digits returns no results (a blank goal is refused
with exit code 64). The list shows settings that match every goal word in
catalogue order, or, if there are none, up to ten partial matches ranked by the
number of matching words, with ties in catalogue order.

The commands work offline. For settings with a value, `show` includes the value
schema where available, the default and its source, the effect on future
decisions and the records that keep their current values. For a capability or
invariant, it gives the reason and where to read about the limit. To discover these pages from the installed guide,
run `./node_modules/.bin/openlup-context search "renewal stock protection horizon"`.

## Read the effective behavior

Pass `show inventory_renewal_protection --json` to the starter's settings
script. Then pass `check --configuration <id>` to the same script to find the
file and symbol holding the configured value. In the demonstration, run
`./lifecycle up --configuration <id>` with the same ID to apply the changed policy.

Offline `show` for package keys returns catalogue metadata. For a declared
app setting with a reported value, `show` also returns a file observation with
the configuration selected by the binding and the value it reports. For
`inventory_renewal_protection`, `payment_method_expiry_warning_days`,
`payments.declineNoticeTiming`, `promotion_claim_hold_hours`, `subscription_minimum_base_units`,
`subscription_sized_intro_phase`, `subscriptions.retrySchedule`, `shipping_flat_minor`,
`pricing.subscriptionPricePolicy`, `communications.nativeDeliveryControls`, and (with `--app`)
reminders, a connected `show <key> --database-url <read-capable-url>` also reports the
observation. Use a connection authorized to read settings from the intended
store (connected reads of `communications.nativeDeliveryControls` require an explicit
`SELECT` grant on `public.communication_delivery_controls`). The existing installed
row or rows may be an explicit override. An absent
`inventory_renewal_protection`, `payment_method_expiry_warning_days`,
`payments.declineNoticeTiming`, `promotion_claim_hold_hours`, `subscriptions.retrySchedule`, or `shipping_flat_minor` row uses the platform fallback,
whereas an absent `subscription_minimum_base_units`, `subscription_sized_intro_phase`,
`pricing.subscriptionPricePolicy`, or `communications.nativeDeliveryControls`
row reports `absent` (`subscription_minimum_base_units` and `subscription_sized_intro_phase`
refuse fail-closed until a valid row is installed, `pricing.subscriptionPricePolicy` falls back
to legacy subscription price entries when no policy rows exist, and
`communications.nativeDeliveryControls` treats absent control keys as disabled in native
control-plane delivery preparation). For unpinned reminder episodes, an
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
omitted mode uses plaintext. The URL alone sets the host, port, username,
password, database and TLS mode. `PG`-prefixed environment variables and
password files cannot change those settings. Other driver variables still
apply. Both commands refuse when the driver loads the native client. Unset
`NODE_PG_FORCE_NATIVE` to use the JavaScript client. Applications that replace
the driver or pool manage their own connections.

### Installed policy end-to-end (including the local demonstration)

To change an installed policy such as `inventory_renewal_protection` in the starter:

1. Edit the configured policy value and revision in `owned/store.config.ts`.
2. Run offline validation by passing `check --configuration <id>` to your starter's `settings` script.
3. Preview the proposed policy against the store database with `preview` before installing.
4. Install the updated policy with `./lifecycle up --configuration <id>`.
5. Verify the live installed row with a connected `show --database-url ...`.

In the Docker Compose local demonstration, the `database` service does not publish a port on the host, while connected `openlup settings` commands require a TCP connection. Run connected `show` and `preview` inside the `application` container on the Compose network:

```sh
docker compose exec application ./node_modules/.bin/openlup settings --app ./owned/settings-host.ts show inventory_renewal_protection --database-url postgresql://starter_runtime@database:5432/neutral_store --json
```

Pass the same `--database-url` to `preview` inside `docker compose exec application` when estimating stock availability before reinstalling. To inspect the database directly with `psql`, run:

```sh
docker compose exec -T database psql -U starter_runtime -d neutral_store
```

## Check owned configuration before proposing a change

1. Pass `list --goal <words>` to your application’s settings script.
2. Run `check --configuration <id>` with the starter's settings script to read
   values from the selected owned configuration and find their locations.
3. Edit the owned configuration and rerun `check`.
4. For an installed setting with preview support, run a separate connected
   `preview` if you need to estimate the effect on a store. Open a pull request
   with the file change and the check results.

For a value change, a `checked` result and a passing application typecheck are
enough. Skip the full test run and build for the setting itself.

Check uses the settings app binding offline. It opens no database connection
and performs no writes. Installed rows say “Store: not checked.” The starter
checks installed policies for drift at boot. Check includes a file location on
a reported value when the binding supplies one.

Check reports the application's startup validation when supplied. It uses the
packaged schema for known package values and the supplied Zod schema for an
app declaration. A value without an executable schema is marked
`not-validated` for that row.
If loading the app or running its startup validation throws an error with a
nonempty single-line string cause of at most 300 characters and without
control characters, check appends that cause in parentheses.
An offer refused with `starter_subscription_offer_invalid` reports its member
and rule. Other starter refusals such as `starter_lines_above_representation`
keep their code alone.
For example, `subscriptionOffers.<mode>.days` points to `days` in the
`classic` or `sized` offer in the owned store configuration.
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

Keep the current value in the configuration file and omit `fallback` and
`whyThisDefault` from the declaration.
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
same instant.
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
`--configuration` offline. With an explicit `--configuration`, show and explain
resolve it before answering even for package keys, and list the valid IDs if it is unknown.
The module must avoid starting the application, writing data or printing to
stdout. Pass an explicit `--app` only for application code you trust.

List, show and explain work for platform keys without an app or database. With a
PostgreSQL URL, the built-in readers can show the installed row or rows (or fallback or
absent state) for `inventory_renewal_protection`, `payment_method_expiry_warning_days`,
`payments.declineNoticeTiming`, `promotion_claim_hold_hours`, `subscription_minimum_base_units`,
`subscription_sized_intro_phase`, `subscriptions.retrySchedule`, `shipping_flat_minor`,
`pricing.subscriptionPricePolicy`, and `communications.nativeDeliveryControls`
(requiring an explicit `SELECT` grant on `public.communication_delivery_controls`).
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

## What belongs in settings

A configurable item belongs in settings only when it passes all five tests:

1. **Business decision.** Two honest stores could choose different values. It is not a guard for money integrity, data integrity, security mechanisms or legal evidence.
2. **Value, not behavior.** It can be expressed as data consumed by existing code (a number, duration, list or subset of allowed options). If a different choice requires new logic or a contract change, it is a feature rather than a setting.
3. **Known effect.** One sentence states the effect for customers or operators and which existing records keep their original values.
4. **Single value author.** One place is the source of truth. A file may feed a database row only when startup detects drift between them.
5. **Store level.** It describes store-wide policy, not a single installation's infrastructure or an individual record.

| Kind | Where it lives | What it covers |
| --- | --- | --- |
| `code` | Application config and settings host | Store policy values owned by the application and validated at startup. |
| `installed` | Database policy row (installed from host config) | Store policy read by database or platform runtime paths, with explicit installation and drift checks. |
| `callback` | Host-owned module bound at startup | Pure, side-effect-free normalization or validation hook with a documented platform contract. |
| `cap` | Packaged catalogue | Known platform capability limit with no editable setting value; points to the owning guide page. |
| `invariant` | Packaged catalogue | Platform rule that cannot be disabled or tuned because it protects correctness or money integrity. |
| Outside settings | Environment variables, code, catalogue data | Secrets, ports and host addresses, low-level technical tuning, brand and copy, provider selection, and per-record data (such as individual prices or revision IDs). |

Boundary rules:

- **Vocabularies:** Choosing a subset of codes already accepted by the platform and database is an application `code` setting. Introducing a new code outside the platform vocabulary requires a migration or feature.
- **Time windows:** An eligibility or validity window can be a setting; ownership, replay and settlement rules around it remain invariants.
- **Consumer required:** Every declared setting must have working consumer code in the scope where it is declared. Do not declare unused values.
- **Abuse-protection thresholds:** Tunable rate or attempt limits pass the tests only with an explicit warning in their effect description (including scope caveats such as per-process memory). Security mechanisms (signatures, tokens, authentication) stay outside settings.
- **Jurisdiction parameters:** Store-level jurisdiction inputs (such as a configured VAT rate or a contractual return window above the statutory minimum) belong in settings, distinct from mandatory legal rules that cannot be configured away.

## Refusals

### Command, exit code and next step

| Command | Outcome | Exit code | Next step for an agent |
| --- | --- | --- | --- |
| `list`, `show`, `explain` | Completed discovery or lookup | `0` | Read the key's owner, schema, effect and frozen records before editing. |
| `check` | All reported values valid and startup validation passed | `0` | Run the application typecheck and open the change. |
| `preview` | Preview completed (including an invalid proposed policy reported in the document) | `0` | Inspect the validation outcome, availability delta and uncertainty before installing. |
| `mcp` | Read-only MCP server exited cleanly | `0` | Use `settings_list` with a known app key first to confirm the binding. |
| `show`, `explain`, `check`, `preview` | Refusal or invalid application configuration | `1` | Run `explain <refusal-code>` or fix the reported configuration error and rerun. |
| `check` | App binding omits `file` | `2` | Add `file: { configuration, entries }` to `createSettingsBindings` and rerun. |
| Any command | Invalid CLI syntax, blank goal, unknown configuration or bad input | `64` | Correct the flags or configuration ID using `--help`. |
| Any command | Missing app module, missing binding export or unavailable operation | `74` | Verify the `--app` path, `createSettingsBindings` export or database connectivity. |

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
| `payment_method_expiry_warning_days_policy_invalid` | Check the value schema and examples using `show payment_method_expiry_warning_days`. |
| `payment_decline_notice_timing_policy_invalid` | Check the value schema and examples using `show payments.declineNoticeTiming`. |
| `promotion_claim_hold_hours_policy_invalid` | Check the value schema and examples using `show promotion_claim_hold_hours`. |
| `subscription_retry_schedule_policy_invalid` | Check the value schema and examples using `show subscriptions.retrySchedule`. |
| `checkout_recovery_policy_invalid` | Correct the supplied host policy, including offset order after defaults, then repeat the connected read. |

## Use the settings server from an MCP client

The settings server is read-only. After installing the extracted starter's
dependencies, configure your MCP client to run the starter's settings script
from the application root. In clients that support a working directory,
replace `/absolute/path/to/store` with that root.

```json
{
  "mcpServers": {
    "openlup-settings": {
      "command": "npm",
      "args": ["--silent", "run", "settings", "--", "mcp"],
      "cwd": "/absolute/path/to/store"
    }
  }
}
```

You can also use absolute paths to the installed binary and settings host.

```json
{
  "mcpServers": {
    "openlup-settings": {
      "command": "/absolute/path/to/store/node_modules/.bin/openlup",
      "args": ["settings", "mcp", "--app", "/absolute/path/to/store/owned/settings-host.ts"]
    }
  }
}
```

If the `--app` module fails to load, the server stops at launch and reports the
reason on stderr. For your first call, use `settings_list` with a known
application key as `goal`. Confirm that the key appears in the result to verify
the application binding.

| Tool | Use it to |
| --- | --- |
| `settings_list` | Find platform and app settings by goal. |
| `settings_show` | Pass `key` for the setting's details and any available value observation. |
| `settings_explain` | Pass a setting key or refusal code as `keyOrCode` to get an explanation and the next step. |
| `settings_check` | Run the application's offline check and see which reported values were validated. |
| `settings_preview` | Pass `key` and the proposed JSON `value` to estimate a change for a supported setting. |

For connected show and preview, add `--database-url` and a read-capable
PostgreSQL URL to the client's private launch configuration. Supply one TCP host,
a username and the database name. Use `--configuration <id>` to select an app
configuration. Tool calls cannot override the application, configuration or URL.
