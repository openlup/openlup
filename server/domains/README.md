# Server-side domain layer

Status: source-of-truth
Owns: the layering contract for `server/domains/*` - what a server domain
directory may contain, what it must delegate, and where the composition roots
that call it live.
Does not own: any individual domain's semantics (each
`server/domains/<domain>/README.md` or `src/domains/<domain>/README.md` owns
that), the provider adapter contract (`server/adapters/README.md`), or the
deployment-specific provider client contract (the public boundary is in
[Architecture and extension boundaries](../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md)).
Watches: `server/domains`, `server/bff`, `packages/core/src`
Verified against `fa8ae1f8881c176108f35f928d13489b8b5295f6` (2026-09-04) -
scope: the current directory and composition-root inventory below, re-derived
from `find server/domains -maxdepth 1 -type d`,
`find server/bff -maxdepth 1 -type d`, `api/bff/[...path].ts`,
`find api/_cron -maxdepth 1 -type f`, and
`find packages/core/src -maxdepth 1 -type d`. The inventory is 25 server
domains, 15 core domains, and the same twelve shared engine/orchestration
domains named below. The 222 changed files in those paths since `302e74593`
were assessed for directory-inventory impact in this re-read. Individual domain semantics, handler internals,
and the rules list were not re-proved beyond confirming that the paths they name
exist.

`server/domains/<domain>` contains server-only handler factories, use-case
orchestration, auth helpers, and persistence/provider-neutral ports. It is
HTTP-independent: nothing here reads a route, a request object, or a hosting
runtime.

## Layers

- `src/domains/<domain>` owns browser-safe contracts, public types, ports, and
  typed BFF clients.
- `server/domains/<domain>` owns HTTP-independent handlers and services over
  those contracts and ports.
- `server/bff/<domain>` owns route composition: request/response objects,
  auth/session wiring, env checks, database-client construction, provider
  adapter injection, and `withObservedRoute` metadata. This is where a route
  actually lives.
- `api/bff/[...path].ts` is only the dispatcher. It imports the default export
  of each `server/bff/*` route module and maps it to a path; it contains no
  domain logic. `api/_cron/*` is the equivalent composition root for scheduled
  and manually invoked jobs.
- `server/infra/*` owns provider clients, env readers, mappers, verifiers, and
  sanitized provider errors.
- `server/adapters/*` owns execution adapters that implement local domain ports.

## Engine Location

Twelve of these server domains orchestrate a portable kernel that no longer
lives here. Where `packages/core/src/<domain>` exists, that directory is the
engine and this one is the orchestration around it: persistence, leases, ports,
and the decision to call. On this tree those twelve are `bundle`, `catalog`,
`company-identity`, `fulfillment`, `inventory`, `marketing`, `partners`,
`payment`, `platform-runtime`, `risk`, `shipping`, and `subscription`
(the set where both `server/domains/<d>` and `packages/core/src/<d>` exist).
A change to kernel behavior is a `packages/core` change, not a change here.
The local README for each domain carries its source ownership fact, including
the domains whose kernel reaches the server only through a re-export in
`src/domains/<domain>`.

## Rules

- Keep route files thin; put validation and use-case behavior in handler tests
  under `server/domains/<domain>`.
- Do not import provider clients directly into domain services. Inject
  provider-neutral ports, or compose provider clients at the BFF/cron boundary.
- Do not construct database clients in shared `src/domains/*` code.
- Do not return raw provider errors, tokens, buyer payloads, payment-provider
  payloads, or service-role details to browser responses or logs.

## Known non-neutrality

The composition roots named above are shaped by the current deployment's
hosting model: `api/bff/[...path].ts` and `api/_cron/*` are serverless function
entrypoints, and the request/response types they pass down come from
`server/_lib/types`. Domain code under `server/domains/*` does not import them
and is hosting-independent; an adopter replaces the composition roots, not the
domains. Hosting portability is an in-progress programme, so treat the
entrypoint shape as a current-deployment fact rather than a settled contract.

Most ownership docs live in `src/domains/<domain>/README.md`. Add a local
`server/domains/<domain>/README.md` only when the server surface has unusual
security, accounting, payment, auth, or operational risk.

## Public navigation and availability

Use [Architecture and extension boundaries](../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md)
for public ownership and extension seams, and the
[publication catalog](../../config/openlup-publication-catalog.json) for the
bounded public-source inventory. A repository path establishes source existence
at the reviewed commit; a listed `/api/...` value is a logical interface
coordinate. Mounting needs separate dispatcher or registry evidence, and even a
mounted reference interface is not proof that an adopter deployment exposes it.
