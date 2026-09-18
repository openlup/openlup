# platform-runtime (domain)

Provider-neutral **platform portability** seam (Platform Portability program). Lets openlup run on
the default **Vercel + Supabase** one-click bundle while allowing the hosting/services to be swapped
(Node/Docker self-host, S3, plain Postgres, …) via adapters — without forking.

## Owns
- `contracts.ts` — the bundle-id set this deployment actually supports
  (`PLATFORM_BUNDLE_IDS`, `PlatformBundleId`, `DEFAULT_PLATFORM_BUNDLE`), built
  on the guard factory and capability keys re-exported from
  `@openlup/core/platform-runtime`. The list is a deployment fact; the guard and
  the capability vocabulary are the engine's.
- `ports.ts` — pure re-export shim over the 7 package-owned capability port interfaces (`HttpRuntimePort`,
  `SchedulerPort`, `BlobStoragePort`, `DataGatewayPort`, `MigrationRunnerPort`, `AnalyticsPort`,
  `TransactionalRuntimePort`). Stable seams; real adapters live under `server/adapters/*`.

## Where the code lives
⚠️ **The engine is not in this directory.** It lives in
`packages/core/src/platform-runtime/` and is imported through the
`@openlup/core/platform-runtime` package export: the capability port interfaces,
the `PlatformCapability` keys, and `createPlatformBundleIdGuard`. A behaviour
change belongs there, never in a local shim.

- Engine: `packages/core/src/platform-runtime/` (`@openlup/core/platform-runtime`)
- Shared/frontend: `src/domains/platform-runtime/` (shims + the local bundle list)
- Server: `server/domains/platform-runtime/platformKernel.ts` (kernel shim) and
  a deployment-owned composition root described in `docs/platform/RUNTIME_AND_SELF_HOSTING.md`

## Does NOT own
- The kernel compatibility shim: `server/domains/platform-runtime/platformKernel.ts`.
- The deployment-owned composition root that binds adapters per bundle.
- Concrete adapters/infra: `server/adapters/<provider>/*`, `server/infra/<provider>/*` (added by later waves).

## Invariants
- No infra imports here (`server/infra/*`, `@vercel/*`, `@supabase/*`) — enforced by
  `src/lib/platformRuntimeBoundary.test.ts`.
- The default `vercel-supabase` bundle is byte-identical to pre-program behavior (golden-master gate).
- Bundle selection is **explicit** via the `PLATFORM_BUNDLE` env only — never inferred from other values.
