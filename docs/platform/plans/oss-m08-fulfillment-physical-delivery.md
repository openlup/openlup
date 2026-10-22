# M08 fulfillment and physical delivery

Development-preview programme design and contents. The boundary is recorded in
decisions D0–D13, carrier-fit amendments G1–G17, the approved
[replacement, operator, customer-projection, host-read and renewal-admission amendments G18–G23](#lifecycle-handlers-and-customer-projections), and the export/source
registers below. Donor source provenance is `d902ac7f4`. Donor material supplies
source provenance for the neutral contracts and behavior described here.

## Combined contents and boundary

The combined contracts and orchestration change contains neutral fulfillment
contracts, unchanged contributed status logic, core parser binding, injected capability selection,
a paid-order outbox handler, recovery classification, dispatch orchestration,
sanitized evidence projection and a durable command-ledger protocol. Observation
reconciliation adds verified ingress, effects, tracking, stock/product sync,
read-only evidence handlers and offline adapter/store fixture conformance. Native
persistence adds shipment, dispatch, paid-handoff, recovery, observation and stock
stores, command fencing, delivery alignment and sparse migration projections.
Lifecycle handlers add commerce fulfillment list/detail reads, operator mutations
and replacement requests through injected host callbacks. Label lifecycle,
current-parcel and customer alignment helpers remain callable without route mounting.

Fulfillment uses `@openlup/platform/fulfillment`,
`@openlup/platform/fulfillment/contracts` and the existing
`@openlup/core/fulfillment` subpath. Core owns pure presentation and canonical
parser binding; platform retains compatibility re-exports and server orchestration. The contracts entry is
type-only and browser-shareable. There is no new package, dependency, star export
or testing subpath. Under the canonical
[package placement decision](../ARCHITECTURE_AND_EXTENSIONS.md#package-placement-decision-canonical),
no incompatible runtime, peer, lifecycle or consumer requires another artifact.
Platform maintains the experimental contracts; adapters and host policy remain
host-owned. The [fulfillment architecture section](../ARCHITECTURE_AND_EXTENSIONS.md#fulfillment-contracts)
is the documentation owner.

The account order tracking stepper uses actual-evidence progress from
`fulfillmentProgressPresentation`. A reference operator page and status component
ship unmounted and opt-in; the host owns access and mounting.

Excluded: concrete provider adapters, mounted executors/routes,
mounted operator UI integration, money implementation, inventory
authority, replacement-confirmation callers, version preparation and release.
Provider/account/secret access, activation, deployment endpoints and external
operations are outside this scope. Native continuity, provider operation and
stable-framework support are not established by this design.

## Frozen decisions

| Decision | Binding disposition |
| --- | --- |
| D0 | Retain contributed characterization witnesses. Integration requires the payments and money-truth boundary; this change adds contracts and callable orchestration without activation. |
| D1 | Existing core fulfillment subpath for pure presentation; existing platform fulfillment and fulfillment/contracts subpaths for compatibility and orchestration. |
| D2 | Freeze ports against donor fit; G1–G23 are approved amendments, described below. Arrival-only replacement confirmation applies. |
| D3 | Private adapters/defaults/codecs stay private; direct carrier dormant, simulator separate; pickup lookup remains shipping-owned. |
| D4 | Managed and native execution graphs stay distinct; no runtime equivalence is implied. |
| D5 | Preserve contributed characterization witnesses unchanged within their 31-case allocation. |
| D6 | Reconcile shared payment-contract and payment-adapter package companions; no unrelated source changes. |
| D7 | Note-only replacement confirmation unchanged, no caller; arrival discipline belongs in the alignment contract and platform page. |
| D8 | The ordinary cap is 35 paths per pull request, including generated files. Preserve contributed logic before refactoring. Explicit host composition, callable lifecycle integration and offline installed-consumer proof are included. The host renewal-admission decorator is included under G23. Native runner composition, mounted operator UI and activation remain excluded. |
| D8 amendment | The approved combined contracts and orchestration change has a ≤55-path regroup cap, including generated files; this amends the ordinary 35-path cap. |
| D9 | Target 89 authored cases within the 94-case/27-second module budget and outer 100-case/30-second cap. Count generated packageBoundary rows separately; charge all execution time. |
| D10 | Validate package artifacts and every subcap; no cap increase or guessed version. |
| D11 | Host status-map, normalized-fact and current-parcel facades delegate to @openlup/core/fulfillment with existing host names and private provider trace metadata. Order UI imports core progress values and types. Browser graphs declare only core fulfillment modules and exclude platform fulfillment, the preparation binding and account order screens. Explicit fulfillment composition has no default binder. The order-management status ladder and live queue remain together at the host, with no parallel mapper. |
| D12 | Callable lifecycle handlers, offline host fixtures and installed-consumer proof are included. The host renewal-admission decorator is included under G23. Native runner composition, activation, live provider/host calls and mounted operator UI remain excluded. |
| D13 | Native command fencing and delivery alignment use PostgreSQL transactions. Only new-cycle admission/insert is guarded; existing-cycle renewal and dunning retries bypass admission. Late arrival uses the monotonic maximum once, and undelivered replacements remain outstanding. |

## Export register

The [core fulfillment entry](../../../packages/core/src/fulfillment/index.ts) owns
these browser-shareable values and types. Its generic fact exports remain unchanged;
the canonical aliases narrow those generic types to CanonicalLocalFulfillmentStatus.

| Core source | Exported values or types |
| --- | --- |
| statusMap.ts | FULFILLMENT_STATUS_MAP, CANONICAL_LOCAL_FULFILLMENT_STATUSES, CUSTOMER_STEP_SEQUENCE, canonicalStatusToken, stepForToken, customerStepFromSignals, phaseIndexForStep, stepLabelKey, timelineLabelForStep, trackingPhaseKeyForStep, stepUsesTruckIcon, FulfillmentStatusStage, FulfillmentStatusMap |
| trackingProgress.ts | fulfillmentProgressPresentation |
| currentFulfillmentParcel.ts | currentParcel, currentParcelFor, currentParcelPerOrder, currentParcelFirst, belongsToParcel, rowsForParcel, parcelSequenceNo, compareParcelPrecedence, FulfillmentParcelRow, ParcelAttributedRow |
| normalizedFulfillmentFacts.ts | isCanonicalLocalFulfillmentStatus, parseFulfillmentFact, parseFulfillmentTransitionConflict, CanonicalNormalizedFulfillmentFact, CanonicalNormalizedFulfillmentFactV1, CanonicalNormalizedFulfillmentFactV0, CanonicalCompatibleNormalizedFulfillmentFact, CanonicalFulfillmentTransitionSnapshot, CanonicalTransitionConflict |
| types.ts | CanonicalLocalFulfillmentStatus, CustomerFulfillmentStep, FulfillmentProgressInput, FulfillmentProgressPresentation |

The platform statusMap, trackingProgress, currentFulfillmentParcel and
normalizedFulfillmentFacts files re-export these implementations. The last file
preserves its existing unprefixed narrowed type names through aliases; the
platform contracts entry re-exports shared status and progress types from core.
Core's status-map digest, progress matrices, current-parcel assertions and canonical
parser case live in `packages/core/test/fulfillment*.test.ts`; platform retains
label lifecycle and dispatch-contract tests. Host characterization witnesses
retain their existing source and imports.

The platform runtime entry exports only these values; internal helper types are not entry
exports. Dispatch, observation, sync, lifecycle handlers and projections share the
entry with status, parser and capability selection values. The register matches
the [runtime entry](../../../packages/platform/src/fulfillment/index.ts) and
[runtime API report](../../../packages/platform/api/fulfillment.api.md).

| Source | Exported values |
| --- | --- |
| statusMap.ts | FULFILLMENT_STATUS_MAP, CANONICAL_LOCAL_FULFILLMENT_STATUSES, CUSTOMER_STEP_SEQUENCE, canonicalStatusToken, stepForToken, customerStepFromSignals, phaseIndexForStep, stepLabelKey, timelineLabelForStep, trackingPhaseKeyForStep, stepUsesTruckIcon |
| bindings.ts | createFulfillmentServices |
| normalizedFulfillmentFacts.ts | parseFulfillmentFact, parseFulfillmentTransitionConflict |
| providerCapabilities.ts | readFulfillmentCapabilities |
| paidHandoff.ts | createOutboxOrderPaidFulfillmentHandler |
| paidFulfillmentRecovery.ts | collectPaidFulfillmentRecoveryCandidates |
| providerDispatchWorker.ts | runFulfillmentDispatchWorker |
| providerCommandLedger.ts | createFulfillmentCommandLedger |
| verifiedIngress.ts | verifyAndNormalizeFulfillmentObservation |
| fulfillmentObservationEffects.ts | applyFulfillmentObservationEffects |
| providerReconciliationWorker.ts | reconcileFulfillmentObservations |
| providerStockSyncWorker.ts | runFulfillmentStockSyncWorker |
| providerProductSyncWorker.ts | runFulfillmentProductSyncWorker |
| lowStockEvidenceHandler.ts | createFulfillmentLowStockEvidenceHandler |
| productReconciliationEvidenceHandler.ts | createProductReconciliationEvidenceHandler |
| adapterConformance.ts | runFulfillmentAdapterConformance |
| postgresShipmentSpine.ts | createPostgresFulfillmentShipmentSpinePort |
| postgresEvidenceReadPort.ts | createPostgresFulfillmentLowStockEvidencePort |
| postgresStockSyncPort.ts | createPostgresFulfillmentStockSyncPort |
| postgresPaidFulfillmentRecovery.ts | createPostgresPaidFulfillmentRecoveryOpsPort |
| postgresDispatchStore.ts | createPostgresFulfillmentDispatchStore |
| postgresPaidHandoffStore.ts | createPostgresPaidFulfillmentHandoffStore |
| postgresDeliveryAlignment.ts | createPostgresDeliveryAlignmentPort |
| deliveryAlignmentReadModel.ts | readDeliveryAlignment |
| schemaCapabilities.ts | FULFILLMENT_NATIVE_CAPABILITIES |
| migrations.ts | FULFILLMENT_MIGRATIONS |
| commerceFulfillmentHandlers.ts | createAdminCommerceFulfillmentOrdersListHandler, createAdminCommerceFulfillmentOrderDetailHandler, createAdminCommerceFulfillmentCreateOrderHandler, createAdminCommerceFulfillmentRecordProviderAttemptHandler, createAdminCommerceFulfillmentRecordLabelHandler, createAdminCommerceFulfillmentHandOffHandler, createAdminCommerceFulfillmentTrackingEventHandler, createAdminCommerceFulfillmentCancelOrderHandler |
| replacementShipmentHandler.ts | createAdminCommerceOrderRequestReplacementShipmentHandler |
| handlerSupport.ts | CommerceFulfillmentConflictError |
| delayReadModel.ts | readFulfillmentDelay |
| labelLifecycle.ts | readFulfillmentLabel, cleanupFulfillmentLabel |
| currentFulfillmentParcel.ts | currentParcel, currentParcelFor, currentParcelPerOrder, currentParcelFirst, belongsToParcel, rowsForParcel, parcelSequenceNo, compareParcelPrecedence |
| nativeUnsupported.ts | FULFILLMENT_NATIVE_UNSUPPORTED, createNativeUnsupportedFulfillmentPorts |
| replacementRefusals.ts | FULFILLMENT_REPLACEMENT_REFUSALS |
| commerceFulfillmentReadModel.ts | buildCommerceFulfillmentOrdersListResponse, buildCommerceFulfillmentOrderDetailResponse |
| shipmentsOverviewHandler.ts | createFulfillmentShipmentsOverviewHandler |
| trackingProgress.ts | fulfillmentProgressPresentation |

The contracts entry exports only these types, including the prepare-result and
evidence envelopes. G14–G17 amend methods, fields or inline inputs without new
type names; offline conformance adds the subject and evidence types. G18–G21 add
replacement, operator, customer-alignment and host-read types with a shared native
refusal. G22 supplies the host preparation binding. The contracts entry also exposes
FulfillmentServicesOptions and FulfillmentServices for explicit service selection,
readiness and dispatch. The read contracts include tracking-progress input and presentation.
The register matches the [contracts entry](../../../packages/platform/src/fulfillment/contracts/index.ts)
and [contracts API report](../../../packages/platform/api/fulfillment-contracts.api.md).

| Source | Exported types |
| --- | --- |
| bindings.ts | FulfillmentServicesOptions, FulfillmentServices |
| dispatch.ts | DispatchEvidence, FulfillmentDispatchPrepareResult, FulfillmentSelection, FulfillmentDispatchRequest, FulfillmentDispatchResult, FulfillmentDispatchPort, FulfillmentRefusal |
| label.ts | LabelDocument, FulfillmentLabelPort |
| observation.ts | FulfillmentObservation, FulfillmentObservationPort, FulfillmentTrackingReference |
| readback.ts | FulfillmentReadbackResult, FulfillmentReadbackPort |
| sync.ts | SyncCursor, StockSnapshot, StockMovement, LocalStock, FulfillmentStockSyncProvider, FulfillmentStockSyncPort, FulfillmentProductSyncProvider, FulfillmentProductSyncPort |
| capabilities.ts | FulfillmentCapabilityDescriptor |
| store.ts | DispatchRecord, FulfillmentStorePort, FulfillmentPaidHandoffPort |
| alignment.ts | DeliveryAlignmentPort |
| conformance.ts | FulfillmentAdapterConformanceSubject, FulfillmentAdapterConformanceEvidence |
| contracts/index.ts | CanonicalLocalFulfillmentStatus, CustomerFulfillmentStep |
| nativeUnsupported.ts | FulfillmentNativeUnsupported |
| replacement.ts | FulfillmentReplacementPort, FulfillmentReplacementRequest, FulfillmentReplacementResult |
| operator.ts | FulfillmentOperatorMutationPort, FulfillmentOperatorMutationResult |
| customerAlignment.ts | CustomerDeliveryAlignment, FulfillmentCustomerAlignmentRowsReader |
| read.ts | FulfillmentCommerceReadPort, FulfillmentCommerceReadPolicy, FulfillmentOrderStatus, FulfillmentPaymentStatus, FulfillmentCommerceOrder, FulfillmentOrdersListRequest, FulfillmentOrdersListResponse, FulfillmentOrderDetailRequest, FulfillmentOrderDetailResponse, FulfillmentShipmentsOverviewPort, FulfillmentShipmentsOverviewRequest, FulfillmentShipmentsOverviewResponse, FulfillmentProgressInput, FulfillmentProgressPresentation |

`createFulfillmentContribution` is exported from the existing `./composition`
entry. Its structural callables declare the selected ports, event descriptors,
schedules and routes; core readiness rejects duplicate event, schedule and route ownership. The bundle
composer accepts an explicit fulfillment binder and supplies no default.

## Lifecycle handlers and customer projections

The approved amendments extend the injected host boundary:

| Amendment | Contract and behavior |
| --- | --- |
| G18 | [replacement.ts](../../../packages/platform/src/fulfillment/contracts/replacement.ts) adds FulfillmentReplacementPort, FulfillmentReplacementRequest and FulfillmentReplacementResult. requestReplacementShipment requires actorUserId and idempotencyKey and returns a replacement/operation receipt with replayed, or FulfillmentNativeUnsupported. The host owns atomic paid/contact/current-parcel/hold/reservation checks and actor-bound replay receipts. The port neither dispatches nor confirms arrival. |
| G19 | [operator.ts](../../../packages/platform/src/fulfillment/contracts/operator.ts) adds FulfillmentOperatorMutationPort and FulfillmentOperatorMutationResult for create, provider-attempt, label, handoff, tracking-event and cancellation callbacks. Every input requires actorUserId and idempotencyKey; callbacks return a lifecycle receipt with replayed, or FulfillmentNativeUnsupported. The host owns atomic effects and replay receipts. |
| G20 | [customerAlignment.ts](../../../packages/platform/src/fulfillment/contracts/customerAlignment.ts) adds CustomerDeliveryAlignment (protected or aligned) and FulfillmentCustomerAlignmentRowsReader. The reader returns host rows or FulfillmentNativeUnsupported. [readFulfillmentDelay](../../../packages/platform/src/fulfillment/delayReadModel.ts) exposes protected cases and aligned cases whose aligned schedule equals the subscription's current next-cycle schedule; absence from the map means no current customer case. Manual-review and advanced aligned history are hidden; the projection changes no schedule or delivery fact. |
| G21 | [read.ts](../../../packages/platform/src/fulfillment/contracts/read.ts) adds FulfillmentCommerceReadPort and FulfillmentShipmentsOverviewPort for host-owned list, detail and overview read callbacks, with FulfillmentCommerceReadPolicy for host eligibility. Payment status passes through unchanged from the payments projection and is never recomputed. Overview bucket rows and counts remain host-owned, with no native substitution. List, detail and overview callbacks accept the shared FulfillmentNativeUnsupported refusal. |
| G22 | [m08FulfillmentBinding.ts](../../../server/runtime/public-reference/m08FulfillmentBinding.ts) binds one transaction lane, store, provider and readiness observer. Preparation locks the native dispatch identity then the shipment row, reads authoritative host facts and upserts only contact revision, provider and withholding. editAuthoritative requires actorUserId and idempotencyKey; its host closure owns authorization and replay receipts and edits the source in that same locked transaction before synchronization. Every authoritative contact/selection/withholding edit must use this route. Disabled, capability-selection/readiness and unsupported-dispatch refusals take precedence over FULFILLMENT_NATIVE_UNSUPPORTED for a missing binding; all precede worker invocation. Activation is explicit and default-off; construction registers no route, schedule or dispatch. |
| G23 | [deliveryAlignmentRenewalStore.ts](../../../server/runtime/subscription/deliveryAlignmentRenewalStore.ts) decorates the existing automatic-renewal admission hook in host code. The static terms gate runs first and its refusals remain terminal. A typed native alignment denial returns `deferred` from the runner and batch without a refusal write: the operation stays claimed until lease expiry, when the same schedule can be offered again. Admission uses the runner’s observation time, with a decorator clock fallback for direct callers. Existing cycles and their dunning retries bypass native admission; prepared attempts bypass the hook in the runner. Off with no non-terminal captured case returns the static result without calling admission. Captured cases retain their authority after rollback to off; other modes call the existing native admission routine before new-cycle preparation. Enforcing inserts consume the exact-schedule receipt once. A host that composes the native automatic-renewal runner must wrap its store port with this decorator; until it does, native delivery-alignment mode stays off or shadow. The runner recognizes only that typed deferral; no runner composer, factory or production entrypoint is supplied, and no package export, migration, SQL routine change, route or schedule is added. |

The [commerce handlers](../../../packages/platform/src/fulfillment/commerceFulfillmentHandlers.ts),
[overview handler](../../../packages/platform/src/fulfillment/shipmentsOverviewHandler.ts)
and [replacement handler](../../../packages/platform/src/fulfillment/replacementShipmentHandler.ts)
check the method, authorize, validate the request, invoke the host callback and
validate the response. Mutation handlers supply the authorized actor. Commerce
list/detail callbacks return their response shapes (or null for a missing detail),
and the overview callback returns the host bucket rows and counts. List, detail,
overview, replacement and operator callbacks also accept the
[shared native refusal](../../../packages/platform/src/fulfillment/contracts/nativeUnsupported.ts);
their handlers translate FulfillmentNativeUnsupported to UPSTREAM_UNAVAILABLE.
[createNativeUnsupportedFulfillmentPorts](../../../packages/platform/src/fulfillment/nativeUnsupported.ts)
returns that refusal for replacement, operator mutations, customer alignment
rows, commerce list/detail and shipments overview without a database executor
or partial write.

[Label helpers](../../../packages/platform/src/fulfillment/labelLifecycle.ts) delegate
storage reads and actor/idempotency-bound cleanup; a missing cached label proves
no parcel absence, and canProceed does not confirm deletion.
[Current-parcel helpers](../../../packages/core/src/fulfillment/currentFulfillmentParcel.ts)
select by sequence then identifier descending and retain unattributed companion
rows. These handlers and helpers mount no route. Inspect the
[lifecycle handler](../../../packages/platform/test/fulfillment/lifecycleHandlers.test.ts),
[replacement/delay](../../../packages/platform/test/fulfillment/replacementDelay.test.ts)
and [label/tracking](../../../packages/platform/test/fulfillment/labelTracking.test.ts)
witnesses for their host fixture and refusal boundaries.

## Carrier fit and type/test ownership

Platform contract sources are under `packages/platform/src/fulfillment/contracts/`;
server orchestration and compatibility exports are under `packages/platform/src/fulfillment/`,
with witnesses under `packages/platform/test/fulfillment/`. Pure presentation and
canonical parser binding belong to `packages/core/src/fulfillment/`, with the
corresponding witnesses under `packages/core/test/`.

| Amendment | Concrete owner and focused witness |
| --- | --- |
| G1 | dispatch.ts: mandatory fulfillmentRef, nullable parcelRef, contactRevision; contracts.test.ts |
| G2 | dispatch.ts: adapter prepare returns actual-command fingerprint and sanitized DispatchEvidence before claim/begin; raw command stays transient; contracts.test.ts order/remap witness |
| G3 | store.ts: read/prepare/claim/begin/finalize/acknowledge; claim and begin bind adapter-prepared evidence before dispatch; contact_stale requires fresh adapter prepare after remap; contracts.test.ts and portFit.test.ts |
| G4 | label.ts: durable LabelDocument versus transient read response; contracts.test.ts |
| G5 | label.ts: deletion confirmation distinct from canProceed; contracts.test.ts; capability per-operation refusals in portFit.test.ts |
| G6 | observation.ts: core fact plus eventKind/eventKey/correlation (including external order/fulfillment refs)/tracking/diagnostics; portFit.test.ts |
| G7 | observation.ts: eventKey/firstReceivedAt independent of fact fingerprint/nullable occurrence; portFit.test.ts |
| G8 | capabilities.ts: token versus authenticated timestamp/freshness; observation authentication before parsing; portFit.test.ts |
| G9 | observation.ts: 55P03 contention, annotation, recovered receipt and safe phase/retryable refusal; portFit.test.ts |
| G10 | readback.ts: found/absent(scope,proof)/unknown/unsupported; negative absence type check in portFit.test.ts |
| G11 | sync.ts: nullable `sourceRevision`; non-null `revisionSource` is `"provider" \| "collection" \| "unknown"`; collection clock/run and sanitized continuation; portFit.test.ts |
| G12 | sync.ts: movements/lot/expiry, two-way pack operations, conflicts, replay/readBack/resolution; portFit.test.ts |
| G13 | capabilities.ts/providerCapabilities.ts: operation reasons, defaultOff, selected/readiness, authentication/freshness and ownership; portFit.test.ts |
| G14 | Approved amendment to FulfillmentStorePort: recordProviderAttempt(attemptKey, fulfillmentRef, preparedEvidence, mode, status: recorded), returning replayed; idempotent sanitized mapped-attempt persistence. |

G14 preserves host attempt-key bytes through
`mappedAttempt(requestKey, mappedAttemptIndex)`: initial mapping is index zero;
a recorded mapping followed by contact remap is index one. A claim refusal before
recording does not consume the initial index. Write after authoritative claim
readback and before shadow exit, unsafe-status refusal or begin. Persist only
sanitized DispatchEvidence, mode, recorded status and opaque fulfillment/key
references. The same key returns replayed true without a second write; remapped
recorded evidence has its own key. The native dispatch store implements this
idempotent write through `fulfillment_record_provider_attempt`.

Private bytes, headers, commands and signed URLs are transient. Durable contracts
have no generic audit bag, raw pass-through or copied recipient proof. Safe
strings and opaque references require host redaction/minting. Token authentication
provides no signed freshness; collection identity provides no provider ordering;
empty pages never certify absence. Inventory owns reservations/availability and
catalog owns product facts. Native persistence and offline adapter/store fixture
conformance have distinct verification boundaries described below.

## Donor provenance and neutralization register

Donor paths below refer to the provenance revision above. Public destinations are relative to
`packages/platform/src/fulfillment/` unless specified otherwise. statusMap.ts and
normalizedFulfillmentFacts.ts are compatibility re-exports of the same-named core sources.

| Donor → public file | Preserved behavior and neutralization |
| --- | --- |
| src/domains/fulfillment/statusMap.ts → packages/core/src/fulfillment/statusMap.ts | Remove private provider trace type, provider vocabulary columns and generation header. Preserve ranks, phases, canonical/local/FSM/order/alias tokens, effect metadata, labels, label keys, branch order and canonical projection. Type-only status/step declarations live in core types.ts and platform contracts re-export them; parity binds the duplicated literal status union to the map. No provider dictionary is added. |
| src/domains/fulfillment/normalizedFulfillmentFacts.ts → packages/core/src/fulfillment/normalizedFulfillmentFacts.ts | Keep core parser calls and canonical-set predicate; rename application exports to parseFulfillmentFact/parseFulfillmentTransitionConflict. Omit unfrozen core re-exports; copy no schema or fingerprint implementation; use .js imports. |
| src/domains/fulfillment/status.ts → omitted | Display/date/sort helpers have no reachable export or witness. Tracking classifiers, URL constructors and private dictionaries remain host-owned. |
| Capability profile fields → contracts/capabilities.ts and providerCapabilities.ts | Retain role, action policy, stock authority and delivered-notice ownership. Neutralize private role to warehouse and closed provider union to host-injected opaque refs. Keep static registry, aliases, environment/credential reads and defaults host-owned. Preserve provider-before-carrier/service validation and readiness separation; G13 adds concrete operation reasons/authentication/freshness. Selection performs no I/O. |
| Carrier-fit declarations → contracts/{dispatch,label,observation,readback,sync,store,alignment}.ts | Concrete approved packaging, without whole-file donor parity claims. Recipient/line snapshots remain inputs; private product payload metadata uses opaque product/pack refs. Private codecs/builders retain command translation, fingerprints and keys. |
| commerce/outboxOrderPaidFulfillmentHandler.ts and its Ports.ts → paidHandoff.ts/paidHandoffPorts.ts | Preserve parse, optional risk gate, ensureFulfilledFromPaidOrder and outcome ladder. Reuse core outbox types; retain orderUuid payload subset, event vocabulary, 15-second timeout and 300-character-plus-ellipsis truncation. Inline the subset parser/truncation instead of private server helpers. Paid truth and inventory stay behind the injected port. |
| commerce/paidFulfillmentRecovery.ts → paidFulfillmentRecovery.ts | Replace fixed provider token with injected providerRef, private collection name with dispatchRefs and private reason prefixes with provider_. Preserve status ladders, latest-row ties, age defaults, null/missing fields, sorting and recovery posture. Structural host read projections invent no provider default or money truth. |
| The donor's provider dispatch worker → providerDispatchWorker.ts | Rename symbols/reasons neutrally; replace private command building/calls with adapter prepare/dispatch and preserve supplied actual-command fingerprints. Candidate selection stays host-injected; request/mappedAttempt/acceptance keys retain host-supplied bytes, and the optional clock supplies sweep time. Typed store operations replace donor ports and typed refusals replace private contact-stale exceptions. |
| Dispatch acceptance/error helpers → providerDispatchAcceptance.ts/providerDispatchError.ts | Replace private RPC bags with typed records/results and supplied opaque acceptance keys. Retain may-have-succeeded distinctions; replace private error messages/response bodies with neutral fixed diagnostic reasons. |
| 20260714160000_fulfillment_provider_command_ledger.sql → providerCommandLedger.ts | Preserve identity/fingerprint fields and enqueue/claim/fenced submit/outcome/confirm/reconcile/resolve/release/expiry operations with their proof distinctions. Neutralize names to refs; private roles/SQL remain outside this change. |
| Approved evidence boundary → dispatchProjection.ts | Exhaustively project the five prepared-evidence fields, only the three contactRevision fields, and the accepted/not_dispatched/unknown result union. Strip runtime extra properties without changing opaque keys or fingerprints. Raw commands, recipients, headers, bodies, credentials and signed URLs are not durable attempt evidence. |

## Declared adaptations and runtime design

Empty or absent selection refuses with `selection_required`. The donor host's
empty-selection-to-simulator alias is excluded; the reference app preserves its
selection and default-activation behavior.
The donor alias remains host-owned. The surface is additive and requires no
migration of existing public behavior. Native store implementations bind the
ports to PostgreSQL; concrete provider adapter integration remains separate.
The reference facade is retained. The account order tracking stepper uses
[actual-evidence progress](../../../packages/core/src/fulfillment/trackingProgress.ts)
through [OrdersScreen](../../../src/pages/account/v2/orders/OrdersScreen.tsx).
[ReferenceFulfillmentPage](../../../src/pages/ReferenceFulfillmentPage.tsx) and
[FulfillmentDeliveryStatus](../../../src/components/FulfillmentDeliveryStatus.tsx)
ship as an unmounted, opt-in operator example; mounted operator UI integration
remains outside scope. Defaults stay injected, and money SQL remains payment-owned.

Every ACK path uses host acceptance keys, ignoring adapter-provided key fields:
main post-dispatch ACK, loop-start accepted-proof recovery and concurrent begin.
Keys are never re-prefixed. A lost response after a committed ACK must replay
with the same host bytes, without another provider POST.
Accepted-proof recovery calls only local ACK. After dispatch returns accepted,
an ACK failure triggers readback: a matching committed acceptance settles locally;
otherwise the worker attempts to finalize accepted proof as uncertain with
externalRef retained so another worker can close the ACK without another POST.
Loop-start and concurrent-begin recovery ACK failures reach the outer catch as
`dispatch_local_operation_failed`, without this readback/finalize rescue.
Structured adapter failures distinguish
`not_dispatched`/effectMayHaveSucceeded false from `unknown`/true; an unclassified
throw after dispatch remains unknown.

Keep the contributed worker loop and injected ports. One contact remap covers
claim and begin; remapCount is bounded at one and mappedAttemptCount is independent.
A correctable draft re-claim atomically replaces fingerprint and evidence, followed
by authoritative readback before the attempt write. Non-draft states never
automatically POST. Shadow mode requires a configured provider adapter because
command preparation moved into the adapter (G2); it prepares a command but posts
nothing.
`FulfillmentStorePort.prepare` checks contact readiness/withholding;
`FulfillmentDispatchPort.prepare` builds transient command bytes and returns proof.
Absent/mismatched preparation refuses with reason `not_dispatchable`, phase
`dispatch`, retryable false, before I/O.

After payload validation, unless an enabled risk gate returns early, the paid handler awaits
`ensureFulfilledFromPaidOrder` before returning its outcome. Risk `review`/`block` returns
`processed` without calling fulfillment. Fulfillment `completed`, `skipped` and
`manual_review` also return `processed` and settle the event; this does not always
mean fulfillment completed. Outbox ACK follows the handler outcome in the outbox
worker. OrderPaidFulfillmentPort in paidHandoffPorts.ts retains this outcome
ladder; `createPostgresPaidFulfillmentHandoffStore` implements
FulfillmentPaidHandoffPort. Host composition supplies the bridge between the
handler outcome ladder and this obligation/acknowledgement port.

The command ledger is a structural protocol separate from dispatch-reference
draft/claim/begin state. Each operation delegates an atomic durable transaction
and transition receipt to its store. Token, generation, expected version and
lease jointly fence writes. Store expiry queues only pre-submission claims and
makes submitting/accepted work uncertain. Confirmation and uncertain retry require
identity-bound proofs; retry needs authoritative scoped absence, never a missing
local row. There is no second local persistence/retry engine, generated fingerprint,
lease takeover or retry scheduler. The native dispatch store binds these operations
to SQL routines; database conformance covers atomicity, access controls,
contention and lease/time/proof validation.

## Observation reconciliation and sync design

Observation reconciliation uses the existing runtime and type-only entries.
Private authentication, payload mapping, carrier codecs and persistence stay behind
injected ports. Native stores implement durable receipts and sync persistence;
no concrete provider adapter, route or scheduler is mounted.

| Amendment | Contract and behavior |
| --- | --- |
| G15 | SyncCursor adds optional coverageGapSkus; legacy absence reads as []. A sellable SKU has a gap when active reservations exceed provider for-sale stock. Confirmation requires membership in both the current set and the preceding succeeded cursor's set. The completed run stores the sorted current set on success, [] on failure; a running cursor also clears the set, breaking confirmation after interruption. |
| G16 | readLocalInventoryStock(requestedAt) returns unaggregated skuRef/quantity/fulfillable/locationStatus/lotStatus/expiresAt lines. Quantity retains onHand, reserved, unavailable and safetyStock. The worker sums only fulfillable, active-location, available-or-unset-lot lines with no expiry at or before requestedAt. Local stock and active reservations use the same captured clock; the provider stock-sync shape and inventory ownership are unchanged. |
| G17 | Inline localPersistence inputs split by worker: ingress requires atomic eventKey receipt persistence retaining firstReceivedAt and idempotent markProcessed; reconciliation reads local status/latestStatusOccurredAt/handedOverAt. No named persistence type is exported. Durable transactions, replay and recovery remain host obligations; page scheduling stays outside reconciliation. |

| Responsibility | Preserved behavior and neutral boundary |
| --- | --- |
| Observation effects | Await stock consumption, handover, each tracking reference and optional invoice in that order, with callbacks after the corresponding writes and failures propagating. Typed observations replace raw payloads; status policy and opaque effect keys are injected. |
| Verified ingress | The adapter authenticates untouched bytes before private parsing/mapping. observationProjection retains declared fact, correlation, tracking and diagnostics fields. Stable event keys and idempotent host writes support replay. Stock-contention annotation is best-effort and the original stock failure is rethrown; recovered-picked receipts remain typed diagnostics. Superseding-conflict classification stays injected. |
| Reconciliation | Typed readback replaces private page DTOs. Hosts supply page reads, correlation, acceptance, exception/invoice operations and original key bytes. Non-stale found observations for locally cancelled/exception rows write status evidence only. Older known occurrences skip status/effects, but an on-track row with handedOverAt can retry its invoice. Per-row failures remain isolated; classified state conflicts quarantine with safe typed detail. |
| Timestamp and tracking | Timestamp validation requires an explicit zone and valid calendar/time fields; invalid or absent times remain null. The status map defines the off-track set. Tracking keeps the first occurrence of each trimmed nonblank number; provider carrier evidence precedes delivery-carrier fallback. Carrier normalization and public URL construction are injected callbacks. |
| Stock | Typed snapshots, quantities and cursors replace private DTOs; hosts supply run/current/snapshot/evidence keys, stale-evidence sentinel and movement-window time zone. Preserve availability sums, freshness evidence, reservation comparison, packaging exclusion, per-item failures and stale-evidence recovery. These writes record snapshots and evidence; inventory retains availability ownership. |
| Product | Typed ports replace private interfaces; hosts supply collection identity and evidence keys. Missing push metadata skips the product; pushes add missing EANs and mark successful packs synced. Pull delegates ownership/conflict decisions, maps missing-SKU/EAN/locked-quantity conflicts to evidence, resolves inactive conflicts and isolates per-SKU failures. |
| Evidence readers | Inline HTTP shapes, injected responder and request/response parsers replace framework/schema imports. GET, authorization, validation and read retain that order; product reads retain safe authorization/read refusal details. No resolving mutation is exposed by these handlers. |
| Boundary proof | observationProjection and adapterConformance define allowlisted evidence and offline fixture checks; neither implements provider codecs or durable storage. |

For correlated ingress, a trimmed observation or dispatch external reference is
required before acceptance, status evidence, effects or the processed mark. A
missing/blank pair throws after receipt persistence, leaving the event unprocessed.
A classified superseding conflict returns superseded but marks only status
processed; G17 has no dedicated persisted superseded-reason field.

An unknown readback fails the reconciliation run before row processing. Unmapped
status evidence projects eventKey and declared correlation fields before host
calls; a correlated off-track row skips acceptance and quarantine. Otherwise the
external-reference guard precedes acceptance, then unknown-status quarantine.
The readback union is unchanged.

runFulfillmentAdapterConformance accepts readonly
FulfillmentAdapterConformanceSubject[] and returns sanitized
FulfillmentAdapterConformanceEvidence with subject/provider references and passed
operation records; a violated check throws. Adapter-owned offline fixtures cover
dispatch, labels, observations, readback and stock/product operations. Checks bind
prepared-command identity, mismatch refusal before I/O, requested replay, capability
refusals, exact absence scope/proof, local-missing unknown, selection and redaction.
An optional fresh host-store fixture checks mapped-attempt replay, remap keys and
draft re-claim evidence; a worker exercise caps contact remapping at one. Fixture
conformance does not establish native database atomicity or arrival alignment.

## Native persistence and mapping

The canonical forwards
[`20261022080000_fulfillment_command_ledger.sql`](../../../db/platform/migrations/20261022080000_fulfillment_command_ledger.sql)
and [`20261022090000_fulfillment_delivery_alignment.sql`](../../../db/platform/migrations/20261022090000_fulfillment_delivery_alignment.sql)
append command fencing and alignment. `FULFILLMENT_MIGRATIONS` supplies
byte-identical package projections of the shipment, stock, replacement, command
and alignment units. Install the complete canonical catalogue and preserve its
installed prefix; sparse projections are not an independent install chain.
Managed and native execution graphs remain distinct.

| Donor representation | Native representation |
| --- | --- |
| Fulfillment orders | `public.fulfillment_shipments` |
| `replaces_fulfillment_order_id` | `fulfillment_shipments.replaces_shipment_id` |
| Order subscription identity | `commerce_orders.subscription_cycle_id` → `subscription_cycles.subscription_id` → `subscriptions.id` |
| Cycle number | `subscription_renewal_operations.cycle_number`; missing correlation enters manual review |

The native dispatch store delegates candidate data and contact preparation to the
host. The [reference preparation writer](../../../server/runtime/public-reference/m08FulfillmentBinding.ts)
synchronizes `fulfillment_dispatch_contexts` during preparation and authoritative
contact/selection/withholding edits under the shipment lock. Its host reader uses
the same transaction, with no recipient payload copied into the context. Missing
candidate data deletes the context so submission refuses. The
[real PostgreSQL witness](../../../tests/postgres/fulfillmentPreparationBinding.test.ts)
exercises this writer, lock contention, atomic source edits, rollback and absent-binding refusal. Claim and
begin compare stored revisions with prepared evidence. Before submission the
store rechecks paid state, active holds, shipment status, port readiness and
selected provider. Direct and command lanes share a dispatch lock. Direct
submission supersedes only a pristine, never-claimed queued command; effect-bearing
history refuses it. Command claim refuses after direct submission or accepted
proof. ACK records the existing native `dispatch` evidence receipt, preserving
the cancellation fence without asserting an owned label or physical packing.

The native stores implement amendments G14–G17: mapped-attempt replay in the
dispatch store; coverage-gap cursors and the injected timed inventory-line reader
in the stock store; and atomic received/processed receipts, separate status
evidence and local chronology in the shipment store. Receipt time alone is not
applied status chronology. Inventory retains balance and reservation authority.
The native capability descriptor marks local inventory and contact preparation
as host-required, and product packs, provider access and automatic replacement
confirmation as unsupported.

All new routines, including helpers and trigger routines, execute as invokers.
No `SECURITY DEFINER` routine or new execution role is introduced. Access to new
objects is revoked from `PUBLIC`, `anon` and `authenticated`. The initial native
executor is the existing deployment owner. A separate service principal needs
an explicit least-privilege grant set for the called routines and underlying
objects; invoker execution does not elevate its privileges. See
[installation and grant boundaries](../DATA_AND_MIGRATIONS.md#module-catalogues-and-installed-histories).

## Native admission and delivery alignment

The D13 native translation guards only NEW cycle admission/insert, matching the
donor cycle-insert guard. `subscription_delivery_alignment_admit_renewal`
creates an allowed schedule-bound receipt and
`subscription_delivery_alignment_guard_cycle_insert` consumes it once in the
new-cycle transaction. Existing-cycle renewal-operation and dunning retries
never pass through admission and neither mint nor consume these receipts. There
is no `retry_scheduled` state or change to the payments lifecycle.

D13 maps donor activation cycle 1 ↔ native activation ordinal 0, and donor
renewal n+1 ↔ native renewal n. The activation ordinal requires a cycle with no
renewal operation whose linked order is the active `subscription_activations`
row's order for the same subscription. Renewal operation numbers remain ≥1.
Admission selects the highest known paid ordinal, so activation protects the
first renewal and each later paid renewal outranks activation. Successor
artifacts have a greater effective ordinal. Other unnumbered cycles remain
unordered: paid ones require manual review at due admission without minting a
receipt; other unordered cycles prevent automatic arrival alignment regardless
of scheduled date. They neither outrank known predecessors nor silently permit
an autonomous renewal. Shadow mode observes this ambiguity without blocking.

Automatic enforcement of the invariant "a late delivery extends the next cycle"
requires native delivery-alignment control mode `auto_align`. The singleton
`public.subscription_delivery_alignment_control.mode` defaults to `off` for
rollout safety, so installation alone does not enforce this invariant. The other
modes are `shadow` and `protect`, selected through
`public.subscription_delivery_alignment_set_mode`. Existing cases retain their
captured mode and protection when the control changes.

Enforcing modes (`protect`, `auto_align`) require the host's renewal path to call
`subscription_delivery_alignment_admit_renewal` before inserting the cycle.
The [native renewal store](../../../server/adapters/postgres/subscription/automaticRenewal.ts)
does not call it; a host that composes the native automatic-renewal runner wraps
that store port with the
[renewal admission decorator](../../../server/runtime/subscription/deliveryAlignmentRenewalStore.ts).
Without the decorator, an enforcing mode halts every autonomous renewal with
`subscription_delivery_alignment_admission_required`, so native installs keep
mode `off` or `shadow` until the host wraps the port.

The decorator distinguishes native alignment denials from static terms refusals.
Native denials produce a non-terminal `deferred` runner/batch result before
reservation or payment preparation, leaving the operation claimed with no
refusal write. Releasing a protect or manual-review case, or aligning without
extending the schedule, keeps that schedule eligible after the claim lease
expires; the due list does not offer it while the lease is active. This does not
revive previously refused operations or alter reservation-expiry recovery.
Admission receives the runner’s `occurredAt`, with the decorator clock used only
when a direct caller omits it.

In enforcing modes, a subscription whose paid history has no activation or
renewal link, such as imported data, holds every due renewal for manual review.
Operators should check for such cycles before switching modes.

Local pre-dispatch cancellation changes only the shipment locally: alignment
creates no hold or shipment-exception event and does not block other shipments
of the order. An undelivered, unsuperseded cancelled parcel still counts as
outstanding at renewal admission in `protect` and `auto_align`. An explicit
provider exception uses the existing fulfillment-exception hold and notification
rules; alignment observes that active hold to open a case only when control is not
`off`, the order belongs to a paid subscription cycle and the subscription is
active. One-time orders do not open alignment cases. Exception cases never
pause subscriptions.

For automatic alignment, trusted durable arrivals settle only when no
unsuperseded shipment remains undelivered. The target is the latest arrival plus
subscription cadence, clamped by the existing next-cycle date with `GREATEST`.
The operation neither stacks deliveries nor moves a cycle earlier, and replay
cannot extend a settled case again. Subscription locks precede case locks;
failed transactions roll back arrival and schedule changes together. Missing
correlation, open dunning or an existing renewal artifact prevents automatic
alignment; inactive subscriptions do not acquire a new autonomous renewal.

A replacement may settle alignment as `aligned` only after reaching the customer.
Its superseded predecessor is no longer outstanding, but an in-flight or
undelivered replacement still is. As required by the
[agent arrival-only rule](../AGENT_GUIDE.md#architecture-rules), never call
`subscription_delivery_alignment_confirm_replacement` for a replacement that did
not arrive: it records the customer-facing fact "Parcel delivered" and shifts
the cycle later. This remains a note-only operator attestation, with no machine
arrival predicate and no production caller in this surface.

## Limits and verification surface

Capability lookup lowercases selected providerRef but compares injected
descriptors as supplied. `recordArrival` accepts parcelRef without fulfillmentRef;
the native port resolves that parcel reference to a shipment. Fixture stores
establish worker behavior and protocol transport; real PostgreSQL tests cover
durable atomicity, expiry, leases, proof validity and arrival alignment.

Inspect the [native store contract](../../../packages/platform/test/fulfillment/postgresStore.test.ts),
[native conformance](../../../tests/postgres/fulfillmentNativeConformance.test.ts)
and [delivery alignment](../../../tests/postgres/fulfillmentDeliveryAlignment.test.ts)
for install/prefix/replay, dispatch fences, ACK recovery, arrival/replacement,
retry/admission, lock/rollback and denied-access boundaries. These tests are
verification sources, not a hosted installation or activation claim.

Main risks are lost carrier fields, invented external absence, accidental
activation, false arrival evidence and replay-key drift. Concrete envelopes,
injected selection and direct PostgreSQL bindings preserve these controls
without a new plugin framework or retry engine. Package-boundary, API,
neutrality, publication and artifact checks cover the exported surface.
