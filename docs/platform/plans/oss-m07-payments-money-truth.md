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

Each candidate stays within 35 paths. Shared registration companions add only their own entries; both publication JSON projections use repository generators. P1 ceilings: 18 production paths, 5,000 churn, 30 exports and 10 authored cases. Contracts browser budget is 32 bytes; existing pack caps and released baseline remain unchanged.

## P1 record

The prepared contracts, ordering mechanism and internal finalization retry are contributed with import-specifier changes only. The caller injects persistence, execution and failure policy; the reference facade is unchanged. Validation precedes preparation; replay refuses; trusted no-charge proof permits one retry; finalization retries the same immutable local acknowledgement without dispatching again.

Contracts cover execution/dispatch, transient hosted/client handoff, a core capability overlay, asynchronous raw-byte verification, distinct money/method evidence, exact readback/absence, neutral refusal, three refund observation forms and multi-subject conformance fixtures. Receipt time is freshness-only; identity includes outcome class and fingerprints exclude receipt time. Transient secrets and opaque handoffs never enter persisted diagnostics. Refund policy is type-only in P1; the runtime change belongs to P2. Unknown, absence and unsupported remain distinct; timeout/truncation cannot establish absence.

The module graph declares payments without cross-module edges. It has no dedicated child-directory allowance mechanism; future example adapters use the existing module boundary and remain separately owned. No new allowance mechanism is added.

## Evidence and delivery boundary

No new migration, dependency, reference rewiring or provider implementation is included. Release and adopter activation keep their own authority. Example adapters may consume P1 types after merge; runtime conformance waits for P2.

## Completion evidence

P1 local candidate: 25 changed paths, eight production paths, 25 export pairs, 1176 lines of churn; no new dependency or migration. Nine authored cases are present: four exact key-forwarding variants, three acknowledgement/replay variants and two browser/cold boundaries. The source scan adds 24 generated payment-file iterations, reported separately. No test is physically moved or removed. The tenth allocated case, W1 webhook identity, needs the ingress/truth runtime and moves to P2 (P1 9, P2 21; the module total is unchanged). Fixture currency uses the neutral `XXX` code: the mechanism forwards supplied money bytes unchanged, so the transcript shape is the witness's. These seven mechanism cases do not establish the original callers' key-generation behavior.

Focused root evidence: 1,301 passed; package-local: 1,227 passed; retained core payment cases: 123 passed. Final root added test-body time: 4.62 ms prepared, 5.12 ms browser, 77.40 ms installed consumer, plus 7.74 ms generated iterations. These are local observations, not hosted medians or isolated module wall-time deltas.

Actual main to candidate pack: 1,197 to 1,221 files; 1,167 to 1,191 code files; 808,449 to 816,142 packed bytes; 3,647,166 to 3,682,679 unpacked bytes; 679,413 to 687,246 code gzip bytes. Root docs: 43,210 to 43,708 gzip bytes, five files unchanged. Contracts: 20/32 browser bytes. All caps and the released baseline remain unchanged.

Lint, compilation, builds, API checks, focused tests, publication policy and both neutrality checks pass. No native-store or runtime parity claim is made.

Self-retro: mixed-boundary witness allocation exposed a missing runtime dependency before review. Lesson: allocate each witness case to its actual exported runtime before freezing the case budget; use the repository validators directly for fragment format and package-local imports.
