# Command line

Find command syntax and help for the installed tools.

## `openlup`

`@openlup/platform` installs the `openlup` bin.

<!-- generated:cli:openlup -->
```text
openlup upgrade plan|apply --root DIR --from SNAPSHOT.json --to SNAPSHOT.json --schema-version N [--json]
openlup verify [--app ./application-observations.mjs] [--json]
openlup catalogue check --packs ./owned/catalogue.json [--json]
openlup catalogue project --trusted-packs ./owned/catalogue.ts [--json]
openlup settings list|show|preview|explain [--help] [--json] (experimental)
openlup settings mcp [--app <module>] [--configuration <id>] [--database-url <url>] (experimental, read-only stdio)
openlup settings check --app <module> [--configuration <id>] [--json] (experimental, offline)
openlup recipe list|show|add|verify [--help] [--json] (experimental)

Upgrade snapshots use the existing AppVersionSnapshot contract. All unlisted paths are application-owned; upstream-unchanged files preserve local edits. Apply requires an exclusive maintenance window. Rerun identical inputs to resume. No SQL, package installation or hooks run.
Verify loads no app implicitly. --app explicitly trusts and imports application code exporting createVerificationInput(); that module must only assemble observations and read-only probes, must not write stdout, and must close its own resources before returning/report completion. The CLI does not sandbox that module. Only the supplied schema observer is invoked by diagnosis; routes and jobs never run.
Catalogue check reads inert JSON. Catalogue project imports an explicitly trusted module exporting catalogueConformance with the operator’s process permissions and checks an external scratch subject. PASS grants no install, migration, publication or activation authority.
Settings reads the catalogue offline by default. Connected show and preview use --database-url and explicit --app bindings where needed. Preview takes --value <json> or --value - for stdin. Settings JSON uses schemaVersion=1. A completed preview with an invalid policy exits 0, refusals exit 1, invalid syntax/input exits 64, and unavailable operations exit 74. For settings check, a missing app module or factory export exits 74, while a module that throws during loading or binding exits 1 with the cause.
Recipe commands discover, inspect, install into owned/adapters/<domain>/<provider>, and offline-verify (manifest parity, ADR-001 isolation, platform SemVer range, and Stages 1-3 Vitest suites) provider recipes. Passing offline Stages 1-3 never claims Stage 4 live account readiness.
Exit codes: 0 satisfied/completed, 1 unsatisfied/conflict, 2 unknown, 64 invalid invocation/JSON, 74 unavailable operation. JSON uses formatVersion=1, one object on stdout.
```
<!-- /generated:cli:openlup -->

## `openlup-context`

`@openlup/core` installs the `openlup-context` bin.

<!-- generated:cli:openlup-context -->
```text
Usage: openlup-context search <task> [--code] [--package-code] [--limit <1..50>] [--json]
       openlup-context mcp
Run from the application root after installing @openlup/core.
Declaration occurrences are unverified import leads; read installed exports and examples for public specifiers and type/value usage.
```
<!-- /generated:cli:openlup-context -->
