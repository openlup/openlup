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
See [Keep the packages together](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/docs/platform/adopter-kit/README.md#keep-the-packages-together).

## Apply SQL through your migration chain

Read the shipped [platform manifest](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/sql/manifest.json)
and [outbox manifest](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/outbox/sql/manifest.json)
for the SQL paths and hashes. Apply the complete catalogue selected for your
existing installation through your application's migration chain; a sparse
module projection is not a standalone installation chain.

Keep applied SQL unchanged and add forward migrations in order. Use additive
expansion, compatible application changes and resumable backfill before any
later contraction. Code rollback must remain compatible with the expanded
schema; destructive down migrations are not a rollback plan.

Do not apply the outbox fresh-install baseline over an existing managed schema.
Importing a package does not apply SQL. Follow the
[data and migration contract](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/docs/platform/DATA_AND_MIGRATIONS.md#module-catalogues-and-installed-histories)
and the [outbox installation boundary](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/outbox/README.md#postgresql-installation-and-transactions)
for your selected history.

## Reconcile application files

The installed platform package supplies `openlup upgrade plan` and
`openlup upgrade apply`. They read explicit predecessor and target JSON
snapshots plus the application files named in those snapshots. Each snapshot
has a nonblank `version`, a `schema` range with inclusive `min` and `max`, and
`files`, a record mapping relative paths to exact UTF-8 file contents.

Set `APP_ROOT` to your existing application directory, `FROM_SNAPSHOT` and
`TO_SNAPSHOT` to those JSON files, and `SCHEMA_VERSION` to your observed
nonnegative schema ordinal. Both snapshots must admit that ordinal; these
commands do not observe the database.

```sh
./node_modules/.bin/openlup upgrade plan --root "$APP_ROOT" --from "$FROM_SNAPSHOT" --to "$TO_SNAPSHOT" --schema-version "$SCHEMA_VERSION" --json
```

Planning reads without writing. Review its file actions and conflicts.
Unlisted paths remain application-owned; files unchanged between snapshots
preserve local edits. Changed files must match predecessor or target bytes.
Schema-range mismatches, symlinks and invalid managed file structures also
produce conflicts. Conflicts return exit code `1`; apply refuses before writing.
Reconcile affected paths and rerun with the same snapshots.

Hold exclusive access to the application tree before applying:

```sh
./node_modules/.bin/openlup upgrade apply --root "$APP_ROOT" --from "$FROM_SNAPSHOT" --to "$TO_SNAPSHOT" --schema-version "$SCHEMA_VERSION" --json
```

Apply creates, replaces or removes snapshot-managed files. It runs no SQL,
package installation, deployment, version-marker update or hooks. The complete
operation is not atomic: after an I/O failure, rerun identical snapshots under
exclusive access to recognize files already applied.

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
[core](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/core/CHANGELOG.md),
[outbox](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/outbox/CHANGELOG.md)
and [platform](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/CHANGELOG.md).
