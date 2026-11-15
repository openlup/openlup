# Upgrade an application

Move your application to the next OpenLup release while reconciling package,
SQL and application-file changes.

A development preview gives no upgrade guarantee. Read the guide and contracts
for the release you intend to install.

## Read the changes

Read every package's `CHANGELOG.md`, including each `Migration:` block between
your installed and target releases. Use the [per-release notes](#per-release-notes)
as the starting point; older entries may be in the package's
`CHANGELOG-HISTORY.md` at that release tag.

## Upgrade the packages together

Pin every `@openlup/*` package your application uses to the same exact version.
Choose the target release explicitly. With `OPENLUP_VERSION` set to that
version, an application using all the packages runs:

```sh
npm install --save-exact "@openlup/core@$OPENLUP_VERSION" "@openlup/outbox@$OPENLUP_VERSION" "@openlup/platform@$OPENLUP_VERSION"
```

Include only the packages your application uses, keeping their versions equal.
See [Keep the packages together](../start/adopt-from-npm.md#group-dependency-updates).

## Apply SQL through your migration chain

Apply the database changes your selected packages require through your
application's migration chain, as described in
[Upgrade the database](database-migrations.md). Importing a package does not
apply SQL.

## Reconcile application files

Plan, reconcile and apply snapshot-managed application files with
`openlup upgrade plan` and `openlup upgrade apply`, as described in
[Upgrade application files](application-files.md). These commands run no SQL
and do not observe the database.

## Check readiness

Create an application-owned module exporting `createVerificationInput()` that
returns your actual `ReadinessInput`: selected contributions, complete installed
package inventory, candidate identity, bindings and a read-only schema observer.
Set `APP_OBSERVATIONS` to its path, then run:

```sh
./node_modules/.bin/openlup verify --app "$APP_OBSERVATIONS" --json
```

The command imports explicitly trusted application code without a sandbox.
That module must assemble observations and read-only probes, avoid writing to
stdout, and close its resources. Verification invokes only the supplied schema
observer; it does not execute handlers, routes, schedules, migrations or installs.
It does not prove SQL behavior, permissions, provider delivery or live scheduling.

Only `ready` admits the exact candidate; retain the serving candidate for
`unknown` or `unsatisfied`. Repair findings and rerun verification with fresh
observations after changing artifacts, configuration or schema.

| Exit code | Meaning |
| --- | --- |
| `0` | Upgrade completed without conflicts, or verification reports `ready`. |
| `1` | Upgrade conflicts, or verification reports `unsatisfied`. |
| `2` | Verification reports `unknown`. Without `--app`, `OPENLUP_E_APP_UNKNOWN` explains that no application observations were loaded. |
| `64` | Invalid invocation or JSON: `OPENLUP_E_CLI_INPUT`. Correct the syntax or input. |
| `74` | Operation or application-loading failure: `OPENLUP_E_CLI_FAILURE`. Check snapshots, filesystem access or the trusted application module. |

Upgrade conflicts report paths and reasons without a named refusal code.
Snapshot validation failures after JSON parsing can return `74`.
Readiness findings use `OPENLUP_E_PORT_MISSING`, `OPENLUP_E_EVENT_UNHANDLED`,
`OPENLUP_E_EVENT_DUPLICATE`, `OPENLUP_E_SCHEDULE_UNBOUND`,
`OPENLUP_E_SCHEMA_BEHIND`, `OPENLUP_E_SET_MISMATCH` or `OPENLUP_E_ENV_MISSING`.
Each finding includes an observation, cause, fix and recheck instruction.

## Per-release notes

Each release's notes are the packages' changelogs, linked at the release tag:
[core](https://github.com/openlup/openlup/blob/openlup-core-v0.42.0/packages/core/CHANGELOG.md),
[outbox](https://github.com/openlup/openlup/blob/openlup-core-v0.42.0/packages/outbox/CHANGELOG.md)
and [platform](https://github.com/openlup/openlup/blob/openlup-core-v0.42.0/packages/platform/CHANGELOG.md).
[Upgrading to 0.42.0](v0-42-0.md), [Upgrading to 0.41.0](v0-41-0.md) and
[Upgrading to 0.40.0](v0-40-0.md) each gather
that release's notes and API report changes.

## Preparing for native provider profiles

The unreleased 0.43.0 source candidate replaces native provider identity
predicates with immutable profile data. Apply the complete selected catalogue,
including `20261121090000_payment_provider_profiles.sql`, through your existing
migration runner. Do not replace historical slots or rewrite stored payment
identity, evidence, receipts or payloads. Installing packages alone applies no SQL.

The two reference profiles preserve existing preparation, claims, refund and
reopening rules. Arbitrary admitted providers retain generic behavior; claims and
reopening require an explicit profile declaration. A third provider needs its
profile declaration plus adapter. The second reference provider's portable
composition remains unsupported. Absence auto-reopen stays off by default;
provider activation and live qualification remain separate.
