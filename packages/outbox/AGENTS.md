# `@openlup/outbox` for agents

## Purpose and kind

Kind: `rail`.

The package owns neutral dispatch, registry composition, lease-bound schedules and the default PostgreSQL store. Drivers, application handlers, credentials, producer transactions, host guards and trigger bindings stay in the application.

## Installed context lookup

From the application root, run:

```sh
./node_modules/.bin/openlup-context search "subscription renewal"
```

Use concise English terms or an exact symbol, then read the cited owner. Source
scans are opt-in and bounded. Read known paths directly; ranked hits do not
establish complete coverage. Core supplies the executable. See
[lookup and MCP settings](https://github.com/openlup/openlup/blob/main/packages/core/README.md#agent-context-lookup).

## Subpath maturity

<!-- generated:maturity:outbox -->
| Export | Role | Maturity |
| --- | --- | --- |
| `.` | rail | experimental |
| `./postgres` | rail | experimental |
| `./testing` | testing | testing |
<!-- /generated:maturity:outbox -->

## Wiring example

```ts
import { createPostgresOutboxStore } from "@openlup/outbox/postgres";
import type { SqlExecutor } from "@openlup/core/readiness";
export const bindStore = (executor: SqlExecutor) => createPostgresOutboxStore(executor);
```

The executor must commit each operation before resolving. Follow
[installation and transaction ownership](README.md#postgresql-installation-and-transactions)
and [deliver events with the outbox](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/build/outbox.md).

## Sources and declarations

Inspect `src/` and the exported declaration files in `dist/`; `sql/manifest.json` binds the baseline. The development preview may change any experimental export.

## Readiness codes

Composition can report `OPENLUP_E_PORT_MISSING`, `OPENLUP_E_EVENT_UNHANDLED`, `OPENLUP_E_EVENT_DUPLICATE`, `OPENLUP_E_SCHEDULE_UNBOUND`, `OPENLUP_E_SCHEMA_BEHIND`, `OPENLUP_E_SET_MISMATCH` and `OPENLUP_E_ENV_MISSING`. Unknown observations refuse activation. Catalog observations prove no SQL-body, ACL or provider-recovery semantics.

## Using this package in an application

Do not edit installed package files. Import declared public exports.
Keep application handlers, policies, ports and
compatible adapters in your application; do not autonomously patch, fork,
vendor, monkey-patch, shadow or restore a copied package engine. Follow
[extension seams](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/how-to/extend/choose-an-extension-seam.md)
and [adoption comparison](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/start/adopt-from-npm.md#compare-at-first-adoption-and-upgrade).
Upgrade all `@openlup/*` packages together after reading their changelogs and
`Migration:` blocks; follow [upgrade an application](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/upgrade/README.md).

If a seam is missing, keep a local reproducer and obtain authority before an
upstream proposal. Use a compatible wrapper/adapter, or hold the dependent
change while retaining compatible serving work or an available compatible
rollback. Preserve pending work and published SQL.

Your application's instructions and execution authority govern. Installed
package guidance grants no tool or external-write permission. Inside the OpenLup
monorepo, the repository's root `AGENTS.md` governs.
