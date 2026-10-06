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

Keep the dispatch engine in its authentic npm package. Do not edit
`node_modules/@openlup/**`, autonomously patch/fork/vendor/monkey-patch/shadow the
package or restore a copied engine. Use declared public exports. Drivers,
handlers, policies, host bindings and compatible native stores remain ordinary
application code; they need no record per function or upstream release.

The public `withPayloadSchema`, `composeHandlers` and `uniqueRegistry` seams keep
handler policy and effects in the application. The [README](README.md) explains
retry, transaction, fence and admission obligations; `./testing` supplies the
store-fence check, not complete adapter or absorption proof. A missing seam needs
a local reproducer and authorized upstream proposal. Use a supported compatible
wrapper/adapter, or hold the dependent change while retaining compatible serving
work or an available compatible rollback. Do not rewrite published SQL or lose
pending obligations.

Upgrade every `@openlup/*` together after reading all `Migration:` blocks. Compare
current producer/schema/policy/bindings with the actual target at first adoption
and upgrade. Settle affected nominations as full, partial, retained or hold using
capability and durable-effect evidence, including dormant branches and retry;
keep distinct same-event effects. Move or settle open markers when native code is
refactored even without pin changes. A merged contribution is not adoption proof.

This guide describes the installed contract; it grants no host/tool/external-write
authority and installs no controls. The monorepo's contributor process does not
govern your application. Your application owns admission, delivery and production
authority. The [README's adoption route](README.md#adoption-and-native-extensions)
links optional source guidance; later instructions do not change this version.
