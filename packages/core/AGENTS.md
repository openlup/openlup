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

`checkReadiness` from `./readiness` raises these codes. Each failure names the
package, the subject and a one-sentence fix, and the codes are public API.

| Code | Raised when |
| --- | --- |
| `OPENLUP_E_PORT_MISSING` | a manifest lists a required port that was not wired |
| `OPENLUP_E_EVENT_UNHANDLED` | a platform or manifest event type has no handler and no ignored or dormant declaration |
| `OPENLUP_E_EVENT_DUPLICATE` | two packages' manifests emit the same event type |
| `OPENLUP_E_SCHEDULE_UNBOUND` | a declared schedule has no host trigger |
| `OPENLUP_E_SCHEMA_BEHIND` | the schema probe finds a `requiredSchema` object missing |
| `OPENLUP_E_SET_MISMATCH` | loaded `@openlup/*` packages carry different versions |
| `OPENLUP_E_ENV_MISSING` | a manifest's environment variable is absent or blank |

An application runs the check before a new version takes traffic. A failure
refuses that version; it never stops a version that is already serving.

## Using this package in an application

- **Do not edit the installed package.** Do not change files under `node_modules/@openlup/`, and
  do not patch it with `patch-package`, `overrides` or a fork.
- **Change behaviour through seams.** Use this package's ports and options and your application's
  own composition. If a seam is missing, raise an upstream issue.
- **Copying source is ejection.** Copying this package's source into your application makes the
  copy yours, including its upgrades.
- **Upgrade every `@openlup/*` package together,** after reading each changelog's `Migration:`
  blocks.
- **Inside the OpenLup monorepo,** where this package is a workspace, the repository's root
  `AGENTS.md` governs instead.
