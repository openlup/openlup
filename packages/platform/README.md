# @openlup/platform

Invoicing exports explicit `createInvoiceServices`, `InvoiceServices` and inert
`createInvoiceContribution` through `/invoicing`, with no new composition entry.
`claimInvoiceSellerRevision` reads an injected selection before claim; the pinned
SQL wrappers persist it for eligible obligations. `InvoiceSellerRevision` is also
available from the type-only contracts entry. Legacy obligations keep fallback.

Development preview. This package is part of the publishable set with core and outbox; preparation does not establish a registry release or a stable API. Its repository-directory publish command refuses publication; the authorized package-release workflow owns publication.

It holds the runnable server substrate an OpenLup application composes: the Node HTTP runtime, BFF dispatch, scheduling and job leases, blob storage, data gateways, the node-postgres migration runner and bundle composition. Ports and their contracts stay in `@openlup/core/platform-runtime`.

Repository-source links in this README are optional navigation to current public
`main`; the linked files are not part of this package tarball and may describe a
different revision than the version installed. For version-specific behavior,
start with the installed package's README, CHANGELOG and declarations, and consult
source at a matching release or tag when available. A current-`main` link is not
proof of compatibility or support for an installed artifact.

For the prepared `0.34.0` set, read the [adjacent-release migration and known
limitations](CHANGELOG.md#0340) before selecting optional services. Experimental
M13 marketing uses browser-safe `./marketing`, type-only browser-safe
`./marketing/contracts`, and Node-only `./marketing/server` and
`./marketing/server/postgres`. Marketing contributions and bindings remain
inert and default-off. Experimental
account/support APIs use `./account-support` and the type-only
`./account-support/contracts`; reference bindings remain inert and default-off.
Apply the M12 support-authority forwards after complete same-rail predecessors
and follow the email-correction admission, claim, identity-commit and settlement
migration notes before replacing retired callers. Experimental
commerce schemas and ports use `./commerce` and `./commerce/contracts`;
handlers, adapters and checkout engines use the Node-only `./commerce/server`.
The commerce contribution and reference binding remain inert and default-off.
Install the complete native chain through the M12 support-authority forward
(`20261026120000_account_support_operator_authority.sql`). Sparse SQL projections
are not an install chain. Native runtime
roles need the ATP/exposure EXECUTE and underlying SELECT grants described in
the release notes.
Managed hosts apply the complete prefix through `20261026120100`, including
the current support-authority forward and M11's nine forwards for preference/return ownership, operator receipts,
acquisition/finalize admission, ATP preview and starter graduation. Legacy
omitted-country input uses the configured settlement region; neutral commands
require explicit country. Starter graduation admits 14, 21 or 28 days; rollback
below that forward with a 21-day marker is unsupported, so roll forward.
The service-only ATP preview uses owner privileges and a fixed search path.
Retain exact applied failure-attempt attribution for the existing managed
dunning overloads; native attempt-replay parity remains registered. These
managed forwards authorize no host activation.
Preserve captured obligations and receipts on rollback.
M10 subscription services and contributions remain **EXPERIMENTAL and DEFAULT-OFF**.
Hosts explicitly supply readiness, execution, commands, mandatory G23 admission,
a population lease and M04 delivery. Factories activate no serving work. The inert
native reference composes renewal, dunning and stock wait; managed TypeScript
stock recovery, native multi-cycle prepaid and M07 prepared-attempt-store
capabilities retain their named unsupported boundaries. Follow the older native-row
migration precautions when upgrading `0.22.0` data.
M09 invoicing remains **EXPERIMENTAL and DEFAULT-OFF**, available for explicit
provider/capability selection and ready host composition, including issue,
correction, independent duties, delivery/read-side and seller revision helpers.
Adopters must not activate unselected or unready invoicing; installation and
inert contributions register no runner, worker, route or schedule.
M06 managed-host proof classes remain pending in the
[M06 parity ledger](https://github.com/openlup/openlup/blob/main/docs/platform/plans/oss-m06-stock-reservations-delivery.md#parity-pending-rows).
Size comparison uses the published `0.32.0` tarball. Preparation and offline
adapter evidence grant no publication or provider-account certification.

Longer module recipes live in the [platform package reference](https://github.com/openlup/openlup/blob/main/docs/platform/PLATFORM_PACKAGE_REFERENCE.md).

The prepared set requires Zod `^4.6.6` for GHSA-mrhx-c7xc-m3w5.
Public quote requests retain their collection limits and valid-input behavior;
oversized collections now fail with the size error before accumulating invalid
element errors. Package API and installed-consumer checks remain required.
The observation adapter explicitly retains minute-precision timestamps
alongside seconds/fractions, compact offsets and local timestamps. Calendar
validation still rejects impossible dates; validation never rewrites the raw
timestamp used in the webhook's idempotency key.

The experimental migration source may supply `assertSession` to observe host
facts once under the existing advisory lock, after exact ledger-prefix admission
and before status, dry-run or pending SQL. Every source uses catalog-bound locks
and admits only the canonical baseline ledger catalog shape before reading its
exact prefix. A pending unit locks an installed ledger before its first catalog
read in that transaction and preserves the connection's isolation setting. The
[migration owner](https://github.com/openlup/openlup/blob/main/docs/platform/DATA_AND_MIGRATIONS.md#module-catalogues-and-installed-histories)
and [runner witness](https://github.com/openlup/openlup/blob/main/packages/platform/test/migrations/postgresRunner.test.ts) define that boundary;
this callback does not provision or qualify a hosted installation.

## Installed agent context

The tarball includes a small root `AGENT_CONTEXT.md` snapshot of canonical
platform guidance. Source paths, line ranges and excerpt digests identify its
provenance. Read the version from the installed `package.json` and check the
cited source before relying on an excerpt.
Core's installed `openlup-context` command discovers this snapshot locally and
returns file-and-line citations offline. Shipping this documentation adds no
runtime dependency, service or activation, and grants no host policy or execution
authority. A snapshot does not establish publication, compatibility or support.

## Package surface

The experimental Node-only `./lifecycle` entry plans and applies explicit
application-file snapshots. It preserves unmanaged files and local edits in
upstream-unchanged files, refuses divergent changed files before writes, and
resumes exact completed replacements after interruption. The caller holds an
exclusive maintenance window and supplies schema-range evidence; this entry
runs no database migration, npm install or deployment. Read the
[file-ownership boundary](https://github.com/openlup/openlup/blob/main/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#application-file-upgrades)
and [disposable app recipe](https://github.com/openlup/openlup/blob/main/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#application-file-upgrade).

The same entry exports `inspectLegacyPostgresInstallRoles`, a read-only query
through a caller-owned PostgreSQL handle. Its
`legacy-fresh-bootstrap-role-prerequisites` report observes finite immutable
legacy bootstrap role conditions; `rolePrerequisitesMet` does not establish
install readiness, schema/ACL correctness or provider support. See the
[legacy role boundary](https://github.com/openlup/openlup/blob/main/docs/platform/DATA_AND_MIGRATIONS.md#legacy-fresh-bootstrap-role-observation).

The experimental Node-only `./portability` entry copies a bounded, explicitly
complete immutable/quiesced object inventory and captures/restores selected
compatible PostgreSQL rows through injected transaction handles. Private
filesystem objects publish bytes and metadata together, bind an explicit access
label to the filesystem owner's private policy and resume by verified readback.
Row replay preserves exact JSON/numeric/time values, refuses conflicts and every
enabled user INSERT trigger, and copies no schema, migration ledger or grants.
With the complete 0.35.0 catalogue, `outbox_events` also needs the owner path, so the generic utility refuses it; that owner path is reference-source only.
The host qualifies the canonical catalogue, credentials and source completeness.
These helpers activate no executor and do not supply managed identity mapping,
live changed-row catch-up or hosted old-worker fencing. Read the
[transfer boundary](https://github.com/openlup/openlup/blob/main/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#existing-store-transfer-and-recovery)
and the retained [M14 obligations](https://github.com/openlup/openlup/blob/main/docs/platform/plans/oss-m14-operations-portability.md).
The provider-owned HTTP counterexample exercises an existing adapter's cached
bearer; its local fixture establishes no hosted revocation guarantee.

`release-gates.json` declares kind `rail`: this foundation provides runtime infrastructure over core ports, matching the architecture's rail responsibility. Its experimental entries each bind a declaration snapshot and package-owned smoke tests. The API checker reads this same inventory.

| Export | Contents |
| --- | --- |
| `./lifecycle` | Experimental Node file-snapshot planning/apply and read-only legacy PostgreSQL role prerequisites; no install-readiness claim, optional SDK or activation |
| `./portability` | Experimental server object copy/resume, private filesystem transfer store and compatible PostgreSQL row capture/restore; injected handles, explicit refusal and no activation |
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
| `./fulfillment`, `./fulfillment/contracts` | [Experimental fulfillment services, contracts and status canon](https://github.com/openlup/openlup/blob/main/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#fulfillment-contracts). |
| `./subscriptions`, `./subscriptions/contracts` | Default-off, incomplete; [experimental subscription contracts and renewal port](https://github.com/openlup/openlup/blob/main/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#subscription-contracts). |
| `./invoicing`, `./invoicing/contracts` | Default-off invoicing contracts and independent duty collection; no provider activation. |
| `./inventory` | Experimental schemas/ports, handlers, native stores, projection, injected forecast and SQL descriptor; `./inventory/contracts` DTOs. |
| `./catalog` | Experimental neutral catalog schemas, drafts, reads, media source packs and publication ports |
| `./catalog/contracts` | Dependency-free catalog DTOs, media resolver, authority and canonicalization helpers |
| `./marketing/server` | Node-only acquisition handlers, direct read/evidence factories and research orchestration without `pg`; host responder, authorization, binding and notification copy |
| `./marketing/server/postgres` | Acquisition case and research evidence PostgreSQL port factories; requires the existing optional `pg` peer |
| `./marketing/server` (analytics context) | Injected analytics context handler with host persistence, capability and identity bindings |
| `./marketing`, `./marketing/contracts` | Browser-safe acquisition history, portable prelaunch, survey evidence and newsletter consent schemas; type-only DTOs and acquisition/research ports |
| `./marketing`, `./marketing/contracts` (analytics) | Browser-safe acquisition and research schemas, injected analytics, paid purchase and consent-time facts; type-only DTOs and ports |
| `./marketing`, `./marketing/contracts` (SEO and content slots) | Browser-safe JSON-LD serialization and graph builders, URL/hreflang helpers, ordered head data and contact/legal projections; type-only organization, contact, legal-document and privacy-processor content slots |
| `./commerce`, `./commerce/contracts` | Browser-safe neutral commerce schema cores, generic ports and pure contract helpers |
| `./commerce/server` | Node-only OMS, returns, native reviews/media and hosted-feedback handlers/adapters and order-detail composition, email consumers, dispatch registry, paid-fulfillment binding and checkout compensation, checkout handlers, runtime and shared paid-order saga |
| `./pricing` | Experimental price authority, quote computation/handlers, offer projection/cache, readiness and policy tokens |
| `./pricing/browser` | Existing quote primitives, acquisition validators and shipping-terms validator, browser-safe |
| `./pricing/contracts` | Dependency-free authority, money, quote and offer DTOs and version constants |
| `./promotions` | Experimental promotion application, admin handlers, native read/sweep, SQL projections and acceptance |
| `./promotions/contracts` | Dependency-free preview and admin DTOs |
| `./shipping` | Experimental delivery ports, injected-schema handlers, summary/evidence; native flat-rate port + Core schema readiness |
| `./shipping/contracts` | Type-only address, customer-address, delivery, pickup-point, shipping-rate and threshold contracts, plus selection summary and evidence DTOs |

## HTTP runtime and security contract

The Node-only `./http` entry builds a request handler around host-supplied route
tables, dispatch, entrypoint loaders, deadlines, security-header policy, robots
content and static-asset reader. Its request order is fixed: apply security
headers, handle canonical trailing-slash redirects and declared entrypoints,
dispatch the BFF and scheduled routes, refuse unknown API paths, then apply
host-declared redirects and static-document rules. The package does not infer
which application routes are authorized or supply deployment-specific header
policy.

Buffered requests retain the exact raw bytes for signature verification while
also exposing parsed JSON to handlers; the platform CSP-report entrypoint and
explicitly marked stream-first handlers retain their live stream instead. Body
size/deadline boundaries remain explicit. Static serving returns 404 for a
missing asset, serves only declared route documents or an enabled SPA fallback,
and leaves route admission to the host. These helpers define the HTTP adapter
contract; they do not certify a deployed route or security policy.

## Marketing contracts

The browser data-layer factory defaults to analytics-consent-only admission. Hosts may opt in with `consentPolicy: "independent"` to admit events with either stored analytics or marketing cookie consent. The explicit `consentPolicy: "host-authorized"` mode also admits observations when no purpose is granted, solely for hosts that authorize limited consent-aware transmission and enforce route and per-tag gates. Both nondefault modes keep consent updates tied to each stored category; `pushAnalyticsConsentUpdate(false)` denies both. The host must gate every tag by its own purpose, and may allow denied-state transmission only for explicitly authorized consent-aware tags. The factory does not inspect tag behavior or minimize event payloads; the host must authorize every admitted event and its data. Queue admission never authorizes storage or grants a purpose. In nondefault modes update(true) publishes stored flags and update(false) publishes all denial; neither switches the admission policy or fences routes. Queue admission does not prove delivery or attribution.


`./marketing` provides acquisition address references, historical case projections,
list/count reads, portable prelaunch list/detail schemas, idempotency keys, survey submission/evidence/list schemas and
newsletter consent events/responses. Reference compatibility shims forward the
same schema objects and load the reference validation wrapper before package
schemas. The marketing runtime entry configures the shared Zod instance in
jitless mode before constructing schemas, preserving CSP-safe initialization
for direct imports as well as reference facades, like the pricing, catalog and
communications entries. The type-only `./marketing/contracts` entry has no
runtime initialization. The rich prelaunch DTO and case submit/transition schemas remain application-owned
and are excluded from the browser entries. The shared
`acquisitionOpaqueReferenceSchema` lets those retained contracts reuse the exact
reference syntax. No entry registers a route automatically.

`./marketing/contracts` exports only types. Explicit acquisition DTO shapes are
checked against the runtime schema inference by an executed TypeScript equality
witness. Reachable case ports expose list, get, active count and close; the app
uses the server-only compatibility port for its retired methods. Evidence ports retain survey submission,
survey listing and consent application. Port types are also forwarded through
the runtime entry, following the commerce boundary. Both entries forward research schemas or types from the compatibility
owner, `@openlup/core/marketing/research`; runtime schemas retain object identity.
Case locale remains `en|pl`, matching the persisted constraint. Widening it requires
a separate migration. Historical wire values remain unchanged.

The source and built entries have browser graph proofs. The root test runner
selects `test/marketing/`; the installed consumer checks both public entries,
compiles typed usage and refuses deep imports. Kiosk and research reference
contracts/ports continue to consume the core export. The app owns its admin
response client and host composition.

`./marketing/server` owns acquisition case handlers, list/count and prelaunch
list/detail factories, survey evidence submit/list and consent application,
research submit/admin handlers and managed survey orchestration without loading
`pg`. Select `./marketing/server/postgres` for the two PostgreSQL port factories
after installing the existing optional `pg` peer. Hosts inject the BFF responder,
authorization and binding resolvers. Direct case reads receive the host bundle
predicate at their original guard; prelaunch and evidence dispatch stays in the
host. Notification HTML and subject are injected separately, preserving
HTML rendering before the subject clock read. The reference owns retired
route refusals, raw signed consent ingress and notification copy. PostgreSQL
SQL, role selection and transaction/pool handling remain unchanged. The
server-only compatibility command types do not expose retired admission schemas.

Analytics facts share these browser-safe entries. `createNoopAnalytics` implements
Core's existing analytics port; deployment and advertising defaults remain inert.
`AnalyticsEventMap<StepName>` retains the host's literal step vocabulary, with
`string` as the neutral default. Private transport ownership fields and envelopes
remain host extensions. Types are forwarded type-only by `./marketing/contracts`.

`createAnalyticsDataLayer` owns loader readiness per instance and accepts the host's
browser/storage access, consent key and change event, `consentSignalNames`, event
prefix, container reader and deployment callback. `consentSignalNames` supplies
one `analytics` wire name and the ordered `advertising` wire names. Without it,
no consent command is pushed and optional event admission returns false, even
with browser access, a container and stored consent; deployment attempts remain
independent. Consent commands seed default before update and
use array-like arguments; advertising grants read marketing consent at push time.
By default, update commands carry the caller-supplied analytics decision and
optional events require the stored analytics flag. With
`consentPolicy: "independent"`, updates additionally require each
purpose’s stored flag, and optional events accept either stored analytics or
marketing consent. With `consentPolicy: "host-authorized"`, optional events are admitted even before choice or after refusal, while updates still require each purpose’s stored flag. Optional event admission in every mode requires a configured container and configured signals. Hosts must independently fence private routes and unauthorized tags. The host owns
authorization and must not use this helper to create consent; stored flags are
admission inputs, not consent authority.
An explicit all-denial update denies every signal. Sinks are attempted independently with failure
isolation and no replay of observations made before consent. Admission booleans
mean synchronous local acceptance only, never delivery or business acknowledgement.

`createAnalyticsRoutePolicy` requires public paths, redirect sources and all
sensitive-path sets. Its optional-route predicate preserves broad eligibility;
deployment URL sanitization admits exact public paths and safe campaign values.
`projectPaidPurchase` consumes only structural paid-recap facts, preserving
allocation/grouping, the item cap and ordered suppression reasons without an
ambient currency policy. `selectMarketingHistoricalConsentTime` selects exact
native chronology only after host authorization, without changing the local
grant. The reference retains its narrower checkout-kind admission and all wire
names. [Purchase equivalence](https://github.com/openlup/openlup/blob/main/src/checkout/machine/purchasePayloadEquivalence.test.ts)
and the package analytics witnesses pin these boundaries.

`createAnalyticsContextHandler` in `./marketing/server` accepts a required BFF
responder, enable reader, persistence resolver, access-token reader, trusted-subject
resolver, capability mint/hash functions, historical cookie name and `clientIdField`.
The host supplies the client-id wire field name through `clientIdField`; the strict
request also keeps `granted` and `explicitGrant`. Grants require a client
id and existing revoked contexts require an explicit new grant for replacement.
Only token hashes reach persistence. Enrollment uses only the server-verified
subject, and invalid bearer grants refuse before writes. Cookie attributes and
method/flag/origin/schema refusal order are preserved. The host owns flag and
RPC names, gateway authority, route mounting and observability. Persistence
operations must reject on failure; null persistence refuses as unavailable.
There is no default persistence, portable SQL or reference route for this handler.
An `active` result is a local context fact, never delivery, and telemetry context
failure never gates commerce. The [context witness](https://github.com/openlup/openlup/blob/main/packages/platform/test/marketing/analyticsContext.test.ts)
exercises the factory through synthetic host bindings.

`./marketing` also provides browser-safe JSON-LD serialization and graph builders,
route URL/hreflang helpers, an ordered head descriptor and plain contact/legal
projections. Applications supply identity, origin, routes, locales, images and
content; the descriptor is plain data for a host head manager. The type-only
`./marketing/contracts` entry exports shared organization facts and contact,
legal-document and privacy-processor shapes, also forwarded as types by the
runtime entry. The package supplies no document wording, processor inventory or
content policy. The [marketing recipe](https://github.com/openlup/openlup/blob/main/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#marketing-seo-and-content-slots)
owns the mechanics and installed-artifact proof.

## Marketing composition

`./composition` exports `createMarketingContribution`, an inert descriptor for
the `marketing` capability's `./marketing`, `./marketing/contracts` and
`./marketing/server` entries, with a runtime dependency on `identity/contracts`
for obligation validation.
Supply already-bound operations and host schema requirements. Ports, routes and
triggers share the supplied functions; null ports remain required for Core
readiness, and handlers retain only registration descriptors. Duplicate handler,
schedule or route identities refuse. Construction invokes no callable and
installs no worker, route or schedule. See the
[composition contract](https://github.com/openlup/openlup/blob/main/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#contributions-seams-and-readiness)
for the host admission boundary.

`./marketing/server` also exports `createMarketingPrivacyContributor` and
`createMarketingPrivacyBindings`. Explicit enablement and both complete owner
ports select one contributor; its `exportPersonalData`, `assessErasure` and
`eraseOrRetain` callables can be passed directly to `createMarketingContribution`.
Missing ownership makes coverage unavailable and erasure unresolved. Identity
owns assessment ordering, subscription vetoes, receipt replay and transaction
rollback; the marketing fence runs only during `eraseOrRetain`. Provider request
acceptance never proves deletion. The reference leaves marketing unselected,
so its marketing privacy coverage remains an open gap. See the
[privacy composition recipe](https://github.com/openlup/openlup/blob/main/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#marketing-server-composition).

The contributor and binding declarations use identity contract types and local
structural interfaces compatible with identity's `PersonalDataContributor`.
They do not reference identity's main entry; `./marketing/server` compiles without
`pg` or `@types/pg`. Select `./marketing/server/postgres` explicitly for those ports.

## Commerce contracts

`./composition` exports the inert `createCommerceContribution` for the installed
commerce entries and selected callables. Duplicate descriptor identities refuse;
the [composition recipe](https://github.com/openlup/openlup/blob/main/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#contributions-seams-and-readiness)
and [reference binding](https://github.com/openlup/openlup/blob/main/docs/platform/RUNTIME_AND_SELF_HOSTING.md#opt-in-disposable-subscription-reference)
describe host readiness, one executor per operation and native recovery limits.

`./commerce` stays browser-safe. `./commerce/server` is the separate Node-only
entry for checkout engines, handlers, stores and adapters. It exports
`tryCompensate` and `CheckoutCompensationPort`: release the selected order's
reservations, attempt unstarted-promotion cancellation, then cancel the abandoned
order only when promotion cleanup did not succeed. Existing keys, reasons,
warning messages and swallowed cleanup failures are preserved. The reference
facade delegates to the same function; composition still owns the cleanup ports.
The package boundary test bundles the browser entry without Node built-ins or
the server subtree, and the cold consumer exercises installed compensation.
Starter declaration types are inferred from the `createStarterOfferGuard`
binding signature; the declaration interface stays internal to the engine.

The Node-only entry owns the checkout admission/quote/resume/failure sequence,
neutral command adapter, runtime and one paid-order saga. Composition injects
HTTP schemas/responder, quote and persistence ports, subject/metadata projections
and the existing prepared-payment execution callables. Provider roles, flow
selection and trusted provider-evidence classification are reference inputs.
Saved-method alias and recurring-mode strings are host-defined generics passed
unchanged through resolver, saga and runtime; the evidence schema owns its internal JSON-length bound. The reference retains
locale, fiscal, profile, starter-policy, request observation and status-link
bindings. Acquisition expectations and accepted shipping terms require quote
acceptance; offer asks require a bound policy. A matching owned saved epoch can
resume; edited or incomplete state re-quotes. Stock refusal compensates only a
proved pre-dispatch draft; scoped contention and uncertain dispatch carry no
cleanup capability. A synchronous decline stays failed and is never auto-settled.
Neutral finalize and one-time reservation conformance tests use recording ports;
atomic acquisition/finalize SQL still requires integration with its migration chain.

The server entry also owns generic order-draft, runtime-finalize, intent-persistence
and resume stores, cancellation adapters and reservation sweeps. Structural clients
retain the incumbent RPC/table calls; composition supplies frozen snapshot schemas,
ordered finalize arguments, response decoders and fail-open phone normalization.
Use `createCommerceOrderDraftRpcPort`, `createCheckoutCompensationRpcAdapter`,
`createCommerceCheckoutResumeQueryPort` and `createConfiguratorIntentPersistenceRpcPort`
with structural clients, including `ConfiguratorIntentRpcQueryClient` for intent
persistence. Reference bindings retain their incumbent exported factory names.
Verified identity overwrites submitted identity after normalization. Draft retries
supersede only once after an idempotency conflict; catalog refusals do not supersede.
Recovery classifiers inject subject admission, compare shipping terms as well as
money, and separate continuation, expiry policy and refused token states. Application
recovery projection, routes and destinations stay in the host. SQL atomicity and
active-subscription guards require real PostgreSQL integration; the C2 handoff
release check is **to be released**.

`./commerce/contracts` is a type-only, browser-safe entry for commerce-owned
records and generic persistence, checkout/runtime, availability, recovery and
offer-policy ports. It imports no pricing module. Consume pricing DTOs from
`./pricing/contracts` directly. Commerce does not re-export pricing DTOs; its runtime
reuses the version constant through `./pricing/contracts`. Quote ports take the
host request, response and existing options as type parameters; the reference
binds the existing pricing definitions, adding only the server-bound offer.

`./commerce/server` supplies the Node-only OMS handlers, managed adapters and
order-detail composition.
`./commerce` remains browser-safe, including its full runtime import closure.
It also owns canonical order-money validation and commerce event payload schemas.
The latter reuse the core outbox envelope and inject host quote/draft validators,
without importing an outbox worker or storage implementation.
The same entry owns `deriveOfferAvailability`, `defaultOfferAvailability`,
`availabilityBySku`, `statusForSellableNow`, `reasonCodeFor` and the low-stock
threshold. Their reference facades preserve function identity. The server entry's
`createOfferAvailabilityPort` runs the existing physical-table projection over
an `OfferAvailabilityQueryClient` and an injected `isStockProvider` predicate.
It preserves active-hold subtraction, lot/location eligibility and provider
missing/stale refusals. SDK narrowing and provider selection stay host-owned.
M06 owns normalized new-purchase reads and reservation TTL policy; the reference
composition passes its selected read port through unchanged. With `dataKind: "postgres"`,
the host supplies `stockSourceKey` to bind the native ATP reader; omission reports
`inventory_stock_source_key_required`. Managed composition prefers an injected
reader, then binds `stockRpc` over `inventory_new_purchase_stock_read`; without
either it reports `inventory_new_purchase_stock_reader_required`.
W2 conformance distinguishes reads, fallback and one-time allocation; real SQL
atomicity and consumption remain integration obligations.

`./commerce` provides neutral cart/order/read, checkout, intent, persistence,
resume and customer-default schema cores and factories. Bind existing pricing
schemas and explicit host vocabulary, then extend the object cores with local
locale, profile, sizing, fiscal and provider policy. The reference retains those
extensions; it does not publish that policy into the package.
The intent factory accepts a SKU schema with string input and output, preserving
string SKU inputs when hosts infer request types. Resume and availability bindings
also preserve string SKU and product-slug inputs. When composing host fields,
retain their legacy positions: object key order also determines validation issue
order, including nested variants and checkout requests.
Offer tokens are opaque; `minimumUnits` is an untrusted ask with an injected default, never an
admission grant. The server entry executes the offer binding and bounds its server-minted evidence.
The starter guard receives terms, basket/discount functions and its plan schema
from the host. These entries install no store, route,
migration or provider.

Required root discovery includes `test/commerce/`: schema refusal/replay and
port-fit tests join recovery/error/helper witnesses, compensation and neutral W4 composition.
The unchanged reference suites and a pre-extraction parse transcript protect
host bindings. The cold consumer imports both installed entries and checks
availability projection/refusal, opaque offers, injected minimums and snapshot
refusal without optional peers. This establishes contract proof only.

OMS schemas and pure operational builders export from browser-safe `./commerce`.
Order-money derivation and paid-event constants reuse the existing commerce
owners. `OmsOrderPaymentStatus` binds the existing generic
`OmsPaymentStatus<PaymentIntentStatus>` to the core payment states; the generic
K1 contract remains available unchanged.
Node-only `./commerce/server` owns the generic handlers, managed RPC/query store
and detail composition that uses the shipping runtime. DTOs and structural ports
remain in the type-only contracts entry. Inject settlement,
identity/presentation and provider read projections at composition. The managed
client requires only `rpc`; table reads and note persistence receive a separate
query capability, including the `is(column, value)` filter required by hydration.
Unprojected timeline labels use canonical step keys; hosts supply localized copy
through `timelineLabel`. Refund marking remains an operator mark. Replacement creation
uses the existing fulfillment handler and never confirms arrival or interrupts
an active subscription. W5/W6 tests pin replay tuples and forbidden effects.

Returns expose request, approve and reject only: `CommerceReturnsPort` and
its schemas are at `./commerce`; the three handler factories and
`createSupabaseCommerceReturnsPort` are at `./commerce/server`. `restockDisposition`, `refundMode` and
`refundAmountCents` record intent. Receive, restock and refund execution do not
exist. The host supplies authorization and a `BffResponder`; the request adapter
forwards the authenticated principal as `p_requested_by` to the database's owner,
idempotency-key and fingerprint checks.
The package request schema defaults to neutral reason codes. Bind a host set with
`createCommerceReturnsSchemas(reasonCodes)` and supply its request schema to the
customer handler's `requestSchema` dependency; the reference binding retains its
legacy set and unchanged request/refusal envelopes.

Native order-review contracts and the type-only `OrderReviewLifecyclePort` stay
at `./commerce`. Customer/admin handler factories, PostgreSQL lifecycle/media
adapters and raw uploads are exported from `./commerce/server`. Strict schemas keep
pending declarations distinct from stored/confirmed observed media and keep
storage locators out of public results. The raw upload handler accepts an
`OrderReviewRawUploadBinding`; metadata finalization holds its transaction across
the host's promotion callback. The reference host retains its private filesystem
object store, lease composition and reconciliation. M02 `BlobStoragePort` is not a
drop-in binding: it has no private read, inspection, temporary write or promotion
operations. K3b preserves that host seam and adds no M02 storage bridge.

Hosted feedback has its own contracts at `./commerce` and injected Supabase
submit/token-check ports at `./commerce/server`. This tokenized public post-delivery lifecycle is distinct from native order
reviews. It requires the adopter's database to provide `submit_order_feedback`
and `check_order_feedback_token`; native `db/platform` supplies neither RPC.
These ports add no route or native binding. Review-delay policy remains host-owned
SQL (class (b) retention): native uses 14 days and the contributed managed profile
uses 21 days. There is no TypeScript delay parameter or SQL change.
The reference browser contract facades initialize their shared Zod instance in
jitless mode before loading package schemas, preserving CSP-safe construction.
The commerce package contracts add no global Zod configuration side effect. Browser
conformance bundles the complete commerce entry and both reference facades
without externals; the raw-upload source is a failing browser control, while
the complete server entry bundles for Node.

Neutral producer event contracts are exported from `./commerce`;
`createCommerceOutboxEventSchemas` binds the host's exact quote/draft snapshots.
Event-type literals and host payload behavior are preserved.

## Commerce domain effects

The experimental Node-only `./commerce/server` entry provides the transactional email
consumer factories, their descriptors and dispatch registry. Compose explicit
`uniqueRegistry` composition from `@openlup/outbox` and
`CommerceEmailRuntime` bindings for the fulfillment payload parser, communications
transactional scaffold and send-outcome mapping, plus locale, money, generic
line labels, paid-order presentation and tracking/notification policy. The
package selects no provider, country, commercial offer or environment policy.
Neutral email ports take the host locale as a type parameter and carry `contextName` and
`messageId`; the reference maps its existing extension/provider field names.

Supplying `transactionalEmail` registers the transactional email consumers
together; `fulfillmentEnabled` separately controls the paid-fulfillment consumer.
Fulfillment reuses M08's existing handoff and risk seam. This registry adds no
emitter, dispatcher, invoice executor, schedule, migration or subscription
mutation. Cancellation email stays unregistered; `extraHandlers` can bind the
independent accounting consumer. The refund consumer trusts amounts only with
`provider-refund.v2` evidence. Return approved/rejected are separate notices.
Bind the optional `buyerCommsPolicyReader` when channel ownership must suppress
the registry’s eligible buyer-facing email handlers. It reads that live policy at handler
time and settles suppressed events as processed with
`channel_owns_buyer_comms`; omitting the reader leaves those eligible handlers unsuppressed.

The browser-safe `./commerce` entry provides event contracts, email DTOs and pure
projections; it never imports `./commerce/server`.
`projectCommerceSalesChannelEnvelope` retains opaque source identity without
normalization. `CommerceChannelExposureReadPort` is only a host-injected read;
no inventory exposure SQL or default implementation is supplied. Producer event
schemas bind exact host quote/draft snapshots through a factory; email consumers
retain frozen minimal subsets for in-flight compatibility. W8/W9 package
conformance and the rebound reference suites cover this boundary. UI extraction
and any artifact-cap change require their own approved scope.

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

`createInventoryBindings` selects one store with exact host provider validation. With `dataKind: "postgres"`, supply `stockSourceKey` to bind the existing native ATP new-purchase reader; without it, `unsupported.newPurchaseStockRead` reports `inventory_stock_source_key_required`. Admin reads remain ready. The native PostgreSQL admin port refuses direct stock adjustment because this stock is externally observed; no native direct stock writer is supplied here. Preview availability subtracts all live holds, remaining subscription demand inside 14 days and channel exposure, clamped at zero. The native reader refuses a different horizon or an own-order exclusion as `native_stock_read_options_unsupported`. For managed reads, an injected reader wins; otherwise supply `stockRpc` to bind `createManagedStockAvailability` with the managed forward `20261025109000_inventory_new_purchase_stock_read.sql`. Without either dependency, the reason remains `inventory_new_purchase_stock_reader_required`. Managed previews retain provider-tagged ATP accounting and refuse other horizons or exclusions as `managed_stock_read_options_unsupported`. The managed SQL reader refuses a NULL as-of timestamp as `inventory_stock_as_of_invalid` (SQLSTATE `22023`). Their conservative stale flag is true if any provider row for the SKU is stale; ATP quantities and allocator freshness checks are unchanged. `createInventoryContribution` declares selected callables without activation.

`INVENTORY_MIGRATIONS` projects canonical units 27/33 byte-for-byte; install the full catalogue. Store support and pending proof: [M06 parity](https://github.com/openlup/openlup/blob/main/docs/platform/plans/oss-m06-stock-reservations-delivery.md#parity-pending-rows).

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

The [promotion suites](https://github.com/openlup/openlup/tree/main/packages/platform/test/promotions) retain existing assertions. The
[real PostgreSQL witness](https://github.com/openlup/openlup/blob/main/tests/postgres/promotionsNative.test.ts) installs
the full canonical chain, checks projection hashes and validated constraints,
and proves reads without durable writes, paid/released lifecycle, bounded
sweep, receipt/outbox fences, replay, lock/settlement skips and explicit invoker
grants. This is existing native lifecycle/read evidence only. Native code
candidates, mounted issue/honor, acquisition-only mounted acceptance and the
full native/managed eligibility matrix are accepted native-backend capability
gaps, without a parity claim, in the
[module ledger](https://github.com/openlup/openlup/blob/main/docs/platform/plans/oss-m05-catalog-offers-pricing.md#d8-pending-outcome-ledger).

Opt-in `shippingTerms` also binds shipping-only promises. `createQuoteShippingPromotions`
resolves post-discount thresholds; optional `acquisition` bindings select host policy.
Omission preserves incumbent behavior. See [parity seams](https://github.com/openlup/openlup/blob/main/docs/platform/CANONICAL_CONTRACTS.md#m05-parity-seams).

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
`@openlup/core/pricing` entry. `./pricing/browser` directly re-exports exactly
`createCommerceQuotePrimitives`, `acquisitionCapabilitySchema` and
`acquisitionTermsExpectationSchema`, `resolvedAcquisitionTermsSchema` and
`shippingTermsSchema`. Acquisition schemas come from their defining file; shipping
re-exports its pure validator owner through an exact linted edge, preserving identity
without handlers or Node HTTP declarations. The reference
quote context admits both terms as optional fields and retains its existing strict
fields and refusals. The complete browser bundle contains no Node imports or
pricing server root. Other schemas, Web Crypto hashing and Node HMAC token
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
the reference binds its observed request context. The single-quote handler owns
promotion acceptance/fallback. For each validated batch quote entry, the handler
resolves optional eligibility and policy and then calls its injected quote port;
entries run concurrently and return quote bodies in request order. A failed call
fails the whole response. The handler supplies no shared time or read context;
any cross-entry sharing is selected by the host port. The handlers retain their
existing refusal mapping and public evidence validation.
Offer projection requires roster, representative-request, unit-count, floor and
wire-scope policy. It retains v1/v2 responses, partial degradation only for a
missing configured price, and the first successfully priced representative.
The current reference uses this product-only projection for display copy; it
excludes delivery and is not a checkout expectation. The offer cache is keyed by
caller strings: its success and failure TTLs bound reuse age, not key count, and
the caller controls the key set. Readiness keeps its 60-second positive and
5-second negative caps. Every caller-side policy reason still requires a
dedicated host monitor; the exported reason tuple lets a host coverage check
enumerate the reasons but does not install or verify monitors.
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
[parity seam](https://github.com/openlup/openlup/blob/main/docs/platform/CANONICAL_CONTRACTS.md#m05-parity-seams).
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
`effectiveTarget` hook provide [effective bundle parity](https://github.com/openlup/openlup/blob/main/docs/platform/CANONICAL_CONTRACTS.md#m05-parity-seams);
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
public sellable-feed factory. The availability service deduplicates component
SKUs across compositions, calls the injected port once when SKUs are present and
skips it otherwise; the host port owns its query strategy, and missing answers
remain unknown. Named reference wrappers inject lifecycle and stock
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
reference-owned. The [M05 plan](https://github.com/openlup/openlup/blob/main/docs/platform/plans/oss-m05-catalog-offers-pricing.md)
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

Schedules are authored in UTC; a Node adapter must interpret them in UTC to
match hosted cron. `createNodeScheduler` forwards its optional `timezone` to
`node-cron`. The higher-level `createNodeHost` does not set that option, and the
pinned `node-cron` uses the process-local timezone when none is supplied. A Node
host using UTC-authored schedules must therefore run its scheduler in UTC.

`NodeSchedulerAdapter.stopAll()` returns `Promise<void>`. It fences and stops the
current registrations synchronously, then waits for callbacks already admitted,
including pending lock acquisition and unlock. Await it before disposing their
resources; custom scheduler implementations must return that drain promise.
The adapter calls each supplied timer's `stop()` with its original receiver;
receiver-dependent timer implementations such as `node-cron` retain their state.
Later registrations remain supported. The Node host caches its `stop()` promise,
keeps its listener and dedicated PostgreSQL lock session available until the
drain settles, then attempts both cleanup operations even after a drain failure.
This lets an admitted HTTP-bridge callback finish its local request after a
pending lock acquisition. The [composed HTTP witness](test/composition/nodeHost.test.ts)
uses a real local listener and bridge request across that shutdown boundary.

The PostgreSQL lock adapter also reserves each numeric advisory key locally
before acquisition. This prevents reentry on the same session, including pending
acquisitions and colliding job IDs. Contention releases the reservation;
uncertain acquisition refuses that job and further grants with an actionable
error, retaining its reservation until session disposal. Each acquired key is
observed on the same backend in a separate statement before the job runs. A
changed PID or missing lock ownership refuses with
`OPENLUP_E_ADVISORY_SESSION_AFFINITY`; release also checks the backend and
requires an actual unlock. Failed unlock retains the reservation. Use a dedicated
direct connection or session-mode pooler, never `Pool.query` or transaction
pooling; a finite check cannot certify a pooler's configuration. Follow the
[connection recipe](https://github.com/openlup/openlup/blob/main/docs/platform/RUNTIME_AND_SELF_HOSTING.md#postgresql-connection-recipe)
when runtime `DATABASE_URL` uses a transaction pooler. The
[qualified PG16 witness](https://github.com/openlup/openlup/blob/main/tests/postgres/m14QualifiedComposition.test.ts)
proves pooled requests, session exclusion and backend-switch/reset refusal before
the body, plus refusal to unlock another backend's grant. The
[disposable PostgreSQL witness](https://github.com/openlup/openlup/blob/main/tests/postgres/nodeHostRuntimeDrain.test.ts)
checks same-session exclusion and replacement-host admission after drain.
This graceful-stop contract does not fence an old host at external provider I/O
or settle an effect accepted before an acknowledgement; the
[transfer boundary](https://github.com/openlup/openlup/blob/main/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#existing-store-transfer-and-recovery)
retains those separate duties.

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
- the environment, passed explicitly, and the provider clients it needs (the Supabase `createClient`, the `@vercel/blob` module, optionally its own PostgreSQL gateway factory), so the package itself reads no environment variable (an injected SDK may read its own credentials; the static and migration roots default to the working directory). Its optional PostgreSQL peers are `pg` at runtime and `@types/pg` for declarations; `@aws-sdk/client-s3` is loaded lazily by the default S3 client. Blob declarations use structural types and need no S3 SDK;
- an optional scheduler profile for the Node host: a fenced projection of the declared jobs with its own bindings and validation hooks.

`createBundleComposer` binds the blob slot by default; pass `createBundleComposer({ createSupabaseClient })` to enable its Supabase Storage binding when the data-gateway settings and bucket are present. Without that client Supabase Storage stays unbound. A custom `blob` binder still overrides the default. The HTTP, scheduler, data, migrations, analytics and transactional slots stay `null` until the application supplies their binders; `createDataBindings` builds the data binder from the application's database client factory.

For payment and fulfillment provider adapters, the host supplies clients and
policy and composes only declared port capabilities and refusals. Read the
installed `./payments/contracts` or `./fulfillment/contracts` declarations and
their maturity before binding; an exported adapter does not activate a provider.

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

This package's tests are part of the repository's required test selection; from this directory, `npm test` runs them alone. The tests rewrite the originating application's characterization with neutral names and synthetic data, and a boundary test refuses environment reads and provider imports outside its explicit `pg` adapter and `@aws-sdk/client-s3` blob-client allowlist. Follow [repository testing](https://github.com/openlup/openlup/blob/main/CONTRIBUTING.md#test-scope-and-diagnostics) for placement, setup and speed rules.

The module-boundary proof permits one optional `./<module>/contracts` export
only when that module declares `contracts: true` in `PLATFORM_MODULE_GRAPH` in
[`eslint.config.js`](https://github.com/openlup/openlup/blob/main/eslint.config.js). Its `types`, `import` and `default`
targets follow the module entry shape at `dist/<module>/contracts/index`.
Contracts files may import only their own contracts subtree through canonical
relative `.js` paths and exact public `@openlup/core` entries. Both ESLint and
[`packageBoundary.test.ts`](https://github.com/openlup/openlup/blob/main/packages/platform/test/packageBoundary.test.ts) enforce this allowlist
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

The `release-gates.json` pack caps are 2,029,568 tarball bytes, 9,447,424
unpacked bytes, 2,712 total files, 1,743,872 code gzip bytes and 2,656 code files.
The [M15 budget decision](../../docs/platform/plans/oss-m15-generic-risk-controls.md#cd-m15-6-platform-pack-budget--2026-10-27)
sized R1's original allocation from the measured full M15 stack after M14 #397,
with approximately 2% for S1 and repairs. The later lifecycle integration takes
the higher parent value for each cap: M14 supplies the three current byte caps,
while M15 retains its higher file caps. Documentation caps remain 73,728 gzip
bytes and 10 files; browser caps and the release baseline are unchanged.
Every candidate still needs its actual artifact check; later growth needs its
own measured budget decision.

The source-checkout binding `npm run test:consumer` runs
[`platform-cold-consumer.ts`](https://github.com/openlup/openlup/blob/main/scripts/packages/platform-cold-consumer.ts).
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
lockfile's exact versions using `npm install --prefer-offline --min-release-age=3 --no-audit --fund=false`
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
Raising a peer pin within three days of that version's release makes this proof fail with npm's own no-matching-version error until the version ages.

The composition declarations describe the injected Supabase factory structurally;
they do not import the data entry or its PostgreSQL types. The cold proof still
requires all declared non-adapter entries (including `./identity/contracts`) to import in fresh processes and compile
in both resolution modes with all three optional peers absent.

<!-- openlup-doc-impact {"unit":"platform-substrate","digest":"sha256-00994d288cfec0c8dc0ae9aeae2ff542e2e9af2fedcb4dd2dfeb6c99523be92d","reason":"The manifest moves to the 0.15.0 set version with the exact @openlup/core 0.15.0 peer pin. The package surface, settings and verification described here are unchanged by this preparation delta."} -->

## Identity import candidate

`./identity` provides server identity services; `./identity/contracts` supplies browser-shareable contracts.
This is a development-preview import candidate, not an activated adopter contract.
Installed exports alone do not mount routes or establish host readiness; the
application must verify its selected identity composition and capabilities.
See the [identity recipe](https://github.com/openlup/openlup/blob/main/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#identity-import-candidate) for composition, migrations and operator invitations.

## Personal data

The experimental identity entry provides contributor-based personal-data export and erasure.
See the [personal-data recipe](https://github.com/openlup/openlup/blob/main/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#personal-data) for composition, refusals and retained obligations.

## Disposable identity composition

The opt-in reference identity shell consumes the existing identity exports with explicit routes and readiness admission.
See [disposable identity composition](https://github.com/openlup/openlup/blob/main/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#disposable-identity-composition) for its boundary and reference guide.

## Communications import

`./communications` provides host-composed communications services; `./communications/contracts` supplies pure content and browser contracts.
See the [communications recipe](https://github.com/openlup/openlup/blob/main/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#communications-import) for migration, email rendering and native operations.

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

`./payments/contracts` is type-only: execution/dispatch, transient method handoff, capability overlay, verified money/method evidence, bounded readback/absence, neutral refusals, refund observations and multi-subject conformance fixtures. Verification uses receipt time for freshness; ingress starts processing at receipt time and reuses durable first receipt on redelivery. Event identity includes outcome class. Transient authorization and opaque handoffs never enter persisted diagnostics. Capability support is explicit; timeout/truncation is unknown, never exact absence. Refunds require explicit evidence by default; `legacy-assume-full` is an explicit host opt-in. See the [M07 ledger](https://github.com/openlup/openlup/blob/main/docs/platform/plans/oss-m07-payments-money-truth.md).

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
[A2 ledger](https://github.com/openlup/openlup/blob/main/docs/platform/plans/oss-a2-payment-adapters.md) for the current
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
[A2 ledger](https://github.com/openlup/openlup/blob/main/docs/platform/plans/oss-a2-payment-adapters.md#o-p2-boundary-and-named-deltas).

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

## Fulfillment stock evidence replay

The fulfillment migration projection additionally includes the native
`20261022165000_fulfillment_stock_evidence_replay_reopen.sql` forward at canonical
position 76 in this catalogue. Install the complete chain before stock adoption.
Matching-fingerprint alert replay refreshes severity/quantities, reopens status and
clears `resolved_at`, preserving identity, first-seen time and historical resolver
metadata. Mismatches, including legacy 0.22.0 whole-input fingerprints, still
raise `23505`; no rewrite is supplied. See the [migration owner](https://github.com/openlup/openlup/blob/main/docs/platform/DATA_AND_MIGRATIONS.md#module-catalogues-and-installed-histories)
for upgrade and operational-dependency proof.

## Subscription contracts and renewal port

The experimental `./subscriptions` entry exposes hosted renewal mechanisms and
an explicit native capability descriptor; `./subscriptions/contracts` is
browser-safe and type-only. The [subscription architecture and recipe](https://github.com/openlup/openlup/blob/main/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#subscription-contracts)
owns the concrete ports, continuity rules, capability refusals and witnesses.
These entries do not install a store or activate a runner.

Native renewal and N1 retry stores accept injected SQL executors and explicit
snapshot/identity policy. The generic native executor consumes the subscription
ports; host composition supplies G23, M07, transaction and correlation policy.
The initial binding preserves case-before-outcome ordering with atomic bookkeeping.
N1's same-obligation recovery repairs the native decline stall (F16); it does not
supply M07 prepared-store parity or activate a runner.

With N1 then N2 installed, `createPostgresSubscriptionCommandStore` and
`createPostgresSubscriptionCommands` support native generic bundle commands and
command-bound receipts. Preview persists a quote; apply atomically updates future
terms, event and receipt with no proration or current-cycle repricing. Hosts own
authorization, address validation, SKU/composition translation and the transaction
connection. Prepaid remains unsupported; the serving adapter refuses pause.

Native N3 plus the ATP seam/allocator and X/Y suffix provide
`createPostgresStockWaitStore` and `createPostgresStockAvailability` (the latter
at `./inventory`). Hosts supply transactions, clock, source and the existing
wire codec. Candidate discovery preserves uncaptured frozen operations; shortage
creates a durable wait, and elapsed stock-only refusals may reacquire on the same
identity with a new claim generation. Resumed means paid realization admitted.
The fixed 14-day soft priority is distinct from durable advance reservations.
The unbound descriptor keeps stock recovery unavailable. The opt-in native M10
reference composition selects it after composed PostgreSQL proof; managed
TypeScript recovery remains unavailable.

`createSubscriptionServices`, lifecycle-message and neutral command facades are
in `./subscriptions`; `createSubscriptionContribution` is in `./composition`.
They are default-off and describe one host executor/job. The
[composed module recipe](https://github.com/openlup/openlup/blob/main/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#composed-subscription-module)
owns explicit selection, frozen mandate/replay, M04 delivery and M12 boundaries.

## Invoicing contracts

Experimental `@openlup/platform/invoicing` exposes `readInvoiceCapabilities`;
`invoicing/contracts` contains types only. Host selection is explicit and default-off.
Frozen facts, correction recovery, exact absence, owed duties and host-only fiscal,
artifact, delivery, payout and owned-history seams are described in the
[invoicing reference](https://github.com/openlup/openlup/blob/main/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#invoicing-contracts).
The contract entry supplies no executor or activation.
`createNativeUnsupportedInvoicePorts` supplies inert typed refusals for every
host, store and provider seam. `runInvoiceAdapterConformance` checks adapter-owned
offline fixtures; its sanitized evidence does not establish live fiscal readiness.

Issue helpers in `invoicing` preserve claim/preflight/projection/fresh-money/
create/fenced-finalize order. Hosts bind compatibility payloads, seller/date/tax
policy, captions, event descriptors and key scopes. Canonical and legacy line
checks share the unchanged donor allocation; handoff helpers register no job or
executor. Eight issue/line/payment/handoff cases join the existing package smoke
selection. Continuity cutover and activation remain separate.

Correction and reversal workers preserve durable identity, recovery and fenced
outcomes through host callbacks. The reference host requires a conforming
correction bridge; the legacy vendor method stays unselected. Reversal handlers pass
through the RPC action (`voided`, `correction_requested`, `corrected`, `no_invoice`). The required package
selection includes correction/reversal witnesses in `test/invoicing/contracts.test.ts`.
See the [invoicing design](https://github.com/openlup/openlup/blob/main/docs/platform/plans/oss-m09-invoicing.md#p3-correction-and-reversal-boundary)
for managed migration and reconciliation limits.

See the [M09 forward owner](https://github.com/openlup/openlup/blob/main/docs/platform/DATA_AND_MIGRATIONS.md#m09-invoicing-forward-design-and-control-approval) for the registered managed-correction limit and follow-up.

`createPostgresInvoiceStore` uses a caller-owned structural executor for native
owed duties, split fact leases, claims and fenced issue/correction results.
Missing host facts refuse before writes; clearance remains host work. Delivery
requires an explicit host envelope projection and M04 transport. `INVOICING_MIGRATIONS` separates native child-document and managed
base-row correction storage. Install the complete native catalogue, not its
seven sparse byte-identical SQL assets. The local-only Postgres adapter consumes
this store without claiming fiscal parity or registering a worker. The
[invoicing architecture owner](https://github.com/openlup/openlup/blob/main/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#invoicing-contracts)
describes reversal recovery, capture faults and cutover fencing.
`collectInvoiceDuties` and `createIndependentInvoiceDutyBinding` collect retained
paid/handoff duties through separately committed store phases. Hosts invoke them
outside payment and fulfillment work; missing facts remain owed. The pinned
payment-decoupling SQL is a sparse catalogue projection, requiring the full P4
native chain. See the architecture owner for continuity and activation limits.

`runNativeInvoiceIssueJob` supplies the native create/readback binding over
explicit local/fresh money and provider ports. Fresh non-ready results settle
before returning; stale results write no failure. No scheduler or default
composition is registered. Operator DDL/ACL limits of the unchanged M07 readback
remain registered in the architecture owner.

For bounded duty discovery before facts exist, including cursor continuation past
unavailable facts, follow the [invoicing architecture owner](https://github.com/openlup/openlup/blob/main/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#invoicing-contracts).

The invoicing read side adds `runInvoiceDeliveryJob`, `assertInvoicePdf`,
`invoicePdfFilename`, `syncAcceptedInvoiceDocuments`,
`syncInvoicePayoutSettlements`, `resolveInvoiceDocumentHistory` and
`createInvoiceReadModel`. Hosts supply authorization, storage, M04 transport,
terminal/backoff callbacks or the native store, and safe native history projection. See the
[read-helper recipe](https://github.com/openlup/openlup/blob/main/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#invoicing-read-helpers).

`createInvoiceServices` and `createInvoiceContribution` compose the existing
helpers through `/invoicing`, with explicit selection, default-off and readiness
before execution. Native collection, issue, delivery, document/payout sync and
history use their module implementations; host facades may bind factories where
transport or query projection is host-owned. No executor is installed.
`claimInvoiceSellerRevision` selects a seller before leasing. The optional native
store seller binding and managed wrappers persist its first-ever claim revision;
legacy fallback and forward-only migration limits are owned by the
[M09 migration section](https://github.com/openlup/openlup/blob/main/docs/platform/DATA_AND_MIGRATIONS.md#m09-invoicing-forward-design-and-control-approval).

OMS read projections are optional. Omitting the host health classifier preserves the original unprojected empty health snapshot (`ok`, no reasons or evidence IDs); it does not evaluate provider health. The reference composition injects its existing classifier and evidence readers.

## Account and support contracts

Experimental `@openlup/platform/account-support` supplies `createAccountReadFacade`
and the unchanged account-read diagnostic helpers. Inject account and order owner
ports; delegation preserves their arguments, receivers, results, nulls and thrown
failures. Authentication, authorization and private profile/market projection stay
with the host. Importing this entry selects no driver or capability.

`account-support/contracts` is type-only and browser-safe. It declares account,
Customer 360, self-service command, operator recovery and invoice-access envelopes
with explicit capability flags. These declarations do not install their services.
The [account/support reference](https://github.com/openlup/openlup/blob/main/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#account-and-support-contracts)
owns the available boundary and later-phase limits.

R2 adds `readAccountSnapshot` with the two-stage fan-out and a store-level recent
20-order request, stored-money order history/detail, Customer 360 projections
and M09 invoice history/PDF delegation. `createInvoiceAccess` checks the requested
document against the owned account/order history before resolving its ticket or
reading PDF bytes; foreign or unknown documents return `{ kind: "denied" }`. Select pricing, captured line
presentation, private extensions and fulfillment evidence through typed host
ports. Missing evidence stays unknown; owner refusals retain their distinctions.
The default-off reference selections and host-fed read views are unmounted.
Native Customer 360 uses the existing authorized PostgreSQL support reader;
account/history/invoice drivers still require explicit host selection.
Subscription pointer enrichment preserves optional nullable `paymentMethodKind`:
selected-empty evidence is null, while unread evidence is omitted. Reference
line presentation explicitly picks the declared display keys before projection.

`createCustomer360ReadFacade({ authorize, journey, summary, diagnostics })`
requires `authorize(): Promise<boolean>` before every method's source read.
Refused callers receive `{ kind: "denied" }`; authorized delegates preserve
arguments, results, nulls and thrown failures. The reference binding supplies
that authorization once per call, before opening either support scope.

The [account/support reference](https://github.com/openlup/openlup/blob/main/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#account-and-support-contracts)
owns the available R1 boundary and later-phase limits.


R3 adds `createSelfServiceCommandFacade({ context, capabilities, ...lanes })`,
returning `SelfServiceCommandFacade` with required host capabilities and every
managedSubscription, nativeLegacySubscription, subscriptionControl, typed/raw,
profile, paymentMethod, commerce and recovery output lane. Input lanes are optional.
Unselected methods return `{ supported: false, refusalCode }`; paymentMethod uses
the host paymentMethodSetup refusal by identity, commerce uses commerceRecovery,
and other lanes use a frozen host_binding_required refusal. Every lane guards
the principal; typed/raw lanes require a supplied clientId equal to context.clientId.
The trailing `ControlSnapshot = unknown` generic retains the control snapshot type.
Native legacy routing preserves
explicit pause and ownership before bundle quote validation. Owner results,
refusals and nulls retain identity. Supported paymentMethodSetup requires a
paymentMethod lane; supported commerceRecovery/configuredPurchase require commerce.
Supported genericBundleCommands/commandBoundReceipts require a selected subscription
command lane. Missing required lanes refuse customer_self_service_lane_configuration_required.
`encodeNativeSubscriptionCommand`, `decodeNativeSubscriptionPreview` and
`createNativeSubscriptionDriver` retain the raw owner protocol and apply key;
apply never previews. `createPaymentMethodComposition` adapts generic M07
setupMethod to paymentMethod.execute without owner imports. Native repair is a
[registered follow-up](https://github.com/openlup/openlup/blob/main/docs/platform/plans/oss-m12-account-support.md#follow-up-register).
The default-off reference binding mounts nothing; browser key retention and
native profile/start remain unselected.


R4 adds `createOperatorRecovery`, `createManagedOperatorAuthority`,
`createPostgresOperatorAuthority`, `operatorAuthorityCapabilities`,
`moveIdentityForEmailCorrection`, `executeOperatorAccountLink`, `linkThenApply`
and `ACCOUNT_SUPPORT_MIGRATIONS`. The host injects its transaction/RPC and identity
ports, verified human operator and recovery-path policy. Recovery token generation
and SHA-256 hashing use the runtime Web Crypto API without a Node import; the
host may still inject its opaque-token generator. Managed email admission
and claim precede identity mutation and settlement. Native lifecycle commands
delegate to M10, with actual optional owner receipts and named unavailable
subcases. Link-then-action reports a completed link separately when the second
command refuses or fails. The reference binding is default-off and unmounted;
no import provisions authority or activates a route.

R5a adds `createAccountSupportBindings` and `createAccountSupportServices` here,
and `createAccountSupportContribution` in `/composition`. Supply already bound
R1–R4/owner operations for one explicit managed/native graph, host capabilities
and a readiness observer. Each distinct callable receives one guard shared by
its service, port and route aliases; each entrance re-observes readiness. Disabled
construction calls no observer. Refusals are `disabled`, `schema_unknown` and
`schema_unsatisfied`; owner results and thrown failures pass through unchanged.
A null selected operation remains a required port without an executable binding.
The separate injected commerce record uses `commerce(key, ...args)` and returns
`{ kind: "unsupported", code: "host_binding_required" }` for a null record/member.
The reference host may select real M11 checkout/recovery, ATP and existing effect
descriptors by supplying its already-built selection through `commerceOwner`
and its existing registry through `commerceRegistry`. R5b does not construct M11
or import its adapters; the host supplies the complete account/M11/ATP schema
and matching enablement/readiness. Keep capability flags unsupported until
their owner callables are bound. This adds no package export or owner import to
account-support contracts. One M11 result is forwarded without rewrapping its
guarded services; unknown stock, unsupported options and handler outcomes retain
their owner meaning. Contribution descriptors install no routes, handlers,
schedules or workers. See the
[reference recipe](https://github.com/openlup/openlup/blob/main/docs/platform/RUNTIME_AND_SELF_HOSTING.md#opt-in-disposable-subscription-reference)
for the host's schema and transport obligations.

## Operations and diagnostics

The experimental `./operations` entry contains browser-safe operational schemas,
alert projections and `createOperationsClients`, which binds an existing BFF
requester. `./operations/contracts` contains DTOs and narrow ports only.
`./operations/server` contains settings read/update, pipeline read, alert overview,
control-plane handlers and the existing watchdog delivery mechanism. Authorization,
SQL execution, evidence evaluation and alert transport are supplied by the host;
importing these entries registers no route, schedule or provider.

The [package-local control-plane witness](test/operations/controlPlaneHandler.test.ts)
preserves the injected handler's request, authorization, replay and error boundaries,
including authorization before malformed-body parsing.

`runControlPlaneWatchdogTick` evaluates persisted neutral job failures and records
an idempotent heartbeat unless `checkOnly` is true. The richer watchdog accepts a
typed evaluator; the public reference binds its maintained domain evaluator.
Settings preserve scalar values, and pipeline reads preserve the existing tester
and email projection. Identity membership and tracking effects keep their owners.
See the [operations architecture](https://github.com/openlup/openlup/blob/main/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#operations-and-diagnostics)
for refusal behavior, SQL prerequisites and the bounded preview scope.

## Risk controls

The experimental `@openlup/platform/risk` entry exports the existing strict
schemas with CSP-safe Zod initialization. `risk/contracts` is type-only;
`risk/server` exports paid-order assessment, subject hashing, structural managed
clients and the native executor factory. Core risk remains at `@openlup/core/risk`.
No provider SDK or pg runtime import is required by risk. Hosts supply trusted
operator authorization and actor mapping, clients, mode and hash secret.
The [risk contract](../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#risk-contracts)
explains the preserved rail differences and sparse SQL descriptor. These entries
register no route, worker or schedule and do not activate risk.

R2 adds `createRiskBindings` and the unchanged admin handler factories in
`risk/server`; supply the host BFF responder, trusted authorization, admin port,
mutation policy and already constructed assessment port. Pass `outboxRisk` into
the existing commerce registry's risk slot once. `createRiskContribution` in
`composition` describes selected routes and the assessment callable, with no
handlers or schedules. The [reference recipe](../../server/runtime/public-reference/m15RiskBinding.ts)
selects nothing by default and requires schema readiness before effects. Hosts
still mount any selected callables and own their authorization/actor mapping.

`risk/server` also exports `createRiskPrivacyContributor` and
`createRiskPrivacyBinding`. Supply the read-only resource owner and explicit
retention policy, then append the contributor to M03's existing registry with
`risk` required. Unbound policy remains unresolved. No risk deletion or retention
period is supplied, and managed identity erasure remains unavailable. Portability
is deferred unless a host supplies its own opaque binding; the helper neither
invokes it nor claims transfer/restore support.

## Company identity

Experimental `./company-identity` preserves the existing compatibility schemas
(including optional registry fields); `./company-identity/contracts` contains only
browser-safe types over the unchanged core contract. `./company-identity/server`
exposes ordered provider lookup and the HTTP handler. Pass the host BFF responder
to retain its request-reference binding. The handler shares its process cache
across factory instances: ten-minute TTL, UTC-day/normalized-identity keys, no
purpose/provider partition, manual-input bypass and oldest-insertion eviction.
Lookup does not write customer data. Identifier normalization/validity and legal-name policy are optional inputs in
`CompanyIdentityRules`. Neutral defaults keep identifiers unchanged, accept
non-empty values and do not prefer or seek fuller names. The reference
application retains its existing national rules and callers unchanged.

## Market packs

Experimental `./market-packs` exposes pure settlement/fiscal record readers,
profile comparison, exponent lookup and money formatting. COMMERCE configuration keys and refusal semantics are preserved. Readers require
explicit fallback facts; the package defines no market defaults. Supply currency, region, fiscal facts
and display locale independently; formatting historical amounts uses their own
currency. Ambient environment reading/initialization remains application-owned.
These entries add no provider, locale resources, native directory schema or
application caller swap. Shipping suggestions retain the existing optional lane.

`./market-packs` also exports `MarketDescriptor` and `describeMarket(language, profile)`.
They describe independent display, settlement, price-list and fiscal inputs;
no market values, national rules or language defaults are selected. The
[unmounted reference recipe](https://github.com/openlup/openlup/blob/main/server/adapters/market-packs/marketRecipe.ts)
imports application-owned compatibility facts and accepts explicit configuration.
Its [equivalence and variation tests](https://github.com/openlup/openlup/blob/main/server/adapters/market-packs/marketRecipe.test.ts)
separate source composition from an installed or mounted deployment.

## Channels

The experimental `@openlup/platform/channels` subpath provides browser-safe
normalized order, retained purchase, page/cursor and money-allocation contracts
and helpers. `channels/contracts` exports types only. `channels/server` exposes
ingest admission/saga, webhook/operator/pull/recovery helpers and explicit store,
reservation and payment-owner bindings. Importing a subpath mounts no route,
schedule, simulator or provider. The host owns credentials, signature validation,
provider payload decoding, accepted currencies and enablement; jobs and simulator
remain default-off. Optional connector port types describe host capabilities,
not implemented outbound publication or synchronization.

The managed rail can consume original retained paid obligations through the
existing order, payment and inventory owners. Retained rows preserve the first
approval/qualification, locked BOM, component weights, exact integer money groups
and original payment identity across retries and changed current commercial
facts. Reservations precede money effects. The ATP exposure hook reports the
same retained outstanding obligations as channel admission; conversion credits
its own validated exposure before the unchanged allocator clamps stock. Channel
admission takes no subscription locks: uncommitted renewal-demand changes remain
subject to existing stock-wait recovery. Ordinary reservation behavior is
unchanged.

The portable rail offers immutable source capture, protected readback and scoped
page compare-and-swap through `createPostgresChannelPurchasedSourceStore`.
Physical conversion refuses with `channel_purchase_physical_unavailable`; full
portable settlement is unavailable. Native functions keep the selected trusted
migration owner. Managed capture uses a closed NOLOGIN owner; runtime, browser
and MCP callers receive only their declared entrypoints. Generic outbox source
evidence omits normalized buyer/address bodies; authorized capture reads recover
the original protected data. Privacy lifecycle export/erasure is unavailable.

Fresh captures bind the normalized slug to their scoped channel and the raw-source
digest to the original page event. Raw admission checks the existing normalized
buyer, address and shipping scalar contract before persistence. Page watermarks
use the public millisecond comparison and retain the original string on ties.
Retained conversion readback verifies permanent holds by item, SKU, key and total
quantity, including split local lots; recovery retains the sealed original order
and holds when the channel's current delivery provider changes.

`CHANNEL_INGEST_MIGRATIONS` projects the two canonical native units with exact
SHA-256 identities and package SQL assets. It is a sparse projection, not an
installation chain: install the complete selected catalogue and verify its
ledger, object inventory and grants. The three generations append the same two
units after their immutable issued tails. Registry/listing authoring, fresh
qualification/approval/exposure, outbound provider operations and catalog
publication remain outside this import. No real provider readiness, hosted
qualification, release or publication follows from local proof.

Source: [channel contracts](src/channels/index.ts),
[server bindings](src/channels/server/index.ts) and
[preservation witnesses](test/channels/). Repository users can also consult
[the channel task record](../../docs/platform/plans/oss-m17-r1-channel-import.md).
