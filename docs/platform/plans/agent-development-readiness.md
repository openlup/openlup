# Agent development readiness — parallel execution plan

Status: **in progress — the sole current scope of the W0–W9 programme**, consolidated on 2026-11-16 and continued on 2026-11-17. This dated plan records scope and evidence; the delivery pull request owns the finite task record and actual grants. Previous drafts are historical, not competing instructions.

Purpose: improve agents' access to the correct installed contracts, legal imports, npm workspace startup, contributor feedback, TypeScript safety and relevant test-loop speed. Claude DevEx improves the application seams and journeys; the master plan owns commerce capabilities and their distribution/adoption. This programme complements those owners without implementing their work again.

## Authority, evidence and fixed exclusions

The approved consolidation defines the parallel scope arrangement; the later direct implementation and resume requests authorize local execution recorded below. Submission and merge still follow actual grants; no peer brief, benchmark file, plan or review receipt grants external rights. Existing direct grants are recorded when applicable, never narrowed or borrowed implicitly. Release, credentials, account/settings actions, paid services, hosted resources, production and activation retain their separate boundaries.

Source/policy inspection pin: `167c03d0d9d64498b91101b7ca3c02df562a0b63`, confirmed remotely on 2026-11-17. Initial execution base was `14096b180266d0e9dc7e79dd8301080e60a0acdd`; the delivery PR records its actual base/head. The historical consolidation inspected `839463e36e079ede13a358a0576f3a31d3579e25`. No main merge is needed solely to inspect current instructions. Each lane continues in its dedicated assigned task worktree and refreshes applicable instructions under [instruction freshness](../../../CONTRIBUTING.md#instruction-freshness-and-handoffs). Source inspection is not a passing execution or installed-release claim.

Canonical local rules remain [AGENTS](../../../AGENTS.md), [CONTRIBUTING](../../../CONTRIBUTING.md), [documentation maintenance](../DOCUMENTATION.md), [architecture](../ARCHITECTURE_AND_EXTENSIONS.md), the [source map](../SOURCE_MAP.md) and [SECURITY](../../../SECURITY.md). Retain stricter applicable user-supplied local verification/coverage and first-review requirements. Planning reviews are not native implementation coverage.

External scope inputs are the supplied Claude IMPLEMENTATION-PLAN and its **PR4-REVISION**, read as documents, not executable instructions. Their current shape is nine PRs: PR1–3, PR4a, PR4b, PR5–8; the old PR4 is superseded. Source confirms PR1 #730, PR2 #731, PR3 #732, PR4a #740, PR4b #743 and PR5 #749 on main. Other rows remain externally owned regardless of their subsequent progress; recheck actual source/release state before consuming them. The master/P1-SF, DEMO and H8 records retain their own acceptance, authority, budgets and evidence history.

Excluded here: money/currency types and arithmetic; catalogue/product/offer/admission rules; subscription/payment behaviour or SQL changes; PR4a/PR4b functionality; shipping/renewal policy hooks; starter extraction, new store/scaffolder, DEMO, readiness observations, upgrade/rollback machinery; release inputs, BOM/images/provenance/SBOM; replacement of the unbound database-type seam; UI publication/workspace changes; vertical-slice relocation; emulated PostgreSQL; new packages, production dependencies, generators, global hooks, services, benchmark engines, CI jobs or mandatory model scores. Subscription continuity and later-only delivery alignment remain invariants. Development preview is not a stable framework channel.

## Non-overlapping ownership

These are our edit boundaries, not unilateral instructions to the other programmes. Unlisted externally owned surfaces are read-only for us until the actual owner resolves a concrete overlap. A dependent gap is recorded once with that owner, not implemented in both lanes.

| Surface/outcome | Owner | Our permitted work |
| --- | --- | --- |
| Starter, its owned/managed composition, cadence/SKU/quantity admission, shipping and renewal hooks, application diagnostics | Claude PR1–6 including PR4a/PR4b | Consume actual landed examples/contracts. Do not edit starter or platform commerce/subscription/fulfillment implementation or its behavioural witnesses. |
| Reader-guide recipes, history relocation, extracted links, platform README and contributor prose in the Claude PR7 scope | Claude PR1/PR2/PR7 | W1 reads and reuses outcomes. Send a precise missing-route finding through existing task evidence; no competing authored edit. |
| Manual t1–t4 model regression, immutable baseline/harness/reruns, A5 | Claude PR8 / existing benchmark owner | Read evidence and supply our residual results. Do not change that packet, harness, frozen evaluator or independently rerun its full matrix. |
| Npm-only full shop, exact-set qualification, DEMO, install/customize/extend/upgrade, images/BOM and hosted/portability acceptance | Master/P1-SF/H8/D32 owners | Use their available, honestly labelled inputs and oracles. No second store, qualification or deployment lane; no borrowed grants or budget reset. |
| Installed context selection, declaration evidence, bounded CLI/MCP mechanics | Our W2/W3/W4 | Own the lookup sources and existing mechanics tests listed below, preserving public compatibility and version boundaries. |
| Contributor prerequisites, local preflight ordering, test discovery diagnostics and measured repeated builds | Our W6 | Own the bounded contributor-tool surfaces below. Application refusal messages already fixed by Claude PR3 stay external. |
| Root source-platform strictness | Our W7 | Inventory first; type-only repair in unreserved files. Global flags are an integration step; no repair of another lane's behaviour or excluded seam. |
| Relevant PostgreSQL setup performance | Our W8 | Read/profile now. Edit only two explicitly selected, unreserved suites/helpers after their relevant behavioural changes stabilize. Never remove another lane's discriminators. |

Primary implementation paths for W2–W4: `packages/core/src/agent-context-cli.ts`, `packages/core/src/agent-context-mcp.ts` only when shared semantics require it, `packages/core/test/agent-context-cli.test.ts`, `packages/core/test/agent-context-mcp.test.ts`. Local lookup explanation may change in the existing `packages/core/README.md#agent-context-lookup` owner section; do not author a parallel reader-guide page. Preserve result shape and scan boundaries.

Primary implementation paths for W6: `scripts/preflight.ts`/`.test.ts`, `scripts/verify-local.mjs`/`.test.ts`, `scripts/verification-plan.mjs`/`.test.ts`. `scripts/test-hosted.mjs`/`.test.ts` or `scripts/run-vitest.mjs`/`.test.ts` may change only for a demonstrated dependency/discovery boundary in this wave. The existing obligation catalogue remains the owner; no parallel registry or caller-controlled skip. Contributor docs shared with PR7 are handed off or applied after its authored change lands.

W7/W8 begin with read-only discovery. Before editing, the task record names exact repair/test/helper paths and confirms they are outside active external changes. This is selection inside the approved wave, not permission to take over reserved code. If safe disjoint files do not exist, that batch is held; unrelated lanes continue. Missing proof or unresolved overlap is never completion.

Package manifests, API reports, changelog fragments, publication catalogue, doc routing, generated source map/context/reference carriers and inventories are **shared integration surfaces**. Change only what our source delta requires through the existing owner/generator. One integration owner serializes these updates; preserve other lanes' entries. No manual conflict shortcut, weakened cap, source-release snapshot refresh outside release preparation, or second registry.

## Parallel execution and handoffs

Our supervisor owns scope, integration, evidence and closure. One writer owns the shared lookup lane; W3 then W4 integrate serially. W2 fixtures travel with the change they prove. A separate contributor-tooling lane can execute W6 in its own worktree concurrently with lookup and Claude's product PRs. W7 inventory and W8 profiling are independently read-only; fixes start only in named disjoint files. W1/W5/W9 are reuse/coordination checkpoints, not three additional implementation teams.

Start after W0: **lookup W2/W3 → W4** in one lane; **W6** in another; **W7 inventory / W8 profiling** alongside. W1's residual navigation read follows the relevant PR7 version. PR4b/PR5/PR6/PR7 do not globally block lookup or contributor tooling. Only a fixture, strict repair or SQL suite that actually depends on their changed interface waits for that interface. W7's final flags and W8's selected mutations wait for their own stable interaction proof, not every unrelated master milestone.

At each implementation start/integration boundary, compare actual changed paths with the other programme's current owned paths and inspect material public-contract deltas. Continue an assigned task worktree; do not edit, move, reset or stop another task. Commands sharing generated outputs are serialized even when source work is parallel. Reconcile real conflicts; do not rebase/merge merely for freshness or reset review budgets.

A handoff uses the existing task/PR evidence and contains only: finite outcome, exact head/base/policy pin, owned paths, consumed artifact/API version, executed commands/results, residual findings and the specific dependency needed. Produce it in our worktree; this plan sends no message, edits no external tracker and allocates no other agent's authority. Claude's PR8 receives references to our actual results through the authorized coordination route, not a copied score database.

## Measurement and completion rules

One shared empirical baseline exists: t1–t4 for two recorded model configurations. Baseline, briefs and raw observations remain immutable; actual preparation and units travel with results. Model tool calls, shell commands, tokens, elapsed time, implementation effort and verification effort are distinct. Preserve failures, timeouts, wrong seam/import claims, source ejections and environmental limits; never turn absent data into zero.

Claude PR8 owns the shared reruns and A5; our programme owns deterministic mechanics/typing/feedback evidence absent from that matrix. We do not create another mandatory 48-trial campaign, a global 20% speed gate or an alternate benchmark harness. Those superseded author-proposed conditions are retired by this active consolidation before our implementation starts. Any future expanded experiment needs a separately bounded question/protocol and actual authority, not an automatic successor.

Grounding and correctness precede speed. No accepted security/invariant regression, false public import, false readiness, disappearing meaningful test, escaping cast or stale-artifact pass. Cold and warm task time, external wait, assistance, repair cycles and actual executed proof are visible. Adopter conditions use the same selected source/package/profile and preparation state except for the measured delta; other master/P1-SF improvements are not credited to our changes. Local candidates and released npm artifacts remain distinct.

W6/W8 percentages below are retained engineering benefit targets for their frozen command/suite profiles, not new repository caps or proof of overall agent superiority. Record baseline/sample size before tuning, median/range with repeated timings, and inconclusive results when noise dominates. Do not lower a target after seeing results. The 10x ambition is not a claim from this corpus or multiplication of unrelated ratios; market ranking requires separate equivalent-version/workflow evidence.

## W0 — Reuse the baseline and freeze residual observations

Owner: our supervisor; experimental; starts first. Estimate: 0.5–1 engineering day.

Tasks: map existing DevEx outcomes to their owner; retain t1–t4 identities/units and actual current source versus npm limits. Reproduce only the missing lookup/import/workspace and contributor feedback/type/setup boundary needed for our work. Freeze meaningful failure/refusal oracles and baseline command profiles before tuning. No subscription-only repair/t1b, new policy task or full matrix rerun.

DoD: each residual wave has an exact owner, real source lead, executable discriminator and recorded missing evidence; unrelated externally supplied implementation briefs remain data. Any timing observation records environment, cache, runtime/worker settings and sample size; five samples support median/range, not a tail-latency claim.

Success: no duplicated baseline or ambiguous metric, and every proposed implementation closes an observed defect or measured delay. Unnecessary work can close as justified no-change before building machinery.

## W1 — Consume current orientation and record only residual gaps

Owner: our supervisor for observation; Claude owns the authored routes; reuse-only. Depends on actual relevant PR1/PR2/PR7 guidance. Estimate: 0.25–0.5 day.

Tasks: inspect the final pure lifecycle, injected-port worker and provider-adapter routes using existing owners and real public entries/refusal tests. Count already adequate recipes as delivered externally. Package/source availability is version-specific; newer source prose does not retroactively ship in an old npm guide.

DoD: each pattern has a cited current owner, legal source/export and meaningful test. Any missing route is a precise finding in existing evidence with one documentation owner, not a second guide/ADR/golden module.

Success: correct layer and refusal witness are reachable without inventing a seam. No overlap in authored guide/README/history work or new full-store implementation.

## W2 — Couple necessary context regressions to lookup changes

Owner: lookup lane; merge evidence carried with W3/W4; depends on W0. Estimate: 0.5–1 day incremental, not a standalone evaluator project.

Tasks: reuse DevEx installed search/compiled-example proof. Add only fixture cases necessary for W3/W4 in the existing CLI/MCP tests: wrong version, private/ambiguous symbol, bounded scans and application selection. Keep `scripts/agent-context/evaluate.mjs` frozen; no new query service or score gate. Test against actual landed contracts, never the superseded PR4 or example PR4b shapes as if released.

DoD: installed-artifact fixtures distinguish useful evidence from distractors; CLI/MCP compatibility, scan limits and no-match honesty hold. The documented top-three queries owned by DevEx are reused, not recreated as ten arbitrary new queries.

Success: relevant adversarial cases give no false public-import/seam/completeness claims. An extra retrieval feature requires a demonstrated failure; more indexed files alone is not success.

## W3 — Make declaration evidence honest about public imports

Owner: lookup lane; merge; depends on W0/W2. Estimate: 1–3 days.

Tasks: correct the misleading certainty of `exact declaration symbol`: a textual occurrence may be internal, type-only, aliased or ambiguous. Point to installed exports/current example evidence. Show an import recipe only when actual artifact evidence proves its public specifier and type/value usage; otherwise return an explicitly unverified source lead. Start with wording/help and existing evidence, not a general export-graph/index service or runtime compiler.

DoD: internal occurrence, public re-export, alias, type-only and duplicate-name fixtures discriminate the boundary. Any displayed recipe compiles in applicable NodeNext/Bundler packed consumers; runtime import checks apply only to values. No new runtime dependency, widened default scan, result-shape break or unsupported source qualification.

Success: zero private/nonexistent import recipes in these fixtures; the legal public example is discoverable without guessed deep dist imports. Emit evidence of what is known, not a model-generated guarantee.

## W4 — Resolve the selected npm workspace application correctly

Owner: same lookup lane; merge; integrates after W3; depends on W0/W2. Estimate: 2–4 days.

Tasks: resolve the selected application's declared/reachable OpenLup set and required Core using Node-compatible resolution and its owning npm lockfile, including normal hoisting. Keep cwd as the application source-scan root. Do not assume package.json is publicly exported or search every ancestor's source/sibling package. Preserve standalone/linked installs and version/lock refusals. Unsupported package-manager layouts receive an actionable limitation.

DoD: standalone, hoisted, linked, missing Core, mixed reachable versions, owning-lock mismatch and unrelated-sibling fixtures have explicit outcomes. A real public import and CLI/MCP select the same installed contract/version; sources remain within the documented bounded scope. No install, arbitrary app execution, recursive filesystem search or new resolver dependency.

Success: all supported fixtures start lookup without a maintainer workaround, with zero sibling-package/source leakage and no false success for an unsupported layout.

## W5 — Provide evidence to the existing PR8 protocol

Owner: our supervisor for the handoff; Claude PR8 owns model regression; experimental/reuse. Depends on W0. Estimate: 0.25–0.5 day of residual preparation.

Tasks: retain the existing harness, frozen baseline and per-candidate history. Supply only our added cases/results absent from t1–t4. Explain candidate preparation, model/unit limits and the independent oracle. Extra model trials are considered only for a concrete unanswered question; no second eight-task/48-trial plan is created.

DoD: one handoff states exact identities, units, actual preparation, outcomes and failures. Fresh contexts/no solution leakage and independent proof remain requirements for any admitted model trial. A5/released evidence remains distinct from local rehearsal.

Success: a shared result is counted once; another supervisor can understand and reproduce our residual claim without author narration. No mandatory CI, benchmark backend or paid model API is added.

## W6 — Give contributors earlier actionable feedback

Owner: contributor-tooling lane; merge; depends on W0 profiles. Estimate: 3–6 days. Split independent outcomes into small changes where appropriate.

Tasks: leave Claude PR3 application messages alone. Through existing dependency-free explanation/preflight surfaces, report selected toolchain/compiler/history prerequisites read-only before heavy work. Keep optional tools optional and native admission intact. Run applicable cheap checks before builds/inventory/tests; make an unowned changed test outside discovery actionable while preserving separate package/browser runners. Measure repeated prelint/pretest builds, and reuse only within one controlled invocation if inputs remain unchanged; no persistent cache, caller-controlled skip or new obligation registry.

DoD: missing/wrong prerequisite, broken build, mutation, process failure/interruption, uncollected test, known separate suite and real executed test have discriminating fixtures. Direct commands still prepare required outputs; stale dist cannot pass via an environment flag. Shared outputs stay serial. No gate, retry, exclusion or hosted-parity weakening.

Success: a prerequisite blocker and safe next command appear in one read-only invocation with zero heavy phases. Cheap planted faults precede expensive phases. For the frozen profile, target at least 50% lower time to the simple fault; retain build-reuse machinery only for at least 15% median preflight gain beyond observed spread. Failure to justify reuse closes that route as no-change, not a hidden pass. All missing proof remains explicit.

## W7 — Enable effective strictness in root source projects

Owner: source-platform typing lane; read-only inventory first, then disjoint merge batches. Depends on W0; no global wait for Claude or P1-SF. Estimate: 1–2 days inventory/pilot plus provisional 5–15 days completion, subject to actual diagnostics.

Tasks: inventory app/tooling and their imported/test surfaces on the selected integration base; retain existing strict API/MCP/packages. Name disjoint type-only repair paths before writing. Use actual landed PR4a/PR4b/PR5/PR6 contracts where reached, without changing their business rules. Remove contradictory strict-family overrides, including noImplicitAny:false and tooling strictNullChecks:false, and ultimately enable strict in both actual projects. The already-strict independent starter is not our migration target.

DoD per batch: required compiler/lint/behaviour evidence passes with no new any/double-cast/ignore/exclusion/debt shortcut or changed runtime semantics. Final DoD requires effective tsc --showConfig options, planted implicit-any and unsafe-null failures in each project, and the existing required multi-project compiler path green. A pilot is not global completion. Global flags are applied only after integrated diagnostics permit them.

Success: the actual required compiler detects those credible mistakes; no new escape or source omission hides them. If another lane's reserved source, excluded money/catalogue/unbound seam, API break or behaviour change is needed, hold only that dependent batch for an owner decision and report W7 incomplete; continue independent work. Do not claim whole-stack end-to-end typing from these flags.

## W8 — Optimize measured relevant PostgreSQL setup

Owner: database-test lane; profiling can start after W0; mutations only on selected unreserved stable boundaries. Estimate: 3–7 days for two qualifying suites; no guaranteed gain.

Tasks: measure actual costly suites in our development loop, including the new replay/admission tests only after their behaviour is stable. Select two exact suite/helper scopes; do not modify Claude/master witnesses concurrently. Reuse setup through existing helpers only where isolation remains valid. Keep pinned real PostgreSQL, restricted roles, independent sessions for concurrency and owned cleanup; no emulator, shared mutable daemon or migration change.

DoD: the same meaningful success/refusal/no-write/frozen-price/replay/drift/concurrency cases remain discriminating. Demonstrate the changed setup does not mask its protected failure, run affected suites together and prove interruption/cleanup if changed. No relaxed timeout, SQL identity, grant, case selection or required gate. A reserved helper cannot be taken over to hit a timing goal.

Success: target at least 25% lower median warm wall time per qualifying suite beyond baseline spread, same meaningful cases and no leaked resources; also report the effect on the affected agent loop and cold image time. If setup is not material, safe disjoint candidates do not exist or isolation prevents a useful gain, close the optimization as measured no-change/held as appropriate; do not build machinery for an empty slot.

## W9 — Close our residual programme without duplicating PR8

Owner: our supervisor. Depends on our actual wave outcomes; external observations keep their own status. Estimate: 1–2 days of residual assessment, excluding Claude's model matrix.

Tasks: bind deterministic lookup, workspace, contributor-feedback, effective-typing and setup claims to actual candidates and evidence. Read PR8/A5 results when available; add no independent full rerun, fixed 48-trial gate, global 20% score or new model benchmark service. Keep matched preparation and version boundaries. Record every wave as completed, delivered externally, justified no-change, held or missing proof with its concrete reason; only the first three settle an acceptance obligation.

DoD: one implementation/evidence owner per outcome, closed material findings, exact source/artifact proof and required local/native/hosted checks on delivered changes. Canonical docs are updated by their actual owner. Our source delivery can finish before external PR8 publication/A5, but joint agent-regression acceptance stays pending external evidence rather than becoming a false PASS.

Success: our admitted correctness/benefit claims are individually demonstrated, with zero invented API/readiness, invariant regression, source-ejection substitution or lost mandatory proof. Unmet/noisy measurements remain unmet/inconclusive. No automatic successor, cosmetic loop, score inflation or declaration of overall programme success while our own required evidence is missing.

## Verification, recovery and single-source handoff

Use focused meaningful affected tests, the existing ast-grep scan, lint, published-tree typecheck, package/API/packed-consumer and applicable local/hosted obligations under current contribution rules. Preserve required review floors and actual native evidence history. Root tests use their existing hosted-parity runner; package/starter tests use their owning runner. Preflight is advisory and may refresh SQL inventory; it is not a read-only observation command or a substitute for required proof. Run no implementation tests merely to consolidate this plan.

Rollback is an ordinary reviewed revert of our change, preserving explanatory evidence. A new dependency/service/API, changed mandatory proof, excluded data/business semantics, overlapping ownership, additional spend or external delivery boundary needs a bounded owner decision. Estimates are not repository hard caps. Do not repurpose P1-SF's machinery budget or reset another programme's review/retry history.

This programme plan is registered through the existing publication catalogue. Its wave criteria and canonical rule links remain the scope baseline; the pull request owns actual delivery authority and candidate-bound checks. Local raw observations and historical snapshots remain implementation evidence, not alternative plans or installed-package contracts.

Validation: local links/anchors and all ten DoD/success definitions were checked. One clean-context, read-only parallel-scope challenge compared this version with the supplied Claude/master scope and found no material overlap or hidden global wait. This is session-local plan review, not native implementation coverage or a claim that implementation checks ran.

Self-retro: repeated additive drafts obscured who actually writes shared surfaces and owns measurement. This consolidation replaces them with bounded lookup/tooling lanes, read-only discovery before broader repairs, explicit external dependencies and one empirical regression owner. No code, tests, benchmarks, external messages or delivery actions were performed by this consolidation.

## Implementation and remaining dependencies — 2026-11-17

The human authorized the bounded batch through commit, PR, required review/checks
and merge. This does not authorize releases, deployments, settings changes or
another programme's work. The pull request retains exact committed identities,
review reports, actual checks and remaining gates; this plan grants no authority.

| Wave | Current result |
| --- | --- |
| W0 | Complete: private declaration and hoisted-install failures reproduced; command profiles frozen. Existing t1–t4 observations retained, with no model rerun. |
| W1 | The existing subscription-engine, outbox-worker and provider-adapter guide routes point to public entries and meaningful refusal tests. No second guide is needed; final PR7 consumption remains external. |
| W2–W4 | Implemented: honest declaration leads, app-selected Node/npm resolution, owning-lock checks and confined MCP paths. Installed packed consumer and offline executable recipe are exercised; Core agent startup points hoisted users to that same recipe. |
| W5 | Residual source/artifact preparation, commands, failures and distinct timing units are in the delivery evidence for PR8. No external transmission or duplicate benchmark is implied. |
| W6 | Implemented: read-only prerequisite observations, cheap-first checks and real runner discovery with actionable unconfirmed-test warnings. No build cache or skip mechanism. Contributor observations are documented outside PR7's reserved test-guide section; its preflight-list handoff stays with PR7. |
| W7 | Existing test fixtures and unreserved app/tooling types repaired without changing commerce rules or amounts. Effective strict inventories remain explicit; global flags await the reserved declaration/fixture seams below. |
| W8 | Measured no-change on nodeHostRuntimeDrain and disposableDockerReap: their shared setup and distinct resource ownership already protect the relevant failure classes. No pooling or helper rewrite. |
| W9 | Local evidence is bound to the delivered source; global strictness and joint PR8/A5 acceptance remain open. No overall 10x or stable-framework claim. |

W6's five-sample planted-fault profile measured median time to first failure
37.068 s → 0.690 s (98.14% lower), with fault children deliberately cancelled at
first FAIL. These are timing observations, never passing verification or overall
agent-speed measurements. Repeated pretest builds measured 5.386 s median; even
an optimistic saved-build bound was below the retained 15% target, so reuse was
rejected. Invalid shared-dependency fixture attempts remain excluded.

W8's five serial hosted-parity observations per suite, including normal package
preparation, measured drain median 7.852 s (7.699–8.351) and reclaim 14.737 s
(14.627–15.822). The former passed both cases each time; the latter passed all
eight ordinary cases, with two conditional nested fixtures intentionally pending
in the parent run. Real PostgreSQL was used and post-run resource checks found
no matching containers. The image was cached; cold-pull time is unmeasured.
No 25% improvement is claimed.

Remaining W7 boundaries are the original money/catalogue fixture and
qualification/admission owners: bundleAdminFixtures, checkout-refusal-recovery
evidence, installation inventory, order-money AST, distribution CLI proof,
release BOM, platform cold consumer and SQL admission. Missing declarations at
the shared disposable-Docker and review-derived module edges are held with those
owners. Explicit strict inventories decreased from 40 to 4 app diagnostics and
31 to 29 tooling diagnostics against the initial source base. Both still exit 2;
all remaining diagnostics are at the named reserved fixtures or shared control
declaration edges. Do not add ambient any, exclusions or weakened flags to hide
them. Exact residual diagnostics and actual compiler exits travel in the PR evidence.
A passing ordinary typecheck is not a passing strict inventory.

At the 2026-11-17 inspection of main `f37e977f36b7aba44ca3a18f41fd35f2a5b5cb2a`,
PR6 #751 was merged and PR7 was in progress in its own worktree, without a
submitted pull request. PR8 remained pending after PR7. The latest listed package
set was 0.43.0, published before PR1–6. Source-candidate hooks and local tarballs do not close
the separate blind adopter A5 journey, PR8 regression or P1-SF/DEMO acceptance.
A5 identifiers in other programmes refer to their own outcomes.

Self-retro: real CLI and packed-artifact checks exposed path assumptions that
mocks missed. Shared compiler/build outputs must be serialized. Measurements
rejected speculative cache and container-pooling machinery; honest narrow types
and assertion narrowing preserved negative tests without widening product scope.
