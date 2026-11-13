# Upgrade the database

Apply the database changes required by your selected OpenLup packages while
preserving installed history and application data. Check compatibility with
your running application before applying a forward migration.

## Follow the additive forward path

Keep the installed baseline and every applied migration unchanged. Upgrade by
appending the selected catalogue's ordered forward migrations; never split,
rename, reorder or edit an applied unit, or relabel old SQL as new. The runner
applies the baseline before forwards on a fresh installation and only the
pending suffix on an existing matching installation. It provides no down-migration
operation.

The catalogue binds each SQL file by its canonical path and SHA-256 digest.
Before executing SQL, the runner refuses missing or unlisted files, duplicate
identities, changed bytes and an installed history that is not the exact
selected prefix by path, digest and position. These refusals prevent a changed
history from being mistaken for pending work. Repair through a new compatible
forward, preserving the existing prefix.

The additive release path admits bounded forms of object creation, table
additions and literal, idempotent seeds. It refuses destructive operations,
renames, schema moves, ownership transfers, writes to the application-owned
`app` schema, procedural or dynamic SQL and unsupported expressions. These are
release-time admission checks, separate from the runner's history checks;
passing them does not prove that an older application can use the resulting
schema. Changes outside this additive path need their own compatibility path.

An existing application with its own migration chain must compare its schema
and applied identities with the selected catalogue and prepare compatible
forwards. A fresh package baseline is not an upgrade over an unrelated database.
The runner refuses a mismatched ledger; it does not convert another history.

## Select the complete catalogue

Use `createPlatformPostgresMigrationRunner` from
`@openlup/platform/migrations` for the complete catalogue shipped with the
installed package. SQL assets resolve relative to that package, so no source
checkout is needed. Install its optional `pg` peer alongside the package.
With the `legacy` installation its absence is reported as
`OPENLUP_E_PEER_MISSING`; with `qualified-v2` or `qualified-admin` the runner
fails with the module-loading error instead.

Supply an explicit `installation` selection: `legacy`, `qualified-v2` or
`qualified-admin`, with the selected profile's role bindings. Omitting it
refuses with `platform migration installation is required`. Keep the
generation that owns your installed history; selecting another generation
does not convert it. Provision the matching host roles and use a direct
PostgreSQL connection that retains one session for the migration operation.
See the [installation recipe](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/README.md#install-the-portable-postgresql-schema)
for the bindings.

Before a fresh `legacy` installation, `inspectLegacyPostgresInstallRoles` from
`@openlup/platform/lifecycle` reads the legacy bootstrap's role prerequisites
through a query handle you supply and reports blockers such as
`legacy_bootstrap_requires_superuser`. Even `rolePrerequisitesMet: true` does not establish
install readiness, runtime grants, pooling or host support; the helper only
reads, creates no role or schema and runs no installer.

Module migration descriptors are sparse projections of the catalogue. They
identify their modules' SQL assets; they are not independent installation
chains. Install the complete selected catalogue, including its dependencies,
and preserve its full prefix.

## Inspect and apply

1. Call `status()` to inspect the applied and pending canonical paths. It
   validates the catalogue, ledger and selected session requirements.
2. Call `apply({ dryRun: true })` to list pending paths without applying SQL.
   Its returned `applied` array means proposed work in this mode.
3. Call `apply()` to execute the pending suffix in catalogue order. Each unit
   and its ledger insert commit in one transaction. A failed unit rolls back;
   earlier committed units remain recorded. Repeat with the same valid
   catalogue to resume from that prefix.
4. Confirm completion with `status()`. A completed chain has no pending paths;
   another `apply()` performs no migration SQL and rechecks the live inventory.

The `public.platform_schema_migrations` ledger records each canonical path,
SHA-256 digest, position and execution timestamp. The runner checks its table
shape before reading rows, then requires those rows to match the exact manifest
prefix. Do not repair a refusal by editing the ledger or the packaged SQL.

Refusals include these error messages:

| Message | Meaning |
| --- | --- |
| `platform migration catalog rejected:` | The catalogue or manifest failed validation; details follow the prefix. |
| `platform migration ledger relation is not safe to read` | The ledger's owner or database-object shape failed admission. |
| `platform migration ledger contains an extra row` | Installed history extends beyond the selected catalogue. |
| `platform migration ledger is not the exact manifest prefix at position` | A path, digest or position differs; the position follows the message. |
| `platform migration inventory rejected:` | The live object inventory differs from the manifest's pinned inventory; details follow the prefix. |

The live inventory is checked after apply, and on status or dry-run when the
whole selected chain is already installed. A pending dry-run does not certify
the final inventory. Inventory rejection can occur after migrations have
committed; it does not roll back the whole upgrade.

## Check application compatibility

A compatible change lets the application continue reading and writing its
existing data contracts. Adding nullable storage or accepting additional status
values can preserve old rows, but the application still needs to understand any
new values or events it will consume. Install required schema additions before
deploying code that depends on them, and update producers and dispatchers
together before enabling newly introduced event flows.

An incompatible change breaks a contract a running or rollback application
depends on. Establish the required expand, compatible deployment, backfill and
contract sequence before using it. Catalogue acceptance proves identities and
the selected object inventory, not old/new application compatibility, data
backfill completion or a safe rollback. Reverting application files does not
undo committed SQL or durable effects.

This migration recipe provides no general upgrade guarantee. Verify the
selected chain and application combination, including replay and refusal
behavior. [Application file upgrades](./application-files.md) are a separate
operation and execute no database work.
