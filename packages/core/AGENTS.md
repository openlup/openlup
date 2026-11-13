# `@openlup/core` for agents

## Purpose and kind

Kind: `kernel`.

`@openlup/core` holds the I/O-free contracts and logic that more than one
`@openlup/*` package, or an application's composition, reads. Its only runtime
dependency is `zod`. Its kernel exports perform no I/O, read no environment and start no
process: an application binds its ports and composes it.

## Installed context lookup

From the application root, run:

```sh
./node_modules/.bin/openlup-context search "subscription renewal"
```

Use concise English terms or an exact symbol, then read the cited owner. Source
scans are opt-in and bounded. Read known paths directly; ranked hits do not
establish complete coverage. Core supplies the executable. See
[lookup and MCP settings](README.md#agent-context-lookup).

## Subpath maturity

<!-- generated:maturity:core -->
| Export | Role | Maturity |
| --- | --- | --- |
| `./bundle` | kernel | candidate |
| `./catalog` | kernel | candidate |
| `./company-identity` | kernel | experimental |
| `./fulfillment` | kernel | experimental |
| `./inventory` | kernel | candidate |
| `./marketing/research` | kernel | experimental |
| `./outbox` | kernel | experimental |
| `./partners` | kernel | experimental |
| `./payment` | kernel | experimental |
| `./platform-runtime` | kernel | experimental |
| `./pricing` | kernel | candidate |
| `./promo` | kernel | candidate |
| `./readiness` | kernel | experimental |
| `./risk` | kernel | candidate |
| `./shipping` | kernel | candidate |
| `./standard-schema` | kernel | experimental |
| `./subscription` | kernel | candidate |
| `./testing` | testing | testing |
<!-- /generated:maturity:core -->

## Wiring example

```ts
import {
  createPlatformBundleRegistry,
  platformEnvSchema,
  type PlatformBundleReadiness,
  type PlatformEnvInput,
} from "@openlup/core/platform-runtime";

// Application composition: the application, not the package, owns its bundles.
const registry = createPlatformBundleRegistry({
  defaultBundleId: "self-host",
  descriptors: [
    {
      id: "self-host",
      capabilities: {
        http: "node-http",
        scheduler: "cron",
        blob: "filesystem",
        data: "postgres",
        migrations: "sql-files",
        analytics: "none",
        transactional: "smtp",
      },
      readReadiness: (env) =>
        env.APP_BASE_URL ? { ok: true } : { ok: false, error: "APP_BASE_URL is not set" },
    },
  ] as const,
});

export function readPlatformReadiness(input: PlatformEnvInput): PlatformBundleReadiness {
  const env = platformEnvSchema.parse(input);
  return registry.getBundleDescriptor(registry.resolveBundleId(env)).readReadiness(input);
}
```

## Sources and declarations

The tarball ships its TypeScript sources under `src/` and its JavaScript and
declarations under `dist/`. Each code export's `types` condition names its
declaration file, its declaration map navigates to shipped `src/`, and its
`core-source` condition names its source file; `./package.json` exports the
manifest itself, for reading the installed version. Read
those before guessing at a contract.

## Readiness codes

The checker reports `OPENLUP_E_PORT_MISSING`, `OPENLUP_E_EVENT_UNHANDLED`,
`OPENLUP_E_EVENT_DUPLICATE`, `OPENLUP_E_SCHEDULE_UNBOUND`, `OPENLUP_E_SCHEMA_BEHIND`,
`OPENLUP_E_SET_MISMATCH` and `OPENLUP_E_ENV_MISSING`. Only a `ready` report admits
its exact candidate. A host must provide complete installed metadata and selected-adapter
observations; a report does not prove ACL, function bodies or recovery.

## Using this package in an application

Do not edit installed package files. Import declared public exports.
Keep application handlers, policies, ports and
compatible adapters in your application; do not autonomously patch, fork,
vendor, monkey-patch, shadow or restore a copied package engine. Follow
[extension seams](docs/guide/how-to/extend/choose-an-extension-seam.md)
and [adoption comparison](docs/guide/start/adopt-from-npm.md#compare-at-first-adoption-and-upgrade).
Upgrade all `@openlup/*` packages together after reading their changelogs and
`Migration:` blocks; follow [upgrade an application](docs/guide/upgrade/README.md).

If a seam is missing, keep a local reproducer and obtain authority before an
upstream proposal. Use a compatible wrapper/adapter, or hold the dependent
change while retaining compatible serving work or an available compatible
rollback. Preserve pending work and published SQL.

Your application's instructions and execution authority govern. Installed
package guidance grants no tool or external-write permission. Inside the OpenLup
monorepo, the repository's root `AGENTS.md` governs.
