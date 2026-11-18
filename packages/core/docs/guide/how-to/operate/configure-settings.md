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

The commands work offline. `show` includes the value schema where available,
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
the host supplies its policy. To explain the absent-row behavior offline, run
`node --experimental-strip-types host/settings.ts explain checkout_recovery_reminders`.

## Modes and runtime levels

A `code` setting is supplied by the adopter's application. A `callback`
setting binds host-owned code. An `installed` setting has a store-specific
policy row when explicitly configured. A capability gap (`cap`) or platform
invariant (`invariant`) has no editable setting value.

`read-only` covers discovery. `preview` allows inspection of a proposed
change, and `ready` requires qualification for runtime changes. The current
catalogue entries use `read-only` and give the reason and existing change
mechanism for each key.

## Refusals

Machine-readable refusals carry `code`, `path`, `rule`, `hint` and
`remediation`. Run `node --experimental-strip-types host/settings.ts explain <refusal-code>` for the
recheck command and whether retrying can help.

| Code | Next step |
| --- | --- |
| `commerce_setting_unknown` | Find the installed key with `list`. |
| `commerce_setting_refusal_unknown` | Check the exact refusal code from this version. |
| `commerce_setting_read_input_invalid` | Check the arguments with `--help`. |
| `commerce_setting_read_unavailable` | Verify the intended store connection, read access and installed value. |
| `commerce_setting_runtime_not_ready` | Read the key's runtime reason and existing change mechanism. |
| `inventory_renewal_protection_policy_invalid` | Check the value schema and examples using `show inventory_renewal_protection`. |
