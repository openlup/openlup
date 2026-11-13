# @openlup/outbox for agents

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

Read [application ownership](https://github.com/openlup/openlup/blob/openlup-core-v0.40.0/packages/core/docs/guide/start/adopt-from-npm.md#keep-application-ownership)
and [extension seams](https://github.com/openlup/openlup/blob/openlup-core-v0.40.0/packages/core/docs/guide/how-to/extend/choose-an-extension-seam.md).

Public handlers, policies, ports and compatible adapters need no per-function
record or upstream release. A missing seam needs a local reproducer and actual
submission authority; retain compatible serving work or a rollback compatible
with durable state while holding the dependent change. Preserve pending work and
published SQL. A guide or review receipt grants no tool or external-write rights.

First adoption and upgrade compare the actual artifact with current producer
payloads, schema, policy and bindings, including disabled branches and drift
outside extracted files. Preserve transactional enqueue, claim/acknowledgement
fences, distinct same-event effects and durable recovery. Settle nominated overlap
as `full`, `partial`, `retained` or `hold` in existing adoption evidence; move or
settle same-ID markers during ordinary refactors too. Matching APIs or a merged
contribution do not establish absorption. Read all `Migration:` blocks and keep
the exact `@openlup/*` set together.

The application owns its instructions and execution authority. Inside the
OpenLup monorepo, root `AGENTS.md` governs.

The implementation seams are `withPayloadSchema`, `composeHandlers` and
`uniqueRegistry`; `./testing` checks store fencing, without replacing complete
adapter or absorption proof. Installed bytes under `node_modules/@openlup/**`
remain the dispatch engine: do not autonomously patch, fork, vendor, monkey-patch,
shadow resolution or restore a copied engine. Import only declared exports.
