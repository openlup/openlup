# M08 fulfillment and physical delivery

Development-preview programme record, 2026-10-21. P1 authoring base: `41a9477d`
on assigned branch `claude/oss-m08-p1-fulfillment`. Frozen inputs: coordinator C0
D0–D13, C2 decomposition/Author check, carrier fit G1–G13, path/export/source
registers and coordinator freeze. Donor V: C1 `d902ac7f4`, read from its local
`origin/main` source objects. These packets are implementation inputs, not authority
to execute their example commands or broaden scope.

## P1 outcome, authority and acceptance

Outcome: two additive platform subpaths with neutral fulfillment contracts,
unchanged contributed status logic, core parser binding and injected capability
selection. No new package, dependency, star export or testing subpath. The topology
check follows [package placement](../ARCHITECTURE_AND_EXTENSIONS.md#package-placement-decision-canonical):
no incompatible runtime, peer, lifecycle or consumer requires another artifact.
Platform maintains these experimental contracts; adapters and host policy remain
adopter-owned.

P1 candidates `bc4f9110` and repair `9328b676` are committed and were reviewed
by two independent cold PASS reports, as supplied by the coordinator. P1's final
candidate has eight authored cases and 33 paths. Commit/submission/native admission
and delivery remain coordinator responsibilities; this record does not grant them.
No adopter or staging endpoint is in P1 scope.

Acceptance: exact two entries and symbols in the frozen export register plus the
repair-1 prepare-result/envelope type amendment; type-only
browser contracts; concrete G1–G13 fit; unchanged status projection digest and
decisions; arrival discipline in port/platform docs; eight semantic cases; generated
boundary rows reported separately; focused lint/structural/API/consumer/policy
checks and actual tarball budgets. The inventory API generator retains its two
existing enum-order-only adjustments without changing value sets. Repair 1 removes
the module README and unreachable status helper, reuses architecture documentation
as the fulfillment owner, and keeps the whole candidate at 33 paths versus the
35-path cap. Actual diff including generated files must stay
at or below 35 paths. Exclusions: P2+ runtime orchestration, SQL/migrations,
composition, reference facade rewiring, UI, adapter implementation and release
set/version preparation. No native continuity, provider operation or stable
framework claim is made by P1.

## Frozen decisions

| Decision | Binding disposition |
| --- | --- |
| D0 | C0 admitted; C1 donor witnesses retained. No M08 merge before M07 S1; P1 local implementation only. |
| D1 | Existing platform package, only fulfillment and fulfillment/contracts. |
| D2 | Port freeze follows donor fit; G1–G13 below are approved amendments. |
| D3 | Private adapters/defaults/codecs stay private; direct carrier dormant, simulator separate; pickup lookup remains shipping-owned. |
| D4 | Managed/native graphs stay distinct; ten managed bodies equal at normalized-body scope, no native/runtime equivalence implied. |
| D5 | C1 additive witnesses unchanged (later pruned allocation is 31 cases). |
| D6 | Reconcile actual shared M07/A2 package companions; no unrelated source changes. |
| D7 | Note-only replacement confirmation unchanged, no caller; arrival discipline in alignment contract/platform page. |
| D8 | Serial P1→P2→P3→P4→P5a→P5b→P6→P7→S1, each at most 35 paths. Import unchanged before P6 refactor. |
| D9 | C2 forecast 89 authored cases/27s within 94/27 and outer 100/30; generated packageBoundary rows separate, all runtime charged. |
| D10 | Measure actual P1/final pack and all subcaps; no cap increase or guessed version. |
| D11 | Status map one package authoring source after explicit host adoption; existing host remains untouched in P1. OMS ladder/live queue remain together at host, no parallel mapper. |
| D12 | No activation, provider or host calls; later lifecycle/installed proofs remain owed. |
| D13 | P4 appends native fence/alignment and real-PG proofs; late arrival uses outer max once, undelivered successors remain outstanding. |

## Carrier fit and type/test ownership

| Amendment | Concrete owner and focused witness |
| --- | --- |
| G1 | dispatch.ts: mandatory fulfillmentRef, nullable parcelRef, contactRevision; contracts.test.ts |
| G2 | dispatch.ts adapter prepare returns actual-command fingerprint and sanitized DispatchEvidence before claim/begin; raw command stays transient; contracts.test.ts order/remap witness |
| G3 | store.ts read/prepare/claim/begin/finalize/acknowledge; claim and begin bind adapter-prepared evidence before dispatch; contact_stale requires fresh adapter prepare after remap; contracts.test.ts and portFit.test.ts |
| G4 | label.ts: durable LabelDocument versus transient read response; contracts.test.ts |
| G5 | label.ts: deletion confirmation distinct from canProceed; contracts.test.ts; capability per-op refusals in portFit.test.ts |
| G6 | observation.ts: core fact plus eventKind/eventKey/correlation (including external order/fulfillment refs)/tracking/diagnostics; portFit.test.ts |
| G7 | observation.ts: eventKey/firstReceivedAt independent of fact fingerprint/nullable occurrence; portFit.test.ts |
| G8 | capabilities.ts: token versus authenticated timestamp/freshness; observation authenticate-before-parse contract; portFit.test.ts |
| G9 | observation.ts diagnostics: 55P03 contention, annotation, recovered receipt and safe phase/retryable refusal; portFit.test.ts |
| G10 | readback.ts: found/absent(scope,proof)/unknown/unsupported; negative absence type check in portFit.test.ts |
| G11 | sync.ts: nullable sourceRevision/revisionSource, collection clock/run and sanitized continuation; portFit.test.ts |
| G12 | sync.ts: movements/lot/expiry, two-way pack operations, conflicts, replay/readBack/resolution; portFit.test.ts |
| G13 | capabilities.ts/providerCapabilities.ts: operation reasons, defaultOff, selected/readiness, auth/freshness and ownership; portFit.test.ts |

Private bytes, headers, commands and signed URLs are transient. Durable contracts
have no generic audit bag, raw pass-through or copied recipient proof. Safe strings
and opaque references still require host redaction/minting; P3 runtime projection
and A3 adapter conformance remain owed. Token authentication does not invent signed
freshness, collection identity does not invent provider ordering, and empty pages
never certify absence. M06 reservations/availability and M05 facts remain owners.

## Import provenance and enumerated neutralization

1. V `src/domains/fulfillment/statusMap.ts`: remove private provider trace type,
   per-stage provider vocabulary columns and private generation header. Retain all
   ranks, phases, canonical/local/FSM/order/alias tokens, effect metadata, labels,
   label keys and function branch order. W1 canonical projection SHA-256 stays
   `93ec11a68d386d2a742a2925154482766cd30380382b5836903b8039fe602023`.
   Type-only status/step declarations live in contracts; parity pins the duplicated
   literal status union to the map. No new provider dictionary is introduced.
2. V `src/domains/fulfillment/normalizedFulfillmentFacts.ts`: keep core parser
   calls and canonical-set predicate; rename application parser exports to
   parseFulfillmentFact/parseFulfillmentTransitionConflict. Omit unfrozen core
   re-exports; no schema or fingerprint implementation is copied. Use .js imports.
3. V `src/domains/fulfillment/status.ts` is omitted: its display/date/sort helpers
   have no reachable P1 export or witness. Tracking classifiers, URL constructors
   and private dictionaries remain host-owned; no unused helper is published.
4. V capability profile fields retain role, action policy, stock authority and
   delivered-notice ownership. Neutralize the private role to warehouse and closed
   provider union to host-injected opaque refs. The private static registry, aliases,
   environment/credential reads and default values stay host-owned. Runtime selector
   preserves provider-before-carrier/service validation and readiness separation;
   concrete per-operation reasons/auth/freshness fields implement G13. It performs no I/O.
5. Dispatch/label/observation/readback/sync/store/alignment declarations are the
   approved concrete packaging boundary from the fit probe, not claimed as byte-copy
   or whole-file donor parity. Recipient and line snapshots remain inputs; private
   product payload metadata is represented by existing opaque product/pack refs.
   Private codecs/builders keep actual command translation/fingerprints and keys.

Declared adaptation: empty/absent selection refuses with selection_required in
this new package. The donor host's empty-selection-to-simulator alias is deliberately
not imported, and the reference app is untouched. The donor alias remains an open
owner follow-up, not a donor logic edit or a P1 acceptance expansion. Migration:
none for existing public behavior; additive new surface only. F3/F5/F8 runtime
adaptations belong to P3, F4 legacy facade remains retained, F6 UI belongs to P5b,
F7 private defaults remain injected; F9 money SQL stays M07-owned.

## Proof, pack and handoff

Smallest adequate solution: concrete type envelopes and direct injected descriptor
lookup, with the contributed decision table unchanged. No generic plugin framework,
new persistence abstraction, dependency, fallback or runtime redaction process is
needed for P1. Main risks are lost carrier fields, invented external absence,
accidental activation, false arrival evidence and package/browser growth. Focused
type/runtime witnesses and actual artifact measurement address these; P1 does not
claim implementation conformance for the later workers/stores.

Run the three new suites and existing packageBoundary/cold-consumer tests, focused
TypeScript checks, structural/lint checks, publication policy/navigation, neutrality
and API report checks. Serialize generation/build/pack. The ordinary package gate
requires a clean committed tree. P1 repair verification used the existing
measurePack/checkPackBudget/browserEntryBytes helpers on npm-packed materialized
bytes before coordinator commit; those measurements are artifact previews, not
clean-tree admission.
Scratch logs/configs are under .context/scratch; existing cold-consumer fixtures
use system temporary directories and clean up their own output. The P1 report records actual case
counts/time, every pack cap/subcap, paths, checks and any delta-bound documentation
delta-bound documentation impact evidence for coordinator submission.

Original P1 measurement before repair: seven authored semantic cases; 1,432 generated
packageBoundary cases; platform pack 1,026,756 B packed / 4,582,014 B unpacked /
1,438 files; code gzip 882,636 B / 1,404 files; root-doc gzip 48,065 B / 5 files.
Root-doc headroom was 1,087 B against 49,152 B. Repair 1 measures 47,850 B
(1,302 B headroom, 215 B recovered); its final pre-commit artifact preview is 1,024,956 B packed /
4,577,081 B unpacked / 1,434 files, code gzip 882,715 B / 1,401 files. All caps
and browser subcaps pass. Repair-cycle checks and trailers are recorded in the
coordinator handoff report; P1 has two cold PASS reports. Provider implementation
conformance and final integrated admission remain separate obligations.

Known limits retained from the donor: capability lookup lowercases the selected
providerRef but compares it against the injected descriptor as supplied; case
normalization policy is unchanged. recordArrival still accepts parcelRef without
fulfillmentRef; native fence/alignment implementation and proof remain P4 work.

Self-retro: the pre-claim fingerprint gap required an adapter prepare operation;
a neutral-envelope hash could not preserve donor command identity. Removing the
unreachable helper and placing contract prose on the existing platform page
reduces shipped bytes and keeps one documentation owner. The focused order witness
also exercises contact_stale rebuilding, while later adapter conformance remains owed.
A verification retry overlapped the lint pre-hook build with declaration readers,
causing two transient failures; after the build completed, the full focused package
and cold-consumer suites passed. Lesson: serialize lint (including prelint) before
checks that read dist, rather than treating lint as a read-only phase.


## P2 outcome, authority and approved G14 amendment

P2 is stacked on frozen P1 `9328b676f28dfd08ccba159c25feb502e4c45ddd`,
in the assigned `claude/oss-m08-p2-fulfillment` worktree. The owner's delegated
coordinator authorizes local paid-handler/recovery, durable-ledger protocol,
dispatch/fence/acceptance/projection implementation and focused checks, plus G14.
The author leaves changes uncommitted: commit, native review, submission, merge
and release remain coordinator/human gates. No network except dependency install,
provider/account/secret access, SQL, other-worktree mutation, reference wiring,
money implementation, inventory authority, replacement-confirmation caller,
new subpath, package, dependency or version preparation is in scope.

G14 explicitly amends FulfillmentStorePort with recordProviderAttempt(attemptKey,
fulfillmentRef, preparedEvidence, mode, status: recorded), returning replayed.
It adds no exported type name. The host preserves the two existing attempt-key
byte strings through mappedAttempt(requestKey, mappedAttemptIndex): initial
mapping is index zero, a recorded mapping followed by contact remap is index one.
A claim refusal before recording does not consume the initial attempt index.
The separate write stays after authoritative claim readback and before shadow
exit, unsafe-status refusal or begin. It persists only sanitized DispatchEvidence,
mode and recorded status, with opaque fulfillment/key references. Same key means
replayed true and no second write; remapped recorded evidence has its own key.
P2's fixture proves ordering/key/redaction behavior; P3 owns store conformance.
All other P1 contract changes in P2 are explanatory comments only.

Smallest adequate solution: keep the contributed worker loop and injected ports;
represent the separately assigned durable command ledger as a structural protocol,
without a second local persistence/retry engine. Each ledger operation delegates
one atomic durable transaction and transition receipt to its store. Its token,
generation, expected version and lease jointly fence writes; store-side expiry
queues only pre-submission claims and makes submitting/accepted work uncertain.
Confirmation and uncertain retry require the donor's identity-bound proofs;
retry requires authoritative scoped absence, never a local missing row. P4 owns
SQL, atomicity, ACLs, contention, lease/time/proof validation and native proofs.
The ledger is separate from dispatch-reference draft/claim/begin state: the
factory's typed methods neither add methods to the frozen dispatch port nor
replace durable enforcement with an in-memory mock.

### P2 donor map and complete neutralization list

1. V commerce/outboxOrderPaidFulfillmentHandler.ts and its Ports.ts become
   paidHandoff.ts/paidHandoffPorts.ts. Preserve parse, optional risk gate,
   ensureFulfilledFromPaidOrder and outcome ladder. Reuse core outbox types;
   retain the frozen orderUuid payload subset, event vocabulary and 15s timeout.
   Inline the unchanged 300-character-plus-ellipsis truncation and subset parser
   rather than importing private server helpers. M07 paid truth and M06 inventory
   stay inside the injected fulfillment port; P4 owns the concrete durable bridge.
   A successful obligation precedes the handler result and the outbox ACK.
2. V commerce/paidFulfillmentRecovery.ts becomes paidFulfillmentRecovery.ts.
   Replace the fixed provider token with an injected providerRef, the private
   dispatch collection name with dispatchRefs, and private reason prefixes with
   provider_. Preserve status ladders, latest-row tie behavior, age defaults,
   recovery posture, null/missing fields and sorting. Row shapes remain structural
   host read projections; no provider selection/default or money truth is invented.
3. V fulfillment/omnipackDispatchWorker.ts becomes providerDispatchWorker.ts.
   Rename symbols/reasons neutrally. Private command building and external calls
   become adapter prepare/dispatch, actual-command fingerprints remain supplied
   unchanged. Host listCandidates/request/mappedAttempt/acceptance keys preserve
   original byte identities; the optional clock only supplies the donor sweep time.
   Store read/prepare/readCandidate/claim/readback/attempt/begin/ACK/finalize replace
   the corresponding donor port names, with typed refusal results replacing the
   private contact-stale exception classifier. Preserve one remap across claim
   AND begin, and the separate mapped-attempt index. A correctable draft re-claim
   atomically replaces fingerprint and evidence together. Non-draft states never
   automatically POST. Shadow requires command preparation but performs no POST.
4. V dispatch acceptance/error helpers become providerDispatchAcceptance.ts and
   providerDispatchError.ts. Typed store records/results replace private RPC bags;
   opaque acceptance keys are supplied, never re-prefixed. Accepted-proof repair
   calls only local ACK; failed ACK reads back then finalizes accepted proof as
   uncertain with externalRef retained. The next worker can close the ACK without
   another POST. Adapter structured failure translation retains may-have-succeeded
   classification in not_dispatched(false) versus unknown(true); an unclassified
   throw after dispatch remains unknown. Never copy private error messages or
   response bodies into diagnostics: neutral fixed reasons replace those strings.
5. V 20260714160000_fulfillment_provider_command_ledger.sql supplies the separate
   providerCommandLedger.ts protocol: preserve identity/fingerprint fields,
   enqueue/claim/fenced submit/outcome/confirm/reconcile/resolve/release/expiry
   operations and their proof distinctions. Neutralize field names to refs;
   private role/SQL implementation remains outside P2. No local state store,
   generated fingerprints, lease takeover, retry scheduler or SQL is added.
6. dispatchProjection.ts is the new exhaustive typed projection: copy the five
   prepared-evidence fields, including only the three contactRevision fields,
   and the exact accepted/not_dispatched/unknown result union. It strips runtime
   extra properties without changing opaque keys or fingerprints; no raw command,
   recipient, headers, body, credential or signed URL is durable attempt evidence.
   Internal helpers/types are not new entry exports. Four frozen P2 values are
   exported only from the existing fulfillment entry.

### P2 advisory closure and proof boundary

(a) remapCount remains bounded at one; mappedAttemptCount is independent.
Draft refresh is atomic for fingerprint plus evidence, then read back before the
attempt write. (b) absent/mismatched adapter preparation refuses exactly
reason not_dispatchable, phase dispatch, retryable false, before I/O.
(c) FulfillmentStorePort.prepare is contact readiness/withholding;
FulfillmentDispatchPort.prepare builds transient command bytes and returns proof.
(d) P1's committed candidates/two cold PASS reports and eight cases are recorded
above; this section records P2's distinct uncommitted implementation boundary.

Eight additional authored cases in the existing fulfillment test directory cover
the paid handler/recovery ladder, claim/begin remap bound, order and redaction,
shadow/key replay/unsafe statuses, lost ACK before/after commit, ambiguous/definite
provider failures, and ledger fence/proof transport. Existing P1 cases remain.
Generated packageBoundary rows are separate and their execution time is charged.
Fixture stores establish worker behavior/protocol transport only; P3 conformance
and P4 real-database fences/expiry/transactions/proofs remain owed. Adapter absence
or mismatched preparation refusal is documented here; P3 owns its conformance.

Run only the coordinator's focused build/test/type/API/structural/eslint/neutrality,
pack/root-doc and policy/navigation checks, serializing phases that mutate dist.
Keep platform README unchanged and compare actual diff paths against the 35 cap.
The external P2 report records exact measurements, trailers, failures and stops.
No clean committed admission, provider activation or stable-framework claim is made.

P2 self-retro: checking the source register distinguished the separately assigned
ledger protocol from the frozen dispatch store; an initial fence-gap concern was
withdrawn before edits. Lesson: compare the owned protocol boundary before
requesting a port amendment; preserve G14 as the only P1 signature change.
