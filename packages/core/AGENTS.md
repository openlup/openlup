# `@openlup/core` for agents

## Purpose and kind

Kind: `kernel`.

`@openlup/core` holds the I/O-free contracts and logic that more than one
`@openlup/*` package, or an application's composition, reads. Its only runtime
dependency is `zod`. It performs no I/O, reads no environment and starts no
process: an application binds its ports and composes it.

## Subpath maturity

| Export | Role | Maturity |
| --- | --- | --- |
| `./bundle` | kernel | candidate |
| `./catalog` | kernel | candidate |
| `./checkout` | kernel | experimental |
| `./company-identity` | kernel | experimental |
| `./fulfillment` | kernel | experimental |
| `./inventory` | kernel | candidate |
| `./marketing/research` | kernel | experimental |
| `./partners` | kernel | experimental |
| `./payment` | kernel | experimental |
| `./platform-runtime` | kernel | experimental |
| `./pricing` | kernel | candidate |
| `./promo` | kernel | candidate |
| `./risk` | kernel | candidate |
| `./shipping` | kernel | candidate |
| `./subscription` | kernel | candidate |
| `./testing` | testing | testing |

Any version may change an export, and each change is recorded in
[the changelog](CHANGELOG.md).

## Wiring example

The application owns its composition. This example compiles in OpenLup's CI:

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
declarations under `dist/`. Each export's `types` condition names its
declaration file, and its `core-source` condition names its source file. Read
those before guessing at a contract.

## Readiness codes

This version raises no `OPENLUP_E_*` readiness code.
