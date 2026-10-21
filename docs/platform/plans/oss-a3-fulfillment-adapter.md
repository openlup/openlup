# A3 fulfillment example adapter

Status: development-preview implementation ledger, 2026-10-21. O-P1 contributes
internal OmniPack transport and witnesses only. It adds no public entry and makes
no account-readiness, activation or release claim.

## Outcome, authority and boundary

Owner decision, 2026-10-21 (direct-carrier wording paraphrased): “Yes: start an A3
example-adapter round for OmniPack only (opt-in, default-off), with its own lead
after M08's port freeze; no direct-carrier packaging.” The frozen M08 P1 input is
`9328b676f28dfd08ccba159c25feb502e4c45ddd`. Platform maintains the preview example;
hosts own credentials, transport policy, metadata, account verification and activation.

Codex implements local files and focused checks in the assigned worktree; Claude
owns git writes, committed native review, the gated full run and delivery. This
brief grants no submission, merge, release, account or adoption action. No network,
provider, database, credential-file read or dependency installation is authorized.
Acceptance here is the selected donor slice with the bounded error-code adaptation below, injected I/O,
exact serialized-body fingerprint binding, 18 equivalent witnesses plus minimal
adaptation tests, scoped neutrality with no baseline increase and answered docs
impact. Full gates and the two fresh committed control reviews remain with Claude.

O-P1 excludes public factory/configuration/descriptor, exports, API report,
package manifest and release gates. Publication catalogue registration is part
of O-P1: the ledger and 20 package source/test files have `public-output` rows,
as required by publication policy. Existing root
reference copies, the obligation RPC adapter, M08 contracts/index/orchestration,
schedules, persistence, receiving, notifications and default wiring stay unchanged.
The later opt-in entry shares `@openlup/platform`; no topology trigger requires a
new package. Product scheduling remains pull-only; product/pack writes require
explicit invocation with host-owned metadata.

## Frozen capabilities and PR graph

`O-P1 → O-P2 → O-P3`: internal transport first; neutral-port glue and exactly three
public symbols next; actual M08 P3 conformance and integrated budgets last.
O-P2 alone adds `./fulfillment/omnipack` with the factory, configuration type and
capability descriptor. No default binding is part of this round.

Dispatch, positive bounded readback, token-authenticated observations, stock and
product protocol operations are the intended offline capabilities. Account
readiness remains unverified. Freshness is `not_available`. Label create/void
(G5), exact absence (G10), cancellation and courier pickup are unsupported;
label reads are host-storage-owned. Every callable unsupported operation needs an
explicit refusal witness in O-P2. Empty collections establish no exact absence.
Tracking URLs require host approval. Donor `raw` bags and provider prose remain
internal; O-P2 must project closed neutral evidence rather than persist those bags.
Prepared bytes remain transient and the fingerprint identifies the exact body sent.
No local obligation or subscription-delivery effect is implemented here.

## Case ledger (coordinator budget ruling A)

Retained root/adopter copies count as **net-new**, with no moved-pending credit.
The six V-C1 files are absent at the frozen donor revision, so equivalent behavior
was selected from the existing suites below; their assertion meaning is preserved
with neutral fixtures. Loops are assertions within authored cases, not generated
parameter rows. No full donor suite is duplicated.

Destination prefix: `packages/platform/test/fulfillment/omnipack/`.

| Donor source responsibility → destination file | Cases | Status | Running total |
| --- | ---: | --- | ---: |
| `server/infra/omnipack/client.test.ts` → `a3OmnipackWireCharacterization.test.ts` | 3 | net-new | 3 |
| `server/infra/omnipack/outboundOrderMapper.test.ts`, `server/domains/fulfillment/omnipackDispatchPayload.test.ts` → `a3OmnipackDispatchCharacterization.test.ts` | 3 | net-new | 6 |
| `server/domains/fulfillment/omnipackWebhookPayload.test.ts`, `omnipackStatusVocabulary.test.ts` → `a3OmnipackObservationCharacterization.test.ts` | 3 | net-new | 9 |
| `server/infra/omnipack/client.test.ts`, `mappers.test.ts` → `a3OmnipackReadbackCharacterization.test.ts` | 3 | net-new | 12 |
| `server/infra/omnipack/mappers.test.ts`, `providerError.test.ts` → `a3OmnipackStockCharacterization.test.ts` | 3 | net-new | 15 |
| `server/infra/omnipack/productSyncMappers.test.ts`, `client.test.ts`, `server/_lib/omnipackProductPackPayload.ts` → `a3OmnipackProductCharacterization.test.ts` | 3 | net-new | 18 |
| Injected credentials, byte binding, environment/import boundary → `transportAdaptation.test.ts` | 3 | net-new | 21 |
| Allowance, refusal plants, negative subtraction → `scripts/public-ci-neutrality.test.ts` | 3 | net-new | 24 |
| Synthetic fixture helpers → `fixtures.ts` | 0 | helper only | 24 |

O-P1 is **24 net-new**. Projection: private V-C1 18 + O-P1 24 + O-P2 glue 16 and
cold import 2 + O-P3 conformance 2 = **62**, leaving 38 below the round's +100 cap
(10 of that headroom is a planning reserve). Generated package-boundary rows are
reported separately under ruling A; their actual runtime still counts. Recount
expanded cases at each phase; stop if the complete projection exceeds 100.

## Provenance and mechanical adaptations

`V` denotes the adopter repository at `1560c645737a2d68decdccdf1cc063b6313ba6ee`;
`O` denotes the retained OpenLup root reference at the frozen P1 commit above.
Every row is a selected contribution from V, with the corresponding O path cited
for comparison; identical rows below were checked by bytes. Destination prefix:
`packages/platform/src/fulfillment/omnipack/`.

| V source; O root reference at the same path | Destination | Boundary adaptation |
| --- | --- | --- |
| `server/infra/omnipack/client.ts` (identical) | `client.ts` | Remove environment/readiness reader and ambient-fetch default; require injected HTTP and a per-attempt credential supplier. Omit unused cancellation/inbound methods, related imports and config. Order creation takes serialized bytes; retry counts, timeout and wire auth semantics unchanged. Host explicitly supplies timing/path settings. Lead-approved repair: surface provider-supplied codes only when matching `^[A-Z][A-Z0-9_]{0,63}$`, otherwise reuse the donor's missing-code fallback `http_<status>`; payload values must not escape through error codes; donor passed codes unchanged. Round 2 adaptation: classify non-2xx status before consuming its body; on unreadable rejection bodies keep `http_<status>` and the status-derived submission classification rather than the donor network-error fallback, because a known definitive rejection must remain non-submission. Successful unreadable ACKs remain unknown. |
| `server/infra/omnipack/providerError.ts` (identical) | `providerError.ts` | None; native Error base already neutral. This internal projection is not the O-P2 public refusal contract. |
| `server/infra/omnipack/mappers.ts` (identical) | `mappers.ts` | Omit unused inbound/cancellation interfaces/functions; remaining logic unchanged. |
| `server/infra/omnipack/productSyncMappers.ts` (root differs in host comment) | `productSyncMappers.ts` | Neutral host terminology in a comment only. |
| `server/infra/omnipack/trackingReferences.ts` (identical) | `trackingReferences.ts` | Remove an unshipped-carrier example from a comment only. |
| `server/_lib/omnipackOutboundOrderPayload.ts` (identical) | `omnipackOutboundOrderPayload.ts` | None; preserve service in both wire carrier/service fields and pickup refusal. |
| `server/_lib/omnipackProductPayload.ts` (identical) | `omnipackProductPayload.ts` | None; host owns product metadata. |
| `server/_lib/omnipackProductPackPayload.ts` (identical) | `omnipackProductPackPayload.ts` | Neutral barcode examples in a comment only. |
| `server/domains/fulfillment/omnipackDispatchPayload.ts` (identical) | `omnipackDispatchPayload.ts` | Local codec import and structural input slice replace host persistence contracts. Canonical serialization materializes body once and computes its hash; command returns those bytes for transport. Recursive ordering and array order remain unchanged, witnessed against donor hash behavior. |
| `server/domains/fulfillment/omnipackStatusVocabulary.ts` | `omnipackStatusVocabulary.ts` | Select translation functions/table only, excluding effect orchestration and its dependency; neutral explanatory comment. |
| `server/domains/fulfillment/omnipackWebhookPayload.ts` (identical) | `omnipackWebhookPayload.ts` | Select auth/event identity/route mapping only. Structural headers replace framework request type; local mapper type and closed route union replace handler imports. Omit arbitrary stored-payload projection and host tracking enrichment. |
| `server/domains/fulfillment/omnipackReconciliationPayload.ts` (identical) | `omnipackReconciliationPayload.ts` | Select occurrence-key function only; omit persistence projection, arbitrary error prose and unrelated host types. |

Fixture adaptations replace private identity, catalog, contact, location, barcode
and carrier/service examples with synthetic SKU/order subjects, reserved example
hosts/email, example telephone and neutral service codes. These changes preserve
pass-through, authentication, correlation, quantities and refusal assertions.
The Basic credential/token values are low-entropy placeholders.

Repair round 1 extends existing cases only: the stock error projection exercises
HTTP codes containing a reserved email, lowercase prose, digits-only identifiers,
overlong tokens and accepted constant-like tokens. Observation pins all five
event-to-status mappings. Dispatch D3 pins four literal complete-command digests,
repeatability, item-only and service-only changes, retaining recipient/evidence
assertions. The original digest is
`cb7d16e1659b445e32ac98c866d0cda2a523c536f30c0d15eec546e1c9d5731c`;
all four package digests match execution of the frozen donor codec/hash on the
same synthetic commands. Serialize-once changes no digest. Wire W2 attaches its
rejection assertion before advancing fake time by exactly the deadline, checks
one POST and restores real time in `finally`. Case counts remain unchanged.

## Neutrality and documentation impact

One ui-15 predicate subtracts only the vendor word in this ledger, the exact future
API report and the exact package source/test directories. In the existing fixed
carrier files and platform change fragments it admits only the complete,
case-sensitive `fulfillment/omnipack` segment; the complete report filename is
admitted only in release gates and the publication catalogue. Other categories
remain scanned, and negative counts fail closed with category/path/remainder.
Plants cover outside paths, bare prose, suffix lookalikes, token/path casing,
report filename in a wrong carrier, nested fragments and unrelated categories.
No baseline or pinned matcher change is made.

The fulfillment architecture owner describes the internal transport boundary and
links this ledger; contribution checks describe the scoped predicate and refusals.
Generated navigation is refreshed after impact review. No public contract or
package export is introduced by the internal modules. The catalogue inventories
their public source/test outputs and ledger without exposing a public entry.

## Execution evidence and handoff

Initial implementation results (2026-10-21; historical, before repair round 1):

- `npx --no -- ast-grep scan --error=no-suppress-all --error=unused-suppression`:
  passed after source and control edits.
- `npm run lint`: passed, including all three package builds/typechecks, structural
  rule tests and ESLint; 33 existing warnings elsewhere, no errors.
- Requested package witnesses and neutrality tests plus package-boundary and
  cold-consumer tests: **1,566 passed across 10 files**, 50.37 s wall time.
  Expanded enumeration: package witnesses 21, neutrality 35 (32 existing + 3),
  package boundary 1,465 (36 generated rows from these 12 source files), cold
  consumer 45. No extra cold-consumer cases were authored.
- Initial focused run: 55 passed, one boundary assertion failed because it treated
  a type-only import expression as executable. The structural type moved to a
  named type import; the complete focused rerun above passed.
- `node scripts/public-ci-neutrality.mjs`: passed, zero increases.
- `node --experimental-strip-types packages/ui/smoke/neutrality.ts`: passed.
- Both requested `gitleaks detect --no-git --source` directory scans: no findings.
- Root reference files, package manifests, export maps, release gates and
  neutrality baseline are unchanged. The catalogue adds 21 `public-output` rows.
- Documentation impact evaluated with the existing checker API against frozen P1:
  two obligations, **zero unanswered**, answered by the architecture and contributor
  sections. `--policy --docs-update` regenerated navigation without a byte delta.
  Initial policy execution was blocked before catalogue registration; that scope
  conflict is resolved by the O-P1 registration decision above. Review of candidate
  `93e3d482` observed policy **PASS** with `OPENLUP_STACK_BASE=9328b676f28dfd08ccba159c25feb502e4c45ddd`,
  two obligations and zero unanswered. Reviewers' sandbox-blocked Vitest and
  neutrality attempts establish no test pass.

Repair round 1 focused results (2026-10-21):

- Package witnesses, neutrality, package-boundary and cold-consumer tests:
  **1,566 passed across 10 files**, 77.85 s; expanded counts remain 21, 35,
  1,465 and 45 respectively. No authored cases were added: O-P1 remains 24
  net-new and the round projection remains 62.
- Platform typecheck (`tsc -p packages/platform/tsconfig.build.json --noEmit`)
  and the requested ast-grep scan passed. Full lint/gates remain Claude-owned.
- Tree-wide neutrality passed with zero increases; both package source/test
  directory gitleaks scans found no leaks.
- Pinned publication policy passed with two obligations and zero unanswered.
  Generated navigation is refreshed with `--policy --docs-update` before the
  final policy check.
- Removed the three extra EOF blank lines identified in review; stacked
  `git diff --check 9328b676f28dfd08ccba159c25feb502e4c45ddd` now passes.
- No git writes, installs, network access or credential reads were performed.

Native signed-commit reviews, broad checks and delivery are Claude-owned; no
local check claims their completion. O-P2 must bind prepared requests/evidence,
project safe facts, add explicit unsupported-operation refusals and register the
three-symbol entry. O-P3 must use the real M08 runner; no substitute is created.

Simplicity pre-check for the supervisor's first review: retain the selected donor
functions and inject the two host I/O seams directly; a parallel transport or new
abstraction would duplicate existing semantics without improving this boundary.
Self-retro: a type-only import caused one false boundary failure; use a named type
import to keep the selected runtime dependency boundary explicit. Selected donor
witnesses avoid wholesale duplication while retaining the relevant behaviors.
Repair rethink/self-retro: weakened witnesses and unrestricted response codes →
extend the existing cases and constrain the response extraction seam, preserving
the donor fallback and avoiding a new error vocabulary or extra cases.

## O-P2 public neutral-port glue

Outcome: add only the opt-in `@openlup/platform/fulfillment/omnipack` entry on
O-P1 `9593830c`, retaining the frozen M08 P1 contracts and all donor witnesses.
The three public symbols are `createOmnipackFulfillmentAdapter`,
`omnipackFulfillmentCapabilities` and `type OmnipackFulfillmentAdapterConfig`.
The factory's inline return type uses the frozen dispatch, label, observation,
readback and sync provider ports. No parent re-export, orchestration, default binding,
route, schedule, SDK, dependency or account activation is added.

Authority remains local implementation and focused offline checks only. Claude
owns all git writes, committed native review, broad gates and delivery. No git
write, install, credential-file read, network/vendor access or full suite is
permitted here. O-P3 still owns committed conformance integration; the repair pre-check uses
the actual M08 runner only in the disposable scratch tree. The existing pending provider/account,
release and adoption boundaries remain unchanged.

Implementation/proof (current through round 9): retain the client/codecs and
closed neutral projections, with stateless preparation and one bounded submission
record. Dispatch validates evidence/request values, joins or replays retained
results by evidence and command digest, otherwise reserves and rebuilds before
credentials/HTTP. Callback drift refuses and releases the reservation. Host
selection and readiness are independent of secrets. Provider bags/errors are discarded, unsafe
tracking URLs dropped, occurrence remains nullable and empty reads stay unknown.
Accepted results carry nonempty opaque hashes of provider reference and command
fingerprint as provider proof keys; the worker supplies authoritative host keys. Product writes require
explicit invocation; no scheduled push is installed. Unsupported labels return typed refusals through the required frozen label port;
cancel has no callable member. Their descriptors remain supported:false with reasons.

STEP 0: focused package checker passed before edits. Actual packed docs/root class
was **47,850 / 49,152 bytes**, 5 / 10 files, leaving **1,302 bytes**. The single
95-byte README row projects docs to **47,877 bytes**, leaving **1,275 bytes**.
Tarball 1,049,053 / 1,351,680; code 904,454 / 1,126,400; unpacked
4,675,074 / 5,734,400; total files 1,470 / 2,100. No cap changes authorized.
The initial pack attempt hit default npm-cache EPERM; a temporary cache resolved
it without installation or changing the existing cache.

### O-P2 case ledger

| Destination | Cases | Status | O-P1 + O-P2 running total |
| --- | ---: | --- | ---: |
| `packages/platform/test/fulfillment/omnipack/factory.test.ts` | 29 | net-new glue/refusal/redaction; rounds 1/2/4/5/6/8 add 4/1/2/1/1/1; existing replay/model cases extended | 53 |
| `packages/platform/test/fulfillment/omnipack/transportAdaptation.test.ts` | 1 | round 2 unreadable rejection; 3 O-P1 cases retained | 54 |
| `scripts/packages/platform-cold-consumer.test.ts` | 1 | net-new installed import/default-off/injected I/O | 55 |

Current through repair round 9: O-P2 is **31 net-new** (one above the original
target, within the binding round cap). O-P1 + O-P2 is **55**; private V-C1 18 +
55 + O-P3 projected 2 = **75 / 100**, leaving 25 cases (10 remain a planning
reserve). Including both scratch restart and eviction witnesses conservatively
makes **77 / 100**. Package-boundary generated rows are counted separately under
ruling A; actual runtime is reported with final checks.

Simplicity pre-check for Claude's committed reviews: reuse the contributed
transport/codecs, keep preparation transient and project allowlisted fields;
a second transport, durable command cache or generic sanitization framework is
unnecessary. Native reviewers must review the committed stabilized tree, with
two independent full reviews under the existing process, including simplicity.

### O-P2 initial focused evidence and handoff (cfb0e54c; historical)

- Glue obligation (1): factory tests “binds full contact revision”, “missing and
  foreign preparation”, and “every request/evidence mismatch” prove exact body
  hash, closed full revision, pre-credential refusal and fresh remap preparation.
- Obligation (2): “definitive rejection” and “lost/malformed acknowledgements”
  prove non-submission versus unknown, one POST and no invented host keys.
- Obligation (3): “inert, unselected, unready”, four unsupported-operation cases,
  “exact selection refusals” and “product reads pull-only” cover capability/default,
  selection/ref separation and deliberate writes. Label/cancel cases exercise
  explicit unsupported descriptor reasons and absent callable ports. The brief's
  return shape excludes those members; adding refusal-only callables would need
  the lead's bounded shape decision. No extra public export was introduced.
- Obligation (4): “exact absence” and “positive correlated readback” reject empty,
  unmatched, duplicate and unknown-status results without absence/delivery claims.
- Obligation (5): “token before touching”, “event identity across receipts” and
  “unknown/mismatched event taxonomy” cover authentication order, eventKey,
  receipt/occurrence separation, correlation and unknown taxonomy refusal.
- Obligation (6): closed output plants in dispatch, observation, URL, readback,
  stock/product and error cases exclude response bags, secrets, signed URLs and
  command PII. Product writes return only replay evidence or void; sync exceptions
  are closed neutral refusal objects, never provider errors.

Focused package witnesses + neutrality + package-boundary + cold-consumer run:
**1,595 passed across 11 files**, 48.83 s wall time. Expanded groups: package
40 (21 existing + 19 glue), neutrality 35, boundary 1,474 (9 new generated rows),
cold-consumer 46 (1 new). O-P2 remains 20 authored net-new; whole-round projection
remains 64 / 100. Hosted added duration remains unverified.

Platform no-emit typecheck, requested ast-grep scan, API generation/check and
full lint passed; lint reports 33 existing warnings and no errors. Existing API
reports were regenerated with no byte changes; only the new report is added.
Both adapter source/test directory gitleaks scans found no leaks. Tree-wide
neutrality reports zero increases and the UI neutrality smoke passes.
Registration diffs against `9593830c`: package.json **+5/-0**, release gates
**+11/-0**. All previous export/surface/limit values remain unchanged.

Serialized post-build artifact measurement through the shared `measurePack` /
`checkPackBudget` functions passes all class and aggregate caps: docs **47,932 /
49,152 bytes**, 5 / 10 files, **1,220 bytes headroom**; code 913,657 /
1,126,400; tarball 1,059,534 / 1,351,680; unpacked 4,721,951 / 5,734,400;
1,479 / 2,100 files. One earlier post-edit measurement overlapped lint's dist
rebuild and was discarded; these numbers come from the completed build.

The requested policy / docs-update / final policy sequence was attempted. Each
CLI policy run refuses its tracked-only inventory because six new catalogue
files are untracked; docs-update nevertheless refreshed navigation with no byte
delta. The existing documentation-impact API evaluated the complete candidate
against full O-P1 SHA: **3 obligations, 0 unanswered**, answered by the one README
row, the A3-owned architecture paragraph and contribution-check explanation.
The final official package checker refuses the dirty package, as designed.
Neither refusal was bypassed with an alternate index or a git write. Claude must
stage/commit, rerun the policy/artifact gates, complete its required reviews and
broad checks, and retain all remaining release/account/adoption gates.

Self-retro: concurrent rebuild/measurement produced a partial artifact → discard
that result and serialize all consumers of mutable dist output. A tiny transient
cache plus closed projections reused the donor semantics without a new durable
command store or sanitizer framework. No full suite, git write, install,
network/vendor access or credential-file read was performed.

Final focused correction: neutrality caught a vendor token in CONTRIBUTING,
which is outside the allowance; replaced it with neutral prose, leaving the
allowance/baseline unchanged. Descriptor policy now pins C0's
ownsDeliveredNotification:false and providerSpecificAdminActions:false /
genericAdminActions:true in the existing default-profile test. Readback without
an external identity explicitly returns unsupported for exact absence; empty
positive lookup collections still return unknown. No cases added. Lesson:
copying a representative port-fit fixture is not the frozen adapter policy;
assert the exact C0 policy fields in the existing descriptor witness.

Final corrected-candidate focused rerun: **1,595 / 11 passed**, 70.77 s wall time;
counts remain unchanged. Final build/typecheck, API check, ast-grep and focused
ESLint pass. Full lint previously passed with 33 existing warnings. Final neutrality
returns zero increases; documentation-impact API remains 3 obligations / 0
unanswered. All nine existing browser-entry budgets pass. Final measured caps
above reflect the corrected descriptor/readback candidate. No review or repair
budget was started or reset; committed reviews remain exclusively Claude-owned.


### O-P2 repair round 1

Authority: repair the two cold pre-reviews of `cfb0e54c`, apply the M08 P3 author
fit requirements, and run focused offline proof only. No Git writes, installs,
network/secrets, frozen-contract edits or delivery. Claude owns the next committed
review and delivery steps; this local repair does not start or reset their budgets.

| Finding / fit requirement | Fix and focused witness in `factory.test.ts` |
| --- | --- |
| R1/R2 malformed explicit event kinds | Guard present event values before the mapper's omitted-event fallback; taxonomy witness adds numeric, boolean, null, array, object and empty values. |
| R1/R2 proven pre-submission failures | Track the actual fetch invocation after credential resolution, Request validation and pre-submit abort validation; credential/request-construction witness requires closed not_dispatched with zero HTTP. Lost/malformed ACK and ambiguous POST witnesses still require unknown. |
| R1 credential destination / host path | Single-leading-slash segment grammar rejects alternate origins, credentials, schemes, backslashes, traversal, query/fragment and doubled separators before I/O; transport additionally checks resolved HTTPS origin. Unsafe-path construction witness asserts no credential or HTTP calls. |
| R2 incomplete readback | New internal page projection requires explicit page-zero, one-page totals agreeing with all rows and no next/incomplete marker. Pagination, missing totals and truncation remain unknown; complete duplicate/unique/unknown-status witnesses remain. |
| R1/R2 unsupported-operation witnesses | Label create/void now execute typed unsupported refusals with zero I/O; exact absence refuses before I/O and empty positive lookup remains unknown. Cancellation has no callable and no I/O; default-profile witness pins host-only labelRead, unsupported courierPickup and required label read refusal. |
| R1/R2 overlapping preparation minor | Per-request generation identity prevents delayed preparation from restoring superseded state; overlapping-preparation witness completes the older prepare after dispatch and proves only one POST. |
| P3 retained replay and mismatch preservation | Validate before changing preparation state; share an in-flight/completed result, clear transient body after the attempt, clone results to prevent caller mutation. Exact-byte, mismatch and concurrent/replay witnesses prove valid dispatch survives refusal and no replay I/O occurs. |
| P3 acceptance proof keys | Nonempty attempt/label keys hash accepted external reference plus prepared fingerprint; exact-byte witness pins shape and scratch expectedDispatch independently derives exact keys. Host worker still replaces keys. |
| P3 frozen label port | Inline factory return includes FulfillmentLabelPort. Frozen type requires read, so all three methods refuse unsupported without I/O. Exactly three public symbols remain; generated API delta is only the label field/import. |

Case accounting: factory **23** (was 19), transport adaptation **3**, six retained
characterization files **18**; adapter directory **44** (was 40). Cold-consumer
adds one authored case, unchanged. O-P2 **24**, public O-P1 + O-P2 **48**;
including private V-C1 18 and projected O-P3 2: **68 / 100**. Scratch diagnostics
are outside the hosted case ledger; no additional repository test file was added.

P3 pre-check: refreshed the existing scratch runner/contracts/worker/projection
files byte-for-byte from **a8708cf1**, copied repaired adapter sources, and saved
the updated seven-test fixture back to `N/a3omni-c0/p3check-conformance.test.ts`.
Accepted replay and label create/void fixture rows pass without adapter shims.
All **7 tests pass / 0 fail**; the complete profile reports **12/12** runner cases
and the refused-dispatch profile **10/10**. The two individual label profiles each
complete **11** runner cases; three direct probes cover mismatch, proof keys and
replay. This is isolated compatibility evidence; O-P3 committed integration and
provider account proof remain outside this repair.

Initial focused repair run passed **1,564 tests / 10 files** (9.13 s wall):
adapter 44, boundary 1,474 and cold-consumer 46. An early local run exposed header
case drift introduced by Request validation; preserving the existing injected
RequestInit fixed it without changing the unchanged donor witness. A scratch
command first ran from the implementation tree and found no files; rerunning in
the prescribed scratch tree passed. Platform no-emit typecheck, build, regenerated
API check, ast-grep, both source/test gitleaks scans and neutrality (0 increases;
UI smoke passes) succeeded. The pre-update API check correctly detected the new
label field; regeneration changed only this entry's snapshot. Pinned publication
policy passed with **3 obligations / 0 unanswered** before final navigation update.

Self-retro: phase information was lost by a generic error wrapper → record the
actual submission boundary at the existing transport seam. Retaining the one
result and adding preparation generations resolves replay/race requirements
without a durable cache or alternate transport. Preserve injected wire shape
when adding validation; the unchanged characterization witness caught the drift.


Final repair evidence: the separate neutrality CLI suite passed **35/35** (58.90 s),
for **1,599 focused tests / 11 files**, plus **7/7 scratch tests**. Focused ESLint
and whitespace checks passed; gitleaks also found no leaks in docs/platform or
platform API reports. TypeScript module inspection confirms exactly the factory,
capability descriptor and configuration type. Only the fulfillment example API
snapshot changed; no frozen contracts or registration values changed. The pinned
policy/docs-update sequence passed with **3 obligations / 0 unanswered** and no
generated navigation delta. Final pinned policy is required after this evidence
entry; committed native reviews and Claude's broader delivery gates remain owed.

Serialized offline artifact measurement after the completed build passes all caps:
docs **47,932 / 49,152 bytes** (5 files; **1,220 bytes headroom**), code **915,100 /
1,126,400**, tarball **1,061,108 / 1,351,680**, unpacked **4,728,049 / 5,734,400**,
files **1,479 / 2,100**. This is shared measurePack/checkPackBudget evidence, not
a clean committed artifact receipt. Seven tracked files are modified; Git remains
read-only and HEAD remains `cfb0e54c` for coordinator handoff.


### O-P2 repair round 2

Authority: close the two major findings in the full `64bee3d7` review with local
repairs and focused offline proof; rerun the isolated P3 pre-check. Existing
exclusions and Claude's Git/review/delivery ownership above remain in force.

| Finding | Fix and counterfactual witness |
| --- | --- |
| Unchanged prepare resets replay protection | Preserve the retained entry when closed evidence matches for the same request object, including its in-flight/completed promise; refresh only the input digest for host-only description changes. Existing exact-byte, mismatch/remap, rejection and unknown factory cases now re-prepare and require identical results with one POST. A changed address/revision yields a different fingerprint and permits one new POST; old evidence refuses. One new case gates the HTTP response, re-prepares during dispatch and requires both callers to share one POST/result. |
| Unreadable body loses definitive rejection | Check HTTP success before body parsing; failed rejection-body reads retain status and fallback code. Existing factory rejection and unknown cases add errored-stream HTTP 400 and 2xx respectively. One transport adaptation case requires status 400, `http_400`, non-retryable and mayHaveSucceeded:false with one POST. Donor characterization files remain unchanged; the transport deviation is listed in the provenance row above. |

Case accounting: **+2** this repair; factory **24**, transport adaptation **4**,
six retained characterization files **18**, adapter directory **46**. O-P2 **26**,
public O-P1 + O-P2 **50**, conservative round projection **70 / 100**. Expanded
scenarios reuse existing cases; scratch diagnostics remain outside the hosted ledger.

Simplicity rethink/self-retro: unconditional cache replacement erased replay
history → compare at the existing preparation seam and preserve the same entry.
A status already received survives a body failure → consume optional rejection
prose only after choosing the status path. Neither fix needs another cache or
transport. The required concurrency witness uses a gated response rather than timing.

Focused round-2 evidence on the local repair of `64bee3d7`: **1,566 tests pass /
10 files** (7.79 s, final rerun): adapter **46**, package-boundary **1,474**, cold-consumer **46**.
Platform no-emit typecheck, serialized build and API snapshot check pass; TypeScript
module inspection confirms exactly the factory, descriptor and configuration type.
Ast-grep, focused ESLint, whitespace and source/test/docs gitleaks checks pass.
Neutrality reports **0 increases**; UI neutrality smoke passes. The pinned policy
and docs-update pass with **3 obligations / 0 unanswered**, with no generated delta.
A final replay inspection also pins host-only title changes: unchanged wire evidence preserves the result while refreshing the request digest. Repeated focused tests, typecheck/build/API, ast-grep, ESLint, neutrality and gitleaks all pass on that final source. The final pinned policy check follows this evidence update. Frozen contracts, package
registration and API reports are unchanged; no Git writes, installs or network used.

P3 pre-check: verified all 11 imported runner/contracts/worker/projection files in
`a3-p3check` byte-for-byte against **a8708cf1**, copied repaired adapter sources and
reran the existing fixture. **7/7 tests pass** (0.38 s, final rerun); complete profile **12/12**,
refused-dispatch profile **10/10**, both individual unsupported-label profiles pass.
Dispatch replay/mismatch/proof keys, observation, readback and read-only stock/product
operations pass without adapter shims. This remains isolated pre-check evidence;
O-P3 committed conformance integration and Claude's required review/delivery remain owed.

### O-P2 repair round 3

Authority: the lead's structural replay decision for review r6 item 1 on
`01496c35`; local adapter/test/documentation repair and focused offline checks
only. No Git writes, installs, network/secrets, frozen-contract edits or delivery.
Claude retains committed native review and delivery ownership; no review/repair
budget is started or reset by this local run.

Finding: prepare A → dispatch A unknown → prepare B → prepare A discarded A's
submission promise and permitted a second POST. Round 2's evidence comparison
protected only adjacent unchanged preparations; that approach is superseded here.

Decision: keep the latest successful preparation replaceable per request object,
and retain submissions separately in an append-only per-adapter-instance Map keyed
by command fingerprint. A promise is inserted before credential/HTTP callbacks,
then settles to the accepted, unknown or refused result; prepare never touches it.
Dispatch validates the request and evidence before looking up or inserting a
submission. Replays clone the retained result, preserving proof keys and preventing
caller mutation. Removed the preparation entry's result field, retained-evidence
comparison and special request-digest refresh branch. The generation fence remains
necessary to refuse an older overlapping preparation completing late.

Memory grows with distinct submitted fingerprints during an example instance's
lifetime; this bounded workload tradeoff is accepted by the lead. Records are not
evicted, bodies remain transient, and durable replay across processes belongs to
the host/M08 worker. This adapter provides no cross-process replay protection.

Existing unknown and gated in-flight cases now deeply freeze the request and vary
only resolved lot metadata through A → B → A. Both require one POST and identical
replay results; stale A evidence while B is current refuses before new I/O. The
existing mismatch/remap case also proves a new fingerprint before any submission
can submit exactly once. Unchanged re-preparation, overlapping preparation,
refused replay and host-only description cases remain green.

Case accounting: **0 net-new**; factory **24**, transport adaptation **4**, retained
characterization **18**, adapter directory **46**. O-P2 **26**, public O-P1 + O-P2
**50**, conservative whole-round projection **70 / 100**, unchanged.

Focused evidence: **1,566 tests / 10 files pass** (7.06 s): adapter **46**,
package-boundary **1,474**, cold-consumer **46**. Platform no-emit typecheck,
serialized build and API snapshots pass; declaration inspection confirms exactly
the factory, descriptor and configuration type (three exports). Ast-grep, focused
ESLint and whitespace checks pass. Neutrality reports **0 increases**; UI smoke
passes. Source/test/docs gitleaks scans find no leaks. Pinned publication policy
passes with **3 obligations / 0 unanswered**; final docs-update/policy follows this
entry. Canonical and architecture owners now describe the separate replay record.

P3 scratch pre-check: all **11** imported runner/contracts/worker/projection files
match **a8708cf1** byte-for-byte; repaired adapter sources copied. Existing fixture
passes **7/7 tests** (0.28 s), complete profile **12/12**, refused profile **10/10**,
both unsupported label profiles pass. No adapter shim or committed integration
claim; O-P3 and Claude's required review/delivery remain owed.

Self-retro/rethink: replay protection tied to replaceable preparation state →
append-only submission record keyed by fingerprint. Separating preparation from
submission removes the evidence-comparison special case and protects replay
history across all intervening preparations rather than patching each sequence.


### O-P2 repair round 4

Authority: lead decision closing review r7/r8's two major findings on `8e363ad9`;
local repairs, ledger/owner documentation and focused offline proof, including the
actual pinned M08 worker in the existing P3 scratch tree. No Git writes, installs,
network/secrets, frozen-contract edits, committed review or delivery. Claude keeps
those existing review/delivery responsibilities; this run resets no review budget.

| Finding | Decision and regression witness |
| --- | --- |
| Fingerprint-only replay returns stale accepted evidence when the wire body is unchanged | Each append-only submission now stores its canonical evidence key as well as its request-value digest and result promise. Different evidence for that fingerprint refuses `not_dispatchable / dispatch / retryable:false` before I/O; matching evidence joins or replays the original result. Two new factory cases cover sequential and gated in-flight changes to contact revision, source, schemaVersion and carrierRef: same fingerprint, explicit refusal, one POST/credential call, original cloned replay unchanged. |
| Object-identity preparation rejects equal-valued inputs and M08 worker copies | Prepared bodies are keyed by the canonical serialization of complete evidence, with a digest of all frozen request fields. Dispatch compares request values; separate cloned request/evidence dispatch and replay pass. Missing, foreign, malformed and mismatched inputs still refuse before I/O. The actual `a8708cf1` worker passes with its separate prepare/dispatch shallow copies and an in-memory store fixture. |

Removed both WeakMaps, per-object generation tokens and fingerprint-only result
lookup. Numeric generations keyed by request value preserve the existing delayed
preparation fence, including separate equivalent objects. Before first submission,
superseded preparation for that request value still refuses; after submission,
original replay uses the retained request binding and needs no current preparation
entry. Existing unknown and in-flight A → B → A cases now require original replay
while B is prepared, as the lead decision supersedes round 3's stale-A refusal.
A successful new preparation may bind host-only description changes to unchanged
evidence; it cannot replace or erase the submission result. Bodies remain transient;
no host persistence or durable cross-process protection is added.

Case accounting: **+2** this repair; factory **26**, transport adaptation **4**,
retained characterization **18**, adapter directory **48**. O-P2 **28**, public
O-P1 + O-P2 **52**, conservative whole-round projection **72 / 100**. Scratch
worker diagnostic adds one local case (8 total), outside the hosted case ledger.

Self-retro/rethink: partial or object-identity keys for preparation/replay → key by
canonical evidence value, fence submissions per fingerprint. The worker witness
exercises the actual consumer's value-copy boundary; direct same-object fixtures
missed it. Reusing the serializer and existing state seams avoids a new transport,
cache subsystem or orchestration change. Focused evidence follows below.

Focused round-4 evidence: **1,603 tests / 11 files pass** (49.73 s): adapter **48**,
package-boundary **1,474**, cold-consumer **46**, neutrality tooling **35**.
Platform no-emit typecheck, serialized build and API snapshots pass; TypeScript
module inspection confirms exactly the factory, descriptor and configuration type.
Ast-grep, focused ESLint and whitespace checks pass. Neutrality reports **0 increases**;
UI neutrality smoke and source/test/docs gitleaks scans pass. The pinned policy
pre-check passed with **3 obligations / 0 unanswered**; the final docs-update/policy
sequence runs after this entry. No manifest, release-gate, API or frozen-port delta.

P3 scratch evidence: all **11** imported M08 runner/contracts/worker/projection files
match **a8708cf1** byte-for-byte; repaired adapter files copied. **8/8** scratch tests
pass (0.27 s): complete conformance **12/12**, refused profile **10/10**, both
unsupported-label profiles and the actual worker witness. Worker result:
`ok:true, checked:1, updated:1, failures:0, providerCalls:1`; exactly **1 POST**,
**1 mapped attempt**, **1 host-key acknowledgement**, **0 non-acceptance finalizations**.
This remains an isolated pre-check, with no adapter shim or committed integration
claim. Claude's committed review and remaining delivery gates stay owed. Git is
read-only and HEAD remains **8e363ad9** for handoff.

### O-P2 repair round 5

Authority: coordinator/owner-delegate conditions on repair 4 (`c8a924c6`): bound
the adapter's replay/preparation memory and demonstrate restart protection with
the actual M08 worker at `a8708cf1`. Local source/docs/API repair and focused
offline checks only; no Git writes, installs, network/secrets, frozen M08 edits
in this branch, review-budget reset or delivery. Claude retains review/delivery.
This lead decision supersedes round 3's unbounded-memory tradeoff.

The replay record is in-memory and per instance; it is **not** the durable
double-dispatch guard. Durable protection comes from M08's host ledger
(`claim` / `begin` / `recordProviderAttempt` / `finalize`), plus any idempotency
the provider honours. Donor evidence does not establish provider-side idempotency;
no such claim is made. Host-ledger persistence survives adapter rotation/restart.

`OmnipackFulfillmentAdapterConfig.maxRetainedSubmissions` defaults to **10,000**;
construction rejects nonpositive, fractional or unsafe integers. It caps each of
the submission, prepared-evidence and request-generation maps independently.
Submissions are never evicted. A new fingerprint at capacity refuses
`not_dispatchable / dispatch / retryable:false` before credentials/HTTP, while
matching recorded replays return identical accepted, unknown or refused results.
A new preparation key at its map's cap refuses the same reason in phase
`prepare`. Submission releases its transient preparation entry after reserving
the replay result; this cannot reopen a recorded fingerprint. Other preparations
and generation keys are not evicted. The host rotates the instance on exhaustion
and retains its durable host ledger. No cache dependency or new export is added.

Branch witness: `factory.test.ts` adds one combined retention case covering both
preparation-map bounds, dispatch capacity refusal with zero new credential/HTTP
calls, and accepted/unknown/refused replay at capacity. The existing construction
case now covers invalid capacities. No branch-local imitation of the absent M08
worker is added: the existing foreign-instance test proves missing preparation
refusal, not durable restart protection.

Scratch witness: `worker-restart.scratch.test.ts` uses the actual worker with a
fresh adapter and an in-memory host store already `submitting`, with the mapped
attempt recorded. Claim/readback preserve that state; the worker refuses with
`dispatch_not_safe_to_submit:submitting`, zero adapter dispatches and zero HTTP.
The fixture is also saved as `N/a3omni-c0/p3check-worker-restart.test.ts` for O-P3.
This proves worker use of persisted host state, not persistence of the fixture.

| Destination | Cases | Round-5 delta |
| --- | ---: | ---: |
| `factory.test.ts` | 27 | +1 |
| `transportAdaptation.test.ts` | 4 | 0 |
| Six retained characterization files | 18 | 0 |
| Adapter directory total | 49 | +1 |
| Cold-consumer authored addition | 1 | 0 |
| Scratch diagnostics (not hosted) | 9 | +1 |

O-P2 **29**, public O-P1 + O-P2 **53**, conservative whole-round projection
**73 / 100** (previous **72**); the additional scratch-only restart case makes
**74 / 100** if counted conservatively as future O-P3 acceptance too.

Self-retro/rethink: unbounded instance history → explicit no-eviction capacity
and host-ledger rotation. Releasing only preparations already reserved in the
submission map bounds memory without weakening replay or adding a cache policy.
The actual worker witness locates durable safety at the host-state boundary.
The first restart fixture omitted the donor codec's required phone and refused
preparation; supplying its synthetic phone corrected the fixture before proof.

Focused round-5 evidence: **1,604 tests / 11 files pass** (46.57 s): adapter
**49**, package-boundary **1,474**, cold-consumer **46**, neutrality tooling **35**.
Platform no-emit typecheck, serialized build and regenerated API snapshots pass;
TypeScript module inspection confirms exactly the existing three exports.
Ast-grep, focused ESLint and whitespace checks pass. Neutrality reports
**0 increases**; UI neutrality smoke and source/test/docs gitleaks scans pass.
Offline dry-run packing with the existing artifact-budget checker passes all
caps: docs **47,932 / 49,152 bytes**, **1,220 bytes headroom**, unchanged; code
**916,095 bytes**, tarball **1,062,087 bytes**, unpacked **4,732,370 bytes**,
**1,479 files**. No manifest, release-gate, README or frozen-port delta.
Pinned policy pre-check: **3 obligations / 0 unanswered**; final docs-update and
policy check follow this entry.

P3 scratch: checked **11/11** runner/worker/contracts/projection inputs against
`a8708cf1` byte-for-byte, with repaired adapter sources copied from this branch.
**9/9 tests pass** across the existing conformance fixture and new restart file:
complete profile **12/12**, refused profile **10/10**, both unsupported-label
profiles, existing worker acceptance (one POST, one mapped attempt, one host-key
acknowledgement), and restart refusal (**0 provider calls / 0 HTTP**, original
host record/attempt unchanged). The new scratch fixture also passes a focused
strict TypeScript check and gitleaks. No worker shim or branch-local worker
imitation; no committed integration claim. HEAD remains **c8a924c6**, Git
read-only; Claude's committed review/delivery obligations remain owed.


### O-P2 repair round 6

Authority and outcome: the lead's round-6 decision repairs r9 item 1 at
`c753b6ed`, the fifth replay-state interleaving, and r10's stale primary case
summary. Local source/tests/docs repair and focused offline proof only; no Git
writes, installs, network/secrets, frozen M08 edits, new delivery authority or
review-budget reset. Claude retains committed review and delivery. The existing
capacity, no-eviction, bounded-preparation and host-ledger obligations remain.

Finding: prepare(A)/dispatch(A,E), prepare(B)/dispatch(B,E), prepare(C), then
replay(B,E) changed accepted or unknown into definitive non-submission when
A/B/C differed only in host descriptions. The submission's request digest used
the replaceable preparation entry to decide whether B could replay.

Decision: remove request digests from submission records and all replay logic.
Validate well-formed closed evidence and its request-bound contact/selection
values first; then look up the append-only fingerprint record. Equal evidence
returns its identical recorded result (joining in flight); different evidence
refuses without I/O. Only an absent submission consults prepared command state,
its request/generation checks and capacity before recording and posting. No
extra replay-binding cache, fallback, dependency or fourth public export.

Proof plan and acceptance: one seeded model case generates **36 sequences**,
each with **96 generated operations** after an equivalent-wire triple. Its pool
has three fingerprints, two evidence values per fingerprint and three irrelevant
host descriptions per evidence value. Prepare, dispatch and concurrent dispatch
exercise accepted, ambiguous and definitive-rejection HTTP. An independent
submission model asserts exact results, conflicting-evidence refusals, no I/O on
refusal/replay and one POST per fingerprint. The same test must fail against a
copy of old `index.ts` and pass against the fix. The existing in-flight case
also carries r9's accepted/unknown reproduction, both completed and in flight,
and checks stateless mismatch refusals before replay. Focused branch checks and
the actual pinned M08 runner/worker/restart scratch checks remain required.

| Destination | Cases | Round-6 delta |
| --- | ---: | ---: |
| `factory.test.ts` | 28 | +1 model case; existing regression case extended |
| `transportAdaptation.test.ts` | 4 | 0 |
| Six retained characterization files | 18 | 0 |
| Adapter directory total | 50 | +1 |
| Cold-consumer authored addition | 1 | 0 |
| Scratch diagnostics (not hosted) | 9 | 0 |

O-P2 **30**, public O-P1 + O-P2 **54**, whole-round projection **74 / 100**,
or **75 / 100** conservatively including the scratch restart case. The primary
case table now shows these current totals, closing r10's summary nit.

Self-retro/rethink: replay decided from replaceable state → replay is a pure
function of the append-only submission record plus stateless validation; prove
with a model-based interleaving test. Removing the extra replay authority is
smaller than retaining another history of request digests. The old-code model
fails at sequence 0 after the third preparation; the repaired factory's 28
cases pass. Final focused and scratch evidence follows below.


Final round-6 evidence: the identical seeded model test fails with the copied
`c753b6ed` index at sequence 0's B replay after prepare(C): expected accepted,
received `not_dispatched / effectMayHaveSucceeded:false`. Replacing only that
copy's index with the repair passes (**1 model case**, 36 sequences, 3,456
randomly generated operations plus setup). Logs remain in the disposable
`/private/tmp/openlup-op2-r6-old-np6lelz4/model-{old,new}.log`; no old source was
restored into the task tree. The branch's focused run passes **1,605 tests /
11 files** (60.80 s): adapter **50**, package-boundary **1,474**, cold-consumer
**46**, neutrality tooling **35**.

Platform no-emit typecheck, serialized build and API check pass. TypeScript module
inspection confirms exactly `createOmnipackFulfillmentAdapter`,
`omnipackFulfillmentCapabilities` and `OmnipackFulfillmentAdapterConfig`; no API
snapshot change is needed. Ast-grep, focused ESLint and whitespace checks pass;
neutrality reports **0 increases**, UI neutrality smoke passes, and gitleaks
finds no leaks in adapter source/tests or platform docs. Pinned publication-policy
pre-check and docs-update pass with **3 obligations / 0 unanswered**; the final
policy check follows this evidence update. No manifest, README, release-gate,
API report or frozen-port changes were required.

Scratch proof: **11/11** M08 runner/worker/contracts inputs match `a8708cf1`
byte-for-byte; the repaired adapter is copied from this branch. **9/9** scratch
tests pass (0.267 s), complete profile **12/12**, refused profile **10/10**, both
unsupported-label profiles and actual worker acceptance: **1 POST, 1 mapped
attempt, 1 host-key acknowledgement, 0 non-acceptance finalizations**. The actual
worker-restart witness preserves the already-submitting host record and attempt,
refusing `dispatch_not_safe_to_submit:submitting` with **0 provider calls / 0
HTTP**. These remain isolated pre-checks, not a committed O-P3 integration claim.
HEAD remains **c753b6ed**, with no Git writes; Claude's committed review and
remaining delivery gates stay owed. No retry or review budget is reset.


### O-P2 repair round 7

Authority and outcome: the lead's round-7 decision closes the shared r11/r12
major finding at `07aa2b28`. This refines round 6: its no-request-digest rule
applied to replaceable preparation state, not the append-only submission record.
Local source/tests/docs and focused offline proof only; no Git writes, installs,
network/secrets, frozen M08 edits, delivery grant or review-budget reset. Claude
retains committed review and delivery; all existing capacity and host-ledger
obligations remain binding.

Finding: after A submits, dispatch(B, evidence-of-A) returned A's accepted or
in-flight result even when B changed order number, recipient address, quantity,
SKU or host request/fulfillment identity. Stateless evidence checks did not bind
those values. The one-POST invariant held, but the replay could falsely accept
a command that had never been submitted.

Decision: one pure `commandDigest(request)` uses the existing canonical serializer
and SHA-256. It includes requestKey, fulfillmentRef, orderRef, orderNumber,
parcelRef; all three contactRevision values; recipient name/email/phone/line1/
city/postalCode/country; ordered lines' skuRef/productRef/packRef/quantity; and
providerRef/carrierRef/serviceRef/deliveryKind/pickup-point ID. The dispatch and
outbound codecs forward none of line titles, recipient line2/deliveryInstructions/
courierInstructions or pickup-point provider/name/address to bytes or evidence;
a source comment cites those codec reads and excludes those descriptions.
The submission retains only the hash in memory. After stateless validation,
lookup by fingerprint requires both equal evidence and equal command digest
before replay/join. Either mismatch is `not_dispatchable / dispatch /
retryable:false` with no credential or HTTP I/O. New submissions record the digest
before callbacks. Recorded replay never reads replaceable preparation state.
The full-request preparation digest and generation fence remain unchanged.

Proof plan: extend the existing completed and explicitly held in-flight cases
with crossed stale evidence for every command field; extend the existing seeded
model with changed-command/evidence crossings across accepted, unknown and
rejected outcomes and concurrent submission joining. Description-only variants
remain allowed with independently codec-produced equal evidence. Run the same
model against a disposable copy of the old index and the repaired index, then
the focused branch checks and actual a8708cf1 scratch runner/worker/restart.
No authored cases added: factory 28, transport 4, characterization 18, adapter 50;
O-P2 30; public O-P1 + O-P2 54; whole-round 74/100, conservatively 75/100 with
the scratch restart witness. Scratch diagnostics remain 9 cases, not hosted.

Self-retro/rethink: evidence-only replay accepts changed commands → bind the
existing immutable submission record to command semantics, excluding only
codec-proven irrelevant descriptions. The prior simplification removed a needed
immutable binding along with replaceable-state dependence; independent request
and evidence generation exposes that distinction without another cache.


Final round-7 evidence: the identical expanded model fails against a disposable
copy of `07aa2b28` at sequence 0's concurrent crossed-command batch: stale evidence
returns recorded `unknown / effectMayHaveSucceeded:true` instead of the required
`not_dispatchable / effectMayHaveSucceeded:false`. Replacing only the copied
index with the repair passes the model: **36 sequences**, **3,456 generated
operations**, plus deterministic completed/in-flight crossings of **25 command
variants** across all three outcomes and the retained equivalent-description
triple. Old/new logs: `/private/tmp/openlup-op2-r7-proof/model-{old,new}.log`.
The task tree was never replaced with old source.

Focused branch checks pass **1,605 tests / 11 files**: adapter **50**,
cold-consumer **46**, neutrality tooling **35** (10 files, 52.40 s), plus
package-boundary **1,474** (one file, 3.61 s). Platform no-emit typecheck,
serialized build and API snapshots pass; TypeScript symbol inspection confirms
exactly the factory, descriptor and config type, with no API snapshot delta.
Ast-grep, focused ESLint and whitespace checks pass. Neutrality reports **0
increases**; UI neutrality smoke passes; gitleaks finds no leaks in adapter
source/tests or platform docs. Publication policy pre-check and docs-update pass
with **3 obligations / 0 unanswered**; final policy follows this evidence entry.
The canonical and architecture sections now describe the immutable command hash.
No manifest, README, release-gate or frozen-port changes were needed.

Scratch: **11/11** runner/worker/contracts/projection inputs match `a8708cf1`
byte-for-byte; only the repaired adapter index needed refreshing. **9/9** tests
pass (0.240 s): complete profile **12/12**, refused profile **10/10**, both
unsupported-label profiles, actual worker acceptance with **1 POST / 1 mapped
attempt / 1 host-key acknowledgement / 0 non-acceptance finalizations**, and
worker restart refusing `dispatch_not_safe_to_submit:submitting` with **0 provider
calls / 0 HTTP**, preserving the begun host record and attempt. These remain
scratch pre-checks, not a committed O-P3 claim. HEAD stays `07aa2b28`; no Git
writes, installs or network were used. Claude's committed review/delivery gates
and all existing consumed review/repair budgets remain owed and unchanged.


### O-P2 repair round 8

Authority and finite outcome: the coordinator's binding owner-delegate correction
supersedes round 5's no-eviction/capacity-refusal requirement. Admit new prepared
fingerprints at submission capacity, evict oldest completed entries, retain every
in-flight fence and keep preparation bounds. Scope is local source/tests/docs/API
and the prescribed scratch worker witness; no Git writes, installs, network,
secrets, frozen M08 edits, submission or delivery. Claude retains committed review
and delivery; existing consumed review/repair budgets are not reset.

The availability defect was the permanent dispatch refusal once a busy instance
had recorded 10,000 fingerprints. `maxRetainedSubmissions` and its positive-safe-
integer validation/default 10,000 remain. Admission order in the existing Map
provides oldest-first eviction; replay never refreshes age. A completion bit and
one trim function replace capacity refusal. Trimming runs on admission and every
completion, deleting only completed entries while above target. All-in-flight
maps may exceed the target; the first completion is trimmed immediately without
refusing another fingerprint. Preparation caps/generation fencing are unchanged.

Eviction ≡ restart for that fingerprint: no recorded adapter result remains,
and dispatch requires fresh preparation before another POST. The in-memory
per-instance record is not the durable guard; M08's host claim/begin/
recordProviderAttempt/finalize ledger is. Canonical and architecture owners now
state that distinction and the temporary in-flight overflow rule. Retained
submission evidence/command digest checks, result cloning and no automatic POST
retry remain intact.

Acceptance/proof: replace capacity-refusal coverage with admission at capacity,
oldest-completed eviction across accepted/unknown/refused outcomes, replay age,
evicted replay versus a fresh instance and re-prepared resubmission. One added
held-I/O case proves in-flight joining and out-of-order completion/overflow trim.
The existing model keeps 36 sequences × 96 generated interleavings plus its
25 changed-command crossings, and adds 36 × 32 explicit retention transitions:
a separate reference Map models eviction, retained no-I/O replay and new POST
lifetimes after eviction. All three HTTP outcomes have independently computed
expected results. Old/new copies run outside the task tree.

Scratch adds one actual-worker eviction test (saved as
`N/a3omni-c0/p3check-worker-evicted.test.ts` for O-P3). It submits A then B with
capacity 1, proves A has no adapter record, preserves A's begun host dispatch and
recorded mapped attempt, then replays A through the actual worker. The worker
must make zero provider/credential/HTTP calls and preserve that host state.
No worker shim or frozen-port change is introduced.

Case delta: factory **29** (+1), transport **4**, characterization **18**:
adapter **51**, O-P2 **31**, public O-P1 + O-P2 **55**; round **75/100**,
conservatively **77/100** including both scratch witnesses. Scratch diagnostics
are **10** cases; they remain pre-checks, not committed O-P3 conformance claims.

Self-retro/rethink: permanent capacity refusal converts a transient replay cache
into an availability limit → evict completed results and preserve only the
in-flight concurrency fence, relying on the already-owned durable host ledger.
The existing ordered Map is sufficient; no TTL, timer, second cache or new
configuration option is needed.


Final round-8 evidence: the identical updated model **FAILS** against disposable
index copies from **07aa2b28** (changed-command stale evidence returns recorded
unknown rather than refusal) and **c753b6ed** (equivalent-wire triple replay loses
the accepted result). It **PASSES** with the repaired index: **36 sequences**,
**3,456** original generated operations plus **1,152** explicit eviction
transitions, retaining the deterministic 25-command-variant crossings. Logs:
`/private/tmp/openlup-op2-r8-proof/model-{07aa2b28,c753b6ed,new}.log`. No old source
was written into the task worktree.

Focused branch tests pass **1,606 / 11 files**: adapter **51**, package-boundary
**1,474**, cold-consumer **46**, neutrality tooling **35** (48.15 s). Platform
no-emit typecheck, serialized build, regenerated API snapshot/check and TypeScript
symbol inventory pass: exactly the factory, descriptor and config type. The API
snapshot delta is only the retention option's documentation. Ast-grep, focused
ESLint and whitespace checks pass. Neutrality reports **0 increases**, UI smoke
passes, and source/test/docs gitleaks scans find no leaks. Package-root docs class
is unchanged at **47,932 / 49,152 bytes**, **1,220 bytes** headroom (5/10 files);
README, package manifests, release gates and frozen ports are untouched.
Publication policy pre-check passes with **3 obligations / 0 unanswered**;
regenerated navigation and final policy check follow this final evidence entry.

Scratch: **11/11** runner/worker/contracts/projection inputs match **a8708cf1**
byte-for-byte and the adapter index matches this repair. **10/10** scratch tests
pass (0.349 s), complete conformance **12/12**, refused profile **10/10**, and
normal worker acceptance **1 POST / 1 mapped attempt / 1 host acknowledgement**.
Both restart and eviction replay return
`dispatch_not_safe_to_submit:submitting` with **0 provider calls / 0 credentials /
0 HTTP**, preserving the begun dispatch and recorded attempt. The evicted witness
is saved byte-identically in N for O-P3. These remain scratch diagnostics;
Claude's required committed review and delivery gates remain owed. HEAD stays
**7d66e584**; no Git writes, installs or network were used.


### O-P2 repair round 9

Authority and finite outcome: the lead's rethink #3 supersedes preparation
caching, generation fencing and preparation bounds from prior rounds. Repair r13
item 1 and r14 items 1–2 by removing all preparation state. Scope remains local
source/tests/docs/API, disposable old/new model copies and the prescribed pinned
M08 scratch pre-checks. No Git writes, installs, network/secrets, frozen M08
edits, review-budget reset or delivery grant. Claude retains committed review and
delivery; earlier consumed budgets and remaining gates are unchanged.

The remaining defects share one cause: preparation history permanently consumes
capacity and can outlive its submission's eviction. Prepare now uses a shared
computation to resolve host metadata, build canonical bytes once, return closed
evidence and discard the body. No prepared-body or request-generation map,
generation fence or preparation capacity remains. The sole submission map keeps
round-7 command/evidence binding and round-8 completed-entry eviction.

Dispatch order is stateless evidence/request validation plus command digest;
retained record replay/join or explicit no-callback refusal; then, only for a new
fingerprint, reserve before host callbacks, rebuild, compare the fingerprint and
resolve credentials/POST exactly those bytes. Failed resolution or fingerprint
drift releases the reservation and refuses before credentials or provider I/O.
Host resolution callbacks run in prepare and again in new dispatches and must
return the same values for the same request, otherwise the host must re-prepare.
Evidence from another instance is valid if rebuilt bytes match. Eviction and
restart both remove only the replay record: they may POST again when evidence
still matches. M08's durable claim/begin/attempt/finalize ledger remains the guard.

STOP-rule finding: the unmodified `a8708cf1` runner samples `subject.readIoCount()`
around preparation, mismatched evidence and retained replay. The actual scratch
subject implements it as `calls.length`, incremented only in injected fetch;
it does not count host resolution callbacks. Rebuilding on mismatch is permitted
before provider I/O; no runner or frozen contract change is required.

Proof plan: replace preparation-cache tests with independent overlapping
preparation, dispatch without local prepare, callback drift/recovery, more distinct
completed requests than capacity, retained prepare → eviction → old dispatch
versus a fresh instance (both matching and changed callbacks), and reservation
joining before resolution. The existing seeded model has no preparation state;
it retains command-binding, replay, concurrent joining and an independent
submission/eviction oracle varying distinct request identities. Run unchanged
model tests against disposable copies of 07aa2b28, c753b6ed and 3db7e7ab, then the
repair. Refresh only adapter sources in the pinned M08 scratch tree, including
actual restart and evicted worker witnesses. Focused checks follow below.

Case counts unchanged: factory 29, transport 4, characterization 18; adapter 51,
O-P2 31, public O-P1 + O-P2 55; whole-round 75/100, conservatively 77/100 with
both scratch witnesses. Scratch diagnostics remain 10 cases, not a committed
O-P3 integration or conformance claim.

Self-retro/rethink: replaceable caches beside a replay fence keep producing
interleaving defects → make preparation pure and keep one bounded record.
Removing the second lifecycle is smaller than reclaiming generations or adding
cross-map eviction rules. The first focused test invocation combined a root and
config path incorrectly; using the package-local config path resolved it without
changing test configuration. No separate successor or process change is needed.


Final round-9 evidence: the unchanged model **FAILS** on disposable index copies
from **07aa2b28** (changed-command replay incorrectly returns unknown),
**c753b6ed** (equivalent-description replay loses acceptance), and **3db7e7ab**
(third distinct request preparation refuses at capacity 2). It **PASSES** now:
**36 sequences**, **3,456** generated operations, **2,592** bounded dispatch/join
transitions and the retained **25** command-variant crossings. Preparation calls
are generated operations, never modeled state. Logs are in
`/private/tmp/openlup-op2-r9-proof/model-{07aa2b28,c753b6ed,3db7e7ab,new}.log`.
Old source was never written into the task tree. Production index delta versus
3db7e7ab is **47 added / 47 removed, net 0 lines**: shared rebuilding and input
snapshotting replace both maps, their caps and generation lifecycle.

Focused checks pass **1,606 tests / 11 files** (55.96 s): adapter **51**,
package-boundary **1,474**, cold-consumer **46**, neutrality tooling **35**.
Platform no-emit typecheck, serialized build, regenerated API snapshots and API
check pass. Module-symbol inspection confirms exactly the factory, descriptor
and config type; the API delta documents stateless retention and repeated host
resolution only. Ast-grep, focused ESLint and whitespace checks pass. Neutrality
reports **0 increases**; UI neutrality smoke and source/test/docs gitleaks pass.
Pinned policy pre-check passes **3 obligations / 0 unanswered**. Navigation
regeneration and final pinned policy check follow this evidence update.

Scratch: **15/15** runner/worker/projection/contracts inputs match **a8708cf1**
byte-for-byte; only adapter sources were refreshed. **10/10 tests pass** (0.240 s),
complete profile **12/12**, refused profile **10/10**, normal worker acceptance
**1 POST / 1 mapped attempt / 1 host acknowledgement**. Actual restart and
evicted worker cases both refuse `dispatch_not_safe_to_submit:submitting` with
**0 provider calls / 0 credentials / 0 HTTP**, preserving begun host state and
its mapped attempt. These remain scratch pre-checks, not committed O-P3 claims.
HEAD remains **3db7e7ab**; no Git writes, installs or network/secrets were used.
Claude's committed review and delivery gates remain owed.
