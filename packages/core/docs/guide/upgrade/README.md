# Upgrade an application

Move your application to the next OpenLup release while reconciling package,
SQL and application-file changes.

Read the [stability policy](../reference/stability.md) and contracts for the
release you intend to install, including the [database compatibility limits](database-migrations.md#check-application-compatibility).

## Read the changes

Read every package's `CHANGELOG.md`, including each `Migration:` block between
your installed and target releases. Use the [per-release notes](#per-release-notes)
as the starting point; older entries may be in the package's
`CHANGELOG-HISTORY.md` at that release tag.

## Starter upgrade order

For each adjacent release hop in a starter application:

1. Stop the application and keep exclusive access to its files.
2. Install the exact target release's `openlup` CLI in a separate scratch
   directory or pristine target extraction. Use that CLI for this hop.
3. Reconcile owned files as directed by the [target release notes](#per-release-notes)
   and prepare the exact predecessor and target snapshots. Follow the
   [snapshot instructions for a customized inventory](#reconcile-a-customized-ownership-inventory)
   if you changed `ownership.json`.
4. Apply any documented pre-file SQL through your migration chain, including
   the [native checkout-attempt ledger prerequisite](database-migrations.md#check-application-compatibility)
   when applicable. If range admission needs a supported forward, apply it
   through the same chain. Observe the applied migration count after any
   such forward, using the actual database and installation profile.
5. [Reconcile application files](#reconcile-application-files) using the target
   CLI. Plan, resolve the reported conflicts and replan. Apply the final
   snapshot pair and confirm replay makes no further changes. Finish any
   [ownership inventory reconciliation](#reconcile-a-customized-ownership-inventory)
   before refreshing dependencies.
6. Refresh the application's package pins, lockfile and installation to match
   the reconciled manifest. Pin every `@openlup/*` package in use to the same
   exact target version.
7. Complete the remaining documented SQL and explicit policy installation
   steps. [Check readiness](#check-readiness) before restarting the application.

## Upgrade the packages together

For an npm-only upgrade, pin every `@openlup/*` package your application uses to
the same exact version.
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
[Upgrade application files](application-files.md). Supply the applied migration
count observed for the actual database and installation profile. These commands
run no SQL and do not observe the database.

Use `--json` for a structured report.
For a target CLI up to and including 1.3.0, read `plan.conflicts` from `upgrade plan`
and top-level `conflicts` from a refused `upgrade apply`; from 1.4.0, read the
top-level `conflicts` key from both.

### Reconcile a customized ownership inventory

1. When preparing snapshots, save your application's `ownership.json`. Build them from
   the exact predecessor and target extractions. Exclude generated and locally
   owned paths, including ejected copies. Include new owned files only as
   documented target-only creations in the [target release notes](#per-release-notes).
2. During file preflight, restore the exact predecessor `ownership.json` in the
   app. Resolve the reported conflicts, including an
   [occupied settings binding path](v1-3-0.md#discover-and-check-the-starters-owned-settings)
   when applicable, and replan before apply writes any files. Keep the final
   pair identical for apply, resume and replay.
3. After replay, reattach the saved app-owned entries and exclusions to the
   resulting inventory. Check that the app's owned and generated paths stay
   out of its managed list. Use fresh predecessor and target evidence for each hop.

## Check readiness

If your app has an owned settings binding, validate its business configuration
offline with `./node_modules/.bin/openlup settings check --app ./owned/settings-host.ts`
or pass `check` to your starter's `settings` script. Do this before running full
tests and starting the application. See [Configure settings](../how-to/operate/configure-settings.md).

If your custom readiness observer calls the starter's native composition,
see the [1.2.0 argument order](v1-2-0.md#update-custom-native-readiness-observers).

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

From 1.4.0, upgrade findings name schema-range conflicts as
`OPENLUP_E_UPGRADE_SCHEMA_RANGE` and managed-file conflicts as
`OPENLUP_E_UPGRADE_FILE_CONFLICT`. Snapshot validation failures after JSON
parsing can return `74`.
Readiness findings use `OPENLUP_E_PORT_MISSING`, `OPENLUP_E_EVENT_UNHANDLED`,
`OPENLUP_E_EVENT_DUPLICATE`, `OPENLUP_E_SCHEDULE_UNBOUND`,
`OPENLUP_E_SCHEMA_BEHIND`, `OPENLUP_E_SET_MISMATCH`, `OPENLUP_E_ENV_MISSING`
or `registry_missing_referenced_version`.
Each finding includes an observation, cause, fix and recheck instruction.

## Per-release notes

Each release's notes are the packages' changelogs, linked at the release tag:
[core](https://github.com/openlup/openlup/blob/openlup-core-v1.3.0/packages/core/CHANGELOG.md),
[outbox](https://github.com/openlup/openlup/blob/openlup-core-v1.3.0/packages/outbox/CHANGELOG.md)
and [platform](https://github.com/openlup/openlup/blob/openlup-core-v1.3.0/packages/platform/CHANGELOG.md).
[Upgrading to 1.3.0](v1-3-0.md),
[Upgrading to 1.2.0](v1-2-0.md),
[Upgrading to 1.1.0](v1-1-0.md), [Upgrading to 1.0.0](v1-0-0.md), [Upgrading to 0.43.0](v0-43-0.md), [Upgrading to 0.42.0](v0-42-0.md), [Upgrading to 0.41.0](v0-41-0.md) and
[Upgrading to 0.40.0](v0-40-0.md) each gather
that release's notes and API report changes.

## Preparing for native provider profiles

The 0.43.0 release replaces native provider identity
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
