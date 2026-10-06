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
| `./outbox` | kernel | experimental |
| `./readiness` | kernel | experimental |
| `./standard-schema` | kernel | experimental |
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

The checker reports `OPENLUP_E_PORT_MISSING`, `OPENLUP_E_EVENT_UNHANDLED`,
`OPENLUP_E_EVENT_DUPLICATE`, `OPENLUP_E_SCHEDULE_UNBOUND`, `OPENLUP_E_SCHEMA_BEHIND`,
`OPENLUP_E_SET_MISMATCH` and `OPENLUP_E_ENV_MISSING`. Only a `ready` report admits
its exact candidate. A host must provide complete installed metadata and selected-adapter
observations; a report does not prove ACL, function bodies or recovery.

## Using this package in an application

- **Do not edit the installed package.** Do not change files under `node_modules/@openlup/`, and
  do not autonomously patch, fork, vendor, monkey-patch, shadow or restore a copied package engine.
  Import only declared public exports, not internal source or `dist` paths.
- **Change behaviour through seams.** Application handlers, policies, ports, composition and
  compatible native adapters remain ordinary application code, without per-function records or
  an upstream release. Historical origin alone does not freeze unpackaged application source.
- **If a seam is missing,** record a local reproducer and obtain submission authority before an
  upstream proposal. A supported wrapper/adapter must preserve the contract. Otherwise hold
  the dependent change, keep compatible serving work or use an available compatible rollback;
  do not discard pending work or rewrite published SQL.
- **Guides describe the installed contract.** They grant no host policy, tool permission or
  external-write authority and install no controls. Your application's own instructions govern.
- **Upgrade every `@openlup/*` package together,** after reading each changelog's `Migration:`
  blocks.
  Compare the selected authentic artifact and current bindings at first adoption and upgrade,
  including drift outside extracted files, pending obligations and durable effects. Refresh
  identities/readiness and settle affected nominated overlap as full, partial, retained or hold
  in existing adoption evidence; move or settle open markers on ordinary refactors too.
  API equality or a merged contribution is not absorption proof. See the
  [application use guide](README.md#use-in-an-application) for the portable recipe.
- **Inside the OpenLup monorepo,** where this package is a workspace, the repository's root
  `AGENTS.md` governs instead.
