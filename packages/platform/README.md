# @openlup/platform

Development preview. This package is part of the publishable set with core and outbox; preparation does not establish a registry release or a stable API. Its repository-directory publish command refuses publication; the authorized package-release workflow owns publication.

It holds the runnable server substrate an OpenLup application composes: the Node HTTP runtime, BFF dispatch, scheduling and job leases, blob storage, data gateways, the node-postgres migration runner and bundle composition. Ports and their contracts stay in `@openlup/core/platform-runtime`.

For the prepared `0.22.0` set, read the [adjacent-release migration and known
limitations](CHANGELOG.md#0220) before selecting the opt-in M05 parity seams or
M06 composition bindings, the M07 payment selectors, or M08 fulfillment services. Native delivery alignment stays off or shadow until a host composes its automatic-renewal runner with the G23 admission decorator. M07 payment truth is complete for this wave; its selectors are default-off. M06 remains incomplete: inventory and shipping entries
are development-preview surfaces, with managed-host proof classes pending in the
[M06 parity ledger](../../docs/platform/plans/oss-m06-stock-reservations-delivery.md#parity-pending-rows).
The size gate compares the prepared `0.22.0` set with the published `0.21.0` tarball;
preparation, offline adapter evidence and a passing size cap grant no publication
or provider-account certification.

Longer module recipes live in the [platform package reference](../../docs/platform/PLATFORM_PACKAGE_REFERENCE.md).

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
| `./payments/stripe` | Opt-in Node payment example with an injected structural client, verified observations and purpose-sensitive readback; no SDK dependency or default activation. |
| `./payments/tpay` | Opt-in Node payment example with injected HTTP/certificate I/O, Model O aliases and verified observations; no default activation. |
| `./fulfillment/omnipack` | Opt-in Node fulfillment example with injected I/O; default-off. |
| `./payments` | Experimental prepared-attempt ordering with injected persistence, execution and failure policy; contracts at `./payments/contracts`. |
| `./fulfillment`, `./fulfillment/contracts` | [Experimental fulfillment services, contracts and status canon](../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#fulfillment-contracts). |
| `./subscriptions`, `./subscriptions/contracts` | [Experimental subscription contracts and renewal port](../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#subscription-contracts). |
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

`./identity` provides server identity services; `./identity/contracts` supplies browser-shareable contracts.
See the [identity recipe](../../docs/platform/PLATFORM_PACKAGE_REFERENCE.md#identity-import-candidate) for composition, migrations and operator invitations.

## Personal data

The experimental identity entry provides contributor-based personal-data export and erasure.
See the [personal-data recipe](../../docs/platform/PLATFORM_PACKAGE_REFERENCE.md#personal-data) for composition, refusals and retained obligations.

## Disposable identity composition

The opt-in reference identity shell consumes the existing identity exports with explicit routes and readiness admission.
See [disposable identity composition](../../docs/platform/PLATFORM_PACKAGE_REFERENCE.md#disposable-identity-composition) for its boundary and reference guide.

## Communications import

`./communications` provides host-composed communications services; `./communications/contracts` supplies pure content and browser contracts.
See the [communications recipe](../../docs/platform/PLATFORM_PACKAGE_REFERENCE.md#communications-import) for migration, email rendering and native operations.

## Package artifact limits

The monorepo's package artifact checker enforces this package's
`release-gates.json` caps and packed content allowlist. Only
`--release-set <version>` checks compressed growth against the last released
baseline, with explanations in the new set's changelog section and release body. Its browser-safe `./identity/contracts` export also has a minified+gzip cap. See the
[package artifact policy](https://github.com/openlup/openlup/blob/main/.github/VERSIONING_AND_EOL.md#package-artifact-limits)
for measured sizes, current caps, the S1 baseline refresh and refusal remedies.
Artifact checks require a clean package directory; `--manifest-only` supplies no
artifact evidence.

## Payments prepared attempts

`@openlup/platform/payments` exports `executePreparedAttemptMechanism`: validate before durable preparation, refuse prepared replay, dispatch once unless the host proves no charge, and retry one immutable local finalization. The host owns keys, fingerprints, nominal error trust and persistence. An unknown execution never authorizes redispatch. The reference facade retains its existing binding.

`./payments/contracts` is type-only: execution/dispatch, transient method handoff, capability overlay, verified money/method evidence, bounded readback/absence, neutral refusals, refund observations and multi-subject conformance fixtures. Verification uses receipt time for freshness; ingress starts processing at receipt time and reuses durable first receipt on redelivery. Event identity includes outcome class. Transient authorization and opaque handoffs never enter persisted diagnostics. Capability support is explicit; timeout/truncation is unknown, never exact absence. Refunds require explicit evidence by default; `legacy-assume-full` is an explicit host opt-in. See the [M07 ledger](../../docs/platform/plans/oss-m07-payments-money-truth.md).

The payments entry also exports verified ingress, canonical truth fingerprints, method lifecycle/refusal handoff, reconciliation/verify-now and three runner-independent conformance functions. A new internal boundary projects verified envelopes into the contributed processing carrier: original bytes reach verification unchanged, receipt time starts processing, and durable first receipt overrides redelivery time. Full-reversal chargebacks use the existing dispute path. Snapshot and delta observations preserve original payment money; missing observation, required money or identity refuses before terminal application. Missing money, amounts that are not safe positive integers, or blank currencies on succeeded, refunded or disputed adapter evidence use the existing amount-mismatch refusal before ingestion or terminal application; ingress returns the existing processing-failure response. Failed and pending evidence may still omit money. Hosts own durable stores and response transport. Conformance requires safe positive integer amounts and nonblank currencies on settling money and checks exact identity/money, capability/port agreement and transient-secret exclusion; its evidence contains no handoff. Real-store durability still requires a selected-store proof.

`createPostgresPaymentTruthPort` accepts the platform data executor structural
shape and `PostgresPaymentTruthOptions` from the contracts entry. It preserves
the native truth ingest, reconciliation, sweep and readback SQL. `PAYMENT_MIGRATIONS`
projects canonical units 10/35/56 byte for byte, with path, position, SHA-256 and
asset URL; install the complete catalogue, never those three files alone.
`paymentSchemaDescriptor` admits direct truth, settlement and later-only cycle
alignment, and explicitly refuses prepared durable storage, method setup,
absence reopen and cumulative refund. Refunds are purely financial. Seven real
PostgreSQL cases cover fresh/prefix installs, replay/conflict, unknown readback,
lost acknowledgement, rollback, denied access, dunning/recovery, concurrency and
later-only dates; this does not claim managed-store parity or host activation.

Attempt input adds optional method selection with opaque, persistable channelRef
and transient payer email/name. Payer contact is dispatch-only: never persist,
audit, log or diagnose it. Missing adapter-required input must refuse before
dispatch with exact `notDispatched` evidence. Conformance scans the execution
and complete projected stored payload for transient values. Nested normalized
evidence copies only declared typed fields, including nested facts; unknown
extra properties are excluded. Incomplete chargeback evidence remains stored as
a refund and unapplied, a declared operator recovery limit: reclassification
would apply the donor dispute path without checking completeness.

`createCheckoutActivePaymentActionResolver` authorizes the exact owner, order,
intent, attempt and execution rail, reads the provider once, then rechecks the
complete canonical attempt. Hosts inject synchronous `railHandoffKinds` from
adapter capture capabilities; an unknown rail supplies an empty list. Actions
carry the provider address and the existing transient `PaymentMethodHandoff`.
Pending evidence alone may expose a handoff; terminal, mismatched, unknown or
raced evidence refuses it. `createCheckoutRecoveryPaymentResolver` preserves
paid/retry/resume/wait/manual-review ordering without creating a new obligation.
`createCommercePaymentVerifyHandler` validates the existing identity triple,
checks stored ownership before readback, and uses the shared HTTP/responder
contracts. A host may inject its responder to preserve request references.

`PaymentRepairMethodPort` collects a method only; it grants no token redemption,
subscription change or payment success. Unsupported setup is explicit. Method
evidence may carry neutral registration refs/kind/status. Ingress projects them
only with `resolveMethodOwner` supplied by the host; adapter-supplied client or
subscription fields never confer ownership. Without host ownership resolution,
registration is not projected. Lifecycle carriers copy typed facts only.
The existing refusal handoff accepts a failure-reason string, not a typed
adapter refusal envelope; envelope forwarding remains unsupported.

### Payment service composition

`createPaymentServices` accepts `PaymentServicesOptions` and returns
`PaymentServices` or null when truth schema/capability is unavailable. The host
supplies `openTruth`, which opens one port and its asynchronous close operation.
`run` closes that scope after success or failure. Construction performs no I/O.
Use the existing `createBundleComposer` payments binder for named registration;
omitting it leaves the host cold. Schema declarations do not prove installation:
retain the existing readiness/schema checks before admitting work. Existing jobs
and routes keep their owners; this binding adds no schedule or event handler.

The reference direct truth binding injects its existing executor, templates and
recovery path. The separate verified-ingress selector is explicit and default-off;
unknown selections refuse. Its projected carrier includes the adapter fingerprint,
so the reference store records stable identity on the first receipt independently
of audit payload or clock. On replay the store reads the first stored instant;
application and follow-up work reuse it. Missing durable clock evidence refuses
rather than advancing a cycle. This D11 behaviour change does not mount a provider
route or enable an adapter; hosts must explicitly wire the selected ingress.

### Opt-in payment example

Import `createStripePaymentAdapter`, `type StripePaymentAdapterConfig` and
`stripePaymentCapabilities` from `@openlup/platform/payments/stripe`. Supply a
structural client, `webhookSigningSecrets`, explicit `mode`, required
`supportedCurrencies` (a non-empty list of upper-case three-letter codes) and optionally
`toleranceSeconds` (default 300) and `clock` (UTC seconds). The host constructs
and configures the SDK, associates saved methods with customers and confirms
off-session requests. Interactive methods follow the declared card/wallet offer.
Importing creates no I/O or default binding. The adapter advertises the host
currency list as a frozen copy; the frozen exported descriptor keeps an empty list.
Account-specific readiness remains pending TEST verification. Exact absence,
refund creation and split authorization/capture are unsupported. Cancellation
is enabled only when the injected client supplies it. See the
[A2 ledger](../../docs/platform/plans/oss-a2-payment-adapters.md) for the current
preview boundary and the host's responsibilities.

Verified dispute events retain their distinct money outcome and original payment
identity. Audit payloads carry only donor-filtered facts: the source event type,
refund charge snapshot and failure-evidence provenance when present. They exclude
raw bodies, client handoffs and customer authorization and do not affect event
IDs or fingerprints. The offline adapter conformance witness uses two distinct
intents and attempts with separate money and provider references.

Method evidence carries the donor lifecycle and replacement facts through M07
projection when provider time is present. Without provider time it retains the
method outcome and omits the lifecycle instead of inventing a transition time.

### Opt-in bank and code payment example

Import `createTpayPaymentAdapter`, `type TpayPaymentAdapterConfig` and
`tpayPaymentCapabilities` from `@openlup/platform/payments/tpay`. Supply `http`
with explicit `baseUrl`, `clientId`, `clientSecret`, `fetchImpl` and optional
`timeoutMs`; `urls` with `notificationUrl`, `successUrl`, `errorUrl`;
`modelOActivationEnabled`, `mode`, and optional UTC-seconds `clock`.
`notification` requires `rootCertificatePem`, `allowedCertificateUrlPrefix`
(HTTPS directory ending in `/`) and `resolveCertificate`. The resolver owns
redirect/egress policy. Both certificates must be valid at verification time.

Verify certificate validity and notification freshness using original raw bytes.
A signed protected-header `iat` supplies UTC-seconds provider time; absent time
stays null. `maxNotificationAgeSeconds` defaults to seven days, a generous
assumption pending confirmation of the provider retry schedule. Signed issue time
more than `maxClockSkewSeconds` (default 300) after receipt refuses as stale;
both freshness limits must be finite and nonnegative. Host dedupe
uses exact event identity plus stable fingerprint when time is absent. The age
and future-skew limits apply only when the signed header carries a provider issue time. Receipt
time is used only for freshness. Transaction identity includes outcome class;
method identity includes event/alias plus outcome.

Bank redirects, one-time codes and unattended Model O alias charges are supported
when the host supplies the M07 P3 contract payer and method selection inputs.
Supply transient `payer: { email, name? }` on every
attempt, including renewals. An omitted or blank name uses the donor
neutral display label `Customer`. Select `methodSelection: { family: "bank-redirect",
channelRef }` for the bank channel, or `{ family: "one-time-code" }` with
`customerAuthorization` as a `TransientSecret`. A `renewal-unattended` attempt
uses `storedMethod.reference` and its Model O mandate. Missing payer/channel/code
and Model M or unknown mandates refuse before any dispatch with neutral
data-correction evidence. Payer and authorization never cross the return boundary
in diagnostics or request/response payloads. Readback uses the returned API
transaction ID; notification titles remain distinct. The donor's typed no-charge
errors return an exact `notDispatched` envelope: proven request-document refusals
require customer data correction; OAuth, encoding and exhausted pre-send deadlines
remain transient retryable refusals. Host mode/purpose/currency mismatches throw before I/O.
A renewal the provider refuses for data validation is classified as needing customer data correction: the host should prompt the customer to update payment details, and the bundled retry schedule keeps its normal retries unless the host treats that class as terminating. The subscription stays active; nothing is paused or suspended by this classification. The contributed adopter applies this classification only when reopening a checkout; the example applies it to every purpose.
Every other execution error propagates unchanged as ambiguous.

The exported capability descriptor and its nested records and arrays are frozen.
Currencyless money notifications preserve the paid amount and bind to the adapter's single declared currency; multiple declared currencies refuse as malformed.
Alias method evidence preserves the donor lifecycle through M07 projection with
signed provider time; absent provider time leaves the lifecycle field omitted.
The adapter offers its declared market currency; alias registration and recurring
cards are not offered by this factory. Account offers
remain `verification_pending` until owner TEST readback. Chargeback observations carry full reversal,
original money and stable operation identity; refunded/chargeback readback stays
unknown for manual review, including historical attempt/error refusals in either
readback purpose. Pending and refused readback report validated configured money,
including when the paid amount is zero or absent; a refused result with mismatched
nonzero paid money stays unknown for manual review. Succeeded readback requires the donor's
observed paid amount to equal expected money; underpayment and overpayment remain
unknown for manual review. There is no close or exact-absence port. Refund
creation and authorization/capture separation are unsupported. See the
[A2 ledger](../../docs/platform/plans/oss-a2-payment-adapters.md#o-p2-boundary-and-named-deltas).

Verified audit payloads retain only donor-filtered transaction and alias facts,
including `eventKind`, alias `event` and `aliasType` when supplied. Missing failure
provenance and failure prose stay absent. Payer, authorization, certificates and
raw bodies never enter the evidence; audit facts do not affect event identity or
fingerprints. The offline M07 P2 conformance witness uses two distinct intents,
attempts, amounts and provider references, with replay and refusal boundaries.

### Reference-support surface

The vendor subpaths additionally expose these experimental helpers for the
reference application's existing host bindings. Each declaration names its exact
reference consumer and carries `@experimental`: Reference-application support
surface; may change.

| Entry | Additional exports |
| --- | --- |
| `@openlup/platform/payments/stripe` | `createStripeSandboxPaymentExecutionAdapter`, `createStripePaymentReconciliationProvider`, `mapStripeIntent`, `mapSetupIntent`, `normalizeStripeFailureEvidence` |
| `@openlup/platform/payments/tpay` | `createTpayPaymentExecutionAdapter`, `createTpayPaymentReconciliationProvider`, `createTpayHttpClient`, `normalizeTpayFailureEvidence`, `aliasValue`, `ProviderAttemptPreDispatchError` |

Types are inferred from those functions; no extra type export or neutral payment
entry is added. These are the existing contributed implementations, including
rich execution, recovery and filtered audit carriers. The host still owns SDK
construction, environment/feature flags, callback/return presentation, account
readiness and simulator composition. Its prepared-attempt facade re-exports the
same error class so `instanceof` preserves the no-charge trust boundary.
The M07 factories' neutral envelopes and capability limits remain unchanged;
reference-support availability establishes no provider activation or stable API.

## Subscription contracts and renewal port

The experimental `./subscriptions` entry exposes hosted renewal mechanisms and
an explicit native capability descriptor; `./subscriptions/contracts` is
browser-safe and type-only. The [subscription architecture and recipe](../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#subscription-contracts)
owns the concrete ports, continuity rules, capability refusals and witnesses.
These entries do not install a store or activate a runner.

Native renewal and N1 retry stores accept injected SQL executors and explicit
snapshot/identity policy. The generic native executor consumes the subscription
ports; host composition supplies G23, M07, transaction and correlation policy.
The initial binding preserves case-before-outcome ordering with atomic bookkeeping.
N1's same-obligation recovery repairs the native decline stall (F16); it does not
supply M07 prepared-store parity or activate a runner.
