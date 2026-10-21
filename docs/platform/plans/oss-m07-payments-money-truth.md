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


## P4 record

The package contributes the donor active-action/recovery algorithms and buyer
verify handler with DTO extraction, neutral transient handoffs and the shared
HTTP/responder types. Amendment 1 replaces the closed rail predicate with an
injected synchronous capability lookup; unknown rails return no handoffs. The
reference status binding supplies exactly the donor mapping and preserves its
private response shape, double canonical read, pending guard and failure
behavior. The verify binding supplies its existing observed responder; setup
keeps its native callback behind the port-only method seam. No reference clock,
subscription cycle, token writer or provider activation changes.

The reference repair/status view follows in a separate change. Verify cannot
mark payment paid. Native method setup is an explicit unsupported port result
without a host collector/confirmation binding.
Method evidence adds optional neutral reusable registration facts. Only the
host resolves client/subscription ownership; missing resolution omits registration,
and a failed resolver is retryable before ingest. Money-event enrichment stays
host-owned. Lifecycle carriers copy typed facts. The payer redaction fix (empty
values, JSON-escaped forms) moved to a follow-up PR to stay within 35 paths. The donor refusal handoff has no
field for a typed refusal envelope, so that forwarding remains unsupported.
The incomplete-chargeback classification and native schema limits remain; the
reference first-receipt clock switch and required host reader proof stay in P6.

P4 keeps 7 authored cases: two W6 verify cases (browser claims ignored;
mismatched money to manual review), the W7 confirmation-forwarding case, three
owner/attempt-binding cases and the reusable-method owner regression. The
reference repair UI and its 6 DOM cases (the remaining W6 status, W7 renewal
and W8 assertions) move to a separate change, because the hidden-UI guardrails
need a boundary decision.
Focused runs after the split cover the package payment suites and the retained
reference resolver, status, verify and setup suites.
All retained resolver/status/verify/setup/BFF/poller suites remain unchanged.
An offline probe exercises actual reference route/status/package statements with
host-selected in-memory ports, and 156 donor/reference binding scenarios agree.
These establish forwarding and refusal, not a new native-store installation.

Lint (33 incumbent warnings), typecheck, API, structural and neutrality checks
pass. Actual migration-block validation against the pinned predecessor passes.
Publication policy refuses untracked additions under the no-Git-write boundary;
the same navigation renderer ran directly, and the unchanged contributor-check
owner needs the scoped trailer proposed in the handoff. No full verification,
Git/remote write, DCO, native review, release or activation was performed.

P4 final ledger: 29 paths, 12 production paths, about 1,750 lines of churn (including the two regenerated example-adapter API reports), nine frozen
export additions. Computed against main after the first opt-in example adapter (#278), representing main
after P3 for this stacked task; this is not an aggregate P1–P4 comparison or a
claim about the later moving main. No dependency, public subpath, migration or
budget change. Predecessor to candidate pack: 1,275 → 1,287 files, 880,494 →
888,659 packed bytes, 3,965,957 → 4,003,734 unpacked bytes and 735,961 → 743,739
code gzip bytes. Package root docs: 44,652 → 45,190 gzip bytes; contracts remain
20/32 browser bytes. All existing caps remain unchanged.

Self-retro: package-local import refusals exposed host assertions in the wrong
layer. Host assertions belong in reference tests, keeping public tests local and
preserving the assertions, rather than weakening the import controls. Run the
hidden-UI and payment-control guardrails whenever reference pages change. Serialize package builds and tests: one early BFF run raced
lint's dependency build; the isolated rerun passed. No new process is needed.


## P4c record

The opt-in reference store mounts the payment repair view after checkout with
the original order/intent/client identity. Verification never proves payment;
stored status remains the terminal authority, and unsupported method setup is
visible. The hidden-UI guardrail admits exactly three files for their specific
status-only `commerce/paymentStatusClient`, customer `commerce/paymentVerifyClient`
or `payment/components/PaymentStatusPoller` specifiers, with a one-line reason.
The payment-control guardrail admits only the poller for the repair page and
status display. The broader `commerceClient`, operator and control-plane
modules stay refused, as real-module negative cases in both guardrails show.
Redirect handoff links render only for HTTPS URLs. A source-import scan proves the reference store
has no importer outside its own test, so it stays unmounted in the shipped
default profile.

P4c adds 14 authored cases: eleven reference DOM cases (W6 stored status, W7
renewal, W8 mandate refusal, collection and denied actor) and three guardrail
cases. The four existing store cases remain. The status reader moves verbatim to its own module, with its existing commerce
client export preserved. No package export, payment control,
migration or dependency changes.

P4c repair ledger: 17 paths against the current main base, including 3 production
UI paths and the status-only client. No new route or activation.

## P4d record

Bounded new-boundary hardening: refuse null money for succeeded, refunded and
disputed adapter evidence at projection through the donor amount-mismatch
processing-failure path, and refuse those verification fixtures in adapter
conformance. Failed and pending evidence retain nullable money. Two added cases
cover ingress refusal and conformance across all three settling outcomes.
No contract type, export, migration or reference binding changes and no new response
wording: settling evidence without money now gets the existing 503 instead of being
acknowledged. Both added cases fail against the restored predecessor sources and pass
after rebuilding the fix. The existing null-refund assertion now expects mismatch refusal.

Self-retro: package tests require built package entries. Build the original
sources before the reverted-source witness, and serialize rebuilds with tests.


## P4e record

Finite outcome: extend P4d's settling-money refusal to amounts that are not safe
positive integers and blank currencies, through the existing amount-mismatch
path before ingest. Conformance requires the same positive money. Failed and
pending evidence retain their existing behavior. Donor and main creation,
renewal, setup and refund paths were checked first: zero orders cannot create
settling attempts; method setup is separate; zero refund snapshots are unproven.
No export, migration, reference binding, provider activation or dependency change.
Local edits and focused offline checks only; no Git writes, submission, native
review, DCO, release or activation authority. Extend the two P4d cases with table
rows, adding no test cases. Completion evidence belongs in the task handoff. The two extended cases fail
against rebuilt P4d sources and pass after restoring the fix. Structural, lint
(33 existing warnings), typecheck, both neutrality and policy/navigation checks
pass. The wider focused payment run passes 786 tests, but one existing HTTP-wire
suite cannot open its loopback listener in the sandbox; its two wire tests remain
unverified. This run does not claim a fully passing payment gate.

Self-retro: the positive intent constraint alone does not prove blank-currency
refusal; the canonical order currency invariant supplies that evidence. Reuse
the existing guard and table cases rather than introducing another validator.


## P5 record

Compatibility refactor only against P4e `4613d814`: private conformance money
and identity annotations and the private evidence money copier now reuse the
existing contracts. Truth fingerprinting loses three unused type imports.
The three edited modules emit byte-identical JavaScript; public signatures,
types, API reports, assertions and native reference facades remain unchanged.
No export, dependency, migration, runtime helper or behavior change is included.
Authority covers local edits and focused offline checks only; no Git writes,
submission, DCO, native review, merge, release or activation was performed.

Structural scan, lint (33 existing warnings), typecheck, API and both neutrality
checks pass. The focused payment/reference run passes 824 tests in 69 suites;
one HTTP-wire suite cannot open its loopback listener (EPERM), leaving two wire
tests unexecuted. One opt-in local database case remains skipped. Full payment
acceptance is therefore incomplete. Publication impact requires the proposed
scoped no-impact trailer; the untracked fragment is retained for handoff.

Self-retro: direct invocation initially lacked the local test binary on PATH;
adding the existing local bin directory let the focused runner proceed. Keep
private type reuse small: no new abstraction is needed for unchanged runtime.

P5 final ledger vs `4613d814`: 5 paths, 3 production paths, 38 lines of churn; zero test edits and zero API report changes.

## P6 record

Payment truth scope ownership moves to `createPaymentServices`, with
`PaymentServicesOptions` and `PaymentServices` on the contracts entry. The host
opens and closes its existing executor. The existing bundle composer accepts one
optional payments binder; no second registry, cron or dormant handler is added.
Reference selection is explicit, default-off and refuses unknown capabilities.

D11 is the second declared behaviour change: every caller of the reference
payment control port (the selected verified ingress, the existing provider
webhook handler and the captured reference checkout) applies and post-processes
a redelivery at the first stored receipt instant, rather than a later provider
timestamp. The first insert stores the
adapter fingerprint, independent of receipt time and audit payload; concurrent
replays read the winning row. Missing durable receipt evidence refuses. No schema
or existing route is activated. Four direct missing-audit reader proofs extend
incumbent cases; profile alias presentation retains its existing fallback while
recurring execution separately requires consent.

P6 adds exactly three authored cases (two package binding cases and one cold
reference host case); replay, reader and installed-consumer assertions extend
existing cases. Public export additions are exactly the factory and its two
types. The composer declares its payments slot structurally and imports
nothing from payments, so the module graph is unchanged; the typed cold consumer
proves the factory result fits that slot. No release or activation is claimed.


P6 case ledger (folded properties add no cases):

- D11 folded assertion → `server/domains/payment/paymentWebhookHandlers.test.ts:acknowledges canonical event redelivery with the same deterministic payment-result key and keeps the first-receipt clock on later redelivery`.
- First-insert fingerprint folded assertion → `server/adapters/supabase/payment/paymentWebhook.test.ts:writes normalized provider events through payment-control ingest RPC, preserves the first-insert fingerprint, omits missing-audit failure reasons and refuses missing-audit alias activation`.
- Gateway failure reason folded assertion → `server/adapters/supabase/payment/paymentWebhook.test.ts:writes normalized provider events through payment-control ingest RPC, preserves the first-insert fingerprint, omits missing-audit failure reasons and refuses missing-audit alias activation`.
- Alias activation folded assertion → `server/adapters/supabase/payment/paymentWebhook.test.ts:writes normalized provider events through payment-control ingest RPC, preserves the first-insert fingerprint, omits missing-audit failure reasons and refuses missing-audit alias activation`.
- Saved-method consent folded assertion → `server/adapters/supabase/commerce/savedPaymentMethodResolver.test.ts:resolves subscription reuse only for an explicitly stored Model O PAYID and refuses missing-audit recurring consent`.
- Profile fallback folded assertion → `server/adapters/supabase/customerProfilePorts.test.ts:exposes customer address and payment-method contracts and retains missing-audit profile availability`. This discriminates a change to the existing presentation fallback; it characterizes that fallback and grants no recurring execution authority.
- New case → `packages/platform/test/payments/bindings.test.ts:is absent when truth readiness or the selected capability is unavailable`.
- New case → `packages/platform/test/payments/bindings.test.ts:runs selected truth through one scoped port and closes on success and failure`.
- New case → `server/runtime/public-reference/m07PaymentBinding.test.ts:keeps the cold host default-off and uses exactly one selected executor`.

## Combined delivery and test budget

P4d, P4e, P5 and P6 ship as one pull request with their commits kept in order
(coordinator speed-up); P5's commit is refactor-only with byte-identical built
JavaScript and API reports.

Module test budget (M06 counting rule: semantic `it`/`test` definitions count
against the +100 cap; generated rows are reported separately): 59 public
definitions plus 33 C1 witnesses = 92 of 100. Executed invocations, counting each
parameterized row, are about 106. The +30 s runtime budget remains the binding cost.

## M07 follow-ups (next wave)

None is a correctness or security defect in the shipped package after P4d and P4e.

- Reference repair view: the status poll can clear a host-supplied redirect action;
  verify after the poller times out does not poll again; the poller copy is not
  localized; one verify fixture builds a handler it never calls.
- A route-level wrong-rail witness for the reference status route.
- Mapping an unsupported method-setup result to an explicit refusal in the reference route.
- A deployment-neutral reason in the verify handler's disabled response.
- The reference card evidence normalizer's missing-amount path (the package already
  refuses settling evidence without positive money).


## S1 record: 0.21.0 package set

Outcome (2026-10-21, main `b394df2d`): prepare core/outbox/platform `0.21.0`
with exact pins and locks; core/outbox are unchanged republications, UI stays
private `0.0.0`. Consume all 13 fragments: `m07-p1`, `m07-p2`, `m07-p3`,
`m07-p4`, `m07-p4b`, `m07-p4c`, `m07-p4d`, `m07-p4e`, `m07-p5`, `m07-p6`,
`a2-op1`, `a2-op2`, `a2-op3a`. C2 code-complete; selectors remain default-off.

Published `0.20.0` baselines (downloaded bytes match registry shasum/integrity):

| Package | Packed B | Registry shasum |
| --- | ---: | --- |
| @openlup/core | 161,695 | `045eafe05a686616fef921adedb3a7156ca0b086` |
| @openlup/outbox | 39,459 | `aee786aded37acb7cee9f55e1d9d957b4a1d96ab` |
| @openlup/platform | 809,376 | `604e96ed6413e161b69d8a452cd1a529e1a55fd8` |

Only `pack.baseline` changes; all caps remain unchanged. M06 C4 records `0.20.0`
published and C4-checked at #271 merge `3e0f1784`; `0.21.0` follows this merge
and required supervisor review/final verification. The standalone
[0.21.0 limitations](../../../packages/platform/CHANGELOG.md#0210) retain M06
pending proof and the five M07 follow-ups.

Docs cap (coordinator ruling for the owner, 2026-10-21; no cap change): the
packed CHANGELOG keeps the current release and the two previous ones, so
`[0.18.0]` and older move byte-identical to the non-packed
[CHANGELOG-HISTORY.md](../../../packages/platform/CHANGELOG-HISTORY.md), and the
[release guide](../DEVELOPMENT_AND_RELEASE.md) states the rule. The packed docs
class measures 45,553 of 49,152 B. The release notes describe the example
payment adapter subpaths neutrally and the README names them; the neutrality
script's exact-file A1 subpath allowance adds only the history file, so the
verbatim move adds no count.

Self-retro: the bump CLI stages deletions → hold fragments outside the checkout
during the version bump, then assemble notes without Git writes; no tooling change.
