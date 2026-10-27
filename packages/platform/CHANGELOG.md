# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Declaration snapshots track candidate drift, not a stable API or
SemVer promise. This file keeps the current release and the two previous ones;
earlier releases are recorded verbatim in `packages/platform/CHANGELOG-HISTORY.md`
in the source repository.

## [Unreleased]

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
