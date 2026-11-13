# Command line

Find command syntax and help for the installed tools.

## `openlup`

`@openlup/platform` installs the `openlup` bin.

<!-- generated:cli:openlup -->
```text
openlup upgrade plan|apply --root DIR --from SNAPSHOT.json --to SNAPSHOT.json --schema-version N [--json]
openlup verify [--app ./application-observations.mjs] [--json]

Upgrade snapshots use the existing AppVersionSnapshot contract. All unlisted paths are application-owned; upstream-unchanged files preserve local edits. Apply requires an exclusive maintenance window. Rerun identical inputs to resume. No SQL, package installation or hooks run.
Verify loads no app implicitly. --app explicitly trusts and imports application code exporting createVerificationInput(); that module must only assemble observations and read-only probes, must not write stdout, and must close its own resources before returning/report completion. The CLI does not sandbox that module. Only the supplied schema observer is invoked by diagnosis; routes and jobs never run.
Exit codes: 0 satisfied/completed, 1 unsatisfied/conflict, 2 unknown, 64 invalid invocation/JSON, 74 operation or application loading failure. JSON uses formatVersion=1, one object on stdout.
```
<!-- /generated:cli:openlup -->

## `openlup-context`

`@openlup/core` installs the `openlup-context` bin.

<!-- generated:cli:openlup-context -->
```text
Usage: openlup-context search <task> [--code] [--package-code] [--json]
       openlup-context mcp
Run from the application root after installing @openlup/core.
```
<!-- /generated:cli:openlup-context -->
