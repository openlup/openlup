# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Declaration snapshots track candidate drift, not a stable API or
SemVer promise. This file keeps the current release and the two previous ones;
earlier releases are recorded verbatim in `packages/platform/CHANGELOG-HISTORY.md`
in the source repository.

## [Unreleased]

### Documentation

- Clarify that bundle availability batches nonempty SKU requests once per
  response, skips the port for empty requests, and leaves query strategy to the
  injected host port.
- Clarify pricing batch port responsibilities, caller-keyed offer-cache TTLs
  without a distinct-key count cap, policy-readiness retry conditions,
  reference display-only offer use, and the host-owned monitoring check for
  caller-side policy reasons.

## [0.31.0]

- Publishable on the npm `latest` dist-tag as `0.31.0`, from tag
  `openlup-platform-v0.31.0`.

### Runtime and scheduler

- Keep the Node host's local HTTP listener available until admitted scheduler
  callbacks finish, including callbacks waiting for advisory-lock acquisition
  before calling their HTTP compatibility endpoint. Shutdown still attempts
  listener and lock-session cleanup when draining fails.
- Migration: Supply `createPgAdvisoryLock` with a dedicated direct connection or
  session-mode pooler, never `Pool.query` or transaction pooling. If request work
  uses a transaction pooler, inject a separate session connection for scheduler
  locks and a direct connection for migration/admin work. On uncertain lock
  acquisition or session-affinity refusal, drain the host, close its dedicated
  connection and retire any stranded lock backend before restarting. Follow the
  source repository's PostgreSQL connection recipe; finite observations do not
  certify a pooler's future routing.

### Migration admission and qualified reference source

- Hardened migration ledger admission for status, dry-run and apply. Existing
  canonical migration histories retain their exact-prefix and replay boundaries.
- Migration: Migration-runner qualification covers PostgreSQL 16 and 17. Check
  status on the existing installation before applying pending units; other majors
  need separate qualification.
- Pinned name resolution in qualified install owner paths used by acquisition
  and restore operations.
- Migration: The qualified-v2 reference-source PostgreSQL 16 catalogue now has
  92 units, adding runtime completion and the qualified owner-path forward after
  the previously issued 90-unit prefix. Preserve issued migration bytes and
  apply the ordered forwards through the reference binding. Legacy selection
  remains the unchanged 88-unit plan. The qualified migration login still needs
  the declared database-owner SUPERUSER role; runtime and restore remain distinct
  restricted nonowners. Restricted-bootstrap reader preparation does not activate
  a non-superuser installation generation.
- Qualified installation SQL, reference bindings, connected-store adapters and
  portable operations defaults remain source-tree composition. The npm SQL
  projections are not a complete installation or store-transfer catalogue.
  Application upgrade and local handover witnesses establish only their bounded
  profiles. No stable-framework, supported-upgrade, hosted-provider, full-store
  transfer, M14 completion or production-readiness claim follows from this set.

## [0.30.0]

- Publishable on the npm `latest` dist-tag as `0.30.0`, from tag
  `openlup-platform-v0.30.0`.

### Qualified reference-source installation and retained imports

Migration: The reference-source PostgreSQL binding still selects the unchanged
88-unit legacy plan by default. Fresh PostgreSQL 16 installations may explicitly
select `qualified-v2` and either `installer-managed` or `operator-provisioned`
roles. The actual migration session must use the declared SUPERUSER login that
owns the database; it may be the cluster bootstrap login or a separate declared
migration login. Runtime and optional restore logins must be distinct restricted
non-owner principals. Admission checks the actual role graph and capabilities;
selection alone establishes no installation or managed-host readiness.

Migration: Qualified bootstrap/runtime SQL and the reference selection binding
are source-tree inputs, not a complete installation catalogue shipped in the npm
package. The E-only 89-unit shape remains a separate historical expectation.
Selecting the retained-import tail requires the explicit restore binding and its
90-unit catalogue. This fresh-generation route does not convert a legacy database.

Migration: The qualified retained-import tail gives the restore login EXECUTE
only on `client_import_retained_row` and
`subscription_cycle_import_retained_row`. These fixed routines insert an absent
row, replay an identical retained row and refuse a differing row with `23505`;
non-`origin` replication mode refuses with `55000`. Ordinary runtime writes keep
their existing lifecycle and delivery-alignment behavior. Restore parents,
history, frozen terms and identity mappings through their existing owners; the
two routines do not provide a full-store restore or stable upgrade service.

### Added

Add the experimental Node-only `@openlup/platform/lifecycle` entry with explicit
application-file snapshot planning and apply. It preserves unmanaged files and
customized upstream-unchanged files, refuses divergent changed paths before
writes, and recognizes exact completed states for interruption/resume. It needs
no optional SDK and activates no route, timer, provider or installer.

The same entry exports `inspectLegacyPostgresInstallRoles` for one fixed,
read-only PostgreSQL role observation through an injected query handle. Its
`legacy-fresh-bootstrap-role-prerequisites` / `rolePrerequisitesMet` result
retains the immutable legacy bootstrap's superuser, shared-login, mode and
pre-existing-role refusals. It adds no DDL, role support or install-readiness claim.

The owner-authorized byte reserve after the direct directory-prefix and catalog
binding repair sets code-gzip 1,743,872 B, tarball 2,029,568 B and unpacked
9,447,424 B caps. The supervisor computed each as 5% above the actual measured
1,660,249 / 1,932,801 / 8,996,893 B, rounded up to KiB. These fixed limits
supersede the historical exact-minimum C+D allocation and grant no automatic
future increases or additional programme scope. Code/total file caps remain
2574/2628; docs/browser caps, released baseline, versions and locks stay exact.
Actual approved-input remeasurement remains required because metadata edits can
change packed bytes; this budget decision establishes no final review or proof.

### Migration

Select this entry explicitly from a Node application. Supply immutable UTF-8
predecessor/candidate snapshots, an absolute canonical root and separately
observed schema-range evidence. Hold an exclusive maintenance window. Apply
rechecks the current tree; a changed managed file with divergent local bytes
requires adopter reconciliation. Existing managed path components must match
their actual directory-entry spelling exactly; a filesystem case or normalization
alias does not authorize changing an unlisted entry. Per-file rename is not an
all-files transaction or a hostile-concurrency/power-loss guarantee. No SQL, dependency install,
version marker or deployment runs, and file completion does not establish their
compatibility or completion. Keep database expand/contract and dependency
provenance work at their existing owners.

- Add an optional trusted-source session admission observation to the experimental PostgreSQL migration runner. It runs once under the existing migration lock after exact-prefix validation and before status, dry-run or pending SQL; existing sources retain their current queries and execution.

### Added

- Experimental operations contracts/browser/server subpaths expose existing
  settings, pipeline-read, alert overview, watchdog delivery and control-plane
  behavior through injected host ports. The public reference binds these owners.

### Migration

- Existing reference imports remain compatible. Select the new operations entries
  explicitly; imports register no route, job or provider. Identity membership and
  tracking effects retain their existing owners.
- Native control-plane storage requires the complete canonical native prefix,
  including the job ledger and `20260814010000_platform_control_plane.sql`.
  The packaged SQL is a sparse unchanged projection. Supply current capability-local
  operator authority, routine EXECUTE and underlying relation grants; no managed
  parity or hosted-provider certification is established.

### Packaging

- Code/total file limits are 2,574/2,628. After the 0.29.0 main integration, the
  operations candidate measures 2,553 code files and 2,607 total files. The remaining 21
  files are allocated to the seven already-authored B/C/D production TypeScript
  files (4/2/1), each packaged as source, JavaScript and declarations. This is a
  finite source-derived forecast, not an executed B–D package result or capacity
  for later modules. Each stacked candidate must pass its actual pack checks;
  additional files or byte-limit crossings need another bounded review.
- Integrated main's byte, documentation-file and browser limits are unchanged.
  Combining or deleting contracts solely to reduce the count would add ownership and proof churn without
  changing the required capability.

### Added

Add the experimental Node-only `@openlup/platform/portability` entry for verified,
bounded object copy/resume and compatible PostgreSQL row capture/restore through
injected transaction handles. Object reads distinguish absent, denied and
unavailable; private filesystem publication preserves bytes, metadata and source
lineage with an explicit process-owner access policy. Row replay is exact and
conflicts refuse atomically; every enabled user INSERT trigger refuses.

Filesystem publication and readback share one encoded-descriptor byte ceiling
covering admitted Unicode metadata; oversize encodings refuse before publication.
Filesystem locators hash JSON-encoded logical keys, preserving distinct admitted
strings including lone UTF-16 surrogates. This first unpublished layout has no
legacy-format migration or fallback.

The bounded M14 B budget reads approved the initial code-gzip minimum of
1,650,493 bytes, exactly 128 bytes for that necessary Unicode repair and 10 bytes
for exact string-key identity. The current measured minimum is 1,650,631 bytes,
cumulatively 2,631 above 1,648,000.
This allocates no additional forecast headroom. Other byte, file, docs and
browser limits and the released baseline are unchanged by this decision; later
candidates still need their own actual package measurement.

### Migration

Select the entry explicitly. Install the canonical target catalogue
and qualify the source/target privileges separately; this API does not install
schema, copy migration ledgers, map managed identities or activate executors.
Changed-row catch-up, guarded-domain import and hosted effect-time fencing remain
M14 dependencies. Local synthetic proof does not certify complete-store transfer,
provider revocation or a stable migration service.

Node host shutdown now fences its stopped scheduler registrations and waits for
admitted callbacks, including pending lock acquisition and asynchronous unlock,
before closing the dedicated advisory-lock session. Other hosts remain excluded
until the running job releases ownership. Shutdown still attempts the listener
and lock cleanup, caches its promise and aggregates failures in the existing order.
PostgreSQL advisory locks now refuse locally pending or held numeric keys,
including colliding job IDs, so a dedicated session cannot reenter a job lock.
Failed acquisition permits a later attempt; failed unlock remains reserved until
the session closes.

Migration: `NodeSchedulerAdapter.stopAll()` explicitly returns `Promise<void>`
instead of `void`. Await it before disposing resources used by admitted callbacks.
It fences/stops current timers synchronously and supports later registrations.
The only in-tree production caller, `createNodeHost`, awaits that drain before
closing the lock; its public `stop(): Promise<void>` signature remains unchanged.
Custom implementations of `NodeSchedulerAdapter` must return the drain promise.

## [0.29.0]

- Publishable on the npm `latest` dist-tag as `0.29.0`, from tag
  `openlup-platform-v0.29.0`.

Adds experimental browser-safe marketing runtime contracts and a type-only
contracts entry through unchanged schema movement and reference import rebinding.
Core research remains the compatibility owner. Parsing, defaults, issue details
and order, and existing inferred input/output types retain their behavior.

Migration: No observable divergence is introduced for existing reference consumers; shims retain their exported names and schema object identities.
Migration: New public subpath `@openlup/platform/marketing` exposes browser-safe runtime contracts without a server entry.
Migration: New public subpath `@openlup/platform/marketing/contracts` exposes types only, with no Zod or runtime-module imports.
Migration: New public export `ACQUISITION_CASE_CONTRACT_VERSION` is available from `@openlup/platform/marketing`.
Migration: New public export `ACQUISITION_CASE_VIEW` is available from `@openlup/platform/marketing`.
Migration: New public export `ACQUISITION_CASE_SOURCE` is available from `@openlup/platform/marketing`.
Migration: New public export `acquisitionOpaqueReferenceSchema` is available from `@openlup/platform/marketing`.
Migration: New public export `acquisitionAddressReferenceSchema` is available from `@openlup/platform/marketing`.
Migration: New public export `acquisitionCaseStateSchema` is available from `@openlup/platform/marketing`.
Migration: New public export `acquisitionCaseProjectionSchema` is available from `@openlup/platform/marketing`.
Migration: New public export `acquisitionCaseListRequestSchema` is available from `@openlup/platform/marketing`.
Migration: New public export `acquisitionCaseListResponseSchema` is available from `@openlup/platform/marketing`.
Migration: New public export `acquisitionCaseActiveCountResponseSchema` is available from `@openlup/platform/marketing`.
Migration: New public export `acquisitionIdempotencyKeySchema` is available from `@openlup/platform/marketing`.
Migration: New public export `ACQUISITION_SURVEY_VERSION` is available from `@openlup/platform/marketing`.
Migration: New public export `ACQUISITION_NEWSLETTER_VERSION` is available from `@openlup/platform/marketing`.
Migration: New public export `acquisitionSurveySubmitSchema` is available from `@openlup/platform/marketing`.
Migration: New public export `acquisitionSurveyEvidenceSchema` is available from `@openlup/platform/marketing`.
Migration: New public export `acquisitionSurveySubmitResponseSchema` is available from `@openlup/platform/marketing`.
Migration: New public export `acquisitionSurveyListQuerySchema` is available from `@openlup/platform/marketing`.
Migration: New public export `acquisitionSurveyListResponseSchema` is available from `@openlup/platform/marketing`.
Migration: New public export `acquisitionNewsletterConsentEventSchema` is available from `@openlup/platform/marketing`.
Migration: New public export `acquisitionNewsletterConsentResponseSchema` is available from `@openlup/platform/marketing`.
Migration: New public export `marketingResearchJsonSchema` is available from `@openlup/platform/marketing` with its core object identity.
Migration: New public export `researchSurveyTypeSchema` is available from `@openlup/platform/marketing` with its core object identity.
Migration: New public export `adminSurveyResponsesRequestSchema` is available from `@openlup/platform/marketing` with its core object identity.
Migration: New public export `adminSurveyResponseRowSchema` is available from `@openlup/platform/marketing` with its core object identity.
Migration: New public export `adminSurveyResponsesResponseSchema` is available from `@openlup/platform/marketing` with its core object identity.
Migration: New public export `researchSurveySubmitRequestSchema` is available from `@openlup/platform/marketing` with its core object identity.
Migration: New public export `researchSurveySubmitResponseSchema` is available from `@openlup/platform/marketing` with its core object identity.
Migration: New public type `AcquisitionOpaqueReference` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `AcquisitionAddressReference` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `AcquisitionCaseState` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `AcquisitionCaseProjection` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `AcquisitionCaseListRequest` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `AcquisitionCaseListResponse` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `AcquisitionCaseActiveCountResponse` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `AcquisitionIdempotencyKey` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `AcquisitionSurveySubmit` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `AcquisitionSurveyEvidence` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `AcquisitionSurveySubmitResponse` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `AcquisitionSurveyListQuery` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `AcquisitionSurveyListResponse` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `AcquisitionNewsletterConsentEvent` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `AcquisitionNewsletterConsentResponse` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `MarketingResearchJson` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `ResearchSurveyType` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `AdminSurveyResponsesRequest` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `AdminSurveyResponseRow` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `AdminSurveyResponsesResponse` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `ResearchSurveySubmitRequest` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `ResearchSurveySubmitResponse` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `MarketingResearchSurveyResponsesReadPort` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `MarketingResearchSurveyRequestHeaders` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `MarketingResearchSurveySubmitPort` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: `en|pl` locale restriction is known debt tied to the persisted CHECK; locale widening needs a future migration and is outside M13 scope.
Migration: Retired acquisition case submit/transition request and response contracts and the app-owned client-version binding are intentionally not published.
Migration: New public export `PRELAUNCH_ACQUISITION_VIEW` is available from `@openlup/platform/marketing`.
Migration: New public export `PRELAUNCH_ACQUISITION_CONTRACT_VERSION` is available from `@openlup/platform/marketing`.
Migration: New public export `prelaunchAcquisitionListRequestSchema` is available from `@openlup/platform/marketing`.
Migration: New public export `prelaunchAcquisitionDetailRequestSchema` is available from `@openlup/platform/marketing`.
Migration: New public export `prelaunchAcquisitionLeadSchema` is available from `@openlup/platform/marketing`.
Migration: New public export `prelaunchAcquisitionListResponseSchema` is available from `@openlup/platform/marketing`.
Migration: New public export `prelaunchAcquisitionDetailResponseSchema` is available from `@openlup/platform/marketing`.
Migration: New public type `AcquisitionCaseFailureKind` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `AcquisitionCaseResult` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `AcquisitionCaseListQuery` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `AcquisitionCaseGetQuery` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `AcquisitionCasePort` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `AcquisitionEvidenceFailure` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `AcquisitionEvidenceResult` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `AcquisitionEvidencePort` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `PrelaunchAcquisitionListRequest` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `PrelaunchAcquisitionDetailRequest` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `PrelaunchAcquisitionLead` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `PrelaunchAcquisitionListResponse` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: New public type `PrelaunchAcquisitionDetailResponse` is available from `@openlup/platform/marketing` and `@openlup/platform/marketing/contracts`.
Migration: The rich prelaunch DTO and retired acquisition case submit/transition port methods and commands are intentionally not published.
Migration: The marketing runtime entry configures the shared Zod instance in jitless mode on load, the same as the pricing, catalog and communications entries; the type-only marketing/contracts entry has no runtime initialization.

Adds experimental Node-only marketing server factories through unchanged
acquisition, research and PostgreSQL algorithm movement. Host composition retains
routing, environment, authorization, observed wrappers and notification copy.
Browser marketing entries retain their isolated schema/type-only boundaries.

Migration: New public subpath `@openlup/platform/marketing/server` contains acquisition case handlers, direct acquisition history and prelaunch reads, survey evidence and consent commands, research handlers and managed survey orchestration.
Migration: PostgreSQL port factories are published separately under `@openlup/platform/marketing/server/postgres` so the server entry does not load the existing optional `pg` peer. Select `/postgres` with that peer installed. Reference bindings load the adapter lazily after their bundle and connection guards. SQL text, signatures, role selection, pool creation and transaction handling retain their behavior.
Migration: `createAdminClientsTestersDirectHandler` maps to the neutral package symbol `createAcquisitionCaseListDirectHandler`; `createTesterProgramActiveCountDirectHandler` maps to `createAcquisitionCaseActiveCountDirectHandler`. The reference retains both original factory names and route registrations.
Migration: `handleAcquisitionSurveySubmit`, `handleAcquisitionSurveyList` and `handleAcquisitionNewsletterConsent` compose `createAcquisitionSurveySubmitDirectHandler`, `createAcquisitionSurveyListDirectHandler` and `createAcquisitionNewsletterConsentDirectHandler`, respectively. Successful evidence values remain forwarded without response-schema validation.
Migration: Direct factories receive the host BFF responder, authorization callback and binding resolver. Acquisition list/count additionally receive the direct-bundle predicate at its original guard position. Prelaunch/evidence bundle and request-view dispatch remain with host callers; no additional guard is introduced.
Migration: Research submit/admin handler dependencies receive the BFF responder and use platform HTTP types. Research schemas and ports retain the `@openlup/core/marketing/research` compatibility owner. Delivery types retain their communications/contracts owner.
Migration: Managed survey submission receives `renderNotificationHtml(type, responseData, id)` and `notificationSubject(type, now)`. HTML renders before the subject clock read, after policy filtering. The host retains subject/HTML copy and escaping; rendered values reach delivery unchanged.
Migration: Server-only structural submit/transition request and command types retain the historical adapter signatures without adding schemas or changing either browser entry. Retired route factories, terminal refusals, admin auth binding, observed wrappers and raw signed consent ingress remain application-owned.
Migration: Reference acquisition handler and PostgreSQL adapter paths retain thin package re-exports; runtime bindings retain lazy adapter imports. Reference research handler files bind the responder, and managed submission binds notification copy while retaining live host configuration reads. Prelaunch rich read models and admin leads remain application-owned.
Migration: Neutral characterization lives under `packages/platform/test/marketing/server/`, including the complete survey/consent direct-handler witness. Six superseded reference test files are removed: acquisition case handlers, both PostgreSQL adapters, prelaunch direct handlers, research submit handler and research admin responses handler. Each asserts only package-owned behavior.
Migration: Reference direct acquisition tests retain retirement and real admin-auth assertions. Reference prelaunch route tests and evidence direct tests retain host composition coverage. Managed submission retains only reference-side copy/escaping coverage; package tests assert the synthetic renderer seam and ordering.
Migration: Real PostgreSQL parity lives at `tests/postgres/acquisitionEvidenceParity.test.ts`, imports package factories from `/marketing/server/postgres`, applies the hash-checked manifest prefix and connects all ports using a login granted only runtime-role membership. Missing Docker throws instead of skipping. The fixture owner is used only for setup, state inspection and the donor's append-only trigger proof; separate runtime-role mutation assertions retain privilege-denial coverage in the same case. The witness retains 11 cases. Test rows use deterministic synthetic identifiers and timestamps, and emails use `example.invalid`.
Migration: The installed consumer exercises a historical count and a conflict refusal with injected bindings without optional peers. The `/postgres` entry receives missing-peer import refusal and selected-peer factory/refusal checks through the existing adapter proof. One package-boundary bundle case prevents the server entry from reaching PostgreSQL adapters or `pg`, bringing the additive seam cases to seven within the eight-case limit. Exact export, API and package-smoke inventories include both server entries; artifact caps, dependencies, migrations and grants are unchanged.

The browser-safe marketing surface provides inert analytics defaults, independently attempted local sinks, injected route policy, paid purchase projection and historical consent-time selection. The reference application binds its existing policy and wire names while preserving its purchase transcript. Local admission booleans establish synchronous acceptance only, never delivery.

Migration: `AnalyticsStepName<StepName = string>` and `AnalyticsEventMap<StepName = string>` accept host step literals instead of a product-specific union. `AnalyticsCheckoutItem`, `AnalyticsPurchaseItem`, `AnalyticsCheckoutMode`, `AnalyticsPaymentWaitOutcome` and `AnalyticsEventName` retain the neutral event vocabulary. Types are also available type-only through `./marketing/contracts`.
Migration: `createNoopAnalytics` reuses the existing core `AnalyticsPort`. `initializeDeploymentAnalytics`, `trackDeploymentEvent`, `syncAdvertisingConsent` and `trackAdvertisingPurchase` are inert defaults.
Migration: The donor-only transport ownership field and provider-specific purchase envelope, transport result and transport types are excluded private transport concerns; hosts extend their own event map outside the package.
Migration: `createAnalyticsDataLayer` replaces module-global mutable state with per-instance state. `AnalyticsDataLayerOptions` injects consent storage/event names, event prefix, container reader, deployment callback and browser access. Defaults are inert. `AnalyticsBrowserWindow`, `AnalyticsCookieConsent`, `AnalyticsSinkAttemptMask` and `AnalyticsSinkAdmission` describe those seams. Host bindings retain historical literals. Consent command arguments, ordering, parse rules, push-time advertising grants and independent synchronous admission are preserved; no pre-consent replay is added.
Migration: Hosts must supply `AnalyticsDataLayerOptions.consentSignalNames` to enable optional event admission and consent commands: one `analytics` wire name and ordered `advertising` wire names. Omission pushes no consent commands and returns false from `pushAnalyticsEvent`, even with browser access, a container and stored consent; deployment sink attempts are unaffected. Supplied settings retain the analytics key first, then advertising keys in host order, with unchanged consent values.
Migration: `createAnalyticsRoutePolicy` takes required `AnalyticsRoutePolicyInput` public paths, redirect sources and sensitive sets; there is no ambient route manifest or default sensitive-path policy. `normalizeAnalyticsPathname` preserves normalization. The returned optional-route eligibility method uses a neutral name; hosts alias their historical name.
Migration: `projectPaidPurchase`, structural `PurchaseOrder` and `PurchaseSuppressionReason` preserve paid allocation, grouping, residual shipping, cap and ordered refusal logic. Currency is a plain string with no ambient currency initialization. The reference guards unsupported kinds before projection through a null input, preserving its renewal refusal and order/payment precedence; the package admits renewal as subscription, matching the donor.
Migration: `selectMarketingHistoricalConsentTime`, `MarketingHistoricalConsentCommand`, `MarketingHistoricalConsentState` and `MarketingHistoricalConsentResult` expose only chronology facts and the exact compared state literals. Command authorization, persistence and workers stay with the host.
Migration: `createAnalyticsContextHandler` is exported only by `./marketing/server`, with server-only `AnalyticsContextHandlerDeps`, `AnalyticsContextPersistencePort`, `AnalyticsContextStoreResolver` and `AnalyticsContextCapabilityCrypto`. Platform `HttpRequest`/`HttpResponse` and a required host `BffResponder` replace application HTTP/envelope imports; the host keeps its route path and observability wrapper.
Migration: The context handler requires an `isEnabled` reader instead of reading an ambient flag. The host retains the flag name and exact enabled-value comparison; the package has no enabling default. Method, flag, origin and strict request-schema refusal order and error codes/messages are preserved. The schema uses the package's jitless validation wrapper.
Migration: `AnalyticsContextHandlerDeps.clientIdField` is a required host binding for the historical client-id wire field name. Each handler builds its strict schema once with that key, retaining the numeric-dot-numeric pattern, 64-character limit, optional field, `explicitGrant` default false and granted-requires-client-id refusal. Internal and persistence fields remain `clientId`; hosts retain their serving wire names.
Migration: The host supplies `capabilityCrypto.mintToken` and `hashToken` instead of built-in cryptography, and `cookieName` as the historical compatibility input. Minting must provide opaque 32-byte lowercase hexadecimal tokens and hashing must preserve the host's cryptographic digest. Cookie parsing still selects the first matching name, accepts only 64 lowercase hexadecimal characters and hashes the token; mint timing, cookie attributes and explicit no-store placement are unchanged.
Migration: `resolveStore` replaces the application gateway lookup; null still refuses with `UPSTREAM_UNAVAILABLE`. `AnalyticsContextPersistencePort.syncContext` receives token hash, granted and client id, and `enrollSubscriptions` receives the verified subject and context hash. These throwing operations replace the application RPC-call wrapper; the host keeps RPC names, argument translation, error-to-throw handling and gateway service authority. Only literal true is active. No default persistence or portable SQL exists, and no reference route is added; a host must supply persistence before mounting the handler.
Migration: Required `readAccessToken` and `resolveTrustedSubject` bindings replace application authentication imports. The host verifies the bearer under its service authority; invalid bearer grants still refuse before writes, withdrawal needs no identity, and enrollment uses only the verified subject. Explicit regrant replacement, revoked predecessor retention and `{ active }` responses are unchanged. An active result is a local context fact, never delivery; telemetry context failure never gates commerce.

Extend the experimental browser-safe `@openlup/platform/marketing` entry with
JSON-LD serialization and graphs, route URLs and hreflang, an ordered head
descriptor and contact/legal plain-data projections. Contact/legal/privacy
content contracts are type-only exports from `@openlup/platform/marketing/contracts`
and the runtime entry. Applications supply all identity, origin, locale, image,
document and processor facts. Responsibility-specific source files re-export
through the existing marketing barrel without adding a subpath, renderer,
dependency, network call or application policy. Fresh synthetic conformance and
browser-bundle tests, API declaration snapshots and the installed consumer
witness both entries.

Donor divergences: entity facts, lifecycle-selected organization type, contact
type/languages, image URLs/dimensions, route registry, default locale and social
metadata become explicit inputs. Product brand prefixing, fixed category,
audience, fallback weight and image-slug lookup are removed; category, images,
SKU, GTIN and net content are caller supplied or omitted. The fixed locale union
becomes strings, and FAQ fields use neutral question/answer names. The private
image variant helper, language detection and unregistered-route alternate escape
hatch remain application concerns. The head's canonical input uses the injected
route contract instead of the donor's loose absolute-URL passthrough.
The head requires application-supplied image width, image height and Twitter
handle, and emits `og:image:width`, `og:image:height` and `twitter:site`
unconditionally in donor order. `og:locale:alternate` remains conditional on
a supplied alternate locale.

Contact shaping uses supplied support email, shared organization facts, address
text and ordered registration label/value pairs in place of private identity
constants and country-specific identifiers. The optional `registrationAuthority`
line is absent only when its input is undefined; supplied blank company lines
are retained. Legal shaping takes supplied title, intro and ordered title/body
sections in place of fixed translation keys and section inventories. The
last-updated text is optional; supplied blank text is retained. Page markup,
translations, navigation and other contact copy remain application-owned.
Privacy processor disclosures are new structural types, with no projection.

The reference `SeoHead` adapter renders the descriptor through the existing
`react-helmet-async` dependency with `defer={false}`, removes unmanaged shell
canonical/alternate links after client commit only in the host-supplied `csr`
render mode (as in the donor), and emits the serialized JSON-LD
unchanged. These donor host behaviours stay outside the package. The adapter
has no serving-route mount; mounting is a later integration. Its tests witness
hidden-document commits, hostile script data and shell canonical replacement.

Migration: none. Both entries are extended additively; no SQL or application route changes.

The experimental `createMarketingContribution` helper in
`@openlup/platform/composition` describes selected marketing callables as an inert
`marketing` capability providing `./marketing`, `./marketing/contracts` and
`./marketing/server`, depending on identity's `./identity/contracts` runtime
obligation schema.
Handlers are projected to descriptors without `handle`; ports, routes and
triggers retain supplied callable identity. Duplicate registration identities
refuse, and null ports remain required without creating callable bindings.

Divergences from the donor: no donor composition exists; this helper supplies
descriptors only; no worker, route or schedule is installed.

Migration: Import `createMarketingContribution` from `@openlup/platform/composition` and supply already-bound operations, handler registrations, routes, schedules and host schema requirements explicitly.
Migration: Bind each required operation under `@openlup/platform/marketing:<name>`; a null operation remains a Core readiness obligation and reports `OPENLUP_E_PORT_MISSING` until bound.
Migration: The helper invokes no operation during construction. Host admission and installation of workers, routes and schedules remain application-owned.

The existing `./marketing/server` entry additionally exports the marketing privacy
contributor and default-off binding. Both complete owner ports and explicit
enablement select one contributor, shared by the callables supplied to composition.
Unbound or partial ownership reports unavailable coverage and unresolved
obligations; identity refuses erasure before owner effects. Identity owns the
subscriptions veto, receipt replay and rollback. The fence runs only during
`eraseOrRetain`, after all assessments; fence failure throws without owner text.
Accepted provider requests retain an accepted-not-observed reason and never
claim deletion or complete remote export coverage.

Donor divergences: worker, operator and store stay app-owned. Only O18 outcomes
and fence semantics are contributed; provider calls, claims, retries, schedules,
SQL and late-import orphan handling remain with their owners. The reference
privacy graph leaves marketing unselected, and marketing privacy coverage there
remains an open gap. Raw managed questionnaires and other processors are outside
this contributor's coverage.

Migration: Import `createMarketingPrivacyBindings` and its owner port types from `@openlup/platform/marketing/server`; bind both complete transactional owners and set `enabled: true` explicitly to select a contributor.
Migration: Register the returned contributor with identity and pass the returned `exportPersonalData`, `assessErasure` and `eraseOrRetain` callables as the marketing record to `createMarketingContribution`; disabled or partial bindings expose null callables.
Migration: Compose identity's `./identity/contracts` module dependency and preserve its assessment-before-mutation, subscriptions veto, receipt replay and unit-of-work rollback contract.
Migration: Keep remote profile coverage unavailable; accepted requests and outstanding imports or targets do not establish observed deletion. The reference requires a separately authorized owner binding before marketing privacy coverage can be claimed.

Declaration repair: Privacy owner ports and `MarketingPrivacyContributor` use
local structural types and identity's `./identity/contracts` types, preserving
compatibility with identity's contributor without referencing its main entry.
`./marketing/server` remains free of the optional `pg` peer in strict installed
declaration compilation; only `./marketing/server/postgres` selects that peer.
The runtime obligation schema still comes from `./identity/contracts`.
Identity's public surface, privacy execution and the 16-case K5 budget are unchanged.

- Packed root-documentation budget: the docs-gzip cap in release-gates.json rises from 57,344 B to 73,728 B, approved by the owner on 2026-10-26, because the assembled 0.29.0 notes measured 63,226 B; no other cap changes.
