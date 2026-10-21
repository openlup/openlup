# M08 fulfillment and physical delivery

Development-preview programme design and contents. Frozen inputs are C0 decisions
D0–D13, C2 decomposition, carrier-fit amendments G1–G14 and the export/source
registers. Donor V is Velipet C1 `d902ac7f4`. Donor material supplies provenance,
not authority to execute example commands or broaden scope.

## Combined contents and boundary

The combined P1+P2 change contains neutral fulfillment contracts, unchanged
contributed status logic, core parser binding, injected capability selection,
a paid-order outbox handler, recovery classification, dispatch orchestration,
sanitized evidence projection and a durable command-ledger protocol.

Only `@openlup/platform/fulfillment` and
`@openlup/platform/fulfillment/contracts` are added. The contracts entry is
type-only and browser-shareable. There is no new package, dependency, star export
or testing subpath. Under the canonical
[package placement decision](../ARCHITECTURE_AND_EXTENSIONS.md#package-placement-decision-canonical),
no incompatible runtime, peer, lifecycle or consumer requires another artifact.
Platform maintains the experimental contracts; adapters and host policy remain
adopter-owned. The [fulfillment architecture section](../ARCHITECTURE_AND_EXTENSIONS.md#fulfillment-contracts)
is the documentation owner.

Excluded: SQL/migrations, concrete adapters and persistent stores, mounted
executors/routes, reference facade rewiring, UI, money implementation, inventory
authority, replacement-confirmation callers, version preparation and release.
Provider/account/secret access, activation, adopter/staging endpoints and external
operations are outside this scope. This record grants no delivery authority and
makes no native-continuity, provider-operation or stable-framework claim.

## Frozen decisions

| Decision | Binding disposition |
| --- | --- |
| D0 | C0 is the design boundary; retain C1 donor witnesses. M07 S1 is an M08 integration prerequisite; P1 is local implementation only. |
| D1 | Existing platform package, only fulfillment and fulfillment/contracts. |
| D2 | Freeze ports against donor fit; G1–G13 are approved amendments, with G14 approved separately below. Arrival-only replacement confirmation applies. |
| D3 | Private adapters/defaults/codecs stay private; direct carrier dormant, simulator separate; pickup lookup remains shipping-owned. |
| D4 | Managed/native graphs stay distinct; equality of the ten managed bodies is confined to normalized-body scope, with no native/runtime equivalence implied. |
| D5 | Preserve C1 additive witnesses unchanged within their 31-case allocation. |
| D6 | Reconcile shared M07/A2 package companions; no unrelated source changes. |
| D7 | Note-only replacement confirmation unchanged, no caller; arrival discipline belongs in the alignment contract and platform page. |
| D8 | Programme order is P1→P2→P3→P4→P5a→P5b→P6→P7→S1, with a 35-path cap per PR including generated files. Import unchanged before P6 refactoring. |
| D9 | Target 89 authored cases within the 94-case/27-second module budget and outer 100-case/30-second cap. Count generated packageBoundary rows separately; charge all execution time. |
| D10 | Validate package artifacts and every subcap; no cap increase or guessed version. |
| D11 | One package status-map authoring source after explicit host adoption; reference composition is unchanged here. OMS ladder/live queue remain together at the host, with no parallel mapper. |
| D12 | No activation or live provider/host calls; lifecycle and installed-consumer proofs belong to their later lanes. |
| D13 | P4 owns native fence/alignment and real-PostgreSQL proofs; late arrival uses outer max once, and undelivered successors remain outstanding. |

## Export register

The runtime entry exports only these values; internal helper types are not entry
exports. The four orchestration values are the P2 contribution within the same
entry, alongside the P1 status/parser/selection values.

| Source | Exported values |
| --- | --- |
| statusMap.ts | FULFILLMENT_STATUS_MAP, CANONICAL_LOCAL_FULFILLMENT_STATUSES, CUSTOMER_STEP_SEQUENCE, canonicalStatusToken, stepForToken, customerStepFromSignals, phaseIndexForStep, stepLabelKey, timelineLabelForStep, trackingPhaseKeyForStep, stepUsesTruckIcon |
| normalizedFulfillmentFacts.ts | parseFulfillmentFact, parseFulfillmentTransitionConflict |
| providerCapabilities.ts | readFulfillmentCapabilities |
| paidHandoff.ts | createOutboxOrderPaidFulfillmentHandler |
| paidFulfillmentRecovery.ts | collectPaidFulfillmentRecoveryCandidates |
| providerDispatchWorker.ts | runFulfillmentDispatchWorker |
| providerCommandLedger.ts | createFulfillmentCommandLedger |

The contracts entry exports only these types, including the prepare-result and
evidence envelopes. G14 adds a method, not an exported type name.

| Source | Exported types |
| --- | --- |
| dispatch.ts | DispatchEvidence, FulfillmentDispatchPrepareResult, FulfillmentSelection, FulfillmentDispatchRequest, FulfillmentDispatchResult, FulfillmentDispatchPort, FulfillmentRefusal |
| label.ts | LabelDocument, FulfillmentLabelPort |
| observation.ts | FulfillmentObservation, FulfillmentObservationPort, FulfillmentTrackingReference |
| readback.ts | FulfillmentReadbackResult, FulfillmentReadbackPort |
| sync.ts | SyncCursor, StockSnapshot, StockMovement, LocalStock, FulfillmentStockSyncProvider, FulfillmentStockSyncPort, FulfillmentProductSyncProvider, FulfillmentProductSyncPort |
| capabilities.ts | FulfillmentCapabilityDescriptor |
| store.ts | DispatchRecord, FulfillmentStorePort, FulfillmentPaidHandoffPort |
| alignment.ts | DeliveryAlignmentPort |
| contracts/index.ts | CanonicalLocalFulfillmentStatus, CustomerFulfillmentStep |

## Carrier fit and type/test ownership

Contract sources are under `packages/platform/src/fulfillment/contracts/`;
runtime sources are under `packages/platform/src/fulfillment/`, and witnesses
are under `packages/platform/test/fulfillment/`.

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
| G11 | sync.ts: nullable sourceRevision/revisionSource, collection clock/run and sanitized continuation; portFit.test.ts |
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
recorded evidence has its own key. Store conformance belongs to P3.

Private bytes, headers, commands and signed URLs are transient. Durable contracts
have no generic audit bag, raw pass-through or copied recipient proof. Safe
strings and opaque references require host redaction/minting. Token authentication
provides no signed freshness; collection identity provides no provider ordering;
empty pages never certify absence. M06 owns reservations/availability and M05 owns
catalog facts. Runtime conformance belongs to P3 and adapter conformance to A3.

## Donor provenance and neutralization register

All donor paths below refer to V. Public destinations are relative to
`packages/platform/src/fulfillment/` unless specified otherwise.

| Donor → public file | Preserved behavior and neutralization |
| --- | --- |
| src/domains/fulfillment/statusMap.ts → statusMap.ts | Remove private provider trace type, provider vocabulary columns and generation header. Preserve ranks, phases, canonical/local/FSM/order/alias tokens, effect metadata, labels, label keys, branch order and canonical projection. Type-only status/step declarations live in contracts; parity binds the duplicated literal status union to the map. No provider dictionary is added. |
| src/domains/fulfillment/normalizedFulfillmentFacts.ts → normalizedFulfillmentFacts.ts | Keep core parser calls and canonical-set predicate; rename application exports to parseFulfillmentFact/parseFulfillmentTransitionConflict. Omit unfrozen core re-exports; copy no schema or fingerprint implementation; use .js imports. |
| src/domains/fulfillment/status.ts → omitted | Display/date/sort helpers have no reachable export or witness. Tracking classifiers, URL constructors and private dictionaries remain host-owned. |
| Capability profile fields → contracts/capabilities.ts and providerCapabilities.ts | Retain role, action policy, stock authority and delivered-notice ownership. Neutralize private role to warehouse and closed provider union to host-injected opaque refs. Keep static registry, aliases, environment/credential reads and defaults host-owned. Preserve provider-before-carrier/service validation and readiness separation; G13 adds concrete operation reasons/authentication/freshness. Selection performs no I/O. |
| Carrier-fit declarations → contracts/{dispatch,label,observation,readback,sync,store,alignment}.ts | Concrete approved packaging, without whole-file donor parity claims. Recipient/line snapshots remain inputs; private product payload metadata uses opaque product/pack refs. Private codecs/builders retain command translation, fingerprints and keys. |
| commerce/outboxOrderPaidFulfillmentHandler.ts and its Ports.ts → paidHandoff.ts/paidHandoffPorts.ts | Preserve parse, optional risk gate, ensureFulfilledFromPaidOrder and outcome ladder. Reuse core outbox types; retain orderUuid payload subset, event vocabulary, 15-second timeout and 300-character-plus-ellipsis truncation. Inline the subset parser/truncation instead of private server helpers. M07 paid truth and M06 inventory stay behind the injected port. |
| commerce/paidFulfillmentRecovery.ts → paidFulfillmentRecovery.ts | Replace fixed provider token with injected providerRef, private collection name with dispatchRefs and private reason prefixes with provider_. Preserve status ladders, latest-row ties, age defaults, null/missing fields, sorting and recovery posture. Structural host read projections invent no provider default or money truth. |
| fulfillment/omnipackDispatchWorker.ts → providerDispatchWorker.ts | Rename symbols/reasons neutrally; replace private command building/calls with adapter prepare/dispatch and preserve supplied actual-command fingerprints. Host listCandidates/request/mappedAttempt/acceptance keys retain byte identities; the optional clock supplies sweep time. Typed store operations replace donor ports and typed refusals replace private contact-stale exceptions. |
| Dispatch acceptance/error helpers → providerDispatchAcceptance.ts/providerDispatchError.ts | Replace private RPC bags with typed records/results and supplied opaque acceptance keys. Retain may-have-succeeded distinctions; replace private error messages/response bodies with neutral fixed diagnostic reasons. |
| 20260714160000_fulfillment_provider_command_ledger.sql → providerCommandLedger.ts | Preserve identity/fingerprint fields and enqueue/claim/fenced submit/outcome/confirm/reconcile/resolve/release/expiry operations with their proof distinctions. Neutralize names to refs; private roles/SQL remain outside this change. |
| Approved evidence boundary → dispatchProjection.ts | Exhaustively project the five prepared-evidence fields, only the three contactRevision fields, and the accepted/not_dispatched/unknown result union. Strip runtime extra properties without changing opaque keys or fingerprints. Raw commands, recipients, headers, bodies, credentials and signed URLs are not durable attempt evidence. |

## Declared adaptations and runtime design

Empty or absent selection refuses with `selection_required`. The donor host's
empty-selection-to-simulator alias is excluded; the reference app is unchanged.
The donor alias remains host-owned. The surface is additive and requires no
migration of existing public behavior. F3/F5/F8 adaptations belong to P3; F4's
legacy facade is retained; F6 UI belongs to P5b; F7 defaults remain injected;
F9 money SQL stays M07-owned.

Every ACK path uses host acceptance keys, ignoring adapter-provided key fields:
main post-dispatch ACK, loop-start accepted-proof recovery and concurrent begin.
Keys are never re-prefixed. A lost response after a committed ACK must replay
with the same host bytes, without another acceptance attempt or provider POST.
Accepted-proof recovery calls only local ACK. If ACK fails, read back and finalize
accepted proof as uncertain with externalRef retained; another worker can close
the ACK without another POST. Structured adapter failures distinguish
`not_dispatched`/effectMayHaveSucceeded false from `unknown`/true; an unclassified
throw after dispatch remains unknown.

Keep the contributed worker loop and injected ports. One contact remap covers
claim and begin; remapCount is bounded at one and mappedAttemptCount is independent.
A correctable draft re-claim atomically replaces fingerprint and evidence, followed
by authoritative readback before the attempt write. Non-draft states never
automatically POST. Shadow prepares a command but performs no POST.
`FulfillmentStorePort.prepare` checks contact readiness/withholding;
`FulfillmentDispatchPort.prepare` builds transient command bytes and returns proof.
Absent/mismatched preparation refuses with reason `not_dispatchable`, phase
`dispatch`, retryable false, before I/O.

The paid handler completes its injected obligation before its result and outbox
ACK. The donor OrderPaidFulfillmentPort in paidHandoffPorts.ts retains its outcome
ladder; P4/P7 composition bridges it to FulfillmentPaidHandoffPort, with P4 owning
the concrete durable bridge.

The command ledger is a structural protocol separate from dispatch-reference
draft/claim/begin state. Each operation delegates an atomic durable transaction
and transition receipt to its store. Token, generation, expected version and
lease jointly fence writes. Store expiry queues only pre-submission claims and
makes submitting/accepted work uncertain. Confirmation and uncertain retry require
identity-bound proofs; retry needs authoritative scoped absence, never a missing
local row. There is no second local persistence/retry engine, generated fingerprint,
lease takeover or retry scheduler. P4 owns SQL, atomicity, ACLs, contention,
lease/time/proof validation and native proofs.

## Arrival discipline, limits and risks

D2/D7 preserve the subscription invariant: a late delivery extends the next cycle;
the monotonic clamp must never stack deliveries or move a cycle earlier. A
replacement may settle delivery alignment as `aligned` only after it reached the
customer. Its superseded predecessor is no longer an outstanding obligation, but
an in-flight or undelivered replacement still is. Never call
`subscription_delivery_alignment_confirm_replacement` for a replacement that did
not arrive: the operation records the customer-facing fact "Parcel delivered"
and shifts the cycle later. The note-only operator attestation is unchanged and
has no caller here; P4 owns native alignment and continuity proof.

Known donor limits: capability lookup lowercases selected providerRef but compares
it with injected descriptors as supplied, retaining case asymmetry. recordArrival
accepts parcelRef without fulfillmentRef; native fence/alignment belongs to P4.
Fixture stores establish worker behavior and protocol transport, not durable
atomicity, expiry, lease enforcement or database proof validity.

Main risks are lost carrier fields, invented external absence, accidental
activation, false arrival evidence, replay-key drift and package/browser growth.
Use concrete type envelopes, direct injected descriptor lookup and the unchanged
decision table; no generic plugin framework, dependency or persistence abstraction
is needed. Contract/status-parity/port-fit witnesses, paid/recovery ladders,
claim/begin remap bounds, ordering/redaction, shadow/replay/unsafe statuses, lost
ACK before/after persistence, ambiguous/definite provider outcomes and ledger
fence/proof transport define the affected verification surface. Package-boundary
and cold-consumer checks cover entry isolation. Validate structural/lint, types,
API, neutrality, publication policy/navigation and artifact/browser budgets;
serialize generation/build/pack and phases that mutate dist. Inventory API
enum-order adjustments must preserve their value sets.
