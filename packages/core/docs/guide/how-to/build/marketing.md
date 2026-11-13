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
server composition. The [marketing
reference](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/README.md#marketing-contracts)
describes the surrounding package boundary.

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
direct handlers. Case list/count factories also require `isDirect`. Select the
factories for the routes you expose:

- `createAcquisitionCaseListDirectHandler` and
  `createAcquisitionCaseActiveCountDirectHandler` for case reads;
- `createPrelaunchAcquisitionListHandler` and
  `createPrelaunchAcquisitionDetailHandler` for prelaunch projections;
- `createAcquisitionSurveySubmitDirectHandler` and
  `createAcquisitionSurveyListDirectHandler` for evidence;
- `createAcquisitionNewsletterConsentDirectHandler` for an already verified
  consent event.

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
