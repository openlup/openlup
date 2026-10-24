# A3 fulfillment example adapter

Status: development-preview implementation ledger, 2026-10-22. O-P1 contributes
internal transport; O-P2 adds the opt-in OmniPack entry. Local native-review
repair 1 and O-P3 runner integration are implemented; O-P3 focused verification
is recorded below. Fresh committed native review and the broad gate remain owed.
No account-readiness, activation or release claim is made.

## Outcome, authority and boundary

Owner decision, 2026-10-21 (direct-carrier wording paraphrased): “Yes: start an A3
example-adapter round for OmniPack only (opt-in, default-off), with its own lead
after M08's port freeze; no direct-carrier packaging.” The frozen M08 P1 input is
`9328b676f28dfd08ccba159c25feb502e4c45ddd`. Platform maintains the preview example;
hosts own credentials, transport policy, metadata, account verification and activation.

Owner repair-1 grant (2026-10-22): Codex performs local merges, repairs, focused
checks and commits in O-P1 then O-P2 with the supplied identity and trailers.
Only `git fetch origin` is authorized network access; no push, PR, release,
account/adoption action, provider/database access, secrets or installs. Heavy
runs are serialized. Claude retains committed native re-review, broad gates and
delivery. Scope is the four supplied native reports, M08 merge reconciliation,
the selected hardening and documentation fixes; other advisory trims are excluded.
Acceptance is the focused checks in the owner brief, exact three-symbol entry,
unchanged registration, current documentation, bounded counts and clean worktrees.

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

O-P1 remains **24 net-new**. Current O-P2 and whole-round counts appear below;
loops extend assertions within existing authored cases. Generated package-boundary
rows are reported separately under ruling A; actual runtime still counts.

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

### Product-sync donor parity repair (2026-10-22)

Coordinator grant: restore the donor product-sync error, SKU and pack behavior,
retaining deduplicated reads and redirect refusal. Codex may edit, run the brief's
focused checks and make one local signed-off commit; no network, installs, secrets,
push, PR, adoption or release. Claude retains native committed review and delivery;
existing review histories, budgets and expiry are unchanged. Acceptance is the
three fake-HTTP cases below, unchanged donor witnesses and the requested focused
gates. Frozen ports, worker orchestration, default wiring and host persistence
remain outside this repair. Public exports remain exactly three.

Current donor comparison uses the adopter's locally available `origin/main`:
`client.ts` and `providerError.ts` own safe operation messages and encoded product
paths; `productSyncMappers.ts` owns pack filtering; the product-sync cron composes
`getStock`/`getProduct`, and `managedProductBinding.ts` observes Error messages and
pack counts before passing them to M08. The pack request builder validates writes;
that validation is separate from permissive response evidence.

| Decision | Implementation and impact | Reversibility |
| --- | --- | --- |
| 1 — Parity restoration: safe Error surface | All product and stock sync refusals/failures throw an internal Error subclass with typed `reason`, `phase` and `retryable`. Provider failures retain the donor operation message, bounded code and status plus `providerFailure:true` for host HTTP 502 mapping, without retaining a cause, payload or secret. Local `malformed`/selection refusals remain distinguishable. | Internal projection only; reverting would restore the defective `[object Object]` diagnostic. |
| 2 — Parity restoration: SKU admission | List every string SKU whose trim is nonempty, without trimming its identity, and use the client's existing `encodeURIComponent` per segment. The shared reference regex originally guarded opaque references against arbitrary prose/URLs (the `reference()` comment, O-P2 closed projections and prior-local-repair row 3), not a donor SKU grammar; it is not needed for URL safety. Slash, punctuation, Unicode and long identities now reach product reads. Literal dot segments and lone surrogates remain listed but throw a safe `malformed / sync` Error before HTTP: URL resolution would collapse the former, and encoding cannot represent the latter. M08 counts these as per-SKU `failures` with `ok:false` and `reason:product_sync_operation_failed`; no new silent omission. | Reverting narrows coverage again. Other reference-bearing ports retain their existing validation. |
| 3 — Parity restoration: pack evidence | Remove only the factory's extra read filter. Exactly the donor mapper keeps string EANs with `length > 0`, preserves finite numeric quantities (including zero, negative and fractional values), and uses zero otherwise. Closed `{ean, quantity}` projection remains; host validation/conflicts stay observable. No donor defect is asserted: provider evidence and write admission are different boundaries. Explicit-write validation is unchanged. | A local factory revert would again hide packs and alter reconciliation evidence; no migration is involved. |
| 4 — Adapted (donor-divergent) behaviours: SKU dedup | Keep `Set` dedup. Two equal stock rows cause one product read/upsert/resolve sequence: successful `pulledSkus=1`, `providerCalls=2` (one stock listing plus one product read), versus donor 2/3. Counters describe completed provider-method reads, not stock rows or HTTP retry attempts. | Removing the `Set` restores duplicate reads and donor counters; no stored schema changes. |
| 5 — Adapted (donor-divergent) behaviours: redirect refusal | Keep `redirect:"error"` on every fetch; a redirect fails rather than following to another endpoint. Native repair C-4e protects against repeating a POST body on 307/308. | Removing the option restores fetch's donor redirect-following behavior but loses this hardening. |

One existing safe-failure case covers decision 1 against fake transport and HTTP
503, including bounded-code fallback, all sync operations and Error refusals.
One new fake-HTTP SKU case covers decision 2, actual encoded URLs, dedup counters
and counted unsafe-segment failures. One existing product case covers decision 3,
including short/non-numeric/blank EANs and nonpositive/fractional/fallback quantities.
Net-new **1**, whole round **76 / 100**; all six characterization files unchanged.

Plain-object throw audit: dispatch throws only Errors internally; readback and
observation call `observation()` which still throws plain `missing_correlation`
and `malformed` refusals internally. Their enclosing catches return the frozen
port's result unions; no plain object escapes these public methods. Those port
semantics are preserved rather than replaced with public exceptions.

Simplicity pre-check: reuse client encoding and donor mapping, remove the extra
read filters, and add one private Error projection. No new exported type, worker
result shape, dependency or generic sanitizer is needed. Unsafe SKUs use the
existing worker failure counter rather than a parallel reporting mechanism.

Focused verification: lint passed (0 errors, 33 existing warnings), including
Core/Outbox/Platform builds. Platform strict no-emit typecheck and `api:check`
passed with no snapshot change. Direct Vitest over fulfillment, package boundary
and cold consumer passed **1,822 tests / 29 files**; factory **30**, unchanged
characterization **18**. Public neutrality reported **0 increases** and UI
neutrality passed. Policy/docs regeneration passed with no generated delta;
final policy and commit gitleaks results are recorded in the local handoff.
An extra standalone strict check of the factory test reports existing TS2339 on
`profile.readiness.refusal`; the unchanged baseline reproduces the same diagnostic
(one line earlier). This is outside the package build's source-only typecheck and
is left unchanged. No broad test, install or network command was run.

Self-retro: the initial factory probe lacked built Core declarations and collected
no tests; the lint prebuild resolved it. Reuse the documented build prerequisite
before direct Vitest. Removing the read filters preserved donor evidence with
less code; one existing worker failure path also made unsafe SKUs observable.

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

## O-P2 public neutral-port glue

Outcome: add only the opt-in `@openlup/platform/fulfillment/omnipack` entry on
updated O-P1, retaining current main's M08 contracts and all donor witnesses.
The three public symbols are `createOmnipackFulfillmentAdapter`,
`omnipackFulfillmentCapabilities` and `type OmnipackFulfillmentAdapterConfig`.
The factory's inline return type uses the frozen dispatch, label, observation,
readback and sync provider ports. No parent re-export, orchestration, default binding,
route, schedule, SDK, dependency or account activation is added.

The repair-1 owner grant above supersedes earlier local-only Git restrictions.
O-P3 integrates the actual, now-shipped M08 runner below. Prior scratch results
do not establish current-tree integration or provider/account readiness.

Current implementation/proof: retain the client/codecs and
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

### O-P2 case ledger

| Destination | Cases | Status | O-P1 + O-P2 running total |
| --- | ---: | --- | ---: |
| `packages/platform/test/fulfillment/omnipack/factory.test.ts` | 30 | net-new glue/refusal/redaction; rounds 1/2/4/5/6/8 add 4/1/2/1/1/1; donor parity adds 1; existing replay/model cases extended | 54 |
| `packages/platform/test/fulfillment/omnipack/transportAdaptation.test.ts` | 1 | round 2 unreadable rejection; 3 O-P1 cases retained | 55 |
| `scripts/packages/platform-cold-consumer.test.ts` | 1 | net-new installed import/default-off/injected I/O | 56 |

Current counts: factory **30**, transport **4** (3 O-P1 + 1 O-P2), characterization
**18**, adapter total **52**. O-P2 is **32 net-new** including the one cold-consumer
case. O-P1 + O-P2 is **56**; private V-C1 18 + 56 + O-P3 2 = **76 / 100**,
leaving 24 cases, including the 10-case planning reserve. The earlier conservative
77/100 projection counted two separate scratch worker cases; O-P3 combines those
scenarios into one authored case and the runner fixtures into one. Repair 1 adds no
`it()` cases. Generated package-boundary rows remain separate under ruling A.

Simplicity pre-check for Claude's committed reviews: reuse the contributed
transport/codecs, keep preparation transient and project allowlisted fields;
a second transport, durable command cache or generic sanitization framework is
unnecessary. Native reviewers must review the committed stabilized tree, with
two independent full reviews under the existing process, including simplicity.

## Prior local repairs: findings → decision → lesson

Nine local repair rounds preceded these native reports. They do not reset any
native session counter, repair budget, finding history or expiry. Those remain in
the existing native session; this ledger is not a review receipt. Historical
local/scratch observations below are not current-tree acceptance evidence.

| Rounds / findings | Decision | Lesson |
| --- | --- | --- |
| 1: mutable requests, incomplete readback, explicit malformed event | Snapshot command inputs, require complete page totals, distinguish absent and malformed event kinds. | Admit evidence only at its actual boundary. |
| 2: unreadable HTTP rejection, weak input shape | Preserve definitive rejection from status and validate before callbacks. | Response parsing must not erase known non-submission. |
| 3: replay identity and neutral projection gaps | Bind full evidence/contact and project closed outputs. | Keep provider bags transient. |
| 4: object identity blocked cloned worker inputs | Bind equal-valued request/evidence; use the actual worker in scratch. | Value contracts must survive serialization. |
| 5: preparation capacity and callback races | Bound state and reserve before awaiting resolution. | Async admission needs a single owner. |
| 6: crossed-command replay | Model concurrent/repeated preparation and recorded submission independently. | Tests need an independent state oracle. |
| 7: changed-command stale evidence | Bind evidence plus command-bearing request digest; omit codec-unused descriptions. | Keep precisely the identity that affects the command. |
| 8: unbounded completed retention | Evict oldest completed entries, never in-flight; eviction behaves like restart. | Durable double-dispatch protection belongs to the host ledger. |
| 9: preparation history consumed capacity and outlived submissions | Remove all preparation state; rebuild only new submissions and compare fingerprints. | Replaceable caches beside replay fences → pure preparation plus one bounded record. |

Round 9's unchanged seeded model rejected three earlier defective implementations
and passed the repaired tree: 36 sequences, 3,456 generated operations, 2,592
bounded dispatch/join transitions and 25 command variants. Historical focused
checks passed 1,606 tests / 11 files. Scratch used 15 byte-matched M08 inputs,
10 tests and actual worker restart/eviction refusal with zero provider calls.
Those disposable paths and unreachable intermediate commits are omitted; none
establish committed O-P3 conformance. Earlier scope, failed attempts and consumed
budgets carry forward; no successor programme is opened.

## Native-review repair 1 (2026-10-22)

Inputs: native O-P1 reports A/B failed with material A-1/A-2/B-1; O-P2 report C
failed with material C-1, while D passed with advisory findings. The owner selected
the fixes below. Fresh native review remains owed after these local commits.

| Finding | Fix / decision | Lesson |
| --- | --- | --- |
| A-1 | W2 optional signal access prevents a removed signal becoming a false timeout pass. | Observe the deadline, not an incidental TypeError. |
| A-2 | Existing error loop adds mixed-case email, hyphen and mixed/lowercase code plants. | Discriminate each independent regex widening. |
| B-1 | Existing ui-15 plants cover package/prefix/segment, other plans/report, extension and token-prefix boundaries. All seven broader mutants failed; matcher restored unchanged. | Negative plants must fail on broadening. |
| B-4 | A3 follows main's M08 architecture lead. | Preserve canonical owner context. |
| C-4e | Every fetch refuses redirects; existing POST case includes 307/308 and checks `redirect: "error"`. O-P2 annotates its intermediate request as `RequestInit`. | Prevent redirected POST body repetition at the transport boundary. |
| C-1 | Existing default-off case dispatches selected-twin evidence against unselected and unready adapters; readback and all sync methods refuse with zero credential/fetch calls. | Test each callable gate on a new submission. |
| C-2 / D-4 | Selected/ready construction leaves the exported descriptor default-off; freeze every nested object and expose `Readonly` like the payment descriptor precedent. | Runtime immutability complements a copied profile. |
| A-4 | Existing factory already validates numeric settings; existing construction case now rejects invalid timeout/retry values before credentials or HTTP. | Pin the constructor boundary without duplicate validation. |
| D-1 | Three fulfillment subpaths and the whole API report family are documented in architecture and generated source mapping. | Navigation must cover the opt-in entry. |
| D-2 | Contributor proof and fragment name missing or malformed evidence, consistent with stateless preparation. | Describe the current refusal, not an obsolete cache. |
| D-3 | Replace long repair history with this table; remove machine-local paths, unreachable intermediate SHAs and stale projections/authority. | Retain decisions, budgets and proof limits without replaying chronology. |
| D-6 | Canonical readback contract states page 0 / size 100 and at most 100 rows. | State the practical coverage bound. |

Merges retain main's M08 sources, contracts, reports, plan, release rows, consumer
parts and generated release snapshot. Publication rows are the sorted union;
README has the OmniPack row once and Canonical Contracts has one combined class
paragraph. Both branches have exactly one merge base with main. The approved
package export and release-gates row remain unchanged.

Self-retro: O-P1's first focused run caught an edit syntax error and a wrong 307
expectation, fixed before its 1,623-test rerun. Neutrality also caught a vendor
word in redirect prose; neutral wording passed without a scanner change. The
O-P2 merge build caught literal widening in its intermediate request object;
a `RequestInit` annotation fixed integration without changing behavior. Existing
cases cover these repairs, so no new harness or authored test case was needed.

## Repair-1 focused evidence

O-P1: merge and repair committed on the internal branch. Lint/build (33 warnings,
zero errors), no-emit typecheck and API check passed. Fulfillment, package-boundary
and neutrality tooling passed **1,623 tests / 22 files** in **47.43 s**. All seven
broadened neutrality mutants failed; the scanner was restored. Tree neutrality
had **0 increases**, UI smoke passed, commit-range gitleaks found no leaks, and
policy/regeneration/final policy passed **2 obligations / 0 unanswered**.

O-P2: transitive M08 declarations were regenerated during the merge; the repair
API delta adds `Readonly` only. Compiler symbol inspection confirms exactly the
three intended exports. Serialized lint/build (33 warnings, zero errors),
no-emit typecheck and API check passed. Fulfillment, package-boundary, neutrality
and cold-consumer suites passed **1,708 tests / 24 files** in **46.68 s**. The
first new gate assertion used the wrong phase/reason; the corrected existing
`not_dispatchable / dispatch` contract passed the targeted and complete reruns.
Tree neutrality had **0 increases** and UI smoke passed. Stacked policy, docs
regeneration and final policy passed **4 obligations / 0 unanswered**, pinned to
updated O-P1. The source-map routing change required the substantive ownership
explanation in Documentation; regeneration includes the whole report family.
The package artifact gate passed on the committed package bytes: **1,551 files**,
**1,112,562 packed bytes**, **4,964,926 unpacked bytes**; code class
**968,390 / 1,126,400 bytes**, docs class **46,381 / 49,152 bytes** (5 / 10 files),
leaving **2,771 docs bytes**. All size/file/browser caps passed with no findings;
no budget, export registration or release-gates row changed. The local pack ran
with offline npm and no installs. Commit-range gitleaks found no leaks. This
closing evidence update changes no package bytes.

Local repair handoff: both assigned worktrees are clean after their commits,
M08-owned files match main, the A3 scanner implementation is unchanged by this
repair, and no push or PR was performed. Fresh committed native reviews, their
existing counters/expiry, the supervisor's broad gates and O-P3 remain external
to this bounded repair; no acceptance or review budget was reset.

Final self-retro: keeping the existing cases preserved the 75/100 round projection
(77/100 conservatively) while adding independent refusal and mutation evidence.
The ledger consolidation removes 800+ narrative lines; the actual docs artifact
measurement replaces stale projected headroom. No further in-scope improvement
is needed.

## O-P3 offline M08 integration (2026-10-22)

Owner's minimal-mode grant: Codex implements and commits only in the assigned
O-P3 worktree, stacked on O-P2 `423dbab7`, using the supplied identity/trailers.
No push/PR, network, installs, secrets or account actions. Full `npm test` and
`test:scoped` are excluded; Claude's committed native reviews and gated run remain
separate and retain all existing counters and expiry. Scope is one conformance
file, its public catalogue row, exactly one smoke-evidence line, contract and
architecture-owner prose, this ledger, a change fragment and required generated
navigation.

Acceptance: actual merged M08 runner with injected fake HTTP and independent
expected bytes/evidence; real worker with an in-memory begun/recorded host ledger
for restart and eviction; focused checks, no API change, neutrality increases or
case-budget overrun. No production adapter, M08 implementation, export, dependency,
default binding, persistence or budget control changes are authorized.

| Destination / responsibility | Cases | Round running total |
| --- | ---: | ---: |
| `packages/platform/test/fulfillment/omnipack/conformance.test.ts`: one subject, 13 runner evidence rows | 1 | 74 |
| Same file: real worker restart and eviction scenarios, one authored case | 1 | 75 |

At O-P3 integration, before the parity repair above: O-P3 was **2 net-new**; public O-P1/O-P2/O-P3 was **57**; private V-C1 **18** gives
**75 / 100**, with **25** remaining. Runner evidence rows and loop scenarios are
assertions within authored cases, not generated cases. Generated package-boundary
rows remain separate under ruling A. No donor witness is removed or weakened.

The subject covers selection/default-off, accepted dispatch/replay, prepared
fingerprint mismatch before I/O, refused prepare, label create/void unsupported,
verified and unsupported observation, positive and empty readback (unknown,
never exact absence), stock snapshots/movements and product packs/SKU listing.
Sensitive plants cover contacts, credentials and signed tracking URLs. The worker
fixture preserves one mapped attempt and a submitting record and requires zero
provider dispatch, credentials, HTTP, begin, finalize or acknowledge calls after
restart or completed-record eviction; this is offline host-ledger fencing proof,
not a production store atomicity or provider-account claim.

Simplicity pre-check for the supervisor's committed review: reuse M08's runner and
worker directly; one fixture subject and one two-scenario host store avoid new
runner abstractions and duplicate scratch cases.

Focused verification: `npm run lint` passed (0 errors, 33 existing warnings),
including Core/Outbox/Platform builds and Platform's strict build typecheck.
The new test also passed a focused strict `tsc --noEmit` check with explicit
Node types.
Platform `api:check` passed without snapshot changes. Direct Vitest over
`packages/platform/test/fulfillment`, `packageBoundary.test.ts` and the cold
consumer passed **1,675 tests / 24 files**: fulfillment **83**, generated boundary
**1,546**, cold consumer **46**. The new file passed **2 cases**, including one
subject's **13** exact sanitized runner rows; restart and eviction each returned
`dispatch_not_safe_to_submit:submitting` with **0** provider/HTTP calls. The
existing factory remains **29**, transport **4**, characterization **18**;
new conformance **2** gives **53** adapter cases. An initial probe needed the
existing Core build prerequisite; the post-build probe and complete focused
reruns passed. No full/gated test command was run.

Tree neutrality passed with **0 increases**; UI smoke passed with zero forbidden
hits; working-tree gitleaks found no leaks. The offline artifact preview used the
existing tarball/content/size/browser check functions: **1,551 files**,
**1,112,563 packed / 4,964,983 unpacked bytes**, code **968,390 / 1,126,400**,
docs **46,386 / 49,152** (5 / 10 files), **2,766 docs bytes** headroom; no findings.
The package checker requires committed bytes, so its final run follows the local
commit. `release-gates.json` has exactly **one added line**, registering this test;
all caps, API entries and other smoke rows are unchanged.

Stacked documentation policy uses exact O-P2 `423dbab7`. It found two owner
obligations: the architecture section now explains runner/worker proof, and the
package README's unchanged contract is justified by the delta-bound commit
trailer (only another smoke witness is registered). The final policy and
`--docs-update` runs consume that own-commit trailer after signing; generated
changes, if any, are committed before the final check. Current source-release
bindings are computed; their stale release-preparation snapshot is informational.
Fresh committed native review and the supervisor's broad gate remain owed;
no native session, repair counter or expiry is replaced by these focused results.

Self-retro: adopting the scratch assertions into two authored cases avoided
separate runner-row and worker-scenario tests while retaining independent expected
bytes and explicit eviction proof. Missing build prerequisites caused one failed
probe; build the existing dependencies before probing package entry imports.
No production mechanism or additional process was needed.
