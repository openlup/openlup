# Configure settings

Find the renewal stock protection horizon or other business settings before
choosing how to change them. The [Settings catalogue](settings-catalogue.md)
lists each key, its owner and the expected effect. This discovery surface is
experimental.

## Find a setting

From an extracted starter with matching packages installed, run:

```sh
node --experimental-strip-types host/settings.ts list --goal "renewal stock protection horizon"
node --experimental-strip-types host/settings.ts show inventory_renewal_protection --json
node --experimental-strip-types host/settings.ts explain commerce_setting_unknown
```

The commands work offline. The extracted starter’s `AGENTS.md` also gives the
npm invocation for pure JSON on stdout. `show` includes the value schema where available,
the default and its source, the effect on future decisions and the records that
keep their current values. To discover these pages from the installed guide,
run `./node_modules/.bin/openlup-context search "renewal stock protection horizon"`.

## Read the effective behavior

An offline result reports catalogue defaults. For inventory and reminders, a
connected `show <key> --database-url <read-capable-url>` also reports the
observation. Use a connection authorized to read settings from the intended
store. The existing installed row may be an explicit override. An absent
inventory row uses the platform fallback. An absent reminder row uses the host
call parameters for checkout recovery and the 1, 24 and 72 hour schedule for
abandoned carts. The result names the source and includes checkout offsets when
the host supplies a valid policy. If the effective host policy fails native
validation after defaults, the read returns `checkout_recovery_policy_invalid`
with remediation. To explain the absent-row behavior offline, run
`node --experimental-strip-types host/settings.ts explain checkout_recovery_reminders`.

## Preview before changing a setting

From the extracted starter, preview the proposed inventory policy against the
intended store. Pass the value as JSON and repeat `--sku` for each SKU to inspect.

```sh
node --experimental-strip-types host/settings.ts preview inventory_renewal_protection '{"revision":"store-1","renewalProtectionDays":21}' --database-url <read-capable-url> --sku <sku> --json
```

Use `--configuration <id>` to select a stock source when the app has multiple
configurations. Use `--as-of <UTC-ISO-instant>` to repeat an observation at the
same instant. The host can also compose the read-only MCP definition
`settings__preview` with `previewSetting` from `@openlup/platform/operations/server`.
Bind the inventory key to `previewRenewalStockProtection` from
`@openlup/platform/inventory` using the intended store's pool and stock source.
Both surfaces report the current and proposed policy, one validation outcome,
and the effect on reservations and new purchases. A valid result includes the
normalized value. An invalid result explains how to correct it. Preview reads
settings and stock without changing the database. If preview is refused, follow
the remediation to check access and validator installation.

A longer horizon can only leave availability for new purchases equal or lower.
A shorter horizon can only leave it equal or higher. Existing reservations
keep their quantities and expiry times. The result includes current availability
for the named SKUs and leaves `effect.skus[].proposedAvailableForNewPurchases`
null pending a proposed-horizon read.

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

CLI and MCP return the same `refusal` object with `code`, `path`, `rule`,
`hint` and `remediation`. Run `node --experimental-strip-types host/settings.ts explain <refusal-code>` for the
recheck command and whether retrying can help.

| Code | Next step |
| --- | --- |
| `commerce_setting_unknown` | Find the installed key with `list`. |
| `commerce_setting_refusal_unknown` | Check the exact refusal code from this version. |
| `commerce_setting_read_input_invalid` | Check the arguments with `--help`. |
| `commerce_setting_read_unavailable` | Verify the intended store connection, read access and installed value. |
| `commerce_setting_preview_connection_required` | Repeat preview with a read-capable connection to the intended store. |
| `commerce_setting_preview_unsupported` | Read the key's runtime level and effect with `show`. |
| `commerce_setting_preview_unavailable` | Verify the installed policy and use a role that can read it, run the stock read and execute the validator. |
| `commerce_setting_runtime_not_ready` | Read the key's runtime reason and existing change mechanism. |
| `inventory_renewal_protection_policy_invalid` | Check the value schema and examples using `show inventory_renewal_protection`. |
| `checkout_recovery_policy_invalid` | Correct the supplied host policy, including offset order after defaults, then repeat the connected read. |
