# Changelog history

Releases moved verbatim out of the packed `CHANGELOG.md`, which keeps the current release and the two previous ones.

## [0.32.0]

- Publishable on the npm `latest` dist-tag as `0.32.0`, from tag
  `openlup-platform-v0.32.0`.

### Installed agent context

- Package a root `AGENT_CONTEXT.md` with excerpts of canonical platform
  guidance, source paths, line ranges and excerpt digests. Core's installed
  offline `openlup-context` command can find it; check the cited source before
  relying on an excerpt. It adds no dependency or runtime activation.

### Generic risk controls

- Add experimental `@openlup/platform/risk`, type-only `risk/contracts` and
  Node-only `risk/server` entries for risk scoring, blocklist checks and the
  operator review queue. Core risk keeps its existing coordinates and algorithms.
- Expose paid-order assessment, structural native/managed persistence adapters,
  admin list/detail/decision factories and explicit host composition. Reference
  bindings delegate to these entries. Risk remains default-off; importing a
  package installs no route, worker, schedule or second paid-event executor.
- Native and managed behavior remains distinct. Shadow-mode review/block
  decisions can prevent fulfillment without a SQL hold; managed assessment
  fingerprints include the occurrence timestamp, and managed admin readback
  returns `replayed: false`. Review the selected rail and mode before enabling it.
- Migration: Upgrade the complete package set together. `RISK_MIGRATIONS`
  projects the unchanged native post-order control catalogue unit; it is not a
  standalone installation chain. Install the complete same-rail canonical
  catalogue and verify its prefix and inventory before selecting risk. Hosts
  supply authorization, trusted actor mapping, clients, hash secret, schema
  readiness and explicit mode; no SQL forward is introduced by this set.

### Privacy composition

- Add a bounded experimental risk privacy contributor for the existing identity
  registry. Hosts inject read-only resource access and explicit retention policy;
  unavailable resources or unresolved ownership remain explicit. Retention
  preserves audit, hash, replay and hold-link facts without a default period.
- Export refuses credential payloads. Identity retains authorization, transaction
  rollback and receipt replay. No deletion adapter or managed erasure support is
  added. The inert privacy binding leaves portability deferred unless the host
  supplies its own opaque binding; it provides no transfer or restore capability.

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
## [0.28.0]

- Publishable on the npm `latest` dist-tag as `0.28.0`, from tag
  `openlup-platform-v0.28.0`.

Add experimental account-support and type-only account-support/contracts exports
with five owner-derived envelopes, explicit capability types, unchanged account-read
diagnostics and an injected read facade. Hosts retain authorization, projections,
private extensions and driver selection; command envelopes install no executor.
Add owner-equality, browser, delegation, reference and packed-consumer witnesses.

Migration: none for existing callers. The new subpaths are additive and the
reference diagnostic path retains its exports and behavior. The catalog,
commerce-server, commerce, fulfillment, identity, pricing and promotions API
reports (`api/catalog.api.md`, `api/commerce-server.api.md`, `api/commerce.api.md`,
`api/fulfillment.api.md`, `api/identity.api.md`, `api/pricing.api.md`,
`api/promotions.api.md`) reorder existing enum/union members because declaration
emit order changed after adding the module: member order only, no declaration
change; no member is added, removed or changed. No SQL migration or activation.

Add bounded account/support read composition through the existing experimental
account-support and type-only account-support/contracts entries. New runtime
exports: CUSTOMER_ACCOUNT_V2_CONTRACT_VERSION, readAccountSnapshot,
isCustomerVisibleSubscription, recurringPrice, computeEditState, editCutoff,
buildActionRequired, CUSTOMER_ORDERS_CONTRACT_VERSION, readCustomerOrderSummaries,
readCustomerOrderDetail, customerOrderMoney, toOrderMoneyHeader, toOrderMoneyItem,
mapCustomerOrderLines, lineListTotalMinor, SUPPORT_CUSTOMER_360_CONTRACT_VERSION,
projectCustomer360Snapshot, deriveContactHealth, boundedCustomerJourneyAudit,
createCustomer360ReadFacade, createInvoiceAccess, downloadOwnedInvoicePdf and
deriveCustomerDocumentDeliveryStatus. Add neutral account/order/support DTOs and
typed source, projection and invoice-owner ports; preserve R1 exports.

Reference factories and host-fed views are default-off/unmounted. Native support
reads use the existing authorized PostgreSQL scope; unselected capabilities
refuse explicitly. Pricing, captured presentation and private extensions stay
host injected. Invoice access binds the document to a found owned-order history
before ticket resolution or artifact IO, adding one history read; foreign/unknown
documents return denied. Download requires a bound owned-order history; an unbound
history reports unsupported (host_binding_required). Denied, unknown and unsupported
history results retain their distinct M09 outcomes before ticket/artifact IO;
thrown history stays unknown. M09 PDF validation remains unchanged.
Customer 360 facade authorization now runs before every source read and returns
denied with zero source IO on refusal. The reference binding uses that callback
once per call before opening a governed journey or independent diagnostic scope.
Customer 360 subscription pointer enrichment includes optional nullable
paymentMethodKind, preserving selected-empty null and unread omission. Reference
diagnostic search, segment history and v2 overview select their own authorized
scope; reference line presentation picks only its declared display fields.

Migration: the unreleased Customer360Subscription gains optional nullable
paymentMethodKind. Selected Customer360ProjectionInput.subscriptionPointers values
now supply paymentMethodKind alongside shippingAddressId; use null for known-empty
evidence and omit the pointer source when unread. Callers of the unreleased
createCustomer360ReadFacade now supply authorize(): Promise<boolean> alongside
journey, summary and diagnostics, and handle the added { kind: "denied" } result
on every method. No SQL migration is required.

The unchanged generator also regenerates these sibling API reports:
- `packages/platform/api/catalog.api.md`
- `packages/platform/api/commerce-server.api.md`
- `packages/platform/api/commerce.api.md`
- `packages/platform/api/communications.api.md`
- `packages/platform/api/fulfillment.api.md`
- `packages/platform/api/identity.api.md`
- `packages/platform/api/invoicing.api.md`
- `packages/platform/api/pricing.api.md`
- `packages/platform/api/promotions.api.md`

These generated companions are member order only, no declaration change. No
snapshot is hand-edited; no member is added, removed or changed in those reports.

Add experimental self-service composition returning SelfServiceCommandFacade,
with required host capabilities and every guarded output lane. ENV-R3-1 keeps
input lanes optional and adds nativeLegacySubscription plus subscriptionControl.
Unselected methods return AccountSupportLaneUnavailable: paymentMethod uses the
host paymentMethodSetup refusal by identity, commerce uses commerceRecovery,
and every other lane uses a frozen host_binding_required refusal after its guard.
Native routing retains ownership-before-quote behavior and explicit pause; typed,
raw, profile, method, commerce and recovery delegates keep owner results/refusals.
Raw/typed admission requires the supplied clientId before every owner call. The
trailing `ControlSnapshot = unknown` generic preserves snapshot DTOs and existing
twelve-argument consumers.
The generic M07 adapter maps setupMethod to paymentMethod.execute. No owner type
imports or new module-graph edges. Native repair is a registered follow-up, not a
cut; token handlers stay in reference source. The reference binding remains off.

The unchanged API generator leaves two sibling snapshots changed from final R1:
`commerce-server.api.md` and `commerce.api.md` under `packages/platform/api/`.
These are disclosed generated companions: member order only, no
declaration change, proven by AST comparison normalizing union/enum member order.

Migration: development-preview envelope delta ENV-R3-1. Supply verified context,
AccountSupportCapabilities and complete selected owner lanes. Handle the named
unavailable arm in method results. Supported paymentMethodSetup requires paymentMethod; supported
commerceRecovery/configuredPurchase require commerce; supported subscription
genericBundleCommands/commandBoundReceipts require a subscription command lane. No schema, dependency, release cap, activation or browser cutover change.

Add explicit operator recovery composition, current managed email claim/settlement,
managed account link and human recovery fence, and native support delegation to
M10 through injected executors. Preserve donor callback and failure ordering;
expose actual optional owner receipts and truthful link-then-action partial results.
The reference binding remains default-off and unmounted.

Migration:
- Introduce the frozen native support-authority SQL and packed twin plus the
  managed current-authority forward, after complete same-rail predecessors.
- Retire `customer_support_correct_subject_email_v1`: human calls raise 55000
  `customer_support_email_correction_requires_admission`; drain old callers and
  use admission → claim → claim-fenced identity commit → settlement.
- operator_subscription_actions: 3 combined email calls now execute admission → claim → claimed auth move (linked only, deferred fence forced before settlement) → settlement; existing success/replay/collision/stale/audit expectations retained; human roster fixture added.
- operator_contact_correction: 4 combined email calls now execute admission → claim → claimed auth move (linked only, deferred fence forced before settlement) → settlement; existing success/replay/collision/stale/audit expectations retained; human roster fixture added.
- runtime_capability_boundary: missing-subject/null-clock correction uses admission (same subject_not_found result); human admission fixture added; machine retired-entry 42501 unchanged.
- marketing_lead_email_namespace: 1 combined email calls now execute admission → claim → claimed auth move (linked only, deferred fence forced before settlement) → settlement; existing success/replay/collision/stale/audit expectations retained; human roster fixture added.
- absorb_lead: 1 combined email calls now execute admission → claim → claimed auth move (linked only, deferred fence forced before settlement) → settlement; existing success/replay/collision/stale/audit expectations retained; human roster fixture added.
- CD-8: use `status = 'payment_pending'` for native residual-unpaid detection,
  matching the native cycle CHECK; native outcomes and the managed predicate stay
  unchanged. The native witness covers resume with and without that cycle.
- CD-9 standing donor-adopter adoption mapping: link keeps the same body; the donor adopter uses
  INVOKER with table-wide `service_role` access, while OpenLup uses DEFINER under
  column-level capability closure. Preserve the migration owner, fixed search
  path and service-only EXECUTE; widen no table grant. Retired email correction
  and recovery remain INVOKER.
- RD-R4-4 link refusal proof: machine/non-human, missing and inactive operators
  leave clients, support commands and audit rows unchanged. Subject refusals
  leave clients and auth identities unchanged and write exactly one refusal
  receipt plus one matching audit row for the key, with no other row/xmin changes.
  Unknown subjects return `refused` / `subject_not_found`; email expectation,
  foreign-identity and already-linked conflicts return `conflict` with
  `email_expectation_conflict`, `identity_linked_elsewhere` and
  `subject_account_linked`, respectively. Same-key replay returns the stored
  refusal unchanged with zero further writes.
- Native M03 contact/link and unsupported M10 subcases remain named refusals;
  no historical migration, pin, module graph or source-release contract changes.

API generator companions and measured verification are recorded in the module plan.

Add inert account/support graph bindings, guarded owner services and composition
descriptors over the R1–R4 envelopes. The reference recipe is default-off, mounts
nothing and starts no workers. Service/port/route aliases share one callable
guard; readiness is observed before every entrance. Owner authorization, keys,
receipts, refusals and M04 delivery/replay remain with their existing owners.
The reference operator subscription adapter restores donor BFF command metadata
around one R4 dispatch and serializes only the strict donor outcome fields,
including decoded ISO timestamps and explicit nulls. Optional native `ownerReceipt`
evidence stays server-side and is absent from the response. The composition witness
distinguishes that response from SQL storage.

Migration: additive `createAccountSupportBindings`, `createAccountSupportServices`
and `createAccountSupportContribution` exports. Hosts supply one graph, prebound
operations, exact selected schema and complete catalogue identity, map admission
refusals before serving routes, and explicitly compose declared owner contributions.
Null selected operations remain required/unbound. Commerce is a nullable injected
record returning `unsupported/host_binding_required` when unbound. The reference
`commerceOwner` option accepts the host-built M11 selection over bound checkout,
recovery and ATP callables, with the complete account/M11/ATP schema union and
matching enablement/readiness. R5b does not construct M11 or import its adapters;
it uses a local structural selection type. Supply the existing effect registry
as `commerceRegistry` and forward guarded services and contributions once;
unknown stock, unsupported options and commerce outcomes remain unchanged.
While account-support is disabled, a supplied M11 selection stays cold: the
keyed commerce entrance returns the disabled refusal before the selected owner
or the injected record runs, and no M11 contribution, port, route, trigger,
reference handle or schema requirement is forwarded.
Configured recovery/purchase elements use explicit host paths and clients. No SQL, version, serving
activation or source-release snapshot changes. Regenerated account-support and
composition API reports describe these additions; no sibling API report changed.

## [0.27.0]

- Publishable on the npm `latest` dist-tag as `0.27.0`, from tag
  `openlup-platform-v0.27.0`.

- Bind experimental native new-purchase previews to the existing ATP reader through the inventory and reference composition, protecting subscription stock without another stock calculation.
- Migration: PostgreSQL hosts supply the optional `stockSourceKey` binding dependency to enable `newPurchaseStockReadPort`. The preview then binds with no unsupported reason; an absent or blank key reports `inventory_stock_source_key_required`. Admin readiness is unchanged; a required preview leaves reference readiness refused until the key is supplied.
- Migration: Native previews subtract all live holds, remaining active subscription demand inside 14 days and channel exposure. For 20 units with 5 held and 7 still due, both availability fields report 8; a provider-tag-filtered preview counting only 2 of those held units would report 11 for new purchases. Credited own-cycle holds are not subtracted twice. Exposure of 4 reduces a budget of 11 to 7.
- Migration: Native budgets clamp at zero, stale stock contributes zero to ATP, and local-only stock has no native source. The native preview refuses own-order exclusions or a horizon other than 14 days as `native_stock_read_options_unsupported`; it provides no one-time or replacement allocation seam.
- Migration: Managed hosts apply the managed forward `20261025109000_inventory_new_purchase_stock_read.sql` after the managed migration prefix (`public.inventory_new_purchase_stock_read(p_skus jsonb, p_as_of timestamptz) RETURNS jsonb`, service_role-only execution), then supply optional `stockRpc` to the inventory binding (also forwarded through the reference store). An injected `newPurchaseStockReadPort` wins; without either dependency the existing `inventory_new_purchase_stock_reader_required` remains.
- Migration: Managed preview quantities equal ATP with renewal exemption fixed false, preserving M10 provider-tagged holds, safety, 14-day uncredited demand and channel exposure. Both availability fields now include demand and clamp at zero. Other horizons and own-order exclusions refuse `managed_stock_read_options_unsupported`; SQL accepts at most 200 requested array items before deduplication and refuses a NULL as-of timestamp as `inventory_stock_as_of_invalid` (SQLSTATE `22023`). The managed preview treats ANY stale provider-stock evidence for the SKU as stale (fail-safe; exact when one provider kind exists); quantities remain unchanged and the allocator's own stale refusal stays authoritative.
- Migration: Managed `source` is "provider" iff ATP returns a row for the SKU; otherwise it is "missing".

- Add experimental `@openlup/platform/commerce` neutral schema cores, contract helpers and ports, plus type-only browser-safe `@openlup/platform/commerce/contracts`. Reference bindings extend these cores with existing profile, locale, fiscal and provider policy. No version or artifact cap changes.
Migration: Commerce-owned ports and generic records may be imported from `commerce/contracts`. Pricing DTOs remain at `@openlup/platform/pricing/contracts` directly, without convenience re-exports from commerce. Reference exported names remain available.
Migration: `commerceOfferVersionSchema` now validates opaque offer tokens of at most 40 characters, using the lower-case token grammar (D1).
Migration: The commerce quote port's out-of-band `CreateQuoteOptions` now accepts the server-bound `offerVersion`; the M05 options and quote DTOs remain their existing owner (D2).
Migration: Reference quote context types additionally carry optional shipping and acquisition terms using their existing package definitions (D3).
Migration: Checkout expected-quote acceptance and price-change responses now admit acquisition expectations independently of totals; invalid revisions and discount bounds are refused (D4).
Migration: Configurator intents additionally admit acquisition capability, opaque `offerVersion` and bounded `minimumUnits` asks (D5).
Migration: A supplied minimum replaces the injected host default for untrusted intent validation only; it does not authorize server checkout admission (D6).
Migration: `offerAvailabilityRequestItems` projects one unit per variant in input order and the supplied checkout mode (D7).
Migration: The reference configurator-to-quote mapper forwards an admitted acquisition capability, leaving absent capabilities absent (D8). This does not activate an acquisition issuer or offer guard.
Migration: `CheckoutOfferPolicyPort<Intent, Quote>` and its bound/refused result are available as types only (D9). Offer resolution, evidence execution and the starter guard remain outside K1 and are deferred to K2a.
Migration: Reference recovery policy, nominal errors and order-contact helpers delegate to the package with identity preserved. Neutral checkout, resume and defaults schema factories require explicit host bindings; their reference extensions retain existing acceptance, parsed output and error paths.
Migration: `commerce/server` is a reserved empty Node-only entry; browser consumers continue to use `commerce` and `commerce/contracts`. Canonical order-money and commerce outbox payload validation are available from `commerce`; host quote/draft schemas are injected with the existing validation behavior.
Migration: Checkout admission refuses unbound offer/minimum asks while no server offer resolver is composed, retaining the host floor for ordinary requests; untrusted intent parsing still accepts those asks.
Migration: The commerce quote port requires request, response and host-options type parameters; the reference binds the existing pricing definitions and retains its named types. This removes an unnecessary pricing declaration closure without copying its contracts or changing pricing behavior.
- Add browser-safe `@openlup/platform/pricing/browser` with direct re-exports of the existing quote primitive factory and acquisition capability/expectation schemas. Reference imports retain symbol identity and validation behavior; the pricing root and contracts entry are unchanged.
Migration: Regenerated `communications.api.md`, `fulfillment.api.md` and `inventory.api.md` change declaration order only: TypeScript emits union and enum members in literal-creation order across the program. For `defaultCommunicationPurposeRegistry`, before: `"transactional" | "marketing_launch_offer" | "marketing_newsletter" | "tester_program" | "subscription_dunning" | "admin_notification"`; after: `"transactional" | "subscription_dunning" | "marketing_launch_offer" | "marketing_newsletter" | "tester_program" | "admin_notification"`. Communications newsletter, fulfillment and inventory enum members likewise appear in a different order. The member sets and all types are unchanged; type consumers are unaffected and need no code or SQL migration.

- K2 lands no SQL. A dedicated later PR, L1, lands all nine reviewed managed M11 slots (`scripts/fixtures/reviewed-m11/supabase/migrations/20261025100000..110000`) in order; no release ships K2 without them (D-M11-SQL-LAND-1).
- Until L1 lands on the managed rail, a 21-day starter graduation cadence passes admission but fails at provisional-subscription creation: the installed `subscription_create_provisional_for_checkout` and `subscription_apply_starter_graduation` still accept only 14 and 28. Checkout returns the generic failure (HTTP 503).
- Until L1 lands on the managed rail, the finalize acquisition-admission backstop is inert: `commerce_finalize_order_for_checkout` does not invoke `private.commerce_assert_acquisition_admission` to raise `acquisition_terms_changed` (SQLSTATE 55000), so the package mapping and the safe-compensation re-quote it triggers never fire from the database. The TypeScript quote guard still re-quotes a changed acquisition expectation before finalize.
- Until L1 lands on the managed rail, `commerce_configurator_persist_intent` lacks the donor preference write scope: preference/consent writes are not restricted to the authenticated owner, and the legacy country fallback stays as installed.

- Move the unchanged checkout compensation helper and cleanup port into `@openlup/platform/commerce/server`. The reference facade re-exports the identical function; release/cancellation ordering, idempotency keys, reasons and warnings are unchanged.

- Move checkout handlers, the shared paid-order saga, runtime and command execution into the experimental Node-only commerce entry. Host projections, schemas, response routing, starter policy and existing payment execution are injected; reference paths delegate to one package implementation.
Migration: Acquisition expectations independently reject changed terms in the TypeScript quote guard before finalize; a locked finalize refusal re-quotes only after safe draft compensation once the managed forwards land (L1) (N1). Shipping or acquisition terms now require promotion acceptance even without a current promotion discount (F2).
Migration: Failed promotion-price-change re-quotes now map `CommerceQuoteError` code `UNKNOWN_SKU` to `BAD_REQUEST` (HTTP 400), and `PRICE_NOT_CONFIGURED`, `UNSUPPORTED_TAX_PROFILE` or `PRICING_INVARIANT_VIOLATION` to `CONFLICT` (HTTP 409), forwarding `error.message` and `error.details` instead of the base's `UPSTREAM_UNAVAILABLE` (HTTP 503), "Checkout failed" and `{ feature: "checkout", stage: "quote" }`. Newly supported acquisition-terms-change re-quotes use the same typed mapping (donor N1).
Migration: Failed promotion-price-change re-quotes with `CommerceQuoteCatalogReadError` retain `UPSTREAM_UNAVAILABLE` (HTTP 503), but now return "Commerce catalog is unavailable" and `{ reason: "catalog_unavailable", refusalCode: error.code }` instead of the base's "Checkout failed" and `{ feature: "checkout", stage: "quote" }`. Newly supported acquisition-terms-change re-quotes use the same catalog mapping (donor N1).
Migration: Initial quotes, including normal quoting after saved-continuation fallback, and promotion-price-change re-quotes now map `AcquisitionTermsError` reasons `acquisition_terms_capability_required` and `acquisition_terms_v2_required` to `CONFLICT` (HTTP 409), "Acquisition terms unavailable" and `{ reason: error.reason, refreshRequired: true }`. The base returned `UPSTREAM_UNAVAILABLE` (HTTP 503), "Checkout failed" and `{ feature: "checkout", stage: "orchestrate_order" }` with an optional sanitized preview `diagnosticReason` for initial quotes, or `{ feature: "checkout", stage: "quote" }` for promotion re-quotes. Newly supported acquisition-terms-change re-quotes use the same acquisition mapping (donor N1).
Migration: On those initial/continuation and promotion re-quote paths, `AcquisitionTermsError` reasons `acquisition_terms_policy_unconfigured`, `acquisition_terms_invalid`, `acquisition_terms_ambiguous` and `acquisition_terms_not_effective` retain `UPSTREAM_UNAVAILABLE` (HTTP 503), but now return "Acquisition terms unavailable" and `{ reason: error.reason, refreshRequired: false }` instead of the base's "Checkout failed" and initial-quote orchestration/preview or promotion re-quote stage details described above. Newly supported acquisition-terms-change re-quotes use the same acquisition mapping (donor N1).
Migration: An offer-version or minimum-units ask requires a server offer-policy binding. Without a resolver, reference admission retains its host minimum and original validation refusal before persistence. A composed resolver binds or refuses before any quote, order-draft or runtime write; identity persistence retains its existing earlier ordering. Accepted evidence is bounded and the bound version follows authoritative, steady and replacement quotes (N2).
Migration: An owned saved acquisition quote may continue before re-quoting only when subject context, basket, total, terms, contact, invoice, delivery and starter state match exactly; edits and failed/incomplete lookups take normal quoting (N3).
Migration: Scoped inventory admission contention returns retryable unavailability without provider dispatch or compensation capability; retry identities are unchanged (N4). Raw database error classification remains an adapter responsibility.
Migration: Starter admission accepts injected terms and a supplied graduation constraint, includes the 21-day graduation cadence, compares acquisition revision and rate, and freezes the selected second-delivery discount with steady quote policy/version (N5). Reference starter defaults remain host inputs. End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: The best-effort account-link helper accepts an optional trigger for its existing timeout log; without a trigger its log and timeout behavior are unchanged (N8).
Migration: Saved-method alias and recurring-mode metadata are host-defined string generics throughout the checkout resolver, handler, orchestration, command and runtime APIs. Reference bindings retain their existing provider unions, wire values and execution behavior.
Migration: The offer-evidence JSON-length limit is internal; consumers use the exported evidence schema.
Migration: The reference browser quote context now admits optional shipping and resolved acquisition terms through their existing validators, preserving strictness and existing fields (donor D3; K1-scope port carried by K2). `pricing/browser` re-exports the identical schema objects without new validation logic.
Migration: `outbox.commerceOrderDraftCreatedEventSchema` now accepts the 21-day starter cadence at `payload.quoteSnapshot.quote.context.starterPack.graduation.cadenceDays`, `payload.orderDraftSnapshot.context.starterPack.graduation.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `outbox.commerceOrderDraftCreatedOutboxRecordSchema` now accepts the 21-day starter cadence at `payload.quoteSnapshot.quote.context.starterPack.graduation.cadenceDays`, `payload.orderDraftSnapshot.context.starterPack.graduation.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `outbox.commerceOrderDraftCreatedPayloadSchema` now accepts the 21-day starter cadence at `quoteSnapshot.quote.context.starterPack.graduation.cadenceDays`, `orderDraftSnapshot.context.starterPack.graduation.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `checkout.checkoutRequestSchema` now accepts the 21-day starter cadence at `intent.starterOffer.steady.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `checkout.checkoutResponseSchema` now accepts the 21-day starter cadence at `authoritativeQuote.quote.context.starterPack.graduation.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `contracts.commerceQuoteSchema` now accepts the 21-day starter cadence at `context.starterPack.graduation.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `contracts.createOrderDraftRequestSchema` now accepts the 21-day starter cadence at `quoteSnapshot.quote.context.starterPack.graduation.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `contracts.createOrderDraftResponseSchema` now accepts the 21-day starter cadence at `orderDraft.quoteSnapshot.quote.context.starterPack.graduation.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `contracts.createQuoteBatchResponseSchema` now accepts the 21-day starter cadence at `quotes.0.context.starterPack.graduation.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `contracts.createQuoteResponseSchema` now accepts the 21-day starter cadence at `quote.context.starterPack.graduation.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `contracts.orderDraftSummarySchema` now accepts the 21-day starter cadence at `quoteSnapshot.quote.context.starterPack.graduation.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `contracts.publicCreateQuoteBatchResponseSchema` now accepts the 21-day starter cadence at `quotes.0.context.starterPack.graduation.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `contracts.publicCreateQuoteResponseSchema` now accepts the 21-day starter cadence at `quote.context.starterPack.graduation.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `contracts.quoteContextSchema` now accepts the 21-day starter cadence at `starterPack.graduation.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `contracts.starterPackPlanSchema` now accepts the 21-day starter cadence at `graduation.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `intent.configuratorIntentSchema` now accepts the 21-day starter cadence at `starterOffer.steady.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: `persistence.configuratorIntentPersistenceRequestSchema` now accepts the 21-day starter cadence at `starterOffer.steady.cadenceDays`; invalid-cadence issue alternatives change from `[14, 28]` to `[14, 21, 28]` in that order (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).
Migration: The reference subscription starter-marker reader now also accepts the 21-day graduation cadence, matching the checkout starter plan; 30 days remains refused (donor N5). End-to-end managed checkout with this cadence requires the managed forwards to land (L1).

- Move generic draft/finalize/intent/resume stores, cancellation and sweep adapters, bounded recovery classifiers and token helpers into `commerce/server`. Reference factories inject existing schemas, ordered arguments, response projections and phone normalization; verified subject stamping remains last. Recovery projection/routes stay reference-owned; the C2 release handoff is to be released.
Migration: Runtime-finalize `acquisition_terms_changed` now retains its scoped conflict reason; database-triggered safe pre-dispatch draft compensation and repricing become reachable once the managed forwards land (L1) (N1).
Migration: Draft catalog-head-moved, missing-anchor and offer-membership refusals now map to catalog-admission conflicts without superseding a draft (N1).
Migration: Expired subscription recovery permits an absent host subject only with the exact persisted neutral-command marker and all other eligibility fences; public runtime schemas gain no marker bypass (N6).
Migration: Recovery commercial fingerprints now include shipping terms version, currency, flat charge and threshold; same-money policy drift refuses recreation (N6).
Migration: The token-state classifier permits continuation only for active/order-not-recoverable, separates expired-policy handling and refuses revoked/used/missing/unknown states. Retained routes are not rewired by this addition (N7).
Migration: `StarterDeclaration` stays internal to the checkout engine; derive a declaration type from the `createStarterOfferGuard` binding signature instead of importing a standalone type from `commerce/server`.

- Add the unchanged physical-table offer-availability projection at `commerce/server` over a structural client and explicit provider predicate, and the pure status/reason ladder at browser-safe `commerce`. Reference adapters retain SDK/provider policy and delegate to the one package implementation; M06 retains normalized stock reads and reservation TTL ownership. No preview ATP switch or second allocator.
Migration: The reference reservation binding now maps protected inventory `55P03` failures to scoped `inventory_admission_busy`/`inventory_lock_unavailable` details, refuses schema fallback under contention and preserves the original retry keys (N4). Checkout exposes the existing retryable refusal before dispatch; no compensation capability is fabricated.
- Give structural draft, resume, intent and compensation factories neutral RPC/query names. Reference bindings retain their incumbent exported names and behavior.

- Add experimental neutral OMS schema cores, browser-safe DTOs and ports, generic handler factories, read builders and managed adapters through the existing commerce entries. Reference wrappers bind identity, settlement, fiscal fields, governance and provider projections. No versions, SQL, migrations or pack caps change.
Migration: Host integrations supply `respond`, `authorizeAdmin` and optional read-gate/schema bindings. Mutation request parsing and response envelopes use the donor shared helpers; invalid results remain 502, nominal conflicts 409 and upstream throws 503 with their existing messages.
Migration: Managed clients are structural and RPC-only; query hydration and idempotent note persistence require a separately injected query capability. Manual refund marking calls only the operator-mark RPC and creates no refund.
Migration: Neutral read contracts omit private identity and first-cycle presentation, use open provider/accounting status strings, a neutral fiscal field and neutral provider counter. Hosts extend the schema and pass projections through final validation to preserve their existing response fields and acceptance.
Migration: The reference replacement facade now delegates to the existing fulfillment handler instead of its local handler engine. For managed results, request parsing, success bodies (including defaulted released hold IDs), replay receipts, metadata, idempotency keys, RPC arguments, receiver identity, named 409 refusals and ordinary 400/401/403/405/502/503 responses are unchanged. The fulfillment handler additionally recognizes the native-unsupported sentinel and returns its specific 503; the old local handler would classify that sentinel as an invalid 502 response. The managed adapter does not emit this sentinel. Neither path creates a refund or confirms delivery alignment.
Migration: Default neutral settlement validation checks a three-letter currency and labels empty totals with `XXX`; hosts inject their actual acceptance/default policy. Delivery summaries and labels use neutral defaults until the host supplies its projections.
Migration: Browser-safe `./commerce` exports schemas and pure helpers; handlers, managed RPC/query adapters and detail composition now import from the Node-only `./commerce/server` entry. `./commerce/contracts` remains type-only.
Migration: Unprojected OMS timeline labels now use canonical step keys (for example `delivered`) instead of the reference locale labels. Unknown tokens retain `Delivery status updated`; reference presentation remains behind the existing `timelineLabel` projection. Managed query clients must implement the required `is(column, value)` filter for hydration; class query receivers are preserved by the adapter factory.
Migration: Omitted fulfillment debug now defaults to `No fulfillment data.` in neutral detail schemas. The reference schema binding retains its previous localized summary and serialized field order.
Migration: Commerce no longer re-exports the core locale label helper `timelineLabelForStep` or the label-bearing `FULFILLMENT_STATUS_MAP`. Presentation consumers import these from their core owner or host binding; commerce retains pure canonical step and recovery helpers.
Migration: OMS binds K1 order-money and paid-event exports directly. The concrete OMS payment type is `OmsOrderPaymentStatus`, using K1's unchanged generic `OmsPaymentStatus<PaymentIntentStatus>`. Fulfillment recovery DTOs are commerce-owned alongside their pure recovery helpers.
Migration: Regenerated `commerce.api.md`, `commerce-contracts.api.md`, `commerce-server.api.md`, `communications.api.md`, `fulfillment.api.md` and `identity.api.md` reflect this final declaration graph. Beyond the commerce additions described above, existing declarations change order only: newsletter event `ignored`, fulfillment status members and identity lifecycle-stage members move within their existing declarations. Before and after member sets and types are identical; consumers need no code or SQL migration for this ordering.
- @openlup/platform size growth: Neutral OMS read model, handlers, managed adapters and contracts moved into `@openlup/platform/commerce` and the new Node-only `./commerce/server` entry, together with the rest of the M11 commerce stack; K1+K3a measured 1,562,728 packed bytes; adding K3b, K4, K2 (K2a x1.4) and F3 projects 1,749,300 packed bytes; caps raised once with 10% headroom to 1,925,000 packed bytes, 1,648,000 code-gzip bytes, 8,970,000 unpacked bytes, 2,520 code files and 2,580 total files (K3a PR #370, cap-raise commit 5e42e9ec).

- Add experimental returns, native order review/media and separate hosted-feedback contracts at `@openlup/platform/commerce`, with handlers and adapters at `@openlup/platform/commerce/server`. Reference paths remain thin facades; no route, SQL, activation or release is added.
- Migration: Import returns and native order-review/media handlers and adapters from `@openlup/platform/commerce/server`; schemas and port declarations remain at `@openlup/platform/commerce`. Standalone returns handlers require an injected `BffResponder`; reference handler signatures and observed response context are preserved by their facades. Raw upload HTTP types now use the equivalent package HTTP shapes.
- Migration: Hosted-feedback schemas and RPC-name constants are available from `@openlup/platform/commerce`; Supabase submit/token-check factories are at `@openlup/platform/commerce/server`. Adopters must supply `submit_order_feedback` and `check_order_feedback_token`; native `db/platform` has neither RPC. Hosted feedback remains distinct from native order reviews.
- Returns scope (F9): only request, approve and reject exist. `restockDisposition`, `refundMode` and `refundAmountCents` record intent; receive, restock and refund execution were never implemented. Request owner/key/fingerprint enforcement stays in the database; the contributed TypeScript RPC arguments are unchanged.
- Native handler donor-ahead command-runner contribution is observably identical to the prior inline handlers: the 96 pre-move result pins pass, including admin error mapping and exact `replayed` presence. No behavior migration arises from this command-runner contribution.
- HOST-OWNED class (b) retention: review delay is SQL-only, 14 days native and 21 days in the contributed managed profile. No TypeScript delay seam or SQL change is included.
- Media retains its existing private storage/upload seams. M02 blob storage lacks private read, inspection, temporary write and promotion operations, so a behavior-changing bridge is not included.
- Migration: The package default returns reason set is neutral. Use `createCommerceReturnsSchemas(reasonCodes)` and the customer handler's `requestSchema` dependency for host policy; the reference keeps the legacy set with BASE-identical parsed output, refusal details and responses. Return request/approve/reject RPC behavior is unchanged.
- Migration: Reference browser review and hosted-feedback facades restore jitless Zod initialization before package schema construction. This restores BASE/donor CSP behavior without adding global configuration to the package modules.
- Migration: `runOrderReviewCommand` is internal to the package. Import the customer/admin handler factories from the commerce/server entry; the reference customer-handler facade keeps its BASE factory export.
- Migration: Handlers, adapters and raw upload use the existing `@openlup/platform/commerce/server` entry. The `./commerce` runtime graph is browser-safe; `./commerce/contracts` stays type-only. Reference import paths and observed behavior are unchanged.

- Add experimental Node-only commerce domain-effect consumers at `@openlup/platform/commerce/server`; browser-safe event contracts, projections and ports stay at `@openlup/platform/commerce`. No new executor, emitter or dispatcher.
- Record omitted adopter-private W8/W9 assertions and their owners in the [reference commerce guide](../../src/domains/commerce/README.md#w8w9-conformance-dropped-adopter-private-assertions).
- Migration: Import handler factories, registry composition and `CommerceEmailRuntime` from `@openlup/platform/commerce/server`. The browser entry never imports the server entry or M08 runtime.
- Migration: Reference email handlers and the dispatch registry bind a single neutral implementation. Package ports use `contextName` and `messageId`; reference adapters retain their existing extension/provider fields and public send behavior.
- Migration: `uniqueRegistry` is injected from the existing outbox rail, with no new package dependency. `CommerceEmailRuntime` requires explicit communications parser, transactional scaffold, outcome mapping, locale, money, line-label, paid-presentation, tracking and notification-policy bindings. Reference locale, formatting, provider outcomes and legacy tracking URLs remain unchanged.
- Migration: Refund notices display amounts only with `refundEvidenceVersion: "provider-refund.v2"`; historical order totals and unversioned refund amounts no longer appear as refund evidence (donor-ahead).
- Migration: The frozen refund consumer subset ignores legacy `totalCents` and admits optional string `refundEvidenceVersion`; supplied refund amounts and currencies retain their existing validation.
- Migration: Paid-receipt presentation forwards its proved discount percentage, including non-default percentages (donor-ahead); commercial eligibility stays with the host.
- Migration: Core handler descriptors and expected-descriptor validation are available before claiming. Claim order, flags, independent paid-email/fulfillment duties, same-event timeout composition and risk gating retain donor behavior.
- Migration: Channel-owned buyer communication settles as processed with `skipped: "channel_owns_buyer_comms"`, using a live policy read per event. Cancellation email remains unregistered; its fact can be consumed through adopter `extraHandlers`.
- Migration: Producer event-type literals and payload schema behavior remain unchanged; the draft-event factory accepts exact host snapshot schemas. The neutral source projection preserves external-reference bytes and case, with no inventory SQL or exposure default.
- Migration: Reference email payload parsing binds the existing fulfillment `parseOutboxPayload` export; its schema issues and bounded discard reason are unchanged. K1 owns all producer schemas through `createCommerceOutboxEventSchemas`; all nine golden parse/refusal cases pass unchanged.
- Migration: Paid-fulfillment registration re-exports the existing fulfillment descriptor, preserving its identity, event literal and timeout instead of maintaining a second descriptor.

- Add an experimental structural commerce contribution at the existing composition entry, with explicit installed commerce exports, namespaced ports and existing handler, route and schedule descriptors. Duplicate registrations refuse before maps can overwrite an executor.
- Add an inert, default-off reference commerce binding over existing package callables and the existing native checkout-recovery adapter. Only ready schema observations admit work; unknown and unsatisfied candidates leave the serving selection intact. Native recovery records reminder intents, authorizes their delivery and compacts terminal outbox rows; managed-only expiry and recreation remain separate.
- K5 adds no refactor: the event-contract gap and server entry scaffold are already resolved in the preceding imports. Existing commerce witnesses and engines remain unchanged; no SQL, timer, route activation or second executor is introduced.
Migration: `@openlup/platform/composition` additively exports `createCommerceContribution`. Supply the selected callables, complete required schema and existing descriptors; the factory declares them without installation or execution. Existing imports and default compositions need no change.

- Managed commerce migrations preserve the exact reviewed fixture bytes and ordered prerequisite chain.
Migration: Guest configurator destinations do not rewrite saved delivery or payment preferences; preference writes require a server-proved matching account.
Migration: Legacy omitted-country fallback uses `platform_region_code()` for address identity and insertion; configure the adopter's settlement region. Neutral commands require explicit country.
Migration: Return creation and replay require the server-supplied principal's owned order and identical normalized command; foreign or changed commands refuse atomically.
Migration: Checkout payment-link receipts use the service-only operator entry point and the `checkout_payment_link_mint` audit action.
Migration: Subscription finalize validates retained acquisition terms under the shared policy lock; policy writers require its exclusive counterpart. Completed finalize replay preserves its response after policy changes; one-time checkout is exempt.
Migration: The acquisition terms reader refuses absent effective terms; the no-policy finalize compatibility branch remains available.
Migration: New-purchase stock reads use ATP with renewal exemption fixed false, bounded SKU arrays and conservative stale reporting. The service-only reader uses owner privileges with `SECURITY DEFINER` and `search_path = pg_catalog, pg_temp`.
Migration: Starter graduation admits 14, 21 or 28 days, while provisional creation uses the retained starter interval and subscription timezone default. Rolling back below the forward with a 21-day marker is unsupported; roll forward.
## [0.26.0]

- Publishable on the npm `latest` dist-tag as `0.26.0`, from tag
  `openlup-platform-v0.26.0`.

Managed dunning attempt replay.

Carry the exact applied failure attempt through renewal propagation. Managed
same/stale observations replay the canonical result; newer attributed failures
advance and revoke prior recovery authority, including used tokens.

Migration: `CycleChargeFailurePropagationPort.openDunningCase` now requires nullable `failedPaymentAttemptId`; update host implementations and callers to pass the applied transition's identity.
Migration: `applyFailedResult` may return `paymentAttemptId?: string | null`; return the durable applied attempt so propagation can forward it, including on replay.
Migration: managed hosts must pass exact applied-transition attribution to the new overloads. Fresh missing attribution refuses with SQLSTATE `55000`; do not substitute the current or prepared attempt. Already-applied donor schema/backfill requires the explicit host mapping in DATA_AND_MIGRATIONS.

Native attempt-replay parity remains REGISTERED with M10; these managed forwards
do not implement native parity or authorize host activation.
## [0.25.0]

- Publishable on the npm `latest` dist-tag as `0.25.0`, from tag
  `openlup-platform-v0.25.0`.

- Re-pin the pending M10/F17 control fixtures after landed M08/M09 without
changing either installation rail, the migration manifest or landed N1. The
16-entry packet has seven native and nine managed pins. Native X restores
ATP-counted late-positive stock recovery; Y filters paid retry candidates
before LIMIT. Fold command-preview receipt replay into uninstalled N2, keeping
apply unchanged. Preserve the historical 14-pin approval reader and exact
prefix, definition, statement, ACL and catalog controls. Real PostgreSQL
witnesses cover ATP, starvation, all 43 fresh command scenarios and raw preview
replay with no counts/columns/xmin delta.

No package SQL asset, export, runtime activation or external CI dependency is
introduced. The development-preview boundary remains.

- Fix uninstalled N3 normal_due pagination to exclude waiting/stock_secured cases before LIMIT, preventing normal-renewal starvation.

- Repair uninstalled N2 donor no-op truth for native bundle/resize, plan, package, add-on and same-UTC-day slide commands before repricing: preserve locked prices after catalogue changes, writing only the command receipt, with no quote, event or version increment. Native resize compares lines/cadence; portion mode/factor remain host-owned without native storage. Predicate-removal mutants cover every mapped donor action; apply stays unchanged.

- Audit pending M10 donor change and no-op semantics together. N2 plan edits
apply requested core lines; new add-ons normalize quantity, preserve cadence
and compare UUIDs by value. N3 preserves paused waits, filters eligible recovery
before LIMIT, binds frozen reads to the current active schedule, reports free
stock separately from own holds, and ignores closed/unpaid realization notices.
Real PostgreSQL tables cover applied state, no-op/refusal/replay and rolled-back
assignment mutants. Installed rails and N2 apply remain unchanged; channel
exposure/admission parity stays outside the frozen stock-seam claim.

- Close the 0.24.0 known limitation that managed dunning exhaustion still pauses active subscriptions.
- Land the reviewed managed M1/M2 prefix: refunds preserve subscription lifecycle and paid history; exhausted dunning stays open with NULL retry and active service until authorized same-cycle repair.
- Folded scope E-gate-replay-loop-landed-untested: retain the existing interleaving-aware catalog replay and add the Docker-free landed N1/M1/M2 witness.
- Folded scope D-earlier-pin-digest-unplanted: prove CI and release refuse changed earlier M1 bytes beneath landed M2.

Migration notes: Apply M1 then M2. Existing paused, expired and refund-cancelled history is not rewritten or reactivated. The existing first-cycle refund stock-release guard remains; later refund-evidence parity and stock-wait/winback changes are separate. No runner is activated.

- Add native N2 command preview/apply stores and a P1 command adapter with atomic future terms, actor/key/actual-command receipts and applied/replayed/noop/refused outcomes; preserve frozen current obligations and existing native callers.
- Type-level flip for dev-preview consumers: `NATIVE_SUBSCRIPTION_CAPABILITIES.genericBundleCommands.supported` and `.commandBoundReceipts.supported` change from `false` to `true`; command results now include `SubscriptionCommandRefusal`.

Migration: install N1 then N2 through the complete native manifest; preserve receipts on rollback. Accepted future prices use lock_until_edit, proration none. Address mutation and private introductory/graduation policy stay host-owned; native activation continues to require captured payment evidence.

Migration (C73, temporary limitation): managed `subscription_create_provisional_for_checkout` stamps an explicit timezone literal equal to today's `subscriptions.timezone` column DEFAULT. Adopters changing that DEFAULT must also replace the function until the scheduled follow-up forward follows the DEFAULT; no managed SQL changes here.

Migration: `SubscriptionCommandPort.apply()` may now return `SubscriptionCommandRefusal` (`outcome: "refused"`), so callers must handle it.

- Type-level change visible to dev-preview consumers: `RenewalPaymentRail.execute` adds an optional `failure` field for explicit failure evidence.
- A host or driver skips `openCase` after a replayed `applyFailure` receipt only when that rung's case propagation already committed; otherwise recovery must complete propagation. The P8 retry driver must add a replay/case-advanced signal and a zero-delta witness for replay after committed propagation.
- N2 preview follows the supplied core lines for plan-length changes (omitted lines retain stored expansion); new add-ons normalize missing/nonpositive quantity to one, add-on actions preserve cadence, and quantity updates/removals compare variant UUIDs case-insensitively.

Land the seven reviewed managed stock-wait/ATP and F17 refund-parity forwards.
Managed hosts can use the service-role SQL functions and pgTAP witnesses; the
package declares the SQL surface and keeps TypeScript stock recovery unavailable
because no managed adapter implements the stock-wait/availability ports.

Migration: apply the complete managed prefix through `20261024185100` before
calling stock-wait or refund-evidence functions. M4 extends M2's active/open
continuity with wait exclusion before LIMIT. M5 makes positive customer
cancellations immediately winback-eligible within 120 days, retaining episode
dedupe, and maps started/resumed notices. F17 accepts cumulative provider snapshots,
emits one refunded event on transition, and preserves M1 refund/lifecycle
independence. Keep captured obligations and receipts on rollback and disable the
host stock-wait driver first. SQL installs no scheduler or payment executor.

ATP protects active upcoming demand within 14 days plus live provider hard holds.
The exposure hook remains zero; current donor channel admission is deferred.
This is a development-preview SQL surface, not a composed managed TypeScript port
or a claim of advance future-cycle reservations or stable installation support.

Native stock-wait persistence, frozen discovery and stock-only refusal recovery
now have transaction-bound adapters. The native ATP/new-purchase read protects
hard holds and fixed 14-day soft subscription demand; the renewal allocator uses
the same seam. X restores late-paid released stock once, and Y filters paid and
settled retry obligations before LIMIT. Managed stock wait and runner composition
remain separate; native selection still requires passing real-PostgreSQL proof.

Migration: install the native N3, ATP seam, allocator, X and Y prefix in filename
order, with their package twins and regenerated selected-catalog-v2 inventory.
Migration: upgrading hosts must grant their native inventory-reserving runtime
role EXECUTE on public.inventory_available_to_promise(text,text,timestamptz,boolean)
and public.inventory_channel_exposure_quantity(text,text), plus SELECT on the
seam's underlying relations as listed in Data and migrations, before using the
updated allocator or N3 stock-wait paths.
`StockWaitStorePort.listCandidates` now returns `StockWaitFrozenCase[]`: discovery
may have no durable case yet. Hosts must retain its frozen snapshot and binding.
Frozen discovery requires the active current schedule; paused current waits remain open.
Deficits separate own reserved units from free ATP and subtract both for missing
units. Closed or pending-payment resume callbacks return null without writes; paid
fulfillment-pending orders can complete realization admission.
No advance reservation, physical coverage guarantee or one-time checkout writer
is introduced. No pause, payment execution or parcel-arrival fact is added.
Uncaptured stock refusals rotate on the operation selection timestamp even when
missing or stale stock prevents case creation, allowing replenished work through
a bounded candidate page.

M10 P6 + P8: composed subscriptions (development preview)

Migration: Additive `./subscriptions` facades are `createSubscriptionServices`, `createSubscriptionCommandExamples`, `createSubscriptionLifecycleMessages` and `subscriptionLifecycleTemplate`; hosts explicitly supply readiness, execution, commands and M04 delivery. No factory activates serving work. `SubscriptionLifecycleFact` is exported from this entry; `subscriptionLifecycleTemplate(kind, retryAttempt?)` preserves the installed payment-failure rungs (1, 2, otherwise 3). `runRenewalBatchRows` exposes the existing per-row error-result isolation for composed hosts.
Migration: Additive `./composition` entry `createSubscriptionContribution` describes exactly one selected subscription schedule; off supplies none. Hosts bind its callable to their existing population lease and observe the complete installed schema.
Migration: `createPostgresRetryStore` adds `failureProgress(operationId,key)`, returning receipt replay and committed case progression. The native retry driver completes interrupted propagation and skips already advanced cases; existing applyFailure/openCase signatures remain unchanged.

The inert native reference binding composes mandatory G23, dunning and stock wait.
Captured alignment cases retain authority under off. Prepared attempts reconcile
without re-execution; ordinary retries bind the frozen mandate and logical cycle.
M04 owns delivery; M12 owns aggregation. No SQL asset, serving swap, release or
managed TypeScript recovery is introduced. Native multi-cycle prepaid and M07
prepared-attempt-store capabilities retain their named unsupported boundaries.
## [0.24.0]

- Publishable on the npm `latest` dist-tag as `0.24.0`, from tag
  `openlup-platform-v0.24.0`.

- Require Zod `^4.6.6` to fix GHSA-mrhx-c7xc-m3w5; oversized constrained
  request collections fail before element validation accumulates errors.
- Preserve the observation adapter's accepted minute-precision occurrence timestamps and raw
  idempotency-key bytes with the updated validator; impossible dates still fail.

- Add the optional `runFulfillmentDispatchWorker.shadowCommandFingerprint` callback for a pure, local adopter command hash in shadow mode. Without it, shadow evidence still hashes the same `JSON.stringify(request)` bytes with SHA-256. The callback must return a lowercase 64-hex SHA-256 digest of the adopter's canonical command bytes, never command contents, credentials or contact data. The package accepts only strings matching `/^[a-f0-9]{64}$/`; invalid output or a throw returns a typed refusal with closed cause `adopter_fingerprint_invalid` or `adopter_fingerprint_failed`, without raw output, exception text or claim/attempt/evidence writes. Stage/live never invoke the callback. The fingerprint is used across shadow claim/readback/attempt, including mapped-attempt replay; shadow never begins, and live preparation must produce the same identity; shadow still performs no provider preparation, credentials lookup or POST.
- Preserve optional boolean `submissionAttempted` and `responseBodyRead` facts on typed dispatch errors and finalize evidence. `submissionAttempted: false` proves no provider submission was attempted; absence is unknown. `responseBodyRead: true` means the response body was read, including empty or malformed JSON; `false` means reading failed, and absence means there is no body-read evidence. Credential/request-construction failures include explicit non-submission proof; command validation/rebuild retains its closed `not_dispatchable` refusal. No raw body, exception prose or credentials enter these facts; durable projections admit only actual booleans.

Migration: existing callers need no changes. `shadowDispatchEvidence(request)` becomes `shadowDispatchEvidence(request, commandFingerprint?)`; omitting the new optional argument keeps the same evidence bytes and hash. These facts allow adopter classification without inferring uncertainty from retryability. Package classification remains unchanged: definitive rejections (including an unreadable HTTP 400 body) are `not_dispatched`; ambiguous submission and unreadable successful acknowledgements are `unknown`. No release, default binding, route, schedule or activation is added.

- Add inert native unsupported invoicing ports and runner-independent offline adapter conformance for exact recovery, parent identity, scoped absence, declared host capabilities and safe evidence.
- Document the invoicing design and host boundaries without installing workers, stores, fiscal providers, routes or activation.

- Extract invoice issue sequencing, snapshot/canonical line verification, unchanged allocation, payment evidence and handoff helpers into the existing invoicing entry; retain host payloads, keys, seller/tax policy and routing.
- Migration: compatibility callbacks preserve existing RPC/provider request bytes, issue fences and handoff descriptors. No native store, D7/O2 behavior, default provider, executor registration or activation is added.

- Add correction and reversal workers to the experimental invoicing entry, preserving durable correction identity, recovery, host event/key semantics and fenced outcomes. The reference host requires an explicit conforming correction bridge; its legacy vendor copy stays unchanged and unselected.
- Migration: introduce the two pinned managed v2/compatibility forwards with versioned adapter and pgTAP callers. Unkeyed attempted legacy corrections remain visibly unresolved for provider reconciliation. Preview correction references use correctionRef. Native forwards and runtime activation remain separate.
- See the [M09 forward owner](../../docs/platform/DATA_AND_MIGRATIONS.md#m09-invoicing-forward-design-and-control-approval) for sync-first settlement and permanent-failure parking.
- Registered limit: multi-reason / late-issue compensation can yield more than one full correction per invoice, as the incumbent does today.

- Add an experimental structural-executor native invoice store, a create/readback issue binding, separate native/managed migration descriptors, and six byte-identical sparse SQL assets. Read-only bounded discovery exposes duty/order IDs before facts are installed. Missing host fiscal facts refuse before writes; local-only document construction retains its previous behavior. Native fresh non-ready preflights settle before dispatch; stale preflight/finalizer results write no failure.
- Migration: append the three reviewed native duty/effect/payment forwards at positions 77–79 after the unchanged 160000/165000 prefix. Install the complete catalogue. Native child-document and managed base-row corrections have distinct descriptors. Seller revision and activation remain separate.

### Independent native invoicing duties

Experimental invoicing adds `collectInvoiceDuties` and
`createIndependentInvoiceDutyBinding` for explicitly invoked, separately committed
duty collection. Native fulfillment no longer waits for accounting readiness or
invoice requests. Managed dispatch behavior stays unchanged.

Install the full native catalogue, including 190000/191000 before the exact
reviewed 192000 payment-decoupling forward. Captured settlement and dunning
recovery survive invoice capture failure; retained paid/handoff facts support
later repair. New unlinked payment events retain `accountingRequested=false`,
including after independent issue; historical linked events retain their readback.
Use owed-duty readback for invoice progress. No payment
export, provider activation, scheduler registration or fiscal default is added.

- Extract invoice delivery, PDF validation, accepted-document synchronization, payout item recording and document-history/read helpers into the existing invoicing entry; bind the reference host facades through explicit callbacks.
- Migration: F8 retains A2 payout transport and exact settlement keys; the legacy batch/payment importer preserves donor calls and aggregate results, while package receipt reuse across item scopes is an identity conflict with continued processing and no extra write; distinct recorded receipts require an item-capable host recorder/resolver. F11 retains M04 content, recipient, locale, transport and uncertainty. F9 bounds reference consumers; F12 leaves runbooks and customer correction intent host-owned. Native delivery uses an optional host envelope projection over P4’s store; job store mode binds fenced terminal/backoff outcomes (whole seconds clamp 60..86400, absent/invalid 900, retryable:false parks); callback mode requires terminalFailure before claim; native history requires a safe owned projection. PDF downloads now refuse invalid bytes; the reference panel displays closed diagnostic codes without free-text provider errors. No SQL, activation, executor or fiscal-policy change.

Explicit invoicing composition and first-claim seller revision

PART A: `createInvoiceServices`, `InvoiceServices` and `createInvoiceContribution`
use the existing `/invoicing` entry. Host selection is default-off; readiness
precedes factories and claim. Native helpers compose the real P4/P5 store,
collection, delivery, sync and read-model implementations. Host-specific factories
retain auth, configuration, transport/query projection and the existing executor,
registry and lease. Targeted module runs refuse before leasing.

PART B — Migration: native 195000 and managed 195100 are forward-only,
byte-identical introductions of the approved CTL-M09-4 fixtures. Eligible
obligations freeze the seller at their first-ever durable claim, independently
for corrections; retries retain it. Previously claimed legacy obligations keep
execution-time fallback. Issued documents and installed buyer/line facts are
unchanged. Native reversals use the correction request branch; managed order
reversals preserve incumbent results through the seller request wrapper.
Unknown/unsupported seller reads and order-scoped managed corrections refuse
before claim. SQL replay conflicts surface as typed identity conflicts.

### Selection and installation boundary

Invoicing remains EXPERIMENTAL and DEFAULT-OFF. The issue/correction/reversal,
durable duty collection, native store, delivery/document/payout sync, safe history
and first-claim seller revision helpers are available for explicit host composition.
Select a provider and capability, bind host ports and establish readiness before
factories or claim; the structural contribution registers nothing itself. Fiscal
policy, ownership/authentication, M04 transport, artifact/history projections,
execution leases and route/job registration remain host responsibilities. No live
provider, fiscal acceptance or inbox-delivery evidence is established. Adopters
must not activate unselected or unready invoicing, or infer activation from SQL.

M10 subscription renewal/retry stages remain EXPERIMENTAL, INCOMPLETE and
DEFAULT-OFF, not for adopter activation: contracts, native stores/executor and
N1 SQL are present, but runner activation and the G23/N1 host composition,
correlation, authorization and replay obligations remain pending. Native delivery
alignment must remain off or shadow until the host composes the renewal runner
with its G23 admission decorator.

Migration: upgrade core, outbox and platform together from `0.23.0` to `0.24.0`
for exact internal peers. Install the complete canonical native migration chain
through position 80 (`20261022195000_invoicing_seller_revision.sql`), including
invoicing positions 77/78/79 (`190000`/`191000`/`192000`); P5 adds no SQL and P7
adds position 80. Sparse package projections are not an installation chain.
Managed installations use their own ordered forwards, including correction
`193000`/`193100` and seller `195100`; managed descriptor paths are catalogue
references, not files installed by the npm tarball. Preserve first-claim seller
snapshots and legacy fallback; there is no retroactive backfill or reversal of
forward SQL on application rollback. Retain the `0.23.0` shadow/observation retry
and legacy stock-fingerprint migration precautions when upgrading older rows.

### Limits closed by this set

- The earlier invoicing contract-only/no-SQL/no-worker surface limit is closed:
  P1b–P7 introduce explicit services, native store and helpers, with CTL-M09-1–4
  reviewed forwards at native positions 77–80 and the managed correction/seller
  forwards; see the [design boundary](../../docs/platform/plans/oss-m09-invoicing.md#p7-composition-and-seller-revision).
  Default activation and live fiscal/provider acceptance remain unclaimed.
- M08 stock-evidence replay/reopen was already closed in `0.23.0` by position 76;
  this set does not close its legacy fingerprint conflict or other M08 gaps.

### Known limitations

- Managed dunning exhaustion still pauses active subscriptions; retaining active status needs a managed forward. Native N1 lands the bounded retry/failure repair, with the host obligations below still pending.
- D8-1: native advisory v2 promo-code candidates/rejection details unavailable.
- D8-2: native mounted v2 issue/honor/fallback unavailable.
- D8-3: native acquisition-only mounted issuance/honor unavailable.
- D8-4: full native/managed eligibility equivalence unavailable.
- Bundle-1: independent DB human-only actor-kind enforcement absent natively; first in the native-backend parity round.
- Bundle-2: managed-equivalent actor-kind/email history absent natively.
- Bundle-3 closes injected-reader M05 mounted admin/feed readback only. Native new-purchase stock read absent despite P5a installed-store proof; deferred second after bundle-1 (owner 2026-10-21); readiness refuses.
- Bundle-4: incumbent real-PostgreSQL contention only; no exactly-once guarantee.
- Managed schema/pgTAP retain `44.404`; removal needs owner decision/forward; reference composition supplies it to app code.
- A1 offline only; account/hosted-time/owner TEST evidence unclaimed; `communications/klaviyo` verification-pending.
- M05 omitted opt-ins preserve defaults/outputs/read order/schedules/refusals/acceptance-token bytes/SQL.
- Native inventory adjustment unavailable; address writes refuse readiness. Flat-rate save needs selected port/Core readiness/applied-seed observation.
- Native shipping audit unavailable; handler swallows best-effort audit failure.
- Native flat-rate integer bounds (0 through host maximum; reference 100,000 minor units) use request schema, not DB CHECK.
- Managed ATP/forecast/dated-supply/pagination readback unproved/pending M06.
- Managed two-session locks/concurrency/uncovered compensation unproved/pending M06.
- Managed exact-prefix upgrade/ledger unproved/pending M06.
- Managed address idempotency/conflict/readback unproved/pending M06.
- Managed successful flat-rate read/save unproved/pending host authority.
- M06 stock-wait lifecycle/durable timing/staging controls retain C5/C6; busy/try-gate, continuity/flag/TTL transfers are dispositions, not PASS.
- Shipping national-registry fields/locale-specific `canonicalAddressKey` fold await M16 host market pack/key migration; reference shipping copy stays locale-specific until M16.
- Native durable prepared storage, method setup, absence reopen and cumulative refunds unavailable; no production installation parity claimed.
- Typed refusal-envelope forwarding unavailable (`failureReason` only); reusable registration needs host ownership resolution.
- Incomplete chargebacks stay refunds/unapplied: reclassification bypasses evidence validation into dispute apply; limited operator recovery.
- Audit compatibility still detects `chargeId`; refund operation identity/original money supply no typed charge identity.
- M07 follow-up: repair poll can clear host redirect; post-timeout verify never restarts polling; unlocalized poller; fixture builds/never calls handler.
- M07 follow-up: reference status route wrong-rail witness.
- M07 follow-up: explicit reference-route refusal for unsupported method setup.
- M07 follow-up: deployment-neutral disabled-verify reason.
- M07 follow-up: reference card normalizer missing-amount path; package settling evidence already requires positive money.

- Native delivery alignment stays off or shadow until a host composes the native automatic-renewal runner with the G23 renewal admission decorator. The decorator alone neither composes nor activates the runner.
- The core fulfillment status map carries localized adopter labels; replace them with host-injected labels or internationalization keys at the host presentation boundary.
- The warehouse adapter example is opt-in and has offline conformance only; no provider-account proof or activation is established. Exact absence, label create/void and cancellation remain unsupported.
- After an alignment extension, a deferred renewal operation at the old schedule remains claimed with no reader or reservation effect. Changed terms snapshots conflict under the existing snapshot-conflict rules.

Native parity remains host-owned at these seams. Missing native bindings use the shared `FULFILLMENT_NATIVE_UNSUPPORTED` refusal; no partial write or parity claim is implied.

| Amendment | Host-owned seam and native boundary |
| --- | --- |
| G18 | Replacement creation and atomic eligibility/replay receipts; native replacement callback refuses. |
| G19 | Operator mutations, actor attribution and replay receipts; native mutation callbacks refuse. |
| G20 | Customer alignment rows; native reader refuses, while the pure delay projection remains callable. |
| G21 | Commerce list/detail and shipments overview; native read callbacks refuse. |
| G22 | Authoritative preparation edits, authorization and replay receipts; missing preparation binding refuses before dispatch, after disabled/selection/readiness checks. |

- M08 parity D2 KEEP-GAP: native dispatch finish still loses rejected/unknown error detail.
- M08 parity KEEP-GAP: immutable stock snapshot/alert evidence storage is absent; cursor JSON is overwritten. Hosts retain referenced evidence.
- Stock-evidence replay/reopen is CLOSED by native position 76; legacy `0.22.0` alert fingerprints still conflict with `23505`, including after resolution.

### Invoicing registered limitations

These are notes carried from the landed design, not fixes in this preparation.

- M07 `payment_truth_readback` still joins `accounting_documents`: operator
  ACCESS EXCLUSIVE DDL or denied ACL can block/refuse the call. New unlinked
  payment events remain `accountingRequested=false` after independent issue;
  use owed-duty readback for invoice progress (PR #334).
- Managed multi-reason and late-issue compensation can create more than one full
  correction per invoice. A later finalizer can be fenced `claim_inactive`, leaving
  its row `processing`; failed/pending rows on already-corrected parents may never
  be reclaimed. Reconcile provider identity/evidence, including unresolved attempted
  legacy corrections. Broader reversal/manual arbitration needs a separately
  designed replacement forward (PR #329, #330, #348).
- An in-flight issue can still compensate outside the seller wrapper with
  `legacy_fallback`; latest-parent reselection retains incumbent behavior.
  Managed keys are scoped to invoice/provider/reason, and delegated void stores
  no key; native cross-order reuse refuses. Pre-wrapper native reversal-key
  retries can conflict after wrapper evidence is added (PR #346, #348).
- Managed paid/handoff contention (`55P03`) is a visible retryable no-effect
  refusal with no automatic adapter retry. Fail-soft dispatch can finish without
  an invoice request; durable recreation can require operator recovery and delayed
  shipped-without-invoice monitoring (PR #348).
- A bad host fiscal revision can refuse an entire scoped/provider batch. A null
  payment `providerRef` falls back to the fiscal provider: hosts must supply explicit
  payment identity. A failing `store.fail` aborts remaining leased work; retain
  lease recovery and host retry handling (PR #334).
- Reversed-duty fact installation can still report owed: read authoritative
  reversal/duty evidence, never treat that answer as permission to issue.
  Unsupported reversal and parked document/request residues remain visible and
  unclaimable; later fact installation/reversal retry can change their diagnostics
  (PR #332, #334; design phase obligations).
- Native corrections ride the issue batch; a separate correction operation without
  a host factory refuses `host_binding_required`. Unknown native seller selection
  currently maps to non-retryable unsupported; hosts must handle recovery explicitly
  (PR #348).
- Delivery visibility must exceed transport timeout. Fenced settlement, database
  failure or lease expiry can abort a batch and leave unsent leased rows uncertain.
  Retryable/unsupported transport diagnostics may project as `retryable`; counters
  omit projection failures/parked mismatches, so inspect durable status/error
  evidence. Malformed projections and permanently invalid PDFs can retry without
  an attempt cap (PR #332, #344).
- Reused settlement-receipt detection continues within one call only; it does not
  detect another item's reuse in a later run. Legacy host aggregates expose item
  conflicts through count differences; distinct receipts require an item-capable
  recorder/resolver (PR #344).
- Hosts retain accepted-document observation polling and safe history composition.
  `resolveDownload` must bind the document to the authorized order; the package
  ticket check compares `documentRef`. Opaque-reference filtering covers its listed
  schemes only (PR #344).
- Closed diagnostic policy reduces managed message-only/non-allowlisted errors to
  `unknown`; an empty/non-string earlier `code` can hide a later closed code. The
  separate OMS projection retains redacted free text. Missing-order cleanup can
  log error rather than warn with the same refused/discarded outcome (PR #344, #348).
- PDF content-type normalization retains OpenLup behavior; signature checks are
  stricter than donor ASCII decoding. `invoicePdfFilename` falls back to English
  `invoice`; supply host captions (PR #344).
## [0.23.0]

- Publishable on the npm `latest` dist-tag as `0.23.0`, from tag
  `openlup-platform-v0.23.0`.

- Add `approveTrackingUrl` inputs to `verifyAndNormalizeFulfillmentObservation`,
  `PostgresFulfillmentShipmentSpineOptions`, `FulfillmentAdapterConformanceSubject`
  and reconciliation `trackingCodecs`. Under the strict default, provider tracking
  URLs persist only with host approval and must be query-free and credential-free
  HTTPS; host-built tracking URLs pass unchanged, including query strings.
- Existing `reconcileFulfillmentObservations` callers now receive row-local unknown
  readback failures (`ok: false` with `failures`) while recognized rows still
  process.
- Observation ingest (`verifyAndNormalizeFulfillmentObservation`, the native
  `recordObservation`, `reconcileFulfillmentObservations` and
  `runFulfillmentReconciliationPage`) now applies the durable-sink sanitizer: provider-derived
  references outside the opaque reference rule (for example `#1001` or
  `ORD/2026/1`) are stored as null or redacted and counted instead of verbatim,
  and `firstReceivedAt` must be an RFC 3339 timestamp with an offset; other
  values fail ingest or the reconciliation row. A correlation refused to null can
  be quarantined as `missing_correlation` in reconciliation.
- Fulfillment reconciliation inputs replace `readLocalFulfillmentState` with
  `readLocalFulfillmentStatus`, `latestStatusOccurredAt` and `readHandedOverAt`;
  migrate host persistence implementations to these three reads.
- Add exported page observation contracts and `runFulfillmentReconciliationPage`
  for host-owned scheduling, checkpoint resume and HTTP/ledger result projection;
  exact lookup remains separate. `providerCalls` counts logical page-port reads,
  including failures and exhaustion, separately from transport retries.
- Add redacted dispatch transcript/mapping fields, typed operation errors,
  acceptance recovery evidence and provider-status occurrence evidence. Existing
  unchanged stage/live dispatch identities retain their stored evidence for native replay.
- Migration: shadow drafts/attempts recorded by `0.22.0`'s native dispatch store
  do not replay after this change: shadow now hashes the local candidate rather
  than the provider-prepared command. Claim may consume a remap or raise
  `fulfillment_dispatch_remap_exhausted`; an existing attempt may raise
  `fulfillment_attempt_key_conflict`. Complete or abandon such drafts before
  upgrading. The `0.22.0` native dispatch store has no adopter; no compatibility
  transition is supplied.
- D2 KEEP-GAP: native `fulfillment_dispatch_finish` drops rejected/unknown error
  detail; durable retention is a scheduled SQL follow-up.

- Compatibility: `getStock()` and `getStockMovements()` now return a row union;
  consumers must discriminate rejections with
  `"kind" in row && row.kind === "rejected"` before reading observation fields.
  Provider read failures now return failed worker results (`ok: false`) with
  persisted `providerError` diagnostics when the provider supplies a typed failure,
  instead of throwing. Hosts can map those
  failures to HTTP 502; terminal cursor-write failures still reject.
  Cursor reads, running-cursor writes, local stock/class/reservation reads and
  stock/evidence writes or SKU evidence resolution now also resolve `ok: false`
  instead of rejecting when a terminal failed cursor can be persisted.
- `SyncCursor` adds optional `syncRunId`, `counts`, `items`, `alerts`, `staleSync`
  and `error`, worker results add `rejected`, `items`, `providerError` and `refusal`,
  and `fulfillment_stock_sync_cursors.error_code` now stores safe operation reasons
  (including `operation:SQLSTATE`) or typed provider/admission reasons instead of
  the generic `io_failure`.
- Mixed valid/rejected batches with valid stock rows succeed, retain rejection
  counts and diagnostics, evaluate/resolve alerts for valid SKUs and advance
  `lastStockSyncedAt`; an empty stock response is also valid, but a nonempty stock
  response with no valid stock rows is malformed and non-retryable even with valid
  movements, preserves prior coverage gaps and cannot resolve stale alerts.
  Typed disabled, not-ready and bad-identity refusals retain their original reason
  and retryability in the worker result and cursor.
  Blank stock SKU references are skipped before persistence; stale-sync recovery
  resolves after the terminal cursor, with cleanup failure preserving success.
  Stock and movement rejection diagnostics carry a `kind` discriminator.
  Stock-sync redirects are non-retryable, report `redirect_refused` and make only
  one GET attempt; exhausted stock network reads remain retryable through the stock
  failure projection. Product-sync retains the base client diagnostics and retry
  behavior, including `retryable: false` after exhausted network reads.
- Stock-sync alert fingerprints now contain only `requestKey`, `skuRef` and
  `thresholdKind`: changing quantities, severity or run evidence under the same
  key returns `replayed: true`. Different SKUs or thresholds use different keys;
  a changed identity under a reused key still conflicts.
- Closed the scheduled KEEP-GAP for stock alert refresh/reopen with native forward
  `20261022165000_fulfillment_stock_evidence_replay_reopen.sql`. Matching-identity
  replay reopens the alert, refreshes severity/quantities and clears `resolved_at`;
  identity mismatches retain SQLSTATE `23505`.

Migration: install the complete native catalogue through `20261022165000` before
stock adoption. The package descriptor and SQL asset project that same forward;
replay preserves the row identity, first-seen time and historical resolver run.
There is no managed forward or legacy fingerprint rewrite.

Migration: alert rows written by 0.22.0's native port carry the earlier whole-input fingerprint; subsequent writes under those keys conflict with SQLSTATE `23505`, and resolve only marks the row resolved while retaining its key and fingerprint, so it does not clear the conflict. Legacy fingerprints are documented only; this change does not rewrite them.

- Fulfillment ingress exposes receipt IDs, a host-neutral HTTP result mapping,
  counted correlation/timestamp/tracking refusals and persisted safe superseded
  causes. The opt-in adapter preserves donor webhook key bytes and defaults to
  strict opaque references. Adopters can explicitly allow wider reference shapes
  through `observationCodecs.approveReference`; tracking URLs retain their strict
  default policy. `carrierRef` now stores the service-derived lowercase carrier
  prefix by default, or the safe kind returned by `normalizeCarrier`, and effects
  receive that same value as `carrierKind`. Both are null when no kind is available
  or service evidence is refused; raw provider carrier codes have no fallback,
  matching donor deduplication. Strict timestamp validation applies only at
  webhook ingress, accepting compact offsets and local timestamps as before;
  reconciliation and stock-movement timestamp parsing retain PR2 behavior.
  Hosts retain referenced raw evidence.

Migration (observation ingress): donor-format colon identities remain the
compatibility target. Observation receipts/effects recorded by 0.22.0's native
stores under package digest keys are not recognized under the incumbent colon
keys, so retrying such an event can apply tracking again. Replaying a superseded
receipt processed by 0.22.0 fails with `fulfillment_observation_outcome_conflict`.
Drain in-flight observation retries before upgrading. No bridges or aliases are
provided for these native rows. Wider incumbent correlation/tracking references
require an explicit adopter allowlist; the default refuses and reports them.

Close the scheduled native stock-evidence refresh/reopen gap with forward
`20261022165000_fulfillment_stock_evidence_replay_reopen.sql` and its byte-identical
fulfillment package projection. Matching fingerprints refresh severity and nullable
quantities, reopen status, and clear `resolved_at`; identity, first-seen time and
historical resolver metadata survive. Existing-row replays and resolution serialize
on the row lock. Fingerprint mismatches still raise `23505`.

Migration: install the complete canonical native catalogue through `20261022165000`
before stock adoption, preserving its immutable ledger prefix. Sparse package SQL
is not a standalone install chain. The managed baseline already has this behavior.
Legacy 0.22.0 whole-input fingerprints are not rewritten and still conflict with
PR1 identity fingerprints, including after resolution.

- Add experimental invoicing declarations and explicit default-off capability selection, preserving exact absence, uncertain effects, correction identity and owed-duty visibility.
- Freeze host fiscal/facts/seller/money, registry, artifact, delivery, payout-item and safe account-history seams without installing a worker, store, provider or route.

Approve only the exact frozen M10/F17 native and managed SQL packet through a separate forward-control class, with inert fixtures, refusal plants and a required real PostgreSQL/pgTAP catalog gate. This control adds no migration, runtime activation or new permission to an installation.

- Add experimental subscription contracts and exact server/browser subpaths, preserving schedule identity, graph transaction boundaries, deferred admission and explicit native capability refusals.
- Contribute the unchanged hosted cycle, refusal and durable failure mechanisms with injected policy and their characterization; preserve native captured-case protection through rollback until actual arrival.

- Add injected native renewal and retry stores and a native executor using the subscription ports; bind hosted charge/failure facades to the contributed mechanism and existing M07 policies.
- Type-level change visible to dev-preview consumers: `capabilities.retryRecovery` changes from `"unavailable"` to `"selected"` (asserted in packages/platform/test/subscriptions/portFit.test.ts).

Migration: Install native N1 through the full ordered manifest before composing the retry driver. Native declines can retry or recover the original obligation instead of stalling indefinitely (F16); exhaustion leaves an active subscription and open case with no next retry. Preserve ledgers on rollback. The initial binding preserves case-before-outcome order and atomic terminal/bookkeeping writes. An existing immutable receipt short-circuits initial terminal replay before settlement, rebinding or case propagation, preserving all later retry effects; no runner is activated and M07 native prepared-store parity remains unavailable.

Host obligations: establish explicit logical-cycle correlation before invoking the runner (including prepare/execute). Ordinary retries must use the frozen mandate/authorization; N1 does not bind an ordinary retry method, so the P8 retry driver or host must enforce this, with a composition witness added in P8. Prepared retries retain the existing non-terminal `retry_scheduled` disposition with no next dispatch date. Bare `failed` execution status without explicit failure evidence requires verified readback (or remains awaiting an ACK).

A host or driver must never call `openCase` after a replayed `applyFailure` receipt, and the P8 retry driver must add a zero-delta replay witness.

### Warehouse product-sync parity

A3 #311 restores product-sync parity and safe diagnostics in the opt-in warehouse
adapter, including product/pack projection and injected transport behavior.
It remains default-off with offline evidence only and no provider-account proof.

Migration: upgrade the complete core/outbox/platform set from `0.22.0` to
`0.23.0` for exact peers. Install the complete canonical native chain through
position 76 (`20261022165000_fulfillment_stock_evidence_replay_reopen.sql`),
including native N1, before selecting native stores. Sparse package SQL is not
an installation chain. Follow the shadow-draft, observation-retry and legacy
alert-fingerprint migration notes above; rollback preserves the forward ledger.

### Experimental stages: no adopter activation

M10 subscription renewal/retry is **EXPERIMENTAL, INCOMPLETE and DEFAULT-OFF**,
not for adopter activation. This set includes P1 exports, the forward controls,
and P2 native renewal/retry stores and executor with native N1 SQL landed.
No runner is activated. G23 composition and N1 correlation, frozen authorization
and replay obligations remain pending: compose admission before any new cycle,
bind a logical cycle before prepare/execute, enforce frozen authorization on
ordinary retries, and never open a case after a replayed failure receipt.
The later retry driver still owes its zero-delta replay witness.

M09 invoicing capability selection and type-only contracts are
**EXPERIMENTAL, INCOMPLETE and DEFAULT-OFF**, not for adopter activation.
There is no invoicing SQL, store, worker, provider or route in this stage.
Installing the set does not register subscription or invoicing routes, workers
or a renewal runner; host composition remains explicit.

### Known limitations

- Managed dunning exhaustion still pauses active subscriptions; retaining active status needs a managed forward. Native N1 lands the bounded retry/failure repair, with the host obligations below still pending.
- D8-1: native advisory v2 promo-code candidates/rejection details unavailable.
- D8-2: native mounted v2 issue/honor/fallback unavailable.
- D8-3: native acquisition-only mounted issuance/honor unavailable.
- D8-4: full native/managed eligibility equivalence unavailable.
- Bundle-1: independent DB human-only actor-kind enforcement absent natively; first in the native-backend parity round.
- Bundle-2: managed-equivalent actor-kind/email history absent natively.
- Bundle-3 closes injected-reader M05 mounted admin/feed readback only. Native new-purchase stock read absent despite P5a installed-store proof; deferred second after bundle-1 (owner 2026-10-21); readiness refuses.
- Bundle-4: incumbent real-PostgreSQL contention only; no exactly-once guarantee.
- Managed schema/pgTAP retain `44.404`; removal needs owner decision/forward; reference composition supplies it to app code.
- A1 offline only; account/hosted-time/owner TEST evidence unclaimed; `communications/klaviyo` verification-pending.
- M05 omitted opt-ins preserve defaults/outputs/read order/schedules/refusals/acceptance-token bytes/SQL.
- Native inventory adjustment unavailable; address writes refuse readiness. Flat-rate save needs selected port/Core readiness/applied-seed observation.
- Native shipping audit unavailable; handler swallows best-effort audit failure.
- Native flat-rate integer bounds (0 through host maximum; reference 100,000 minor units) use request schema, not DB CHECK.
- Managed ATP/forecast/dated-supply/pagination readback unproved/pending M06.
- Managed two-session locks/concurrency/uncovered compensation unproved/pending M06.
- Managed exact-prefix upgrade/ledger unproved/pending M06.
- Managed address idempotency/conflict/readback unproved/pending M06.
- Managed successful flat-rate read/save unproved/pending host authority.
- M06 stock-wait lifecycle/durable timing/staging controls retain C5/C6; busy/try-gate, continuity/flag/TTL transfers are dispositions, not PASS.
- Shipping national-registry fields/locale-specific `canonicalAddressKey` fold await M16 host market pack/key migration; reference shipping copy stays locale-specific until M16.
- Native durable prepared storage, method setup, absence reopen and cumulative refunds unavailable; no production installation parity claimed.
- Typed refusal-envelope forwarding unavailable (`failureReason` only); reusable registration needs host ownership resolution.
- Incomplete chargebacks stay refunds/unapplied: reclassification bypasses evidence validation into dispute apply; limited operator recovery.
- Audit compatibility still detects `chargeId`; refund operation identity/original money supply no typed charge identity.
- M07 follow-up: repair poll can clear host redirect; post-timeout verify never restarts polling; unlocalized poller; fixture builds/never calls handler.
- M07 follow-up: reference status route wrong-rail witness.
- M07 follow-up: explicit reference-route refusal for unsupported method setup.
- M07 follow-up: deployment-neutral disabled-verify reason.
- M07 follow-up: reference card normalizer missing-amount path; package settling evidence already requires positive money.

- Native delivery alignment stays off or shadow until a host composes the native automatic-renewal runner with the G23 renewal admission decorator. The decorator alone neither composes nor activates the runner.
- The core fulfillment status map carries localized adopter labels; replace them with host-injected labels or internationalization keys at the host presentation boundary.
- The warehouse adapter example is opt-in and has offline conformance only; no provider-account proof or activation is established. Exact absence, label create/void and cancellation remain unsupported.
- After an alignment extension, a deferred renewal operation at the old schedule remains claimed with no reader or reservation effect. Changed terms snapshots conflict under the existing snapshot-conflict rules.

Native parity remains host-owned at these seams. Missing native bindings use the shared `FULFILLMENT_NATIVE_UNSUPPORTED` refusal; no partial write or parity claim is implied.

| Amendment | Host-owned seam and native boundary |
| --- | --- |
| G18 | Replacement creation and atomic eligibility/replay receipts; native replacement callback refuses. |
| G19 | Operator mutations, actor attribution and replay receipts; native mutation callbacks refuse. |
| G20 | Customer alignment rows; native reader refuses, while the pure delay projection remains callable. |
| G21 | Commerce list/detail and shipments overview; native read callbacks refuse. |
| G22 | Authoritative preparation edits, authorization and replay receipts; missing preparation binding refuses before dispatch, after disabled/selection/readiness checks. |

- M08 parity D2 KEEP-GAP: native dispatch finish still loses rejected/unknown error detail.
- M08 parity KEEP-GAP: immutable stock snapshot/alert evidence storage is absent; cursor JSON is overwritten. Hosts retain referenced evidence.
- Stock-evidence replay/reopen is CLOSED by native position 76; legacy `0.22.0` alert fingerprints still conflict with `23505`, including after resolution.
## [0.22.0]

- Publishable on the npm `latest` dist-tag as `0.22.0`, from tag
  `openlup-platform-v0.22.0`.

- Add eleven experimental reference-application support exports on the existing payment vendor subpaths. Reuse contributed execution, readback, mapping and diagnostic helpers; preserve the no-charge error class identity. Neutral payment exports and default activation remain unchanged.

Migration: none.

### Opt-in warehouse fulfillment example

Add the experimental, opt-in warehouse fulfillment entry described in the README behind the frozen neutral fulfillment ports: explicit injected I/O, prepared-byte binding, closed evidence, token observations and positive readback. Default-off; account readiness is host-owned. Exact absence, label create/void and cancellation remain unsupported.

Missing or malformed evidence refuses before credential resolution or HTTP.

Migration: none

### Offline warehouse fulfillment conformance

Prove the opt-in warehouse fulfillment entry described in the README with M08's offline conformance runner using injected
HTTP and synthetic fixtures. Cover dispatch replay and refusals, observation,
readback, stock and product sync, plus real-worker host-ledger fences after
restart and retention eviction. No provider-account or activation proof is claimed.

Migration: none

### Fulfillment contracts and status canon

Add experimental `fulfillment` and type-only `fulfillment/contracts` entries with
contributed status decisions, strict core parser bindings, concrete provider/store
ports and injected default-off capabilities. No adapter, executor, route or default
profile is activated; existing reference integrations remain unchanged.

Declared adaptation: empty or absent provider selection is a typed refusal in the
new package, rather than the donor host's implicit simulator alias. The donor alias
remains an open owner follow-up; this contribution does not change donor logic.
Private provider trace columns and registry/environment values are excluded from
the neutral package; persisted command fingerprints and opaque host keys are retained.

Migration: none (new surface; no existing reference behavior changes).

### Fulfillment paid handoff and fenced dispatch

Add the paid outbox handler/recovery classifier, injected dispatch worker and
separate durable command-ledger protocol through the new fulfillment entry.
Preserve one contact remap, opaque host keys, actual-command fingerprints,
readback/attempt/begin order and local accepted-proof repair without another POST.
Provider/money/inventory authority remains injected; no SQL, route or activation.

Approved port amendment G14 adds recordProviderAttempt to the new
FulfillmentStorePort. It records only sanitized prepared DispatchEvidence plus
mode/recorded status and opaque references, after authoritative claim readback;
same-key replay writes no second attempt and contact remap retains its own key.
No new named export or subpath is added by this method. Other contracts are unchanged.

Correctable draft re-claim must refresh fingerprint and evidence atomically.
Store conformance and native durability/fencing and SQL proofs remain later work.

Migration: none (new surface; contracts and orchestration land in one release).

### Fulfillment observation and sync workers

Add neutral observation effects, verified ingress, observation reconciliation,
tracking, stock/product sync, read-only evidence handlers and the offline
runFulfillmentAdapterConformance at the existing fulfillment entry.

Migration: approved G15 extends the unreleased SyncCursor with optional
coverageGapSkus (legacy absence reads as []). Only consecutive succeeded runs
confirm a reservation coverage gap; running/failed cursors clear the set.
Migration: approved G16 changes readLocalInventoryStock(requestedAt) to typed
unaggregated lines with skuRef, quantity balances, fulfillable, locationStatus,
lotStatus and expiresAt. The worker filters/sums at the captured clock; expiry
exactly then is excluded. Inventory authority and the provider stock-sync shape
are unchanged.
Migration: approved G17 adds inline localPersistence: ingress records eventKey
receipts preserving firstReceivedAt and marks processing idempotently;
reconciliation reads local status/latestStatusOccurredAt/handedOverAt. No named
persistence type is exported. Durable replay and processing remain host obligations.
A superseding conflict returns superseded but persists only processed status,
without a dedicated superseded-reason field.

Correlated ingress requires a nonblank observation or dispatch external reference
before acceptance/status/effects/processed mark; failure leaves the receipt
unprocessed. Stock-contention annotation is best-effort before the original stock
failure is rethrown; recovered-picked receipt diagnostics remain typed. Effects
retain stock → handover → tracking → invoice and callback/throw order.
Reconciliation fails the run on unknown readback and projects unmapped correlation
evidence before host calls. Product evidence reads retain safe authorization/read
refusal detail. Private codecs, keys, carrier URLs and provider errors stay
host-owned; typed evidence replaces raw payload pass-through. The conformance
runner accepts adapter-owned offline subjects and returns sanitized evidence;
fixture checks do not establish durable store atomicity or arrival alignment.

### Fulfillment native persistence and delivery alignment

Add native shipment, evidence, stock, recovery, dispatch, paid-handoff and
alignment stores through the existing fulfillment entry. Sparse migration
projections bind native units 5/27/51/73/74; install the complete catalogue.
Coverage-gap cursor state and received/status/processed evidence are
durable, while local inventory lines and contact preparation remain explicit
host inputs. Native 3pl acceptance uses a dispatch evidence receipt and preserves
the cancellation fence without inventing an owned label or physical packing.

Native admission: overdue-delivery admission guards only NEW cycle
admission/insert, matching the donor's guard_cycle_insert. Existing-cycle retries
through renewal operations and dunning bypass admission and neither mint nor
consume a one-use receipt. No retry_scheduled state or payments lifecycle change is
introduced. Native continuity requires the complete canonical migration graph,
real-PostgreSQL installation, replay and access-control checks.

### Fulfillment operator lifecycle and customer delay projection

Add host-owned operator and replacement handlers through the fulfillment entry.
Mutation callbacks require actor attribution and idempotency keys; the host owns
atomic replay receipts and replacement eligibility, reservation and hold effects.
Native bindings return a shared typed unsupported refusal without writing.
Customer delay projection keeps absent cases distinct, hides aligned history
when the schedule advances and never presents manual review as protection.
Label helpers preserve transient downloads and cleanup uncertainty. Current
parcel helpers retain sequence selection and companion attribution. These
exports mount no route, dispatch no parcel and attest no replacement arrival.

### Fulfillment commerce reads and recorded progress

Add host-owned commerce list/detail projections, a shipments overview handler and
typed read callbacks. Projected payment status passes through unchanged and
native reads return the shared unsupported refusal. Preserve opaque host overview
buckets and the legacy shipment-status facade. Progress completion requires
recorded milestones and uses the host-resolved customer step.

### Fulfillment internal simplification

Reuse the empty stock-balance constructor in aggregation and sync, and append to
private recovery groups without copying each growing array. Fulfillment results,
public contracts, key bytes and effect order remain unchanged.

### Fulfillment service composition and preparation

Add explicit default-off fulfillment services, a structural contribution and an
inert reference preparation binding. Authoritative source edits and redacted
context synchronization share the native dispatch and shipment locks. Missing
preparation refuses readiness. No route, schedule, renewal wrapper or automatic
dispatch is activated.

### Fulfillment presentation ownership

The status canon, actual-evidence tracking progress, current-parcel selection and
canonical fact parsers belong to `@openlup/core/fulfillment`. Platform keeps thin
compatibility re-exports and preserves its existing narrowed fact type names.
Fulfillment contracts re-export the shared status and progress types from core.
Server orchestration remains in platform. Browser code, including the host
status, fact and current-parcel facades and the account order views, imports
these helpers from core, so no browser graph loads the platform fulfillment
runtime.

Migration: existing platform imports remain valid; no application or schema
migration is required. Core exposes narrowed fact aliases with a `Canonical`
prefix while its generic fact exports retain their names.

Migration: upgrade core, outbox and platform together from `0.21.0` to `0.22.0` for exact peer pins. Install the complete canonical native migration chain through units 73/74 (`20261022080000_fulfillment_command_ledger.sql` and `20261022090000_fulfillment_delivery_alignment.sql`), never the sparse package projections alone. Before, these fulfillment services were host-owned; after, explicitly compose selected ports and default-off services. Nothing mounts routes, schedules dispatch or composes the native renewal runner automatically. Keep native alignment off or shadow until the G23 decorator is composed. Arrival alignment remains once and later-only; undelivered replacements remain outstanding, and replacement confirmation must only record actual customer arrival. Preserve G15–G17 cursor, receipt and local-status persistence when implementing host stores. An application rollback does not reverse the forward migrations; older runners refuse the extended ledger.

### Known limitations

- Portable dunning repair has no managed twin: exhaustion still pauses active subscriptions there; retaining active status needs a managed forward.
- D8-1: native advisory v2 promo-code candidates/rejection details unavailable.
- D8-2: native mounted v2 issue/honor/fallback unavailable.
- D8-3: native acquisition-only mounted issuance/honor unavailable.
- D8-4: full native/managed eligibility equivalence unavailable.
- Bundle-1: independent DB human-only actor-kind enforcement absent natively; first in the native-backend parity round.
- Bundle-2: managed-equivalent actor-kind/email history absent natively.
- Bundle-3 closes injected-reader M05 mounted admin/feed readback only. Native new-purchase stock read absent despite P5a installed-store proof; deferred second after bundle-1 (owner 2026-10-21); readiness refuses.
- Bundle-4: incumbent real-PostgreSQL contention only; no exactly-once guarantee.
- Managed schema/pgTAP retain `44.404`; removal needs owner decision/forward; reference composition supplies it to app code.
- A1 offline only; account/hosted-time/owner TEST evidence unclaimed; `communications/klaviyo` verification-pending.
- M05 omitted opt-ins preserve defaults/outputs/read order/schedules/refusals/acceptance-token bytes/SQL.
- Native inventory adjustment unavailable; address writes refuse readiness. Flat-rate save needs selected port/Core readiness/applied-seed observation.
- Native shipping audit unavailable; handler swallows best-effort audit failure.
- Native flat-rate integer bounds (0 through host maximum; reference 100,000 minor units) use request schema, not DB CHECK.
- Managed ATP/forecast/dated-supply/pagination readback unproved/pending M06.
- Managed two-session locks/concurrency/uncovered compensation unproved/pending M06.
- Managed exact-prefix upgrade/ledger unproved/pending M06.
- Managed address idempotency/conflict/readback unproved/pending M06.
- Managed successful flat-rate read/save unproved/pending host authority.
- M06 stock-wait lifecycle/durable timing/staging controls retain C5/C6; busy/try-gate, continuity/flag/TTL transfers are dispositions, not PASS.
- Shipping national-registry fields/locale-specific `canonicalAddressKey` fold await M16 host market pack/key migration; reference shipping copy stays locale-specific until M16.
- Native durable prepared storage, method setup, absence reopen and cumulative refunds unavailable; no production installation parity claimed.
- Typed refusal-envelope forwarding unavailable (`failureReason` only); reusable registration needs host ownership resolution.
- Incomplete chargebacks stay refunds/unapplied: reclassification bypasses evidence validation into dispute apply; limited operator recovery.
- Audit compatibility still detects `chargeId`; refund operation identity/original money supply no typed charge identity.
- M07 follow-up: repair poll can clear host redirect; post-timeout verify never restarts polling; unlocalized poller; fixture builds/never calls handler.
- M07 follow-up: reference status route wrong-rail witness.
- M07 follow-up: explicit reference-route refusal for unsupported method setup.
- M07 follow-up: deployment-neutral disabled-verify reason.
- M07 follow-up: reference card normalizer missing-amount path; package settling evidence already requires positive money.

- Native delivery alignment stays off or shadow until a host composes the native automatic-renewal runner with the G23 renewal admission decorator. The decorator alone neither composes nor activates the runner.
- The core fulfillment status map carries localized adopter labels; replace them with host-injected labels or internationalization keys before any stable-framework claim.
- The warehouse adapter example is opt-in and has offline conformance only; no provider-account proof or activation is established. Exact absence, label create/void and cancellation remain unsupported.
- After an alignment extension, a deferred renewal operation at the old schedule remains claimed with no reader or reservation effect. Changed terms snapshots conflict under the existing snapshot-conflict rules.

Native parity remains host-owned at these seams. Missing native bindings use the shared `FULFILLMENT_NATIVE_UNSUPPORTED` refusal; no partial write or parity claim is implied.

| Amendment | Host-owned seam and native boundary |
| --- | --- |
| G18 | Replacement creation and atomic eligibility/replay receipts; native replacement callback refuses. |
| G19 | Operator mutations, actor attribution and replay receipts; native mutation callbacks refuse. |
| G20 | Customer alignment rows; native reader refuses, while the pure delay projection remains callable. |
| G21 | Commerce list/detail and shipments overview; native read callbacks refuse. |
| G22 | Authoritative preparation edits, authorization and replay receipts; missing preparation binding refuses before dispatch, after disabled/selection/readiness checks. |
## [0.21.0]

- Publishable on the npm `latest` dist-tag as `0.21.0`, from tag
  `openlup-platform-v0.21.0`.
- Preview set: core/outbox unchanged, UI private `0.0.0`; published `0.20.0` size baselines, unchanged caps.

### Cumulative M07 status: payment truth and repair surfaces complete for this wave

- Experimental payments/contracts/runtime: unchanged prepared ordering; neutral execution/evidence/readback/conformance, verified truth, first-receipt ingress, method lifecycle/reconciliation; host-owned persistence, translation/failure policy.
- Native PostgreSQL truth/settlement/later-only alignment; three unchanged sparse SQL projections, not an install chain. Refunds never cancel subscriptions.
- Repair/recovery/buyer verify inject rail capabilities; unknown rails refuse. Reference BFF retains mapping/schemas/ownership/auth order/transient callbacks. Browser/verify outcomes never prove payment success.
- Reference-application source (no new export), opt-in repair view: `commerce/paymentStatusClient`, `commerce/paymentVerifyClient`, `payment/components/PaymentStatusPoller`; stored paid alone confirms, redirects require HTTPS, collection/confirmation stay injected, unsupported setup is visible. Exact file/specifier guards refuse broad commerce/operator clients; source-import proof keeps default view unmounted.
- Truth services/one optional named binder use the host executor, no new schedule/executor. Selectors default-off: nothing activates by default. First-insert adapter fingerprint excludes receipt time/audit.
- Two experimental example adapter subpaths under `./payments/`, named in the README. Card-processor example: three frozen exports, injected host client/neutral ports; refund creation, split authorization/capture and exact absence unavailable; cancellation needs host support.
- Regional-processor example: host I/O, Model O aliases, verified observations, purpose-sensitive readback; check certificate validity/notification freshness. Both examples have no import I/O/default binding and await account TEST evidence.
- Example adapter advisory: mismatched nonzero refusal money stays unknown/manual; trusted document refusals mean customer data correction; configuration mismatches throw before I/O. Unpaid/transient no-dispatch classifications unchanged.
- Settling money missing/invalid/non-positive or blank currency refuses as amount mismatch; conformance requires positive money. Empty optional transients stop false leak refusals; JSON-escaped transients in diagnostics/readbacks/stored payloads and payer contact in execution results now refuse.
- Private types reuse canonical money/attempts; unused imports removed, runtime/API unchanged.

Migration: upgrade all `@openlup/*` `0.20.0` → `0.21.0` for exact pins. No schema migration; install the canonical catalogue, not sparse projections. Attempts add optional method selection/transient payer contact; contact is dispatch-only, never persisted/audited/logged/diagnosed. Missing adapter-required input requires exact before-dispatch `notDispatched`. Registration refs/kind/status require host `resolveMethodOwner` client/subscription ownership or are omitted. Lifecycle/normalized nested audit copies typed fields only; conformance scans all for secrets/contact. Adapter-filtered redacted audit never stores raw bodies; typed evidence overrides reader facts, audit bag fills untyped facts; identity/fingerprint exclude bag/receipt time. Other changes need no migration, and nothing rewires a host automatically.

Migration: F2 replaces assumed full refund with `require-evidence`: missing/null kind/amount/operation identity is durably recorded/acknowledged, not applied. Supply original money, stable operation identity and cumulative snapshot, event delta or explicit full reversal (`refund`/`chargeback`); full evidence stays valid. Former default needs `refundEvidencePolicy: "legacy-assume-full"`, also in the reference handler; no native parity implied.

Migration: D11 changes every caller of the reference payment control port (the selected verified ingress, the existing provider webhook handler and the captured reference checkout): apply/post-process redelivery using the first stored receipt instant, not redelivery time, so it cannot shift the cycle again. Replay reads winning receipt evidence and refuses (503) when that instant is unavailable. A legacy pre-fingerprint row takes the later clock once. Retain receipt evidence on upgrade; provider routes are not switched to opt-in ingress.

### Known limitations

- Portable dunning repair has no managed twin: exhaustion still pauses active subscriptions there; retaining active status needs a managed forward.
- D8-1: native advisory v2 promo-code candidates/rejection details unavailable.
- D8-2: native mounted v2 issue/honor/fallback unavailable.
- D8-3: native acquisition-only mounted issuance/honor unavailable.
- D8-4: full native/managed eligibility equivalence unavailable.
- Bundle-1: independent DB human-only actor-kind enforcement absent natively; first in the native-backend parity round.
- Bundle-2: managed-equivalent actor-kind/email history absent natively.
- Bundle-3 closes injected-reader M05 mounted admin/feed readback only. Native new-purchase stock read absent despite P5a installed-store proof; deferred second after bundle-1 (owner 2026-10-21); readiness refuses.
- Bundle-4: incumbent real-PostgreSQL contention only; no exactly-once guarantee.
- Managed schema/pgTAP retain `44.404`; removal needs owner decision/forward; reference composition supplies it to app code.
- A1 offline only; account/hosted-time/owner TEST evidence unclaimed; `communications/klaviyo` verification-pending.
- M05 omitted opt-ins preserve defaults/outputs/read order/schedules/refusals/acceptance-token bytes/SQL.
- Native inventory adjustment unavailable; address writes refuse readiness. Flat-rate save needs selected port/Core readiness/applied-seed observation.
- Native shipping audit unavailable; handler swallows best-effort audit failure.
- Native flat-rate integer bounds (0 through host maximum; reference 100,000 minor units) use request schema, not DB CHECK.
- Managed ATP/forecast/dated-supply/pagination readback unproved/pending M06.
- Managed two-session locks/concurrency/uncovered compensation unproved/pending M06.
- Managed exact-prefix upgrade/ledger unproved/pending M06.
- Managed address idempotency/conflict/readback unproved/pending M06.
- Managed successful flat-rate read/save unproved/pending host authority.
- M06 stock-wait lifecycle/durable timing/staging controls retain C5/C6; busy/try-gate, continuity/flag/TTL transfers are dispositions, not PASS.
- Shipping national-registry fields/locale-specific `canonicalAddressKey` fold await M16 host market pack/key migration; reference shipping copy stays locale-specific until M16.
- Native durable prepared storage, method setup, absence reopen and cumulative refunds unavailable; no production installation parity claimed.
- Typed refusal-envelope forwarding unavailable (`failureReason` only); reusable registration needs host ownership resolution.
- Incomplete chargebacks stay refunds/unapplied: reclassification bypasses evidence validation into dispute apply; limited operator recovery.
- Audit compatibility still detects `chargeId`; refund operation identity/original money supply no typed charge identity.
- M07 follow-up: repair poll can clear host redirect; post-timeout verify never restarts polling; unlocalized poller; fixture builds/never calls handler.
- M07 follow-up: reference status route wrong-rail witness.
- M07 follow-up: explicit reference-route refusal for unsupported method setup.
- M07 follow-up: deployment-neutral disabled-verify reason.
- M07 follow-up: reference card normalizer missing-amount path; package settling evidence already requires positive money.

## [0.20.0]

- Publishable on the npm `latest` dist-tag as `0.20.0`, from tag
  `openlup-platform-v0.20.0`.

- Refresh release size-gate baselines from the published `0.19.0` tarballs; all caps remain unchanged.

- Keep active subscriptions active on portable dunning exhaustion (invariant repair).

Migration: apply the complete portable catalogue through
`20261021120000_dunning_lifecycle_active_repair.sql` at position 71. Previously,
NULL next retry expired the case and paused an active subscription; it now leaves
the case open and repairable, retains the final notice and exhaustion event, and
changes no subscription or cycle dates. Existing rows are not rewritten. Pass
NULL only when `isDunningLadderExhausted` holds; a class-terminated rung-one refusal
still must not be passed as NULL. There is no managed twin yet; the managed
baseline still needs a separate forward.

- Add the readiness-gated native flat-rate binding; the host supplies the named
  role-free lane and fixed-key rate port, as in the reference composition.
- Require the native port and Core readiness for the shipping seed migration.
- Refuse missing-row saves; native audit remains explicitly unsupported and best effort.

Migration:
Apply the complete portable chain through 20261021200000_shipping_flat_rate_seed.
The seed preserves an existing rate and inserts zero only when absent; no ACL or
role changes are made. New code on an unmigrated schema keeps refusing. Older code
reads the seeded zero as it read an absent row. An application rollback does not reverse either forward
(positions 71 and 72), and older runners refuse the extended ledger.
Managed host-save authority remains pending.

- Add the shipping `SHIPPING_MIGRATIONS` export and the optional
  `nativeRateReadiness` / `nativeRateSchema` binding dependencies.

Migration: upgrade the complete `@openlup/*` set from `0.19.0` to `0.20.0`
for exact internal pins. Native rate bindings require the selected port plus
Core readiness and a same-database schema observation of the applied seed.
Install the complete canonical migration catalogue, never sparse package
projections as an installation chain.

### Cumulative M06 status

- M06 remains incomplete: inventory and shipping are development-preview
  surfaces, with managed-host proof classes pending.
- Inventory and shipping contracts, stock/ATP reads, reserve/release/expire
  operations, subscription forecasts, delivery selection, address and flat-rate
  handlers first shipped in `0.18.0`. Opt-in inventory/shipping/composition
  bindings (P5a/P5b) first shipped in `0.19.0`. M06's only new behaviour in
  `0.20.0` is native flat-rate save behind readiness; the portable dunning
  invariant repair is separate from M06. Host-owned policy and unsupported
  operations retain their explicit boundaries.

### Known limitations

- The portable dunning invariant repair has no managed twin in this set. The
  managed baseline pauses active subscriptions on exhaustion; keeping them active
  requires a separate managed forward. Portable proof does not establish managed parity.

- D8-1: native advisory v2 promo-code candidates and rejection details are not supported on the native backend.
- D8-2: native mounted v2 code issue/honor/fallback is not supported on the native backend.
- D8-3: acquisition-only mounted issuance/honor is not supported on the native backend.
- D8-4: full native/managed eligibility equivalence is not supported on the native backend.
- Bundle-1: independent database human-only actor-kind enforcement is not supported on the native backend and is the first item of a future native-backend parity round.
- Bundle-2: managed-equivalent actor-kind/email history is not supported on the native backend.
- Bundle-3 remains closed for M05 mounted admin/feed readback with an injected stock reader, while native new-purchase stock reads remain unsupported despite P5a's installed native inventory-store read proof.
- Bundle-4 establishes only incumbent real-PostgreSQL contention characterization and provides no exactly-once guarantee.
- The managed baseline schema and its pgTAP tests retain the incumbent legacy value `44.404`; removing it needs a forward migration and an owner decision, while reference composition supplies that value to application code.
- A1 evidence is offline only: account verification, hosted-time behaviour and owner TEST certification are not claimed, and the `communications/klaviyo` adapter's capabilities stay verification-pending.
- M05 parity seams are opt-in and omitted bindings preserve incumbent defaults, outputs, read order, scheduling, refusals, acceptance-token bytes and exported SQL.
- Native inventory adjustment remains unsupported; native address writes refuse
  required-capability readiness. Native flat-rate save is supported only behind
  the selected port, Core readiness and applied-seed schema observation.
- Native new-purchase stock read is deferred to the native-backend parity round
  (owner 2026-10-21), second after M05 bundle-1; required readiness still refuses
  honestly.
- Native shipping-rate save has no durable audit: audit is explicitly unsupported,
  and the incumbent handler swallows the best-effort audit failure.
- Native flat-rate value bounds (integer, 0 <= value <= the host request schema's
  maximum) are enforced by that schema, not a database CHECK; the reference
  maximum is 100,000 minor units.
- Managed host ATP/forecast/dated-supply/pagination readback is not proved and
  remains pending in the M06 ledger; no managed-host parity is claimed.
- Managed two-session lock order/concurrency and uncovered compensation paths
  are not proved on a managed host and remain pending; no equivalence is claimed.
- Managed exact-prefix upgrade/ledger is not proved on a managed host and remains
  pending; no managed installation equivalence is claimed.
- Managed address adapter idempotency/conflict/readback is not proved on a managed
  host and remains pending; no fixture-to-host equivalence is claimed.
- Managed successful flat-rate read/save remains pending host authority and is
  not proved on a managed host; no successful managed host-save claim is made.
- M06 adopter stock-wait lifecycle, durable subscription timing and staging
  control observations retain their separate C5/C6 evidence gates. Busy/try-gate
  protocol, durable stock-wait continuity and staging flag/TTL rows transferred
  to C5 adopter evidence are dispositions, not PASS.
- Shipping contracts retain national-registry address fields and
  `canonicalAddressKey` retains a locale-specific character fold. M16 owns their
  move behind a host-supplied market pack with a canonical-key migration plan.
- Reference shipping UI copy remains locale-specific until M16.
## [0.19.0]

- Publishable on the npm `latest` dist-tag as `0.19.0`, from tag
  `openlup-platform-v0.19.0`.

### 0.18.0 → 0.19.0 set scope

- Prepare the complete development-preview minor set at `0.19.0`, including everything on main since `0.18.0`; core and outbox are unchanged republications, and UI stays private `0.0.0`.
- M05 parity adds opt-in shipping-promise consent, post-discount threshold shipping and acquisition orchestration to the experimental pricing, promotions and shipping entries; financial policy and acquisition capability remain host supplied.
- M05 parity adds effective native bundle selection and an authoritative preview hook, optional resolved-target/detail/feed context fields and `selectEffectiveBundleTargetPrice`; effective feeds require unambiguous gross unit anchors and whole-BOM readiness.
- Add `createConcurrentCommercePriceAuthorityPort` with concurrent history scheduling, selected-list identity and base-refusal precedence; browser additions are type-only.
- Catalog/contracts draft canonical JSON detects lone surrogates without regex lookbehind so it loads in Safari before 16.4, with unchanged behavior.
- M06 P5a adds explicit inventory store/provider bindings and structural inventory contribution, keeping reference catalog-stock composition inert and managed authorization intact; native new-purchase stock reads remain unsupported pending an owner decision and native adjustment still refuses.
- M06 P5a retains focused installed-consumer, runtime-role, managed FEFO/adjustment and consume/refund replay evidence with unproved parity gates retained in the M06 ledger.
- M06 P5b adds opt-in shipping selection, address and flat-rate bindings with injected validation and authority; native address writes remain unsupported and refuse required readiness.
- M06 P5b adds the final isolated installed inventory/shipping consumer, preserving incumbent selection errors and flat-rate behavior.
- M06 in progress: inventory and shipping entries are early surfaces; module not complete
- Supporting main changes sort platform registration lists one item per line and use the database clock in the M05 P7 quote witness; neither adds runtime behavior.

Migration: upgrade the complete `@openlup/*` set from `0.18.0` to `0.19.0` for exact internal pins; existing bindings need no change and new module adoption remains explicit and experimental. Hosts selecting shipping promises must forward `shippingTerms` through both acceptance callbacks and use a context schema that preserves the selected terms. Bind `resolveQuoteShippingPromotions` to the promotions factory to select the bounded two-pass threshold path; financial policy and acquisition capability remain host supplied. The additive APIs require a minor set and introduce no activation. For both M05 24b and M06 P5b, the pricing and promotions API reports reorder existing enum/union members because declaration emit order changed (24b follows the catalog-to-pricing import); no member is added, removed or changed and callers need no migration for that reorder. Install the complete canonical migration catalogue, never sparse package projections as an installation chain; this preparation adds no SQL migration.

### Known limitations

- D8-1: native advisory v2 promo-code candidates and rejection details are not supported on the native backend.
- D8-2: native mounted v2 code issue/honor/fallback is not supported on the native backend.
- D8-3: acquisition-only mounted issuance/honor is not supported on the native backend.
- D8-4: full native/managed eligibility equivalence is not supported on the native backend.
- Bundle-1: independent database human-only actor-kind enforcement is not supported on the native backend and is the first item of a future native-backend parity round.
- Bundle-2: managed-equivalent actor-kind/email history is not supported on the native backend.
- Bundle-3 remains closed for M05 mounted admin/feed readback with an injected stock reader, while native new-purchase stock reads remain unsupported despite P5a's installed native inventory-store read proof.
- Bundle-4 establishes only incumbent real-PostgreSQL contention characterization and provides no exactly-once guarantee.
- The managed baseline schema and its pgTAP tests retain the incumbent legacy value `44.404`; removing it needs a forward migration and an owner decision, while reference composition supplies that value to application code.
- A1 evidence is offline only: account verification, hosted-time behaviour and owner TEST certification are not claimed, and the `communications/klaviyo` adapter's capabilities stay verification-pending.
- M05 parity seams are opt-in and omitted bindings preserve incumbent defaults, outputs, read order, scheduling, refusals, acceptance-token bytes and exported SQL.
- Native inventory adjustment remains unsupported; native address writes and flat-rate saves refuse required-capability readiness.
- M06 managed host ATP/forecast/supply/pagination, remaining compensation/concurrency/lock-order, exact-prefix upgrade/ledger, address idempotency/conflict/readback and runtime rate authority remain pending in the M06 ledger.
- M06 adopter stock-wait lifecycle, durable subscription timing and staging control observations retain their separate C5/C6 evidence gates.

### Size note

Only platform `pack.docs.maxPackedBytes` rises from 40,960 to 49,152 B; all other caps and budgets remain unchanged. All three baselines use integrity-verified published `0.18.0` tarballs.

Question (2026-10-21): "The platform package's root docs (README + CHANGELOG) will exceed their 40,960 B gzip cap at the next release. What should we do?"
Owner's answer: "Raise to 49,152 B (Recommended)"
Option description shown to the owner: "Same figure as core. Unblocks the next few releases; the CHANGELOG grows every release, so this cap would otherwise block each one."
Recorded as an owner decision taken through the coordinator's question on 2026-10-21.
## [0.18.0]

- Publishable on the npm `latest` dist-tag as `0.18.0`, from tag
  `openlup-platform-v0.18.0`.

- M06 P4: retain named compatibility shims, restrict inventory smoke evidence to package-owned tests, neutralize synthetic transport fixtures and clarify inventory documentation; no runtime or API change.

### 0.17.0 → 0.18.0 set scope

- Prepare the complete development-preview set at `0.18.0`: core and outbox are
  unchanged republications; platform includes every change on main in this set.
- M05 adds catalog foundation/contracts, draft validation, product/lifecycle DTOs,
  authority/GTIN/quantity helpers, media and source-pack operations,
  fixed-bundle read/admin/feed logic, native envelope/draft stores and an inert
  catalog contribution; pricing adds the neutral quote foundation, authority,
  subscription policy and assignment token, quote/offer projection, opt-in
  acquisition terms and promise consent; promotions includes advisory, preview, acceptance,
  admin/native reads and sweep with explicit host bindings; lifecycle/publication
  contracts alone do not provide a publisher or native lifecycle writes.
- M05 P6: pricing and bundle comments are corrected, VAT arithmetic delegates to the
  existing helper and moved test fixtures are neutral with assertions unchanged;
  no API change.
- Reference-application source: opt-in catalog, product, basket, builder and admin UI consumes explicit
  data/locale/media/lifecycle inputs; basket edits invalidate promise consent and
  minor-money display uses the currency exponent.
- Shipped catalog SQL projects unchanged canonical positions 1/8/16/19/58/59/61,
  promotions projects 47/48 and inventory projects 27/33; native catalog factories
  retain the existing store bodies and references preserve their named exports.
- A1 adds 17 neutral marketing/consent declarations, the three-function `communications/resend`
  entry, the `communications/klaviyo` marketing adapter and lazy opt-in reference bindings with
  invocation-time admission; default routes, schedules and handlers stay empty.
  Existing providers remain assignable; existing neutral entries keep their runtime
  behaviour (the declarations above are additive), and the maintained reference
  adapter and default wiring are unchanged.
  Authenticated raw webhooks and GET-only delivery reconciliation retain host
  ownership of persistence and admission; no SDK or default sender is added.
  `communications/klaviyo` profile projection, negative consent readback,
  account-wide deletion acknowledgement and authoritative consent push stay
  verification-pending until the host supplies owner TEST verification.
  Audience-scoped deletion and deletion status are unsupported; newsletter sync
  refuses. No flow control, historical import, suppression edits or automatic
  mutation retry is added.
- Consent push grants stay audience-scoped; only withdrawals may be account-wide.
  The capability declares `grantEffect`; accepted/acknowledged results require
  `reconcileRequired`. Conformance keeps grants unsettled until settlement and
  fresh readback. Withdrawals bypass grant-caused fences/quarantine but retain
  same-key withdrawal fences and account cooling. No push factory, activation,
  callback, retry or subpath is added.
- M06 in progress: inventory and shipping entries are early surfaces; module not complete
- The merged M06 surfaces include inventory contracts/admin/native reads, injected
  new-purchase availability, reservation policy/maintenance and dated forecast
  calculation with required provider injection, plus shipping selection, address
  and rate handlers with required host validation.
- @openlup/platform size growth: added M05 catalog, pricing and promotions implementations, native stores and SQL projections, A1 communications adapters and consent contracts, and the merged early M06 inventory/shipping surfaces with their declarations and documentation.

Migration: upgrade the entire `@openlup/*` set from `0.17.0` to `0.18.0` for exact
core peer pins; new module adoption remains explicit and experimental.
Catalog and promotions server entries are adapters: their declarations require
selected optional `pg` peers, while runtime imports and injected executors work
without them and their contracts entries remain non-adapters. Supply host schemas, authorization,
responders and policies through the documented bindings. Acquisition requires
an explicit `AcquisitionFinancialPolicy` with no default; absence refuses with
`acquisition_terms_policy_unconfigured`, and reference activation remains off.
Bind resolved terms from the final optional issue/honor callback argument for
acquisition-aware acceptance; existing callbacks remain assignable. Stop
assigning `NegativeFeedback.kind` or `.outcome`, now readonly. Reference-application
source threshold classifiers require the host's explicit threshold. Generated enum declaration
ordering changes preserve member values and runtime behavior. Catalog adds
`createPostgresBundleCatalogStore`, `createPostgresCatalogDraftStore` and
`createPostgresCatalogSkuEnvelopeReadPort`, plus `BUNDLE_MIGRATIONS` (16/19) and
`CATALOG_MIGRATIONS` (1/8/58/59/61); composition adds
`createCatalogContribution` and `CatalogContributionInput`, with no public export
removed or renamed. Existing named reference imports remain compatibility paths.
The native writer, pooled transaction binding and transport remain reference-owned;
browser schemas stay local. Core remains the promotions evaluator; no claim writer
is added, and claim writing and mounted acceptance retain their owners. Reference
shipping selection, pickup and stock UI mechanics and browser validation stay local.
Install the complete canonical migration manifest, never sparse package SQL
projections as an installation chain; this preparation adds no new SQL migration.
A1 hosts retain credentials, identity/authority, atomic storage, environment,
egress and schedule ownership; acknowledged/accepted does not establish remote
effect and local consent remains authoritative.

### Known limitations

- D8-1: native advisory v2 promo-code candidates and rejection details are not supported on the native backend.
- D8-2: native mounted v2 code issue/honor/fallback is not supported on the native backend.
- D8-3: acquisition-only mounted issuance/honor is not supported on the native backend.
- D8-4: full native/managed eligibility equivalence is not supported on the native backend.
- Bundle-1: independent database human-only actor-kind enforcement is not supported on the native backend and is the first item of a future native-backend parity round.
- Bundle-2: managed-equivalent actor-kind/email history is not supported on the native backend.
- Bundle-3 is closed for M05 mounted admin/feed readback through the merged availability builder with an injected stock reader; the real native stock read remains M06 P5a work.
- Bundle-4 establishes only incumbent real-PostgreSQL contention characterization and provides no exactly-once guarantee.
- The managed baseline schema and its pgTAP tests retain the incumbent legacy value `44.404`; removing it needs a forward migration and an owner decision, while reference composition supplies that value to application code.
- A1 evidence is offline only: account verification, hosted-time behaviour and owner TEST certification are not claimed, and the `communications/klaviyo` adapter's capabilities stay verification-pending.

## [0.17.0]

- Publishable on the npm `latest` dist-tag as `0.17.0`, from tag
  `openlup-platform-v0.17.0`.

- Add experimental `./communications` and browser-safe
  `./communications/contracts`, plus generic capped raw-body, hex-HMAC and
  constant-time comparison helpers in the existing `./http` entry. Compose neutral
  transport/results/capture, rendering/content, independent Auth verification,
  receipt/observation, polling/reconciliation, consent and membership sync engines.
  Provider clients, protocol/key mapping, copy and activation remain host-owned.
- Require explicit egress admission for supported injected network senders.
  Guarded transports validate fresh host decisions, redirect sink sends and
  suppress drops before network entry; provider names grant no admission.
  Capture remains local acceptance. Preserve the maintained reference transport
  through its trusted composition bridge and keep Auth/provider verification separate.
- Add Polish/English invoice, role, opt-out and inquiry default-content factories
  with whole-copy injection. Preserve implicit Polish invoice and existing role
  expectations; EN invoice is construction-time opt-in. Reference opt-out page
  copy, EN legacy/error text, document language and escaping change deliberately.
  Pure inquiry rendering activates no sender. See the
  [B1/B2 expectation inventory](../../docs/platform/plans/oss-m04-communications-triggers.md#b1-egress-boundary).
- Add an opt-in immutable composition-time purpose registry with mandatory
  classification and finite legacy defaults. Registration grants no consent,
  provider activation or managed schema permission; custom-purpose persistence
  stays with the host. Add neutral newsletter processing and marketing ports
  without a runner or a new public purpose.
- Add four bounded native store groups: delivery observation/readback, existing-rail
  membership sync, operator notification recipients and durable consent decisions.
  Append CREATE-only direct catalogue position 70,
  `20261019200000_communications_native_operations.sql`, and its exact sparse
  projection. Standard factory lanes refuse unsafe effective privileges.
  Sync uses `public.outbox_events`; the sidecar is not another executor.
- Compose selected native readback and atomic signed-token preferences with Core
  readiness, explicit provider/binding identities and host-supplied clocks and
  schedules. Add distinct opt-in operator evidence and installed substitute-provider
  proof. Captured, network-accepted and membership-synced are not delivered.
  Native consent excludes managed 16-hour / 2-day / 4-week caps and legacy
  contact-touching, and is not a send-time fence. No default cadence, deployment
  activation, full native general sender or UI package capability is added.
  [T07 destinations](../../docs/platform/plans/oss-m04-communications-triggers.md#t07-destination-matrix)
  remain explicitly open with their owning modules.
- @openlup/platform size growth: added the reviewed neutral communications runtime and browser content contracts, bounded native stores and SQL projection, and their API/adoption documentation.

Migration: `0.16.0` did not export communications. Upgrade the complete package
set to `0.17.0` for the exact core peers, then explicitly select and bind the new
experimental capability. Existing non-communications entries retain their contracts.
The host retains renderer/copy, environment, origin, egress, provider protocol,
credentials and schedule ownership. The generic HTTP helpers do not replace the
independent Auth Standard Webhooks or provider-specific verification protocols.

Install the complete selected direct canonical catalogue through position 70
before selecting native stores. `COMMUNICATIONS_MIGRATIONS` projects positions
2, 9, 20 and 70; never reapply these sparse files over an existing canonical
history or treat them as a standalone chain. Preserve managed/private lineage
and custom-purpose persistence: registering a purpose does not expand managed
CHECKs. Thread the same registered purpose union and registry through selected
policy, token, newsletter and store bindings; omitted arguments retain finite
legacy defaults and existing signing bytes.

`registerNativeSyncWorkInTransaction` is a trusted host transaction seam. Its
caller-owned executor must already hold the lane's safe effective privileges;
this function does not check those privileges. The caller owns the transaction
and must commit or roll back permission, sidecar and existing-rail effects
atomically. Use a safely admitted lane; the helper grants no provider or claim
authority. Standard native sync factory transactions check
`public.communication_native_sync_state`, `public.outbox_events` and
`public.communication_recipient_consents`.

Custom native stores must provide binding-scoped `findByMessageId`, bounded
`listEvidence` (1–100) and atomic `registerPreference` as declared by the new
surface. Supply explicit provider/binding identities and full catalogue admission.
Hosts preserving older opt-out page bytes retain their own presentation binding;
token purposes, verification and existing HTTP status/header semantics remain.
See the [package composition guidance](README.md#communications-import).

Growth reading: +61.4% against the retained initial `0.16.0` baseline (256,973
packed bytes), measured before S1 notes at 414,808 bytes; final S1 measurements
are recorded in the programme evidence. No cap is changed. Baseline evidence
(2026-10-20): the published `0.16.0` tarball is 257,434 packed bytes, SHA256
`030756175d61279aab0ae7b26b27783e08467ec93673f5623d19d0b7fc436463`.
S1 option B retains the initial release-gates baseline rather than replacing it
with this observed registry identity.

## [0.16.0]

- Publishable on the npm `latest` dist-tag as `0.16.0`, from tag
  `openlup-platform-v0.16.0`.

- Add the experimental identity capability at `./identity` and browser-safe
  `./identity/contracts`: role-based authorization, actor-scoped profiles,
  bounded normalized contact matching, unconfirmed soft accounts with explicit
  email-trust policies, and configured-origin magic-link redirect resolution.
- Add operator invitations with transactional pending acceptance, expiry,
  cancellation and revoked re-invitation for direct stores, and immediate active
  membership with repeat/concurrent recovery for managed stores. Direct operator
  login uses single-use email challenges, operator-audience sessions, live
  membership authorization, explicit first-administrator bootstrap and bounded
  challenge pruning. An opt-in OIDC access-token verifier provides pinned issuer
  discovery, bounded rotating JWKS, strict claim validation and deterministic
  issuer/subject principals for direct composition.
- Add versioned personal-data contributors, identity export and transactional
  direct erasure with contributor vetoes, challenge/invitation cleanup,
  pseudonymization, guarded operator revocation and idempotent receipts. Managed
  export reports incomplete coverage; managed erasure refuses with
  `MANAGED_PRIVACY_ERASURE_UNAVAILABLE` without mutation. Issued tokens may remain
  valid until expiry.
- Add seven byte-identical identity SQL projections and host-selected module
  schema readiness. The projections retain canonical migration identities and
  positions; they are not a standalone installation chain.

Migration: identity adoption is opt-in; upgrade the complete package set together
for the exact `@openlup/core` `0.16.0` peer pin. Supply the selected bundle's schema
inventory, clients and delivery bindings, an explicit email-trust policy, exact
redirect origins, a distinct operator audience and a deployment policy for
admin, operator and privacy routes. Managed soft-account provisioning requires
an email-trust envelope with automatic confirmation disabled and all enabled
non-email providers declared email-verifying. Install the complete direct
catalogue through `20261018190000_identity_privacy_erasures` before enabling
identity; never reapply projections to an existing canonical history. Managed
adopters need their committed chain's
`20261018160000_identity_service_role_capabilities.sql` forward for contact linking
and operator membership capabilities, and must supply their own erasure path.

## [0.15.0]

- Publishable on the npm `latest` dist-tag as `0.15.0`, from tag
  `openlup-platform-v0.15.0`.

- First publication of `@openlup/platform`, the server substrate for an OpenLup application, with one module subpath each for `http`, `bff`, `scheduler`, `blob`, `data`, `migrations`, `job-ledger`, `kernel` and `composition`.
- Transport-neutral scheduled jobs: a `run(context)` contract, an empty job registry, a lease-aware runner and an authenticated HTTP cron entry, with a constant-time cron secret comparison.
- Per-capability bundle readiness that refuses an unknown bundle and reports every missing scheduler, lock and blob setting together.
- Blob capability selection with filesystem, Vercel Blob, Supabase Storage and S3 bindings; `pg`, `@types/pg` and `@aws-sdk/client-s3` are optional peers, and an adapter refuses a missing peer with `OPENLUP_E_PEER_MISSING`.
