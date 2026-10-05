# @openlup/outbox for agents

## Purpose and kind

Kind: `rail`.

The package owns neutral dispatch, registry composition, lease-bound schedules and the default PostgreSQL store. Drivers, application handlers, credentials, producer transactions, host guards and trigger bindings stay in the application. Inside the OpenLup monorepo the root `AGENTS.md` governs.

## Subpath maturity

| Export | Role | Maturity |
| --- | --- | --- |
| `.` | rail | experimental |
| `./postgres` | rail | experimental |
| `./testing` | testing | testing |

## Wiring example

The compiled npm-only reference proof uses the same factories at scheduled and immediate entries. A minimal store binding is:

```ts
import { createPostgresOutboxStore } from "@openlup/outbox/postgres";
import type { SqlExecutor } from "@openlup/core/readiness";
export const bindStore = (executor: SqlExecutor) => createPostgresOutboxStore(executor);
```

The executor must commit every operation before resolving. Apply shipped SQL through the application's migration chain and admit the candidate with the core checker before effects. The README explains full schedule, transaction and failure ownership.

## Sources and declarations

Inspect `src/` and the exported declaration files in `dist/`; `sql/manifest.json` binds the baseline. The development preview may change any experimental export.

## Readiness codes

Composition can report `OPENLUP_E_PORT_MISSING`, `OPENLUP_E_EVENT_UNHANDLED`, `OPENLUP_E_EVENT_DUPLICATE`, `OPENLUP_E_SCHEDULE_UNBOUND`, `OPENLUP_E_SCHEMA_BEHIND`, `OPENLUP_E_SET_MISMATCH` and `OPENLUP_E_ENV_MISSING`. Unknown observations refuse activation. Catalog observations prove no SQL-body, ACL or provider-recovery semantics.

## Using this package in an application

Do not edit `node_modules/@openlup/**`, patch packages or apply the monorepo's contributor process to your application. Change behavior through ports and composition. Copying source is ejection and makes its security, tests and upgrades yours. Upgrade every `@openlup/*` together after reading all `Migration:` blocks. Your application owns its own admission, delivery and production authority.
