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

Candidate `bc4f9110` is committed on the assigned branch. Repair cycle 1 is a
working-tree-only handoff to the coordinator: local edits and focused verification,
with the report in the assigned P1 notes directory. Commit, submission, native
review and delivery remain coordinator responsibilities. This repair performs no
commit/push, network, secret/provider access, other-worktree operation or
scripts/agent-review-* execution. No adopter/staging endpoint is in P1 scope.

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
requires a clean committed tree; the working-tree repair uses its
existing measurePack/checkPackBudget/browserEntryBytes helpers on npm-packed
materialized bytes, report the limitation, and leave clean-tree admission owed.
Scratch logs/configs are under .context/scratch; existing cold-consumer fixtures
use system temporary directories and clean up their own output. The P1 report records actual case
counts/time, every pack cap/subcap, paths, checks and any delta-bound documentation
trailers still needed because commits are prohibited.

Committed-candidate baseline: seven authored semantic cases; 1,432 generated
packageBoundary cases; platform pack 1,026,756 B packed / 4,582,014 B unpacked /
1,438 files; code gzip 882,636 B / 1,404 files; root-doc gzip 48,065 B / 5 files.
Root-doc headroom was 1,087 B against 49,152 B. Repair 1 measures 47,850 B
(1,302 B headroom, 215 B recovered); its working-tree pack is 1,024,956 B packed /
4,577,081 B unpacked / 1,434 files, code gzip 882,715 B / 1,401 files. All caps
and browser subcaps pass. Repair-cycle checks and trailers are recorded in the
coordinator handoff report; this record claims no
native review, clean committed admission or provider implementation conformance.

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
