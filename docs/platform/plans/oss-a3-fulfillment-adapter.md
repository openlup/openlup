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
| `server/infra/omnipack/client.ts` (identical) | `client.ts` | Remove environment/readiness reader and ambient-fetch default; require injected HTTP and a per-attempt credential supplier. Omit unused cancellation/inbound methods, related imports and config. Order creation takes serialized bytes; retry, timeout and auth semantics unchanged. Host explicitly supplies timing/path settings. Lead-approved repair: surface provider-supplied codes only when matching `^[A-Z][A-Z0-9_]{0,63}$`, otherwise reuse the donor's missing-code fallback `http_<status>`; payload values must not escape through error codes; donor passed codes unchanged. |
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
