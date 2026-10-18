# @openlup/platform

Development preview. This package joins core and outbox in the publishable set from the next set version; this configuration does not establish a registry release or a stable API. Its repository-directory publish command refuses publication; the authorized package-release workflow owns publication.

It holds the runnable server substrate an OpenLup application composes: the Node HTTP runtime, BFF dispatch, scheduling and job leases, blob storage, data gateways, the node-postgres migration runner and bundle composition. Ports and their contracts stay in `@openlup/core/platform-runtime`.

## Package surface

`release-gates.json` declares kind `rail`: this foundation provides runtime infrastructure over core ports, matching the architecture's rail responsibility. Its eleven experimental entries each bind a declaration snapshot and package-owned smoke tests. The API checker reads this same inventory.

| Export | Contents |
| --- | --- |
| `./http` | Node request adaptation, deadlines, security headers and static documents, and `createNodeHttpRuntime` with its fixed request order |
| `./bff` | `createBffDispatcher`, `lazyBffRoute`, the hosted router URL rewrite, the response envelope (`createBffResponder`), the observed request context and the health route |
| `./scheduler` | Transport-neutral scheduled jobs (`ScheduledJob`, the job registry, the lease-aware runner and the authenticated HTTP cron entry), path-declared jobs from configuration, the node-cron scheduler with per-job advisory locks, hosted cron verification, the cron entrypoint guard (it compares the presented bearer token with `CRON_SECRET` in constant time) and direct job bindings |
| `./blob` | Filesystem, S3-compatible, Supabase Storage and Vercel Blob adapters, and `bindBlobPort` |
| `./data` | Supabase and node-postgres data gateways, the role-free transaction lane, the query builder and the data bindings |
| `./migrations` | The node-postgres `MigrationRunnerPort` |
| `./job-ledger` | The job-run ledger port, its PostgreSQL and managed (Supabase) adapters, the managed v2/v3 compatibility calls and the location of its SQL |
| `./kernel` | The bundle identifiers, descriptors and readiness |
| `./composition` | `createBundleComposer`, the Node HTTP binding helpers and `createNodeHost` |
| `./identity` | Experimental capability: identity engine, authorization, profile readers, session adapters and BFF factories |
| `./identity/contracts` | Experimental capability: browser-safe customer auth port, value types and provider parser |

## Scheduled jobs

A job is `{ id, schedule, lease?, run(context) }` with a UTC cron expression. Domains and packages contribute jobs to `createScheduledJobRegistry`, which refuses duplicate ids and ships empty. The Node host runs registry jobs on its own timers and calls `run` directly, with no HTTP request and no secret. `createScheduledJobHttpEntry` mounts the same job behind the cron guard for a hosted cron. A job that declares `lease` runs only after the injected job-lease port grants it; a lease held elsewhere skips the run, and a finish the port refuses fails the run. `scheduledJobsFromContribution` turns a contribution's cadence schedules into jobs and refuses a cadence that no cron expression matches exactly; a contribution run that reports a failed outcome fails the job.

## Bundle readiness

`PLATFORM_BUNDLE` selects `vercel-supabase` (the default when absent), `node-supabase` or `node-postgres`. A bundle's readiness refuses, before any traffic or timer: an unknown `PLATFORM_BUNDLE` (resolution itself still falls back to the default); a self-host bundle without `APP_BASE_URL`; and, reported together under `OPENLUP_E_ENV_MISSING`, every selected capability without its settings: the scheduler without `CRON_SECRET`, Node scheduling without `DATABASE_URL` for its cluster lock (never a silent single-instance lock), and the selected blob capability without its settings (see Blob storage). An unknown `PLATFORM_BLOB` is refused too. The Node host checks readiness at boot.

## Blob storage

`PLATFORM_BLOB` selects the blob capability; without it the bundle's own applies (filesystem for node-postgres, the local development default). `bindBlobPort` builds each one from the environment and the clients the application injects:

- `filesystem`: `BLOB_FS_ROOT`, `BLOB_FS_BASE_URL`;
- `s3`: `BLOB_S3_BUCKET`, `BLOB_S3_BASE_URL`, and a default client from `createS3ClientFromEnv` (`BLOB_S3_REGION`, `BLOB_S3_ENDPOINT`, `BLOB_S3_FORCE_PATH_STYLE`, `BLOB_S3_ACCESS_KEY_ID` with `BLOB_S3_SECRET_ACCESS_KEY`). `@aws-sdk/client-s3` is an optional peer loaded on first use, so only an application that selects S3 installs it;
- `supabase`: `BLOB_SUPABASE_BUCKET` and `BlobBindingDeps.supabaseStorageClient`, a factory returning the structural `SupabaseStorageClient` declared in blob. Blob itself reads no data-gateway settings. The default composer supplies this factory from the data-gateway settings and its optional `createSupabaseClient` dependency, using the service-role key with `persistSession: false` and `autoRefreshToken: false`. For this binding, a blank `SUPABASE_URL` falls back to `VITE_SUPABASE_URL`, consistently with readiness;
- `vercel-blob`: the injected `@vercel/blob` module and `BLOB_READ_WRITE_TOKEN`.

The Node host passes the composed ports, blob storage included, to the HTTP runtime builder and to the jobs contributed to it. The reference repository's compose file starts a local S3-compatible service with `--profile local-storage`; missing storage credentials refuse at service startup, while an omitted `OBJECT_STORAGE_PORT` selects an ephemeral loopback port. The inactive profile requires no storage settings. A conformance test runs upload, read-back, delete and access refusal against that image; initialization failure with Docker available fails the test. Hosted S3 provider certification is not claimed.

## What the application supplies

The package carries no deployment identity. The application passes it every value that names a deployment or a domain:

- the BFF route table, the not-found response, the request preflight and the per-request hook;
- how a request reference is chosen, and the health payload with its strict contract;
- the security header policy, including the content security policy, the production hosts and the robots.txt body;
- its own entrypoints, by exact path or by path rule;
- the job configuration file or object, the direct job bindings and the host admission check;
- the migration catalogue, the migration lock name and the object-inventory projector;
- the release correlation, default failure reason and read-failure messages that the job-run ledgers record;
- the environment, passed explicitly, and the provider clients it needs (the Supabase `createClient`, the `@vercel/blob` module, optionally its own PostgreSQL gateway factory), so the package itself reads no environment variable (an injected SDK may read its own credentials; the static and migration roots default to the working directory). Its optional SDK peers are `pg`, whose types its PostgreSQL declarations use, and `@aws-sdk/client-s3`, loaded lazily by the default S3 client. Blob declarations use structural types and need no S3 SDK;
- an optional scheduler profile for the Node host: a fenced projection of the declared jobs with its own bindings and validation hooks.

`createBundleComposer` binds the blob slot by default; pass `createBundleComposer({ createSupabaseClient })` to enable its Supabase Storage binding when the data-gateway settings and bucket are present. Without that client Supabase Storage stays unbound. A custom `blob` binder still overrides the default. The HTTP, scheduler, data, migrations, analytics and transactional slots stay `null` until the application supplies their binders; `createDataBindings` builds the data binder from the application's database client factory.

## Job-run ledger SQL

`JOB_RUN_LEDGER_MIGRATIONS` lists the two files a fresh installation applies, in order, through its own migration chain:

1. [`sql/20260809150000_job_run_ledger.sql`](sql/20260809150000_job_run_ledger.sql): the job controls, runs, and the v2 claim and finish; its bytes and migration identity equal the reference application's platform migration of that name.
2. [`sql/20260809150001_job_run_ledger_v3.sql`](sql/20260809150001_job_run_ledger_v3.sql): the v3 claim and finish the PostgreSQL ledger calls, as `CREATE OR REPLACE`, with bodies byte-equal to the reference chain's definitions.

The package SQL and the reference application's platform migration chain are alternative install paths, never applied together: the reference chain defines all four job-control functions itself, with plain `CREATE FUNCTION`, so it fails on a database where the package SQL already created them. The package file `20260809150001_job_run_ledger_v3` has a migration identity no reference migration uses. Importing the package never applies SQL.

## Optional peers

`pg`, `@types/pg` and `@aws-sdk/client-s3` are optional peers. Install `pg` and
`@types/pg` alongside this package when selecting PostgreSQL adapters; install
`@aws-sdk/client-s3` when selecting S3 blob storage. Loading an unselected adapter
never installs or initializes its SDK. The PostgreSQL scheduler lock also loads
`pg` only on its first operation.

A selected capability whose SDK is absent rejects its first loading operation
with `OPENLUP_E_PEER_MISSING: <package> is required by <capability>; install it
alongside @openlup/platform`. The original module-resolution error is the cause.
A broken SDK, a missing transitive dependency or a provider error propagates
unchanged. Blob `exists` retains its boolean contract and returns false on a
failed HEAD; use an upload or list operation to observe an S3 loading refusal.

## Verification

This package's tests are part of the repository's required test selection; from this directory, `npm test` runs them alone. The tests rewrite the originating application's characterization with neutral names and synthetic data, and a boundary test refuses any environment read or provider import in the package source.

The module-boundary proof permits one optional `./<module>/contracts` export
only when that module declares `contracts: true` in `PLATFORM_MODULE_GRAPH` in
[`eslint.config.js`](../../eslint.config.js). Its `types`, `import` and `default`
targets follow the module entry shape at `dist/<module>/contracts/index`.
Contracts files may import only their own contracts subtree through canonical
relative `.js` paths and exact public `@openlup/core` entries. Both ESLint and
[`packageBoundary.test.ts`](test/packageBoundary.test.ts) enforce this allowlist
for static imports and re-exports (including types) and literal `import()`;
they refuse non-literal `import()` targets. Both checks reserve the identifier
names `require`, `module`, `exports`, `process`, `globalThis`, `global`,
`__dirname`, `__filename` and `Buffer` in every value and type position,
including local and property identifiers, and refuse every use of `import.meta`.
This rejects loader aliases and wrapped calls regardless of the load target.
The existing non-literal `require` member-call guard also remains, including
computed property calls.
The package test additionally requires every file in the contracts subtree to
be a scanned `.ts` file, refuses triple-slash type and path references and all
meta-properties (also `new.target`), and retains member-call `require` detection
outside contracts. Identity declares this entry; synthetic graphs also exercise these checks.


The job-run ledger SQL asset test verifies a readable, nonempty file within the
package SQL directory. Its SQL parity tests bind the actual adapter calls to the
shipped routine signatures; the asset's explanatory header may be edited freely.

`npm run api:check` compares each of the eleven declaration entry graphs with the
committed `api/*.api.md` reports. After building, deliberately regenerate them
with `node --experimental-strip-types ./scripts/api-contract.ts --update` from
this package, and review the declaration changes.

The source-checkout binding `npm run test:consumer` runs
[`platform-cold-consumer.ts`](../../scripts/packages/platform-cold-consumer.ts).
It requires the cold package producer's verified `OPENLUP_PACK_MANIFEST` and
exact `OPENLUP_PACK_COMMIT`; it never substitutes a workspace build or repacks
on refusal. `ci:required` invokes that proof; API checks remain in the shared
cheap phase. The producer must include publishable core and platform tarballs;
the package inventory includes both at the same set version. Cold packing requires a clean committed package tree; an uncommitted preparation cannot produce the manifest.

The proof installs those tarballs, locked Zod and explicit Node type tooling
offline from the default npm cache into an OS temporary directory outside the checkout.
It verifies optional-peer absence physically and through both CommonJS and ESM
resolution, refuses symlinks and ancestor package sources, checks the complete
export classification, imports every nonadapter entry with an empty environment,
and compiles its types in strict NodeNext and Bundler modes without skipping
library checks. A type leak fails the proof even if runtime imports pass.

It then checks actual missing-SDK refusals, installs the three peers at the root
lockfile's exact versions using `npm install --prefer-offline --no-audit --fund=false`
and the default npm cache, compiles all adapter declarations and runs the real SDKs against owned
in-memory fixtures: S3 upload/HEAD/list/delete through the real SDK and
deterministic invalid-URL refusals after the default SDK/driver loads.
These fixtures contact no live provider. The PostgreSQL adapters then run their SQL conformance
against a disposable database: the CI job's pinned PostgreSQL service when the job supplies its
identity (`OPENLUP_PROOF_SERVICE_CONTAINER` and `OPENLUP_PROOF_SERVICE_PORT`), as the outbox proof
uses it, or otherwise an owned, labelled container of the same pinned image. There is no skip:
without either the proof fails. Temporary consumer files, the proof database and an owned container
are removed on completion. Missing cached packages fail the initial offline installation;
the SDK-present install can fetch missing registry metadata or packages. Neither
phase redirects npm to an empty temporary cache.

The composition declarations describe the injected Supabase factory structurally;
they do not import the data entry or its PostgreSQL types. The cold proof still
requires all six nonadapter entries (including `./identity/contracts`) to import in fresh processes and compile
in both resolution modes with all three optional peers absent.

<!-- openlup-doc-impact {"unit":"platform-substrate","digest":"sha256-00994d288cfec0c8dc0ae9aeae2ff542e2e9af2fedcb4dd2dfeb6c99523be92d","reason":"The manifest moves to the 0.15.0 set version with the exact @openlup/core 0.15.0 peer pin. The package surface, settings and verification described here are unchanged by this preparation delta."} -->

## Identity import candidate
Managed verification now requires the confirmation timestamp. Email-derived
reconcile requires an injected `emailTrustPolicy`. Managed hosts share
`createManagedEmailTrustPolicy` with `identityEmailTrustReadiness`; it reports
module `identity` using core's existing codes. Hosts retaining verifier-only
admission explicitly bind `createVerifierResultOnlyEmailTrustPolicy()`.
See the [identity policy and migration](../../docs/platform/IDENTITY.md#responsibility-and-composition)
for the empty provider allowlist, cache/deadline, 403/503 failures and the opt-in
`node tests/postgres/runIdentityEnvelopeConformance.mjs --phase email-trust` prerequisites
and conformance scope. The committed managed chain includes the identity
capabilities forward, so the runner proves association under the shipped managed
reference grants.
Construction and imports perform no settings read or SDK initialization.


The `./identity` server entry imports the existing identity engine, authorization,
profile readers, session adapters and BFF factories into one capability. Its
`./identity/contracts` entry is declared browser-safe and currently exposes the
customer auth port, value types and provider parser. Runtime-schema extraction
is pending the contracts-boundary choice described in the
[identity owner page](../../docs/platform/IDENTITY.md). Both entries remain an
unpublished development-preview import candidate.

Application composition supplies SDK clients/loaders, feature admission, redirect
policy, rate limiting, messages, sender and deployment URLs. Factories use the
foundation BFF envelope and accept the application's observed request-ID reader.
The module depends only on the declared foundation entries, without changing the
artifact's rail kind. Its schema contribution requires a host-selected inventory;
its four SQL files are verbatim projections at canonical positions 11, 12, 29 and
60, not an independent migration chain. The owner page maps the characterization
witnesses and records the remaining evidence.

Identity authorizes stored operator roles only when they are `admin` or
`distributor`; null and unknown values return `FORBIDDEN` (HTTP 403). The reference
admin-profile reader reports those rows as non-admin, and admin magic links do
not send for them while retaining the generic accepted response, padding and
quota. Adopters needing legacy role mapping must do it in their own adapter
before passing the role to the package; there is no package fallback option.

Both managed contact stores match normalized addresses case-insensitively,
including mixed-case stored contacts. Literal matching uses an anchored, escaped
`imatch` database prefilter plus an exact `email.trim().toLowerCase()` comparison
with the normalized input. Unicode regex folding alone cannot establish identity.
Both lookups select email and fetch at most ten candidates. Soft linking selects
the oldest accepted contact; reconciliation requires a single accepted contact
and throws the existing multiple-row error if several remain. A match beyond the
candidate bound is not selected. Injected structural query clients must implement
`filter(column, "imatch", value)` and the bounded array query. The direct customer
challenge already compares `lower(email)` to normalized input; no migration is
needed.

Magic-link factories default to the shared strict origin resolver. Pass
`redirectOrigins: ["https://example.com", "https://secondary.example.com:8443"]`;
the first configured origin builds the callback and every entry must be an exact
HTTP(S) origin, without credentials, a path, query or fragment (a root trailing
slash is accepted). Request headers never authorize an origin. Missing or invalid
configuration returns BFF `UPSTREAM_UNAVAILABLE` (503), with details reason
`magic_link_origin_not_configured`, before provider access. Customer `returnTo`
is normalized to a same-origin relative path; unsafe targets are omitted for the
callback's default landing page. An adopter needing its existing policy can keep
passing `resolveOrigin`; that explicit injection overrides the default. See the
[identity redirect contract](../../docs/platform/IDENTITY.md#magic-link-redirect-policy)
for reference configuration and migration.
