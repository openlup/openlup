# @openlup/platform

Development preview. This package is part of the publishable set with core and outbox; preparation does not establish a registry release or a stable API. Its repository-directory publish command refuses publication; the authorized package-release workflow owns publication.

It holds the runnable server substrate an OpenLup application composes: the Node HTTP runtime, BFF dispatch, scheduling and job leases, blob storage, data gateways, the node-postgres migration runner and bundle composition. Ports and their contracts stay in `@openlup/core/platform-runtime`.

For the prepared `0.20.0` set, read the [adjacent-release migration and known
limitations](CHANGELOG.md#0200) before selecting the opt-in M05 parity seams or
M06 composition bindings. M06 remains incomplete: inventory and shipping entries
are development-preview surfaces, with managed-host proof classes pending in the
[M06 parity ledger](../../docs/platform/plans/oss-m06-stock-reservations-delivery.md#parity-pending-rows).
The size gate compares the prepared `0.20.0` set with the published `0.19.0` tarball;
preparation, offline adapter evidence and a passing size cap grant no publication
or provider-account certification.

## Package surface

`release-gates.json` declares kind `rail`: this foundation provides runtime infrastructure over core ports, matching the architecture's rail responsibility. Its experimental entries each bind a declaration snapshot and package-owned smoke tests. The API checker reads this same inventory.

| Export | Contents |
| --- | --- |
| `./http` | Generic capped raw-body reader, hex HMAC and constant-time token comparison; Node request adaptation, deadlines, security headers and static documents, and `createNodeHttpRuntime` with its fixed request order |
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
| `./communications` | Experimental existing public consent/status, newsletter sync, Auth email hook, transport contracts/capture, observation/polling orchestration, standard webhook verification and delivery receipts; host-selected rendering, egress, protocol mapping and control policy |
| `./communications/contracts` | Pure renderer, block builders, copy-injected commerce/subscription factories and email/newsletter/Auth/intake/receipt types; no Zod, Node or provider runtime imports |
| `./payments` | Experimental prepared-attempt ordering with injected persistence, execution and failure policy; contracts at `./payments/contracts`. |
| `./inventory` | Experimental schemas/ports, handlers, native stores, projection, injected forecast and SQL descriptor; `./inventory/contracts` DTOs. |
| `./catalog` | Experimental neutral catalog schemas, drafts, reads, media source packs and publication ports |
| `./catalog/contracts` | Dependency-free catalog DTOs, media resolver, authority and canonicalization helpers |
| `./pricing` | Experimental price authority, quote computation/handlers, offer projection/cache, readiness and policy tokens |
| `./pricing/contracts` | Dependency-free authority, money, quote and offer DTOs and version constants |
| `./promotions` | Experimental promotion application, admin handlers, native read/sweep, SQL projections and acceptance |
| `./promotions/contracts` | Dependency-free preview and admin DTOs |
| `./shipping` | Experimental delivery ports, injected-schema handlers, summary/evidence; native flat-rate port + Core schema readiness |
| `./shipping/contracts` | Type-only delivery, pickup-point, summary and evidence DTOs |

## Shipping

Shipping handlers require injected host schemas; contracts are type-only with opaque provider/carrier strings.
No vendor code, inventory import, activation or parity claim.
Native flat-rate save requires the rate port, a ready Core report and
`nativeRateSchema`, a same-database Core `SchemaObservation` proving the applied
seed identity and settings objects. A candidate schema label is not proof;
later forwards do not invalidate an applied seed. The reference host exposes
`observeNativeRateSchema()` for this ledger/object observation and retains
caller-declared schema requirements. Missing proof keeps the named refusal.

## Inventory

`createInventoryBindings` selects one store with exact host provider validation. Native new-purchase reads refuse as `inventory_native_new_purchase_stock_read_unsupported`; `createInventoryContribution` declares selected callables without activation.

`INVENTORY_MIGRATIONS` projects canonical units 27/33 byte-for-byte; install the full catalogue. Store support and pending proof: [M06 parity](../../docs/platform/plans/oss-m06-stock-reservations-delivery.md#parity-pending-rows).

## Promotions

`./promotions` owns the existing automatic/legacy and code quote application,
benefit interpretation, advisory read ports, preview proofs, public-money binding,
acceptance tokens and passive telemetry. It calls `@openlup/core/promo`; it does
not contain another evaluator. Each factory receives the host facts it needs:
`createQuotePromoDiscounts` takes a customer classifier;
`createQuotePromotionV2` also takes the product floor and bound legacy application;
`createQuoteAutomaticPromotions` takes an email eligibility resolver and the bound
applications. `createQuotePromotionCodeAdjustments` and `createPromotionCodePreview`
require the floor. No factory supplies a default financial policy.

`createPromotionQuoteAcceptance<Request>` requires `projectRequest`, which returns
the host's exact request-binding projection; `promoCodes` also binds separately.
Its four issue/verify functions retain public-money projection, section diagnostics,
TTL and rotation. Explicit `acquisitionTerms` binds the full server-selected promise.
The pricing quote handler passes resolved acquisition terms to both
acceptance callbacks. An opt-in shipping binding appends shipping terms. A host must forward them to the acceptance helper. With no
acquisition configuration, terms are absent and historical token bytes stay equal.
This opt-in signature addition does not activate acquisition-only mounted issuance.

`recordPromotionAcceptanceOutcome` requires a recorder and swallows recorder
failure. The reference wrapper retains its existing sanitized operational recorder.
Reference wrappers also retain startup floor resolution, customer classification,
email/contact precedence and the rich request projection. Quote reads never reserve
capacity. Pricing receives application callbacks and has no import back to promotions.

`createAdminPromotionsHandlers` and `createAdminPromotionCodesHandlers` receive
the relevant members of `PromotionAdminBindings`: existing host admin-kit factories, authorization
resolver, response writers, exact RPC-error constructor/mapper and bound preview
helpers. The package does not copy or relocate that kit. The reference wrappers
bind these same objects, preserving human-only writes, required audit, signed
activation previews, validity-window checks and revision-aware replay delegation.
`createAdminPromotionSchemas` also requires the host currency schema. Its list
DTOs preserve system-managed read-only rows and valid status-only mirror handles;
the managed adapter retains the underlying write fences. Adjacent shipping,
catalog-price and subscription-band schemas and managed adapters remain reference-owned.

`createPostgresCommercePromoDataPort` and `createPostgresPromotionClaimSweepPort`
use an injected `PgQueryExecutor` from `./data`. They retain four evaluator reads
and bounded stale-claim sweep; they add no claim writer or reservation path.
`PROMOTIONS_MIGRATIONS` identifies the byte-identical projections of canonical
units 47/48 with paths, positions and hashes. These sparse units are not an
installation chain: use the complete canonical catalogue. No migration or
manifest identity changes in this move.

The server entry is classified as an adapter because its executor declaration
reaches the data entry and optional pg types. It imports at runtime without pg
and works with an injected executor; selecting the data gateway retains its
named missing-pg refusal. Its declarations compile after peer selection. The
contracts entry remains a non-adapter, imports no other module and compiles
without optional peers in NodeNext and Bundler modes.

The [promotion suites](test/promotions/) retain existing assertions. The
[real PostgreSQL witness](../../tests/postgres/promotionsNative.test.ts) installs
the full canonical chain, checks projection hashes and validated constraints,
and proves reads without durable writes, paid/released lifecycle, bounded
sweep, receipt/outbox fences, replay, lock/settlement skips and explicit invoker
grants. This is existing native lifecycle/read evidence only. Native code
candidates, mounted issue/honor, acquisition-only mounted acceptance and the
full native/managed eligibility matrix are accepted native-backend capability
gaps, without a parity claim, in the
[module ledger](../../docs/platform/plans/oss-m05-catalog-offers-pricing.md#d8-pending-outcome-ledger).

Opt-in `shippingTerms` also binds shipping-only promises. `createQuoteShippingPromotions`
resolves post-discount thresholds; optional `acquisition` bindings select host policy.
Omission preserves incumbent behavior. See [parity seams](../../docs/platform/CANONICAL_CONTRACTS.md#m05-parity-seams).

## Pricing

`./pricing` provides the existing OpenLup strict commerce price authority,
subscription-price-policy schemas, canonical digest and integer math, signed
pricing-policy assignment tokens and safe refusal mapping. Hosts inject exact
price-list, base-entry, legacy-entry and policy-history reads. The authority
validates the base before reading history and uses the observed base's
`priceListId` for that lookup. History excludes legacy fallback even when no
revision is currently effective. Digest, interval, ambiguity and amount-kind
refusals retain their existing identities and precedence. The opt-in
`createConcurrentCommercePriceAuthorityPort` instead schedules history alongside
base reads using the selected list ID, with base-refusal precedence.

`./pricing/contracts` contains dependency-free authority observations, policy
DTOs and version constants; its only external type comes from the exact
`@openlup/core/pricing` entry. Zod schemas, Web Crypto hashing and Node HMAC token
operations stay in the server entry. Tokens retain assignment binding, the
72-hour default compatibility window and rollback behavior. Secret selection,
feature flags and readiness remain reference composition responsibilities.
Reference paths use named exports of the same functions and error classes;
the browser keeps its existing policy schema binding locally.

The quote foundation also owns neutral money/tax/quote DTOs, promotion evidence
and rejection details, bounded catalog facts, provenance creation/public stripping
and the supported-tax-profile guard. `createCommerceQuoteSchemas` requires the
host's currency, product-slug and context schemas; `createCommerceQuotePrimitives`
requires currency validation. No settlement default or catalog policy is installed.
The original line, currency, VAT, discount and shipping equations and v1/v2
provenance refusals are preserved. Quote ports accept host request/response types.
The reference keeps its rich browser request/context validation and catalog bridge;
server compatibility paths export the same error classes and provenance/tax functions.
The portable schema counterparts stay server-side; binding tests compare their
results and diagnostics with browser validation.

`createDbBackedCommerceQuotePort` owns the existing quote computation and price,
tax and component helpers. Hosts supply bounded catalog/price reads, settlement
values, a flat shipping read, promotion application and context callbacks. The
reference binds `getShippingFlatMinor`, industry context and existing promotion
implementation. Shipping is read before promotion application; the original VAT
helper and both discount lanes are preserved. Snapshot comparison accepts injected
response validation and request reconstruction, so rich context stays local.

Quote, ordered batch and offer handlers take the host's schemas and BFF responder;
the reference binds its observed request context. Their error identities, refusal
mapping, promotion acceptance/fallback and public evidence refusal are unchanged.
Offer projection requires roster, representative-request, unit-count, floor and
wire-scope policy. It retains v1/v2 responses, partial degradation only for a
missing configured price, and the first successfully priced representative.
The offer cache bounds success freshness from load start and retains its separate
failure TTL; readiness keeps its 60-second positive and 5-second negative caps.
The additive experimental acquisition API is off by default. `selectAcquisitionTerms`
and `filterAcquisitionPromotions` require an `AcquisitionFinancialPolicy<Row>`:
row facts, classification, metadata validation, pair matching, initial rate and
unconfigured terms all come from the host. Omission refuses with
`acquisition_terms_policy_unconfigured`, even with no rows; no financial policy
or schedule is bundled. Selection preserves row identity, validates the whole
tagged schedule and uses half-open windows with the next future boundary.

`createAcquisitionQuoteSchemas` composes separate capability/context/resolved-terms
schemas with the host's validators. `projectAcquisitionOfferPricing` pins the
observation time and capability for every representative request; its v3 output
contains public terms and expires by the next boundary or 60 seconds.
`createAcquisitionOfferPricingSchema` retains the injected v2 settlement and scope
rules. The opt-in handler delegates absent acquisition headers to an incumbent
handler; negotiated responses require v3, paired v2 policy and private no-store
headers. The incumbent handler continues ignoring acquisition headers.
`createAcquisitionReadinessCache` requires an explicit policy configuration,
validates acquisition evidence, clamps positive cache expiry and rereads once
after crossing a boundary. The existing shared readiness cache remains unchanged.

Promise comparison is independent of money. Explicit server-selected resolved
terms can join the existing acceptance money projection and totals section;
absence contributes no property. Quote/batch refusal mapping and unsigned-terms
fallback checks require explicit acquisition configuration. Reference composition
supplies none: existing schemas, headers, reads, error details and token bytes
are preserved. Threshold shipping is supplied by the separate
[parity seam](../../docs/platform/CANONICAL_CONTRACTS.md#m05-parity-seams).
Checkout admission, claims, finalization,
promotion implementation, stores, SQL, routes and activation remain outside
this API.

The package witnesses in `test/pricing/` move the incumbent authority, policy,
token, quote, snapshot, handler, offer, cache and readiness assertions. Currency
fixtures use synthetic identifiers while preserving the same arithmetic and
refusals. Reference schemas, rich catalog/context policy and composition remain
in the application. The existing cold consumer exercises both entries and
compiles installed declarations without optional provider peers.

## Catalog
Opt-in `priceAuthority: "effective"` on the native bundle store and the admin
`effectiveTarget` hook provide [effective bundle parity](../../docs/platform/CANONICAL_CONTRACTS.md#m05-parity-seams);
`selectEffectiveBundleTargetPrice` is exported. Omitted seams preserve defaults.

The native envelope and dark draft adapters now live in this entry as
`createPostgresCatalogSkuEnvelopeReadPort` and `createPostgresCatalogDraftStore`.
They accept an injected executor and retain the existing mapping, errors and SQL
semantics. The mapper remains internal to the package. `CATALOG_MIGRATIONS`
projects canonical positions 1, 8, 58, 59 and 61 byte for byte; these assets are
sparse references, never a standalone install chain. No canonical migration or
manifest entry changes.

The composition entry adds `createCatalogContribution` and its structural input
interface. It describes actual catalog, pricing and promotions callables under
those existing module identities, with no environment discovery, client creation
or registration. It imports only readiness types: composition gains no catalog
edge, and catalog keeps its type-only data edge plus one pricing value edge for
the effective-window selector. Package boundary
checks pin those imports and peer-free composition declarations. The packed
consumer exercises both new stores and the descriptor without optional peers;
its synthetic executor proves named refusal, not durable storage behavior.


`./catalog` is an experimental capability for the existing neutral catalog
foundation, installed product types, draft validation/use cases, active SKU
selection, resolved SKU projection and sellable reference reads. Hosts supply
the read/store ports, verified operator authorizer, product-type registry and
BFF responder. Draft commands retain the original canonical bytes, receipt-first
replay, actor binding and named refusals. Read projections carry opaque
product-scoped document references; they do not interpret document payloads.

Fixed-bundle application/admin now uses this same server entry: rules, read/write
ports, batched stock derivation, nine mutations, four reads/price preview and the
public sellable-feed factory. Named reference wrappers inject lifecycle and stock
helpers, existing admin kit/spec/flags, validators, responder, wire versions and
the reference-owned RPC error constructor. The read error has one package identity.
`createPostgresBundleCatalogStore` now accepts the data entry's injected
`PgQueryExecutor`; it renders the incumbent list/detail/feed/history SELECTs
without constructing a pool or switching roles. The writer, pooled transaction
binding and transport adapters remain reference-owned. `BUNDLE_MIGRATIONS`
projects canonical units 16 and 19 with their original paths, positions, hashes
and byte-identical SQL. These sparse projections are not an installation chain:
apply the complete canonical manifest. No new migration or activation is added.
Preview target selection remains the existing first active matching-mode row.

`./catalog/contracts` carries dependency-free DTOs, the shared authority error,
GTIN/authority helpers, quantity/option helpers and the existing draft JSON
canonicalizer. It imports no Zod, Node runtime or server barrel. Runtime schemas
use the server entry with jitless Zod; the reference browser keeps its sellable
schemas locally. Media manifest validation and `resolveProductMedia` are also
browser exports: declared product/variant/locale associations resolve to supplied
URLs with deterministic ordering and neutral fallback, without filename inference.
The server entry adds bounded source-pack export/validation/restore/import;
`BlobStoragePort` comes from the existing `@openlup/core/platform-runtime` entry.
Import validates every resource before uploading immutable digest keys, deduplicates
shared keys and never activates associations. No upload route is mounted.

Read and draft behavior is supplied by the existing use cases and host ports.
`publicationRead`, `publish` and `lifecycleWrite` remain explicitly unsupported
in the neutral reference binding. Lifecycle DTOs and server validation/publication
ports are types only, with an opaque publisher brand and no constructor or default
binding. A missing authority is `unsupported`; an unavailable configured authority
is `dependency_unavailable`, never an absent receipt. Successful readback requires
real publication lineage; existing active rows cannot invent a head. History pages
are bounded to 100 receipts with stable revision ordering and opaque cursors.
Existing SKU `draft`/`active`/`archived` and draft receipt `open`/`abandoned` wire
statuses remain unchanged. `withdrawn` may map from `archived` only where an
authority establishes withdrawal; abandoning a draft does not withdraw a variant.
Neither entry installs SQL. Rich application catalog interpretation remains
reference-owned. The [M05 plan](../../docs/platform/plans/oss-m05-catalog-offers-pricing.md)
records the cut, its exclusions and the witness ledger.
The moved characterization suites are under `test/catalog/`; the required cold
consumer imports both entries without optional peers and checks installed
canonicalization, authority identity, selection and unauthorized draft refusal.
Three synthetic media conformance cases and one lifecycle type case complement
those moved suites; the existing package boundary tests cover browser closure.
Bundle browser schemas remain locally defined by the reference, preserving
parse/default/strictness behavior; the package contracts add plain DTO types only.
Installed callers inject validators into server factories. Five package suites
retain 44 bundle cases; two root binding suites retain 18. Four neutral W4 cases
and one binding/browser-closure case add five required cases. The cold consumer
also checks bundle composition refusal, unknown stock and exact allocation;
catalog server is deliberately classified as an adapter because its declarations
reach optional pg types through the executor. Its runtime still imports and reads
through an injected executor with optional peers absent. Catalog contracts remains
a non-adapter and compiles without peers. Server declarations compile after peer
selection. Five real-PostgreSQL cases characterize full-chain replay, complete
ordered reads with unchanged data, whole-set rollback/refusals/dry runs, price
history, sequential key recognition and explicit invoker grants. Native routines
have no independent human-only actor-kind gate; the handler supplies that gate.
This does not close the bundle parity ledger.
The complete contracts entry measures 3,281 B minified+gzip against its 4,096 B
budget; other entry and aggregate caps are unchanged.

Moved catalog, pricing and promotion fixtures use synthetic identities, regions,
currencies and host-defined context fields. Their assertions retain the original
operators and case counts. Reference classifiers receive the legacy threshold
from their host composition; only the immutable managed baseline predicates
await an owner decision. Pricing VAT calculation retains
both exported helpers and their signatures: `calculateIncludedVat` delegates to
`splitIncludedVat` through a distinct named wrapper using the same arithmetic.

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

This package's tests are part of the repository's required test selection; from this directory, `npm test` runs them alone. The tests rewrite the originating application's characterization with neutral names and synthetic data, and a boundary test refuses environment reads and provider imports outside its explicit `pg` adapter and `@aws-sdk/client-s3` blob-client allowlist. Follow [repository testing](../../CONTRIBUTING.md#test-scope-and-diagnostics) for placement, setup and speed rules.

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

`npm run api:check` compares every declared entry graph with the
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
requires all declared non-adapter entries (including `./identity/contracts`) to import in fresh processes and compile
in both resolution modes with all three optional peers absent.

<!-- openlup-doc-impact {"unit":"platform-substrate","digest":"sha256-00994d288cfec0c8dc0ae9aeae2ff542e2e9af2fedcb4dd2dfeb6c99523be92d","reason":"The manifest moves to the 0.15.0 set version with the exact @openlup/core 0.15.0 peer pin. The package surface, settings and verification described here are unchanged by this preparation delta."} -->

## Identity import candidate

The OIDC API adds `createOidcIdentityVerifier`,
`deriveOidcPrincipalId`, `createPostgresAccountLinkStore` and
`identityOidcReadiness` from `@openlup/platform/identity`, which also exports
`OIDC_FAILURE_CODES` and `OidcFailureCode` for hosts. The browser-shared
`@openlup/platform/identity/contracts` entry excludes OIDC refusals.
Inject the host's selected JWT library through `IdentityJwtLibraryLoader`.
Discovery and rotating keys load only on verification or readiness. The opt-in
direct composition uses normal reconcile with an explicit email-trust policy,
authenticated actor reads and live operator membership. Managed storage requires
native federation sessions and refuses raw upstream-token composition. Run
`node tests/postgres/runOidcIdentityConformance.mjs` from the repository root with
its cached pinned issuer and local prerequisites; the [OIDC recipe](../../docs/platform/IDENTITY.md#real-issuer-oidc-recipe)
owns timing, refusal, session and certification boundaries. There is no schema or
default login flow change; existing static session verification and default
reference/browser flows retain their runtime behaviour.

The existing `IdentityJwtLibrary.jwtVerify` contract widens with optional
`currentDate?: Date` and `clockTolerance?: number` verify options and now returns
`{ payload: IdentityJwtClaims }`, whose claims interface includes a string index
signature. **Migration:** hosts implementing or typing their own
`IdentityJwtLibrary` or `IdentityJwtLibraryLoader` must accept the optional verify
options and return claims as `IdentityJwtClaims`.

The direct operator API adds `createPostgresOperatorIdentityStore`,
`createOperatorSessionService`, `createOperatorIdentityVerifier`,
`createOperatorAdminAuth` and `createOperatorAuthHandlers` to `./identity`.
`./identity/contracts` exposes strict operator challenge/session schemas and
`OperatorBrowserAuthPort` without a server or provider import. Challenge delivery
and session signing use the existing structural ports. Operator handlers send
the padded generic acceptance before awaiting mailbox delivery, keeping delivery
latency out of the response. Custom HTTP composition uses the session service's
optional acceptance callback for the same ordering. Restoration reads preserve
in-flight browser redemption; explicit sign-out still cancels it. Active operator
login needs no pending invitation and preserves membership and invitation history. The new store's public
signature exposes no driver types and loads its optional driver only on use.

Apply the complete direct catalogue through position 68 before enabling human
login; `sql/20261018180000_identity_operator_challenges.sql` is its exact projection.
Configure a distinct operator audience and an adopter deployment route policy:
the public policy refuses all mounted operator routes, including `me`, with
`adopter_policy_required` before input or authentication-binding construction. The reference dispatcher accepts a
session-binding factory through `createReferenceBffDispatch`; use it to compose
separate operator delivery. Caller-supplied operator handlers retain the same
policy boundary. The browser hook consumes guarded auth-port notifications rather
than signing out from a stale post-redemption check. Use the
explicit bootstrap/prune commands in the [identity guide](../../docs/platform/IDENTITY.md#direct-human-login).
The bounded reference browser builds do not mount the admin shell; application
composition must mount the provided pages and hook. First redemption activates the existing invitation and consumes the challenge in
one transaction. Live membership, not a JWT role, authorizes each request. The
cold consumer includes both identity entries and the new adapter's missing-peer
refusal; real concurrency and upgrade proof needs the complete PostgreSQL chain.

Creating a client/contact records commerce contact data, not an authentication
identity. Creating an auth user provisions a principal. Neither a typed address
nor a soft-account link proves mailbox ownership; reconcile may create a contact
for an existing authenticated principal without creating that principal.

Customer soft-account provisioning now creates unconfirmed auth users
(`email_confirm:false`). The soft-account linker retains create-first lookup,
normalized duplicate recovery and conditional linking. Checkout and paid-order
retry are adopter composition that must call the linker. Failed links retain
the provisioned identity for retry. Customer magic links keep
`shouldCreateUser:false`: captured mailbox proof confirms that existing user;
unknown addresses cannot sign themselves up through this path.

The managed link store requires an injected `emailTrustPolicy`, assessed before
creation or linking an existing identity by email. Unsafe or unavailable settings
return a non-fatal soft-account refusal (`EMAIL_TRUST_ENVELOPE_REFUSED` or
`EMAIL_TRUST_SETTINGS_UNAVAILABLE`) without creating an identity or link. Matching
existing links retain their replay behaviour. The reference adapter binds managed
settings assessment regardless of the selected bundle.

**Migration:** soft-account provisioning requires a trusted envelope: automatic
email confirmation disabled and every enabled non-email provider explicitly
declared email-verifying. Automatic signup can otherwise confirm an unconfirmed
user and issue a session to someone who merely knows the contact's address.
Pass the policy to `createSupabaseClientAuthLinkStore(client, emailTrustPolicy)`;
custom `ClientAuthLinkStore` implementations must expose `emailTrustPolicy`.
An adopter may explicitly bind `createVerifierResultOnlyEmailTrustPolicy()` when
its own trust boundary supplies the guarantee. Ensure the selected Auth installation can deliver and verify the
first-login link for an existing unconfirmed user. Run the documented joint local conformance
command after building core/platform. Existing identities, contact links,
subscription references and migration history are not rewritten.

Managed verification now requires the confirmation timestamp. Email-derived
reconcile requires an injected `emailTrustPolicy`. Managed hosts share
`createManagedEmailTrustPolicy` with `identityEmailTrustReadiness`; it reports
module `identity` using core's existing codes. Hosts retaining verifier-only
admission explicitly bind `createVerifierResultOnlyEmailTrustPolicy()`.
See the [identity policy and migration](../../docs/platform/IDENTITY.md#responsibility-and-composition)
for the empty provider allowlist, cache/deadline, 403/503 failures and the opt-in
`node tests/postgres/runIdentityEnvelopeConformance.mjs --phase email-trust` and
`node tests/postgres/runIdentityEnvelopeConformance.mjs --phase joint` prerequisites
and conformance scope. Both phases replay the committed managed chain, including
the identity capabilities forward, and prove association under the shipped managed
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
its seven SQL files are verbatim projections at canonical positions 11, 12, 29,
60, 67, 68 and 69, not an independent migration chain. The owner page maps the characterization
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


### Operator invitations

`identity/contracts` exposes distinct direct pending-invitation and managed
active-membership results. Matching runtime schemas remain in the server entry.
The admin-action port returns `OperatorInviteResult`, a union of those results.

`createDirectOperatorInvitationStore` provides the new pending, active, expired and
revoked lifecycle in its trusted PostgreSQL transaction lane, including ordered
membership locks and atomic membership/audit writes. Direct callers inject the
store and a parsed TTL. `createDirectOperatorIdentityDirectory` commits principal
creation/reuse separately. Apply the complete direct catalogue through position
67; the byte-identical package projection is for inspection and composition, not
a standalone fresh chain. Direct human acceptance is a trusted command,
unmounted from machine authentication.

Managed hosts use `createInviteAdminUserGateway().activateMembership` in
`runInviteAdminUserUseCase`. Insertion immediately creates active `admin_users`
membership with invitation provenance; it omits `is_machine_actor` and relies on
the database default false. The result carries principal ID, role, active state
and `MEMBERSHIP_CREATED` or `ALREADY_ACTIVE`, without pending timestamps or an
invitation ID. Identical repeats and concurrent insert losers return the existing
membership without a second notification. Role differences conflict; revoked
members refuse with `MANAGED_REINVITE_UNSUPPORTED`. Failures retain identities
for retry, including after notification failure. No Auth metadata store,
first-entry acceptance, expiry or compensation is used. Magic-link eligibility
requires active membership and a known role. Authorization, removal and admin
`me` retain their actor bindings without a service key for lifecycle state.

**Migration:** direct hosts can adopt the new pending lifecycle by applying
`20261018120000_identity_operator_invitations` after the existing direct catalogue
and composing the store, trusted human acceptance and parsed TTL. Existing
memberships are preserved. Managed immediate activation is retained; managed
consumers must now parse the structured active result and its
`MEMBERSHIP_CREATED`/`ALREADY_ACTIVE` codes instead of message-only success.
Duplicates return existing membership rather than `ALREADY_ADDED`, and
notification failure returns 503 `INVITATION_NOTIFICATION_FAILED` while keeping
membership active. Managed pending/expiry remains a compatibility gap requiring
a separate transactional store and reviewed forward. No managed SQL, RPC or SDK
dependency is added. See the
[identity lifecycle owner](../../docs/platform/IDENTITY.md#operator-invitation-lifecycle).

The managed chain's identity capabilities forward
`20261018160000_identity_service_role_capabilities.sql` grants `service_role`
SELECT(email) and INSERT(id, email, role, membership_state, membership_provenance,
membership_accepted_at) on `admin_users`.
The opt-in managed conformance replays the complete committed chain with ambient
default ACLs removed and adds no grant. It proves immediate activation,
repeat/concurrent recovery and revoked-member refusal under the shipped grants.
It does not establish managed/direct lifecycle parity.

With a fresh local managed stack running, export its API URL, service key and
PostgreSQL owner (`supabase_admin`) connection URL as `OPENLUP_MANAGED_CONFORMANCE_URL`,
`OPENLUP_MANAGED_CONFORMANCE_SERVICE_KEY` and
`OPENLUP_MANAGED_CONFORMANCE_DATABASE_URL`, then run from the repository root:

```sh
npm --workspace @openlup/platform run build
node --import tsx tests/postgres/operatorInvitationManaged.conformance.ts
```

The module refuses non-loopback endpoints, an already-installed public schema,
and existing synthetic fixture identities. It retains synthetic identities;
discard the disposable stack after the run. Its database owner connection must
be able to replay the committed prerequisites, baseline and ordered forwards.

## Personal data

The experimental identity entry exposes `createPersonalDataContributorRegistry`,
`createIdentityPersonalDataContributor`, `createPrivacyOperations`,
`exportPersonalData`, `erasePersonalData`, `createPrivacyExportHandler` and
`createPrivacyEraseHandler`. Browser requests, versioned contributor documents and
receipts come from `@openlup/platform/identity/contracts`. Register every required
contributor explicitly, with its owned fields, assessment, erase/retain operation
and remote/retention obligations. Missing required owners refuse erasure; export
reports missing coverage. This capability erases identity-owned data only.

Direct hosts compose `createPostgresPrivacyUnitOfWork` and
`createPostgresPrivacyStore` with the identity contributor and their domain vetoes
using the same executor. The reference subscriptions contributor holds a relation
lock through commit, refusing active and paused subscriptions without changing
them. `IdentityPrivacyPolicy.retainedContactFields` names explicit retention
owners for populated opaque columns; unknown ownership refuses. The reference
retains lifecycle/acquisition fields, and refuses nonempty metadata or external
references until an owner declares their disposition.

Migration: apply the complete direct catalogue including
`20261018190000_identity_privacy_erasures` before using privacy or the updated
customer challenge store. The forward appends one receipt table at position 69
without grants or stored functions. Direct erasure pseudonymizes identity-owned
fields, deletes challenges and outstanding invitations, uses guarded membership
revocation, clears only the selected contact's direct principal link, and commits
an idempotent audit receipt atomically. Contact IDs and managed auth links never
change. Failed writes roll back. Retained audit references are pseudonymous, not
an assertion of anonymization. Already-issued tokens may remain valid until expiry.
Customer challenge issuance and redemption reject a receipt for either the
contact or principal under the same transaction-held challenge relation lock as
erasure, including late challenges inserted after cleanup. Hosts must use the
package adapters; calling the retained raw challenge SQL functions directly
bypasses this erasure receipt fence.

Managed hosts compose `createManagedPrivacyStore` with their structural service
client for export. Coverage explicitly excludes inaccessible country and
identity history/receipt fields. Managed erasure refuses with
`MANAGED_PRIVACY_ERASURE_UNAVAILABLE`: a managed adopter must provide its own
erasure path. The committed grants and structural client cannot provide the
required mutations and atomic receipt. This change adds no managed forward or
erasure grants. Provider identity is never deleted; any future composed provider
erasure must disable it after committed local success. The managed refusal here
occurs before reaching any provider mutation.

The reference mounts authenticated human-admin export/erase POSTs and an Admin
Settings readback panel. Direct and managed mounts require the adopter deployment
policy under admin mutation risk; the public default returns
`adopter_policy_required` before body/query reads, and direct mounts also refuse
before authentication or privacy binding construction. The shipped dispatcher mounts
both routes for managed bundles even when its caller supplies no routes. After admission,
exports and receipts stay in memory with no-store
responses. The maintenance `prune-challenges` command prunes separate bounded
operator/customer batches. See [identity privacy](../../docs/platform/IDENTITY.md#identity-personal-data)
for refusals, token limits and retained obligations.

The complete direct conformance is included in
`npm test -- tests/postgres/operatorIdentityUpgrade.test.ts` from the repository
root after normal setup. A maintainer host resource broker is optional.
For managed conformance, supply the same three `OPENLUP_MANAGED_CONFORMANCE_*`
local disposable-stack settings described for operator invitations, with
`OPENLUP_MANAGED_CONFORMANCE_DATABASE_URL` set to the database owner
(`supabase_admin`) connection, then run
`node --experimental-strip-types tests/postgres/identityPrivacyManaged.conformance.ts`.
Use a fresh public schema and reset the disposable stack between proofs; the
managed privacy proof replays the committed chain without fixture erasure grants.
Replay through node-postgres omits only the psql-only pg_dump `\restrict` and
`\unrestrict` guard lines; all migration SQL remains unchanged.


Reference startup can compose identity through `createReferenceIdentity` and
`startPublicReferenceServer({ identity })`, with explicit route functions,
selected adapters, trusted schema/migration observation and the bundle-specific
inventory. It consumes email-trust readiness before listening, and rejects
unknown or unsatisfied candidates. Direct reconcile reads the existing actor
link; direct invite/remove select the pending-invitation stores. The default
static reference and browser page sets remain unchanged. See the
[composition contract](../../docs/platform/IDENTITY.md#responsibility-and-composition).

Both identity entries already belong to the public export map and build output;
artifact availability does not imply registry publication or release activation.
The cold installed-artifact consumer imports both entries without optional peers,
compiles contracts without driver types, and invokes every driver-owning direct
identity adapter for its missing-peer refusal. Managed factories consume
structural clients. Server declarations compile after peer selection. Full
installed-artifact and database proof require the existing supervisor-run package
consumer command and an owned disposable database.

The managed identity service-role capabilities forward in the committed chain
supplies client link writes and operator membership insert/email-read
permissions; the local conformance runners add no fixture grant. No migration is
added by reference composition.


## Disposable identity composition

The reference application's opt-in identity shell consumes the existing
`./identity` and `./identity/contracts` exports without changing their maturity
or publishing a registry version. It reuses the customer/operator pages and
captured-delivery port, with a private local mailbox and administrator privacy
panel. Its explicit runtime must supply actual routes and readiness admission;
the shell refuses a missing composition. See the
[identity reference guide](../../docs/platform/IDENTITY.md#disposable-identity-reference)
for both-bundle commands, the committed managed grants and installation limits.

## Communications import

For adoption from `0.16.0`, follow the [0.17.0 Migration guidance](CHANGELOG.md#0170)
for the complete package set, canonical SQL installation and host-owned bindings.

M04 P1 relocates the existing public implementation without changing its reference
outputs. The reference shims bind the existing renderer, egress resolver, origin
defaults, delivery-shaping policy and receipt transaction lane. The package does
not select a deployment, mount a route or schedule another executor.
`createCommunicationsContribution` requires the host's version and schema
inventory; supplied handlers, schedules, routes and ports describe only that
host's selection.

`COMMUNICATIONS_MIGRATIONS` projects three existing canonical units byte for byte:
comms outbox (position 2), transactional receipts (9) and communications control
plane (20). This sparse list is not a standalone migration chain. Apply the full
selected canonical prefix through its existing runner; importing the module does
not apply SQL or advertise missing managed/direct capabilities.

Browser previews retain their reference renderer, content defaults and template
policy. The Auth hook receives that same renderer through its reference shim.
The standard Auth webhook and the maintained HTTP mail provider verifiers keep their separate signature
formats and clocks; the generic helper added to `./http` replaces neither.
E2 is applied: the payment webhook module delegates these five generic helpers.
`readRawBody` is the same package function object with its original declared
`(req: VercelRequest) => Promise<string>` signature; the other four exports are
plain re-exports. The payment provider verification and its replay tolerance stay local.
The maintained mail transport, credentials, callback verification/mapping,
poll read/mapping, timeline and send-ledger adapters remain in reference source.
B1 changes only the four raw-injection guard sites in the reference delivery
adapters and the approved invoice test fixture; the concrete client and all
other vendor-directory files retain the comparison-base bytes. The neutral
`./communications` entry exposes transport/result contracts and capture without
concrete mail wiring. The platform ships opt-in vendor adapter subpaths;
default wiring includes none, and adopters choose or replace them.
The type-only `CommunicationProvider<Provider>` and `EmailMessageReadModel<Provider>`
accept host vocabulary; reference types retain their original literal.

`createGuardedEmailTransport({ providerKind, policy, send })` is the network
adapter constructor. At each send it awaits a fresh host policy, validates the
whole decision and enters the sender only for a coherent `production`,
`sandbox_direct` or `sandbox_sink` decision. The sender receives the effective
recipient and a frozen context with intended recipient, host-selected credential,
mode, reason and environment tag. It must consume that context when selecting
credentials and emitting provider metadata. The neutral entry reads no environment
and contains no provider client. Opt-in adapters consume this same guard and
host-selected context. Missing/throwing policy, unknown modes, mismatched
recipients/tags, blank credentials or unsupported fields fail with status zero,
no identifier and bounded error codes. Reasons are lower-case token codes up to
80 characters. One unadorned `local@domain.example` recipient mailbox is required;
whitespace, lists, display names and local-only domains are refused on this new
alternate-transport policy boundary.

`blocked` returns failure; explicit `drop` returns terminal suppression with no
send, no identifier and an ineligible sent timestamp. Arbitrary injected objects
are refused by `guardEmailTransport`; a provider name or copied capture shape
cannot establish admission. Package-created capture retains its ordered envelopes
and synthetic identifiers with no network effect. Capture acceptance remains
local acceptance, never evidence of external delivery.

`admitPolicyEnforcedEmailTransport` is the trusted host bridge for a transport
that already enforces egress internally, as the maintained reference client does.
The package registry owns its identity; this bridge performs no second routing
or credential decision. It is a composition trust boundary, not a sandbox for
host code: callers must not admit an unguarded network sender. New adapters should
use the validating constructor above. The reference default retains its original
sink/drop policy, key selection, optional payload fields, headers, signal and
result/error semantics. `createAuthEmailTransport` preserves the Auth envelope
mapping and admission; raw Auth closures are refused before their send method.
Admin/control and required-audit ordering stay at their existing callers.
No egress result authorizes a subscription-state or delivery-cycle mutation.

`processEmailObservation` accepts already authenticated, decoded and environment-admitted
input. It looks up a local send, constructs evidence only when found, applies one
observation and records best-effort telemetry. Lookup and apply failures propagate.
`runDeliveryReconciliation` polls candidates sequentially, rotates every non-404
read, and delegates consecutive failed-404 abandonment at threshold three to the
store. Rotation failure is counted without dropping delivery truth; apply failure
continues the batch. Candidate-query, read and not-found-store throws propagate.
The host classifies protocol snapshots after rotation and passes recipient/evidence
through unchanged. The existing reference domain entry points use both engines;
routes and schedules remain the same.

Neither engine writes suppression or subscription state. Both callback and poll
composition retain `communication_update_email_delivery_from_provider` as the
single durable convergence/suppression writer. These ports add no in-memory
replay authority, database store or second executor. Legacy transport identifier
fields remain compatibility residue; new ports use `messageId`.

`createCommunicationPurposeRegistry` composes immutable exact identifiers with a
mandatory `marketing` or `non-marketing` classification. Its built-ins cannot be
redeclared. Existing policy, token and newsletter schema calls keep their finite
defaults. Passing a registry to policy evaluation, token verification or
`createNewsletterIntegrationSchemas` recognizes its identifiers without granting
permission. Custom marketing purposes still require a grant and respect
suppression; built-in tester pause and permission rules stay in force.

`createRegisteredPublicPreferenceTokenPort` requires an explicit host persistence
function and passes the exact purpose and frozen classification to it. It creates
no sync event. Stock managed permission and newsletter-sync tables retain their
finite CHECKs; registering a purpose does not expand those stores. Additional
persistence and schema requirements belong to the adopter. No new purpose, table,
migration, preference UI, URL or default fan-out is installed.

`processNewsletterWebhookEvent` supplies the existing event → permission →
settlement sequence behind neutral ports. Reference HTTP admission and signature
mapping stay local. Explicit registered purposes survive permission writes;
purpose-less feedback still targets exactly the two existing marketing purposes.
Verified opt-in, suppression and replay rules are unchanged. Registered dispatch
checks the batch's purposes before provider effects and retains claim tokens,
echo and capability skips, retry behavior and counters. Sync-settled and accepted
receipts are distinct from delivered evidence. Existing job admission, binding,
leases, finish-run linkage and operator readback retain their host composition.
No shared sender pipeline is added: required audit and best-effort send paths
keep their distinct ordering and failure semantics.

`MarketingAutomationProviderPort` and `MarketingAutomationStorePort` describe
explicit scope, claim/generation fences, admission/deadlines, idempotency,
observations/history and ambiguity/backoff. The synthetic substitute-provider
conformance suite is an executable contract, not an installed worker or a remote
provider certification. Evidence carries opaque references; remote feedback does
not grant local consent. No trigger catalogue, schedule or provider activation
is supplied.

The required selection retains the moved-code witnesses and neutral package
characterization tests. The package W1 hook reader witnesses the Auth composition;
provider-specific reference test paths remain in the complete suite. The
[M04 ledger](../../docs/platform/plans/oss-m04-communications-triggers.md#verification-ledger)
records counted cases, separate boundary iterations and local timing provenance.
The clean-commit artifact gate enforces all merged caps, including the owner-read, measured limit on the complete contracts entry. Artifact admission still needs a
clean supervisor commit.
See the [M04 plan](../../docs/platform/plans/oss-m04-communications-triggers.md)
for scope, later waves and verification limits.

## Package artifact limits

The monorepo's package artifact checker enforces this package's
`release-gates.json` caps and packed content allowlist. Only
`--release-set <version>` checks compressed growth against the last released
baseline, with explanations in the new set's changelog section and release body. Its browser-safe `./identity/contracts` export also has a minified+gzip cap. See the
[package artifact policy](https://github.com/openlup/openlup/blob/main/.github/VERSIONING_AND_EOL.md#package-artifact-limits)
for measured sizes, current caps, the S1 baseline refresh and refusal remedies.
Artifact checks require a clean package directory; `--manifest-only` supplies no
artifact evidence.

### Pure email content and browser rendering

`./communications/contracts` now exports `renderEmail`, the nine existing block
constructors, `guideCardBlock` and per-template content factories.
Each `create*ContentFactory` binds host-selected copy plus only the pure helpers
it uses: order-reference formatting, payment-cause wording or marketing footer.
Localized review routes remain in the reference helper.
In P3 no copy pack, brand, locale choice, environment reader, provider client or
sending policy moved into this entry. B2 adds the explicit neutral defaults below. The existing email DTOs remain its canonical types.
Reference `petName` compatibility inputs are translated to neutral `contextName`
by their existing facades. Complete subjects, preheaders, ordered blocks and
HTML/text remain byte-identical, including omitted and explicit optional fields.

Browser previews continue through those facades to contracts values only. Auth
uses its existing server hook factory with the same host renderer injection;
its inactive public content binding still refuses with 503. Standard Auth,
mail callback, integration-event and generic HTTP verification remain separate
policies with their existing raw-byte and replay behavior. No crypto refactor,
new entry, dependency or graph edge is part of P3.

The contracts conformance test compiles the complete entry with no Node types
and checks its value inventory and import closure. The cold consumer repeats the
exact inventory and renders with fetch forbidden and optional peers absent,
retaining all other consumer checks. Browser size measures every runtime export
of the built entry through `browserEntryBytes`; it never measures a tree-shaken
consumer subset. See the M04 ledger for the measured size, owner-read cap and
working-tree versus signed-candidate evidence limits.

P3's complete built contracts entry measures **5,992 B minified+gzip**;
the owner-read cap is **11,776 B**, rounded to the nearest 512 B at about
twice that measurement. Only this browser limit changes. Existing pack classes,
other browser limits and clean-candidate artifact checks remain binding.


M04 B2 adds four default factories in this same pure contracts entry:
`createInvoiceDocumentContentFactory`, `createRoleNotificationContentFactory`,
`createInquiryContentFactory` and `createOptOutContentFactory`. Each accepts an
optional complete bilingual copy replacement; each content call takes an explicit
`pl`/`en` locale. Invoice takes resolved order/document references, kind and account
URL; role takes role, operator URL and optional pending expiry. Inquiry builds
receipt/notice blocks from caller details, signoff and URL without sending or
promising a response time. Opt-out returns display strings for seven outcomes;
it verifies no token and writes no consent. Hosts own brand, locale selection,
URLs, policy and delivery.

The reference invoice adapter defaults to its byte-identical Polish output; explicit
construction locale EN maps to `/account?sekcja=orders`, while the production
composition still omits locale. All existing role outputs remain identical.
The reference opt-out page now selects Polish/EN throughout, escapes display values,
and uses neutral selected-communications/service-message wording. Its methods,
verification, purpose allowlist, durable RPC, headers and statuses are unchanged.
Generic inquiry is only a pure binding; the existing private-label sender stays
unchanged. Invoice/role gain Polish canon previews; no sender/registry activation.
See the [complete B2 expectation ledger](../../docs/platform/plans/oss-m04-communications-triggers.md#b2-changed-expectations-and-preservation)
and [default conformance tests](test/communications/contentDefaults.test.ts).
The measured B2 contracts entry is 8,210 B minified+gzip under the unchanged
11,776 B cap; this is a local built-entry measurement, not release admission.

### Native communications operations (development preview)

The server entry `@openlup/platform/communications` additionally exports
`createPostgresDeliveryReconciliationPort`, `createPostgresCommunicationSyncStore`,
`createPostgresNotificationRecipientsPort` and `createPostgresConsentEvaluator`.
Install the complete canonical manifest through position 70 before selecting
these factories. `COMMUNICATIONS_MIGRATIONS` now projects positions 2, 9, 20 and
70; it remains a sparse inventory, not an installer. Missing schema/configuration
is an error, never an empty queue or an allow decision.

Each factory owns a capability-local, role-free transaction lane and lazy `pg`
pool, with `close()` for host cleanup. Only a trusted host may hold these owner
credentials. Effective PUBLIC/browser table, column and inherited privileges
cause refusal; the CREATE-only forward intentionally changes no old ACL or role.
Do not expose a factory or its database lane to browser callers. The directory
requires a verified active human operator, live communications authorization and
absence of machine authority in the same transaction as each operation.

A host registers `evidence: "network_accepted"` only after actual network
acceptance, with a unique source key and binding. Capture is never registered as
a network target. Polls and admitted callbacks call the same `applyObservation`
writer; observation-key replay must preserve the immutable fact. Readback keeps
acceptance, observed state, attempt/404 counts and abandonment separate. Only
three consecutive 404s abandon a candidate; abandonment is not failed/delivered.
Bounce/complaint writes the authoritative fingerprint's suppression atomically.
No subscription or renewal state is changed.

For newsletter sync, inject `rail: db => createPostgresOutboxStore(db)` from
`@openlup/outbox/postgres` in host composition. `db` is the current transaction,
so claim commits before I/O and rail ack and sidecar settlement commit together.
`registerWork` creates one existing-outbox identity for a source and target
binding. Successive preferences for one contact/target share the rail aggregate,
so newer work cannot overtake older unprocessed work. Configure a distinct
binding per target/provider, and exclude
`nativeSyncEventType(binding)` from generic dispatch registries. Invoke only
`runCommunicationSyncDispatch` with an explicit neutral membership provider.
The sidecar cannot claim work and has no lease or drainer. A membership settlement
records sync progress, never email delivery; remote exactly-once effects are not
promised across a process crash. There is no automatic backfill or activation.

Native consent evaluates registered P4 policy against the authoritative native
permission and persists the decision before returning its id. Admin notices need
an active source-bound notification recipient. Optional `testerPaused` reads
host-owned authoritative pause state inside that transaction; omitted means no
pause policy. The capability explicitly declares `managedFrequencyCaps: false`,
`legacyContactTouching: false`, `sendTimeFence: false`: managed 16-hour / 2-day /
4-week caps and legacy contact-touching are excluded. Evaluation does not fence a
later send against changed consent. Custom-purpose persistence remains host-owned.

The [callable reference binding](../../server/runtime/communications/communicationsLifecycleBinding.ts)
selects only `PLATFORM_BUNDLE=node-postgres` with `DATABASE_URL`; it closes pools
on success/failure and supplies no network/provider default. Existing managed
HTTP cron/UI routes retain their existing composition. See the
[B3 expectation inventory](../../docs/platform/plans/oss-m04-communications-triggers.md#b3-native-stores)
and [real-PG witnesses](../../tests/postgres/communicationsNative.test.ts).

C-compose extends the native delivery store with binding-scoped `findByMessageId`
and bounded `listEvidence({limit})` (1–100). Existing observation/replay and polling
methods retain their behavior. `registerPreference` on the native sync store
commits an authoritative denied/suppressed permission and default-purpose sync
work together; tester permission adds no marketing work. The trusted
`registerNativeSyncWorkInTransaction` helper contains the same registration SQL
used by `registerWork`; standalone input validation still precedes database entry.
This helper is a trusted host transaction seam: its caller-owned executor must
already hold the lane's safe effective privileges; the function does not check
them. Standard native sync factory transactions check
`public.communication_native_sync_state`, `public.outbox_events` and
`public.communication_recipient_consents`. The caller owns the transaction and
must commit or roll back permission, sidecar and existing-rail effects atomically.
Use a safely admitted lane; the helper grants no claim token or provider authority.

Reference composition remains outside the package: actual installed factories,
Core readiness, explicit provider ports and host-supplied schedules. Native
readback and signed-token bridges do not promise managed frequency caps, legacy
tester-source parity, a send-time fence or a full native network sender. The
opt-in browser profile adds no npm entry or UI package export.

Source contributors record notable changes in package changelog fragments;
release preparation assembles the shipped CHANGELOG. Follow the
[public contribution guide](https://github.com/openlup/openlup/blob/main/CONTRIBUTING.md#development-preview-checks).

## Payments prepared attempts

`@openlup/platform/payments` exports `executePreparedAttemptMechanism`: validate before durable preparation, refuse prepared replay, dispatch once unless the host proves no charge, and retry one immutable local finalization. The host owns keys, fingerprints, nominal error trust and persistence. An unknown execution never authorizes redispatch. The reference facade retains its existing binding.

`./payments/contracts` is type-only: execution/dispatch, transient method handoff, capability overlay, verified money/method evidence, bounded readback/absence, neutral refusals, refund observations and multi-subject conformance fixtures. Verification uses receipt time for freshness; ingress starts processing at receipt time and reuses durable first receipt on redelivery. Event identity includes outcome class. Transient authorization and opaque handoffs never enter persisted diagnostics. Capability support is explicit; timeout/truncation is unknown, never exact absence. Refunds require explicit evidence by default; `legacy-assume-full` is an explicit host opt-in. See the [M07 ledger](../../docs/platform/plans/oss-m07-payments-money-truth.md).

The payments entry also exports verified ingress, canonical truth fingerprints, method lifecycle/refusal handoff, reconciliation/verify-now and three runner-independent conformance functions. A new internal boundary projects verified envelopes into the contributed processing carrier: original bytes reach verification unchanged, receipt time starts processing, and durable first receipt overrides redelivery time. Full-reversal chargebacks use the existing dispute path. Snapshot and delta observations preserve original payment money; missing observation, required money or identity refuses before terminal application. Hosts own durable stores and response transport. Conformance checks exact identity/money, capability/port agreement and transient-secret exclusion; its evidence contains no handoff. Real-store durability still requires a selected-store proof.
