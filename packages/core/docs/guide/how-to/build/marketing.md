# Compose marketing handlers

Compose acquisition, survey and newsletter-consent handlers around your
application's authorization, storage and communications ports. Keep route
mounting, consent signature verification and notification presentation in your
application.

## Choose the import boundary

| Import from | Use it for |
| --- | --- |
| `@openlup/platform/marketing` | Browser-safe acquisition, prelaunch, evidence and research validators |
| `@openlup/platform/marketing/contracts` | Type-only request, result and port contracts |
| `@openlup/platform/marketing/server` | Node handlers, survey orchestration and privacy bindings |
| `@openlup/platform/marketing/server/postgres` | PostgreSQL acquisition case and evidence ports; install the optional `pg` peer |
| `@openlup/platform/composition` | `createMarketingContribution` for already-bound operations and host registrations |

The Node-only server entry requires no optional database driver. The browser
entry does not re-export the server entries. Select PostgreSQL only in your
server composition. Runtime validators initialize in CSP-safe mode; the
contracts entry performs no runtime initialization. Rich application intake
contracts and retired command schemas stay in your application. The tester
case port supplies list, get, active count and close; persisted tester locales
remain `en|pl`, while partner inquiries use `und`. Installing a package does
not widen those stored values or mount routes.

## Bind acquisition and consent

Import `createAcquisitionCaseHandlers` and the type `AcquisitionCasePort` from
`@openlup/platform/marketing/server`. Provide that port to the handler factory.
For native persistence, use
`createPostgresAcquisitionCasePort({ connectionString })`; evidence uses
`createPostgresAcquisitionEvidencePort({ connectionString })`. Both accept an
optional `poolFactory`, execute calls inside a transaction with
`SET LOCAL ROLE platform_acquisition_runtime`, and expose `close()` for teardown.
Your login must be able to select that role and the installation must contain
the acquisition routines.

Bind a `BffResponder`, `authorize` and `resolveBinding` when constructing the
direct handlers. Case list/count factories also require `isDirect`. Select only the routes you expose from the
[API report](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/api/marketing-server.api.md).

The active-count handler and public survey submission do not call `authorize`.
Apply your route admission policy before invoking them. Survey submission
requires an `idempotency-key` header. The newsletter handler accepts an event
value, not a signed HTTP request: verify the raw signature in your application
before calling it. You also own route dispatch and any retired-route responses.

Missing bindings and failed operations return `UPSTREAM_UNAVAILABLE`.
Malformed requests return `BAD_REQUEST`; conflicting evidence returns
`CONFLICT`. Case/prelaunch reads validate the outgoing response and can return
`INVALID_RESPONSE`. Evidence handlers forward successful port values unchanged,
so a custom evidence port must uphold its result contract.

## Bind partner inquiries

Use the strict partner case/list/transition and inquiry submit schemas from
`@openlup/platform/marketing`, the `PartnerAcquisitionPort` type from its
contracts entry and `createPostgresPartnerAcquisitionPort` from the PostgreSQL
server entry. Supply `connectionString` and optionally `poolFactory`; the pool
opens lazily and `close()` disposes it. Install the complete selected
[catalogue](../../upgrade/database-migrations.md), including partner routines.

Submit, list and transition calls use a transaction with
`SET LOCAL ROLE platform_acquisition_runtime`. Retain original command keys,
expected versions and returned cursors: replay returns the original receipt,
and lists use descending creation-time/ID tuples. Validate input and authorize
operators before invoking the port. SQL checks actor UUID presence, not admin
membership. Select the neutral `partner_acquisition_v1` list view explicitly.

The submit schema accepts `openlupInternalCheck`; translate another intake
sentinel in your application. Schema acceptance alone does not establish SQL
acceptance: `OTHER` country input and phone numbers beginning with zero after
the `+` normalization fail the stored constraints. A `closed_won` transition
records pipeline progress only; it creates no customer identity, consent or
external notification. Partner personal-data export/erasure is unavailable;
marketing privacy coverage below does not cover this resource. Retained audit
and receipts are append-only, and store transfer with nonempty partner state
requires a separate owner path.

## Bind research and notifications

`createResearchSurveySubmitHandler` takes a responder and
`MarketingResearchSurveySubmitPort`. `createAdminSurveyResponsesHandler` takes a
responder, `MarketingResearchSurveyResponsesReadPort` and `authorizeAdmin`.
Both validate requests and responses. The admin handler returns `UNAUTHORIZED`
when authorization returns false.

For managed survey persistence, use `createManagedSurveyResponseSubmit` with
a `ManagedSurveyResponseGateway`, a `PublicIntakeDeliveryPort` from
`@openlup/platform/communications/contracts`, recipient and sender configuration,
rate-limit settings, `renderNotificationHtml` and `notificationSubject`.
The gateway supplies rate checking, insertion and email-status updates.

The survey row is inserted before notification work. Recipient policy filtering
precedes rendering. HTML receives survey type, opaque answers and row ID; the
subject function receives a later clock reading. Their returned strings reach
the delivery port unchanged. Email-status updates are best effort and do not
undo the row. Missing recipients or policy rejection can return a successful
submission with `email_skipped`.

Submission failures distinguish `invalid_response_data`,
`survey_rate_limit_unavailable`, `survey_rate_limited` and `db_insert_failed`.
Handle these before treating the survey as saved.

## Select privacy ownership

Import `createMarketingPrivacyBindings`, `MarketingAcquisitionPrivacyPort` and
`MarketingRemoteErasurePort` from `@openlup/platform/marketing/server`, using
type imports for the ports. Supply `randomId`, both complete ports and
`enabled: true`. Register the returned contributor with identity and pass
`callables` as `marketing` to `createMarketingContribution`, together with your
version, schema requirements, handlers, schedules and routes.

The returned `exportPersonalData`, `assessErasure` and `eraseOrRetain` callables
are the selected contributor methods themselves.

The acquisition owner supplies record export, content-free evidence, assessment
and erasure/retention. The
remote owner supplies read-only outcomes and transactional `openAndFence`. Use
identity's resolved subject and transaction context; your unit of work must
atomically persist or roll back the fence and local erasure. Keep preparation
and assessment free of effects. Identity completes all assessments, including
subscription vetoes, before erasure/retention. A failed or throwing fence aborts
the unit of work without a receipt; owner error text is not echoed. Receipt
replay follows identity's existing path.

Disabled or partial bindings select no contributor and expose null callables;
missing ports report `OPENLUP_E_PORT_MISSING`. Unresolved ownership in an erasure
assessment causes identity to refuse `PRIVACY_OWNERSHIP_UNDECLARED` before owner
effects. A failed owner call throws `marketing_privacy_owner_failed`; an invalid
or missing fence throws `marketing_privacy_fence_required`.

Remote profile export remains unavailable. An accepted erasure request retains
`REMOTE_ERASURE_ACCEPTED_NOT_OBSERVED`: acceptance does not prove deletion.
Pending, requested, failed and unbound cases retain distinct reason codes.
Waiting imports and pending targets remain obligations. These bindings perform
no remote provider call; your application owns that worker and its retries.
These bindings add no scheduler or persistence schema. Raw managed
questionnaires and other processors are outside the acquisition privacy
coverage.

## Describe the selected operations

Pass already-bound operations, version and schema requirements, handlers,
schedules and routes to `createMarketingContribution`. Null operations remain
required ports without executable bindings. The contribution keeps supplied
port, route and schedule functions; handlers become registration descriptors.
Duplicate identities throw `marketing_duplicate_handler`,
`marketing_duplicate_schedule` or `marketing_duplicate_route`. Construction
calls no operation and mounts no worker, route or schedule. The contribution
declares an identity-contract dependency for privacy obligation validation.

## Admit analytics events

Use `createNoopAnalytics` when no analytics implementation is selected.
`AnalyticsEventMap<StepName>` accepts your application's step vocabulary;
transport envelopes and private ownership fields stay in your application.

For a browser data layer, supply `createAnalyticsDataLayer` with browser/storage
access, the consent key and change event, event prefix, container reader and
deployment callback. Each instance owns its loader readiness. Configure
`consentSignalNames` with the analytics wire name and ordered advertising wire
names. Without signals, no consent command or optional event is admitted;
deployment attempts remain independent. Optional events also require a browser
and a configured container.

Choose `consentPolicy` deliberately:

| Policy | Optional event admission | `pushAnalyticsConsentUpdate(true)` |
| --- | --- | --- |
| `analytics-only` (default) | Stored analytics grant | Caller grants analytics; advertising follows stored marketing consent |
| `independent` | Either stored analytics or marketing grant | Each signal follows its stored purpose |
| `host-authorized` | Also before choice or after refusal | Each signal follows its stored purpose |

`pushAnalyticsConsentUpdate(false)` denies every signal in every mode. It does
not change the admission policy. Consent defaults precede updates when the
factory creates the queue, and commands use array-like arguments. Gate private
routes and every tag by purpose in your application; denied-state transmission
needs explicit authorization for each consent-aware tag. The factory neither
inspects tag behavior nor minimizes payloads. Queue admission creates no consent
or storage authority. Sinks are attempted independently and isolate failures;
observations made before admission are not replayed. Returned booleans mean
local synchronous acceptance, never delivery or attribution.

`createAnalyticsRoutePolicy` needs public paths, redirect sources and all
sensitive-path sets. Optional-route eligibility excludes the sensitive paths;
deployment URL sanitization additionally checks the declared public paths,
redirect sources or supplied additional public paths and retains only safe
campaign values. `projectPaidPurchase` projects structural
paid recap facts with ordered suppression reasons, item limits and money
allocation, using the recap's currency. Authorize historical-consent processing
before `selectMarketingHistoricalConsentTime`; it selects chronology without
changing the local grant. For page metadata, follow
[SEO and content slots](seo-and-content-slots.md).

## Bind the analytics context endpoint

Construct `createAnalyticsContextHandler` from the server entry with a BFF
responder, enable reader, persistence resolver, access-token reader,
server-verified subject resolver, token mint/hash functions, cookie name and
`clientIdField`. The strict request accepts `granted`, your client-ID field and
`explicitGrant`. A grant requires a client ID; replacing a revoked context
requires an explicit new grant. Only token hashes reach persistence, and only
the verified subject can enroll subscriptions. Persistence operations must
reject on failure.

Mount the handler yourself. It checks POST, enablement, same HTTPS origin and
schema before persistence. Invalid bearer grants return `UNAUTHORIZED` before
writes; a null or failed store returns `UPSTREAM_UNAVAILABLE`. The cookie is
HttpOnly, Secure and SameSite=Lax; responses after synchronization are no-store.
Supply your persistence and gateway authority: there is no default store or
portable SQL for this endpoint. An `active` response describes the local
context, not telemetry delivery; analytics failure must not gate commerce.
