# Command line

Find command syntax and help for the installed tools.

## `openlup`

`@openlup/platform` installs the `openlup` bin.

<!-- generated:cli:openlup -->
```text
openlup upgrade plan|apply --root DIR --from SNAPSHOT.json --to SNAPSHOT.json --schema-version N [--json]
openlup verify [--app ./application-observations.mjs] [--json]
openlup catalogue schema [--json]
openlup catalogue check --packs ./owned/catalogue.json [--json]
openlup catalogue project --trusted-packs ./owned/catalogue.ts [--json]
openlup settings list|show|preview|explain [--help] [--json] (experimental)
openlup settings mcp [--app <module>] [--configuration <id>] [--database-url <url>] (experimental, read-only stdio)
openlup settings check --app <module> [--configuration <id>] [--json] (experimental, offline)
openlup recipe list|show|add|scaffold|verify [--help] [--json] (experimental)

Upgrade snapshots use the existing AppVersionSnapshot contract. All unlisted paths are application-owned; upstream-unchanged files preserve local edits. Apply requires an exclusive maintenance window. Rerun identical inputs to resume. No SQL, package installation or hooks run.
Verify loads no app implicitly. --app explicitly trusts and imports application code exporting createVerificationInput(); that module must only assemble observations and read-only probes, must not write stdout, and must close its own resources before returning/report completion. The CLI does not sandbox that module. Only the supplied schema observer is invoked by diagnosis; routes and jobs never run.
Catalogue check reads inert JSON. Catalogue project imports an explicitly trusted module exporting catalogueConformance with the operator’s process permissions and checks an external scratch subject. PASS grants no install, migration, publication or activation authority.
Settings reads the catalogue offline by default. Connected show and preview use --database-url and explicit --app bindings where needed. Preview takes --value <json> or --value - for stdin. Settings JSON uses schemaVersion=1. A completed preview with an invalid policy exits 0, refusals exit 1, invalid syntax/input exits 64, and unavailable operations exit 74. For settings check, a missing app module or factory export exits 74, while a module that throws during loading or binding exits 1 with the cause.
Recipe commands discover, inspect, scaffold, install into owned/adapters/<domain>/<provider>, and offline-verify (manifest parity, recipe-contract isolation, platform SemVer range, and Stages 1-3 Vitest suites) provider recipes. Passing offline Stages 1-3 never claims Stage 4 live account readiness.
Exit codes: 0 satisfied/completed, 1 unsatisfied/conflict, 2 unknown, 64 invalid invocation/JSON, 74 unavailable operation. JSON uses formatVersion=1, one object on stdout.
```
<!-- /generated:cli:openlup -->

For a parsed `upgrade plan` or `upgrade apply` report, read conflicts from
the top-level `conflicts` array. It is empty when the command establishes no
conflicts. Each entry retains its `path` and `reason`. Schema-range conflicts
use an empty path. The report's findings give the code, observation, cause, fix
and recheck. See [Upgrade application files](../upgrade/application-files.md)
for the observed ordinal and recovery procedure.

`verify --app` withholds application exception details. A failure assembling
observations can include the fixed starter `OPENLUP_E_STARTER_STORE_CONFIG_REQUIRED`
diagnostic in the finding's cause. Pass the selected `StoreConfig` as argument
three of `composeNativeBindings` and the optional keyring as argument four.

## `openlup-context`

`@openlup/core` installs the `openlup-context` bin.

<!-- generated:cli:openlup-context -->
```text
Usage: openlup-context search <task> [--code] [--package-code] [--limit <1..50>] [--json]
       openlup-context mcp
Run from the application root after installing @openlup/core.
Declaration occurrences are unverified import leads; read installed exports and examples for public specifiers and type/value usage.
In a symbol's export hit, maturity is the declared maturity (stable, experimental or testing) and deprecated: true marks a deprecated symbol; maturity is absent when the declaration is not found or when no subpath maturity is known and no `@experimental` tag applies, so read the declaration.
```
<!-- /generated:cli:openlup-context -->
