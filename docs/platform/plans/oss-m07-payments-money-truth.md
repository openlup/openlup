# M07 payments and durable money truth

## Scope and placement

Development-preview extraction into `@openlup/platform/payments` and its type-only `payments/contracts` entry. The existing platform package owns this capability; isolated subpaths suffice without a new package or core API change. C1 extraction identity: adopter commit `c86e5c27f`, eight witnesses and 33 cases. Provider translation, host configuration, local policy and existing reference composition retain their owners.

Prepared attempts preserve original cycle/order/frozen money and host key/fingerprint bytes. Unknown execution does not permit another dispatch. Late payment can move a cycle later only, never earlier or stacked. Replacement alignment still requires actual delivery. Source contribution establishes neither activation nor durable native-store parity.

## Ledger

| PR | Finite outcome | Predecessor |
| --- | --- | --- |
| P1 | Unchanged prepared mechanism and all neutral adapter contract envelopes | Main |
| P2 | Verified evidence, truth, reconciliation, method lifecycle and conformance; explicit refund-evidence default change | P1 |
| P3 | Native truth store and three unchanged canonical SQL projections with operation/refusal proof | P2 |
| P4 | Authorized repair/readback/status and useful reference composition | P3 |
| P5 | Compatibility refactor only, characterized behavior unchanged | P4 |
| P6 | Explicit host binding, readiness and single executor | P5 |
| S1 | Existing-set preparation and final installed artifact proof | P6 |

Each candidate stays within 35 paths. Shared registration companions add only their own entries; both publication JSON projections use repository generators. P1 ceilings: 18 production paths, 5,000 churn, 30 exports and 9 authored cases. Contracts browser budget is 32 bytes; existing pack caps and released baseline remain unchanged.

## P1 record

The prepared contracts, ordering mechanism and internal finalization retry are contributed with import-specifier changes only. The caller injects persistence, execution and failure policy; the reference facade is unchanged. Validation precedes preparation; replay refuses; trusted no-charge proof permits one retry; finalization retries the same immutable local acknowledgement without dispatching again.

Contracts cover execution/dispatch, transient hosted/client handoff, a core capability overlay, asynchronous raw-byte verification, distinct money/method evidence, exact readback/close/absence envelopes and ports, neutral refusal, three refund observation forms, a method lifecycle aligned with core lifecycle kinds, one adapter aggregate and multi-subject conformance fixtures bound to those ports. Receipt time is freshness-only; identity includes outcome class and fingerprints exclude receipt time. Transient secrets and opaque handoffs never enter persisted diagnostics. Refund policy is type-only in P1; the runtime change belongs to P2. Unknown, absence and unsupported remain distinct; timeout/truncation cannot establish absence.

The module graph declares payments without cross-module edges. It has no dedicated child-directory allowance mechanism; future example adapters use the existing module boundary and remain separately owned. No new allowance mechanism is added.

## Evidence and delivery boundary

No new migration, dependency, reference rewiring or provider implementation is included. Release and adopter activation keep their own authority. Example adapters may consume P1 types after merge; runtime conformance waits for P2.

## Completion evidence

P1 local candidate: 25 changed paths, eight production paths, 30 export pairs, 1,252 lines of churn; no new dependency or migration. Nine authored cases are present: four exact key-forwarding variants, three acknowledgement/replay variants and two browser/cold boundaries. The source scan adds 24 generated payment-file iterations, reported separately. No test is physically moved or removed. The tenth allocated case, W1 webhook identity, needs the ingress/truth runtime and moves to P2 (P1 9, P2 21; the module total is unchanged). Fixture currency uses the neutral `XXX` code: the mechanism forwards supplied money bytes unchanged, so the transcript shape is the witness's. These seven mechanism cases do not establish the original callers' key-generation behavior.

Focused root evidence: 1,287 passed across the payments, boundary, cold-consumer and retained prepared-attempt suites; package-local: 1,227 passed; retained core payment cases: 123 passed. Final root added test-body time: 4.62 ms prepared, 5.12 ms browser, 77.40 ms installed consumer, plus 7.74 ms generated iterations. These are local observations, not hosted medians or isolated module wall-time deltas.

Actual main to candidate pack: 1,197 to 1,221 files; 1,167 to 1,191 code files; 808,449 to 816,664 packed bytes; 3,647,166 to 3,686,378 unpacked bytes; 679,413 to 688,070 code gzip bytes. Root docs: 43,210 to 43,708 gzip bytes, five files unchanged. Contracts: 20/32 browser bytes. All caps and the released baseline remain unchanged.

Lint, compilation, builds, API checks, focused tests, publication policy and both neutrality checks pass. No native-store or runtime parity claim is made.

Self-retro: mixed-boundary witness allocation exposed a missing runtime dependency before review. Lesson: allocate each witness case to its actual exported runtime before freezing the case budget; use the repository validators directly for fragment format and package-local imports.

## P2 record

Local candidate: unchanged pinned donor truth, method/refusal, reconciliation, silence-window, verify-now and event-conformance algorithms, with type extraction and neutral carrier strings. A new boundary module projects the existing adapter envelopes into the donor carrier with exhaustive outcome mapping, original verification bytes, method object identity and durable first-receipt reuse. The P1 widenings are disputed money, optional core method lifecycle facts and an optional adapter-redacted audit payload shared by money and method evidence. F2 changes the refund default to require explicit evidence; full-reversal chargebacks use the existing dispute path. The reference runtime changes only refund policy and its existing test.

The 21 authored cases comprise W1 webhook identity (one), W3 ingress (six), W4 ambiguity (four), W5 refund forwarding (four), F2 (three) and adapter suites (three). Projection table and replay assertions are folded into those cases. Unknown never proves absence; refund snapshots are never converted into deltas. Conformance excludes handoffs and checks diagnostics for transient secrets. The selected real-store proof, external adapters and reference rewiring belong to later phases.

Final local delta against origin/main: 35 paths, 19 production paths, 36 frozen export additions and 4,437 lines of churn. There are 21 authored cases and 42 added generated source-boundary iterations (14 new production files across three existing matrices). No dependency, migration, public subpath or budget change.

Pinned P1 to candidate pack: 1,221 → 1,263 files, 816,142 → 859,785 packed bytes, 3,682,679 → 3,880,890 unpacked bytes and 687,246 → 730,691 code gzip bytes. Root docs: 43,708 → 44,056 gzip bytes, five files; contracts browser output remains 20/32 bytes. Every cap is respected.

Repair verification: focused root has 55 passes and one existing database-only skip under the offline brief; package-local has 29 passes. Lint (33 incumbent warnings), compilation, API and both neutrality checks pass. A refund event with missing or incomplete evidence is recorded and acknowledged but not applied. No release, activation or selected-store parity is claimed.

Self-retro: the existing invalid-reversal witness caught a dispute-route bypass after replacing throws with null. Gate chargeback projection on valid refund evidence so the existing require-evidence check remains the single refusal point. Serialize builds before tests because builds replace package output.

Package ingress stores adapter-filtered, redacted audit facts with nested normalized evidence, never the raw body. Typed evidence overrides overlapping reader facts; the optional audit bag supplies facts without typed homes. Adapter event identity and fingerprint exclude this bag and receipt time. Missing or incomplete refund evidence is ingested and acknowledged, but not applied under require-evidence.

Known limitations until P4 (method seams): method evidence does not yet carry reusable-method registration data, so package ingress does not support reusable-method persistence. Forwarding the adapter refusal envelope to hosts is also not yet supported.

## P3 record

The direct truth store is contributed with unchanged logic, using the existing
platform data executor structural shape, as in the inventory precedent. Its options DTO moves
to the contracts entry. Three byte-identical SQL projections retain canonical
positions 10/35/56, paths and hashes; the sparse descriptor is not an install
chain. Direct truth, settlement and later-only alignment are supported; prepared
durable storage, method setup, absence reopen and cumulative refund explicitly
refuse capability admission. Refunds are purely financial; no refund operation
cancels a subscription, and no activating-cycle cancellation exception applies.

Attempt inputs add optional method selection (opaque, persistable channelRef) and
transient payer email/name. Payer data is dispatch-only: never persisted, audited,
logged or diagnosed. Missing adapter-required input requires exact before-dispatch
notDispatched evidence. Conformance checks execution, diagnostics and the whole
projected audit payload for payer/secret leaks. Normalized stored evidence copies
an explicit typed field list, including nested money, reversal, refusal and method
lifecycle facts; it excludes unknown envelope properties.

AMENDMENT 1 drops the incomplete-chargeback reclassification: the donor applies a
dispute without checking refund completeness. Keeping incomplete evidence stored
as a refund and unapplied is fail-closed. The stored event type remains a declared
operator recovery limit. The audit snapshot compatibility reader still uses
chargeId key detection: the frozen refund observation has operationId and original
money but no typed charge identity; equating those identities would change behavior.
Reference host readers and binding remain unchanged.

P3 verification and final ledger are recorded below after the final diff.

P3 local checks: 14 authored cases (seven package contract/conformance cases and
seven real PostgreSQL cases), within the permitted maximum of 14. Fresh install,
exact-prefix upgrade, lost-ACK replay/conflict, mismatch/rollback/reconciliation,
ACL/dunning/recovery, lock serialization and later-only dates pass. Package and
retained payment suites, typecheck, lint, API and neutrality checks pass. The
publication policy refuses untracked additions under the local no-Git-write
boundary; navigation is regenerated through the same repository renderer and the
remaining tests-owner no-impact trailer is proposed in the handoff.

P3 final ledger: 24 paths, 9 production paths, 1973 lines of churn, four frozen export additions. Computed against main after P2 merged (#273). No dependency, canonical migration, public subpath or budget change.

Self-retro: the first SQL run exposed six fixture failures (one manifest-key typo
and five deferred order-line constraint failures). Preserve canonical manifest
keys and create orders with their lines in one transaction; the corrected real
suite passes. The native executor uses the existing structural shape, following
the inventory precedent, avoiding an unnecessary transitive declaration graph.
