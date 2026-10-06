# Earlier package gates with bounded verification cost

Status: LOCAL_IMPLEMENTATION — approved local work; no publication or installed-tool authority.
Audience: development-preview contributors and the maintainer.
Outcome: apply reusable premerge gates to every publishable package, rejecting
unvalidated APIs, broken cold artifact/reference bindings and applicable schema
observation regressions through the existing required checks. Stable support and adopter readiness are outside this proposal.

## Boundary and current evidence

Inspected on 6 October 2026 at main
`dd149c6d5f750f17e2430c4f0a74de1b9d7b96df`, freshly fetched through the configured
task-worktree helper. This record follows the public plan convention in
`docs/platform/plans/`. `.agent-protocol.yml` still points to an absent
the missing docs/templates/wave-plan.md template; no generator or validator exists in this tree.
No native Plan Protocol pass is claimed. Planning acceptance is review of this
bounded proposal, not an exception to an implementation gate.

Configured protocol values are 300 source LOC, 1500 default churn, a 750 soft
warning and a 6000 insertion ceiling with an owner-authorized exception route.
Their validator is absent, so configuration is not demonstrated enforcement.
Current likely surfaces are 294 lines for the core consumer, 35 for the Outbox
runner, 274 for packing, 104 for readiness smoke and 133 for DB wiring; the
existing command-contract test is 889 lines. Prefer a cohesive shared manifest
reader over duplicating validation. Do not compress code, split solely for
arithmetic, or reinterpret a soft warning as an owner decision. Forecast roughly
400–900 added/changed lines across tests, consumers and CI/docs (estimate);
retain any genuinely enforced budget and its exception path at implementation.

The live main rules require `dco`, `typecheck`, `install-proof`, `test`,
`self-check`, `gitleaks` and `native-review`. At this SHA, merge-group
[37427873674/1](https://github.com/openlup/openlup/actions/runs/37427873674)
completed all seven successfully. Main-push
[37428448424/1](https://github.com/openlup/openlup/actions/runs/37428448424)
completed the six mechanical checks and both raw diagnostics successfully;
`native-review` was correctly skipped on the push event. These observations
prove execution of the current configured steps, not the proposed gates.

The `merge` cut-line is G1–G3 and one existing-proof extension for the uncovered
G5 replay boundary. G6 is positive/falsifier evidence inside those checks.
G4 adds no selection framework: the current reference accepts supplied handlers,
not an executable application-selection manifest. Its existing admission tests
remain required. No `activation` or `experimental` lane is needed.

Out: public runtime/API/schema changes, new package/version, public timeout
increase, provider effects, managed databases, application configuration or
deployment machinery, new required contexts/rulesets, caches, scanners, general-purpose shell/capability
frameworks, release workflows and installed maintainer-tool edits.
Local implementation was approved on 6 October 2026. The subsequent owner
clarification makes these gates reusable for future modules; Outbox is the first
module-specific example. This covers the stabilized patch, mechanical evidence
and signed task commits only after any applicable maintainer read;
publication, PR, merge and release require their applicable authority.

## Existing controls and remaining failure signals

Paths below are repository-relative at the inspected SHA. “Required” includes
transitive commands; merely residing under a selected CLI path is insufficient.

| Failure class | Existing test/command and actual placement | Remaining gap and smallest change |
| --- | --- | --- |
| Core declarations, exports, docs, coverage and consumer portability | `packages/core/package.json` `ci`; explicitly invoked by required `test` and local verify. It runs coverage/runtime imports, smoke typecheck, `api:check`, `docs:check`, release checks and packed consumer. Root Vitest does not discover core standalone suites; core CI does. | Preserve complete core CI; add no duplicate invocation. Give its existing consumer a supplied-artifact mode for G2. |
| Outbox declaration/snapshot mismatch | `pretest:required` builds both packages; root Vitest discovers `packages/outbox/test`. `packageContract.test.ts` checks files, budgets, SQL hash and guide compilation. Package `ci` contains `api:check`, but neither required workflow nor local verify invokes it. `preparePackage` only runs prepack/build. | G1: run existing Outbox `api:check` against its built declarations in required `test`; do not repeat Outbox's full test suite. |
| Lost package/test selection | `scripts/oss-published-tree-check.test.ts` preserves exact required argv, existing steps and nonempty tracked test selectors. `scripts/packages/packages-check.test.ts` validates the current package inventory/manifests; `package-manifest-policy.ts` refuses unclassified directories. | Use the existing package inventory and actual workspace manifests, with a shared serial runner. Every publishable package needs api:check, ci:required and test:consumer; a fully wired third package passes without central name edits. Missing routes fail before packing. No second registry. |
| Broken current cold package bytes | Existing cold-pack/workflow tests use synthetic repositories. Actual set packing is `packages:check -- --cold --out <empty-output>` in release paths. Core required consumer packs its own artifact; Outbox's root contract packs warm output. | G2: one actual current-set cold manifest in required `test`, then consumers of exactly those files; retain release revalidation. |
| Workspace masks installed-artifact failure | Core required consumer already executes exports, NodeNext/Bundler typechecks and Vite. `outbox-consumer-proof.ts` installs local packs and runs real PostgreSQL `smoke/wiring.ts`, but is manual and repacks. | Extend both existing consumers to accept the same verified manifest; no OpenLup directory/symlink fallback or repack. Make the existing real-DB proof mandatory in `test`. |
| Schema latency/completeness | Core `smoke/readinessStandalone.test.ts` covers unknown/timeout/incomplete observations and binding errors; its real-probe positive is instantaneous and has three objects. Included in required core CI and local verify. | G3: real installed `createSchemaProbe` plus `checkReadiness`, actual installed Outbox schema and deterministic serial executor; distinguish waiting deadline from cancellation. |
| Disconnected bindings/start before admission | Required `candidateAdmission.test.ts`, `factory.test.ts` and core readiness tests cover missing ports/triggers, wrong versions, stale identities, actual listener order and held/disabled leases. | G4 out: no extra scanner or selector system. Do not claim these prevent application-handler construction: handlers exist before reference admission. |
| Effect accepted, acknowledgement lost, reclaimed event | Required `protocol.test.ts` covers ack failure and manual handler replay. Manual PostgreSQL wiring covers concurrent claims, invented stale tokens, retries/snooze, crash before success and retained identities. | One G5 addition in the G2 DB proof: actual same-row reclaim after accepted synthetic effect; once-valid old-token fencing and application-owned dedupe across immediate/scheduled paths. |
| Harness falsely passes damaged input | Existing release/manifest/neutrality and admission falsifiers already run in required CI. | G6 is mandatory evidence for each new obligation below, not a new recurring mechanism. |

## Ordered implementation checkpoints

One integrator owns shared workflow, policy/generated files and final evidence.
Package owners retain their existing consumers and tests. No concurrent command
may read package dist while cold preparation removes/rebuilds it.

### 0. Establish the delivery prerequisite before promising completion

Owner: integrator, with the maintainer owning installed-tool authorization.
Confirm the local owned-DB route and exact verifier-parity dependency before
implementation scheduling. No Docker installation, daemon settings, shared
service adoption or helper mutation is implicit. Plan the changed workflow and
matching mirror together; include proposed DB/process bounds in the single
stabilized packet for applicable maintainer reading. After that packet is ready,
the separately authorized parity amendment is reviewed/installed and its actual
refusals demonstrated before final native review and full verify.
If parity is deferred, the local checkpoint is explicitly **stabilized local
patch awaiting parity**, not completed implementation acceptance. This known
dependency must not first appear as a workflow-drift failure after final review.

### 1. Close cheap API and discovery omissions (G1)

Owner: contribution/CI integrator. Surfaces:
`.github/workflows/published-tree-ci.yml`, `scripts/oss-published-tree-check.test.ts`,
`scripts/oss-publication-policy.ts` only if command inventory changes, and existing
package-policy tests. Preserve every previous selector and standalone step.
Run every publishable workspace's `api:check` after the existing build
and before expensive new proof work. Use each module's current API checker, not a new
declaration comparison. Required coverage must bind actual Vitest project
discovery, not only the presence of a tracked test path.
The common runner reads publishable entries from `config/openlup-packages.json`
and actual workspace manifests. Each package declares `api:check`, `ci:required`
and `test:consumer`. It validates every route before the existing cold producer,
then invokes every API check before any expensive package proof. It passes the
same verified manifest and independent checkout SHA to each `ci:required`, with
no missing-script skip. The package owns that batch's unit/contract and installed
consumer semantics. Do not parse arbitrary shell call graphs, infer capabilities,
keep another package-name map or impose a database on packages that need none.
Core's batch preserves all existing complete-CI obligations except API, already
executed once by the common phase. Outbox's batch runs its installed proof;
its existing root-discovered tests remain once in the unchanged root floor.

Positive: current set has actual routes, and a synthetic third publishable
workspace cold-builds, passes its API and imports its installed tarball through
the actual common runner, without changing central package-name code.
Falsifiers: missing/failing route, absent actual workspace, declaration drift,
incomplete manifest or damaged export fail the actual route. A legitimate
matching declaration snapshot passes. Script existence proves routing, not the
truth of its semantic assertions; module review and positive/falsifier evidence
remain necessary. Do not weaken compatibility/migration checks for a positive.

### 2. Bind cold artifacts to existing consumers (G2 and bounded G5)

Owners: core/outbox package-test authors; integrator owns required wiring.
Surfaces: `scripts/packages/packages-check.ts` producer remains authoritative;
`packages/core/scripts/core-package-consumer-smoke.ts` and its existing tests;
`scripts/packages/outbox-consumer-proof.ts`,
`packages/outbox/smoke/wiring.ts`, and a companion test under `scripts/packages/`.
At most one small manifest-input utility there is justified if both consumers
otherwise duplicate validation. No release-script coupling or second packer.

Supplied-artifact mode checks schema version 2, expected full candidate SHA,
the required exact package set/versions, unique entries, safe basenames, ordinary
files, listed directory contents and both SHA-256 and SHA-512 integrity before
installation. Consumers record which bytes they actually used. Default manual
modes may remain, but required CI never falls back to them on missing evidence.
Missing/unknown input refuses before install or SQL. No author-produced manifest
alone proves packing: the required producer must have exited zero first.

Install in a fresh isolated consumer outside ancestor workspace resolution,
clear ambient module-resolution overrides, use offline installs with scripts
disabled and assert installed OpenLup paths are regular directories confined to
that consumer. Pack locked installed Zod as an explicitly named third-party
runtime input, as the existing Outbox proof does; do not let a directory link
mask a missing runtime dependency. Host tsc/Vite and injected pg driver are
explicit test tooling. The OpenLup package code/types/SQL come only from the
verified tarballs. Retain core runtime/typecheck/Vite and actual reference
composition/admission assertions.

Use one owned disposable PostgreSQL 17 instance/database on loopback, matching
the SQL baseline's required functions. The runner owns readiness, deadline,
database creation and teardown in success and failure. Missing DB/runtime is a
mandatory gate failure, never a self-skip. Keep substituted-IO protocol/admission
tests for cheap diagnostics; they cannot replace real SQL/transaction/fencing
proof. No adopter database or credential value is needed.
Use a job-owned PostgreSQL service in required CI; the local parity route owns
an equivalent ephemeral instance and must prove ownership before cleanup. Pin
the container image digest in the patch. Do not reuse the raw diagnostic
Supabase stack or an ambient local PostgreSQL service as this proof's database.

Positive: complete cold core/outbox artifacts install, execute their public
exports and real reference, run immediate/scheduled work, and preserve current
binding/schema/transaction/compaction refusals.
Falsifiers: remove/change a named tarball after manifest creation (identity
refusal), and create a digest-consistent damaged test artifact with a missing
runtime export or disconnected binding (real consumer failure). The latter
proves behavior beyond hashing. Invoke the actual runner and observe nonzero,
not just a mock classifier or an assertion that no step ran.

Add exactly one replay scenario to the existing DB wiring: a synthetic durable
effect keyed by event identity is accepted; the first ack fails; deterministically
expire that owned fixture's claim; reclaim the same row through the other actual
entrypoint with a new token and increased attempt count. Old token process/fail/
release operations cannot change the new processing claim; new-token ack succeeds.
Assert multiple attempts separately from one synthetic accepted effect. Removing
the synthetic dedupe, or accepting the old token, must fail the actual proof.
This demonstrates at-least-once plus application idempotency, not exactly-once
delivery through an arbitrary provider. No production fence/SQL change is planned.
The synthetic dedupe-removal case checks the example/harness; it does not install
a mutation-testing mechanism or make application dedupe a package guarantee.

Optimize the existing 20 missing-object variants: one complete real observation
plus immutable keyed copies for checker refusals, using `schemaObjectKey` including
overloads. This removes 400 repeated presence reads without dropping a real SQL
positive. G3 separately exercises actual absent table/column/overload answers.
Do not reduce independent transactional/claim observers or cold prerequisite builds.

### 3. Make schema budget regression falsifiable (G3)

Owner: Outbox consumer-proof author with core readiness owner reviewing the
checker contract. Use a reusable repository-only schema budget proof, parameterized with each
module's actual installed schema, installed probe/checker/key functions and its
owned readiness input. Outbox supplies a thin binding in its packed proof before
SQL. No Outbox schema, port inventory or reference constructor lives in the
common harness. It must import `POSTGRES_OUTBOX_SCHEMA`, `createSchemaProbe`
and `checkReadiness` from the actual installed cold artifacts. A neutral copy of
20 objects is insufficient: a future schema addition must participate without
manually keeping two schema inventories synchronized. Existing core-only tests
remain neutral and need no new Outbox dependency. Runtime, API snapshots and
timeouts stay unchanged.

Use fake time and a serial queue that actually resolves one operation at a time;
count identity and presence operations independently. Current probe waits for
identity, then enqueues one presence query per object. Its 3000 ms default bounds
waiting **per contribution**, not total readiness or ongoing driver work.
No API currently cancels the losing observation. The isolated Node proof can use
the built-in [Node 24 mock timers](https://nodejs.org/docs/latest-v24.x/api/test.html#class-mocktimers)
instead of introducing a clock abstraction/dependency into production. Restore
real timers in `finally` and settle owned fake queued work before real SQL starts.
The installed Node 24.20.0 timer smoke passed during plan review; the actual new
timing scenarios remain implementation work.

Positive regression model: identity/setup 250 ms plus 20 reads at 100 ms gives
2250 ms, therefore READY under the unchanged 3000 ms default. This is a test
estimate, not measured network latency or a supported remote-host guarantee.
Require complete observations of the actual requested identities and verify
exact overload query values. Report presence/identity query counts diagnostically;
do not require one query per object as a public algorithm contract. A later
correct grouped-read implementation may use fewer calls. At today's 20 objects,
the positive is 2250 ms; schema growth automatically changes the model and a
failure requires review of the real schema/budget, not shrinking the fixture.
Falsifiers: an individual observation operation exceeding the 3000 ms waiting
budget returns UNKNOWN by the deadline even if a later adapter groups reads;
a stalled identity also refuses. Query counts remain diagnostic. Actual absent table, column
and overload results flow through the real probe to UNSATISFIED; malformed
results become UNKNOWN, retaining independent binding errors and zero effects.
For actual catalog negative answers, probe three explicitly nonexistent neutral
identities (table, column on an existing table, exact function overload) against
the same owned PostgreSQL instance. No Outbox object needs deletion or a second
database. Distinguish this real catalog proof from simulated latency/malformed IO.

Assert readiness timer cleanup and runner-owned eventual driver/fixture cleanup
on all paths. Do not assert that Promise.race aborts pending queries. A parent
process/service bound prevents a hanging driver from holding CI indefinitely.
Public batching, a new cancellation API, wider timeout or a universal schema-size
promise needs a separate evidence-based decision. This plan introduces the missing
regression signal; it does not assume the current public 20-object probe cannot
meet its budget or import a larger application's fingerprint query costs.

## Required/local/release placement and parity

Keep existing owning `test` context, no new status. Preserve the required root
suite, subscription step, complete core CI and both standalone falsifier suites.
The required workflow invokes one inventory-driven `required-package-gates.ts`
route: validate all package/workspace entries → existing cold producer → API
for every publishable package → each package's `ci:required` with the supplied
manifest. Then run the retained root suite, subscription step and standalone
falsifier suites. At today's inventory, this includes the complete core
obligations once and Outbox's installed schema/SQL/replay once. New modules use
the same conventional entry; the runner has no core/Outbox package-name branch.

The producer remains `npm run packages:check -- --cold --out <empty-output>`;
it already builds prerequisites. No extra preceding build or second packer.
Cold preparation precedes all dist readers, and module proof runs serially.
It clears all workspace outputs per target, so unrelated earlier packages may
have no declarations left. Before each API check, the existing prerequisite
build helper restores that package's declarations without another cold cleanup
or repack. The three-independent-package fixture protects this lifecycle; API
timings include these necessary builds. Cold pack guards remain unchanged.
Core/root lifecycle rebuilds do not alter retained tarballs. The root pretest
stays; removing it needs separate measurement. Revised workflow assertions retain
every previous obligation. One small common runner is justified by the owner's
future-module requirement; it is not a general gate/capability framework.

Run the current existing package/input checks before full verification in local
iteration. New companion falsifiers belong in `scripts/packages` and run early
when their runner changes; do not repeat the entire materialized-command or
neutrality CLI suite as a new preflight. Their existing policy/inventory and
tree-neutrality owners already provide early structural refusal.

Every package proof receives the same manifest and expected checkout identity.
The current consumers implement these inputs; test missing-input refusal. Interface: core CI's
existing consumer reads `OPENLUP_PACK_MANIFEST` and `OPENLUP_PACK_COMMIT`; Outbox's
existing positional URL/scratch command gains `--manifest <path>` and
`--expected-commit <full-sha>`. Required-mode wiring supplies both identities
explicitly from the checked-out `git rev-parse HEAD`; one input without the other
refuses. The runner uses an owned temporary consumer outside checkout ancestors,
while task scratch contains reports. These are plain install/test outputs, not
another development clone. Core coverage/API/docs/release checks remain intact;
its supplied consumer skips only its own redundant build/repack, not its assertions.

Focused local iteration: existing Outbox build plus `api:check`; core readiness
smoke with its package Vitest config; package runner falsifiers under root Vitest;
and the existing working-tree pack-budget/API/neutrality checks. Before DCO,
run applicable tests and pack budgets using the existing warm pack-contract/core
release checks, plus new supplied-input tests on owned synthetic fixtures. These
are mechanical checks of the stabilized patch, not exact cold-candidate evidence.
Present any npm/security/release/API control delta and proposed gate budgets for
the applicable maintainer read, then create authorized signed task commits.
Only on that clean committed candidate run the actual `--cold --out` producer
and exact consumers: cold preparation refuses all dirty package/prerequisite
paths, including test-only edits, and its manifest binds HEAD. Do not use a
temporary clone, invented identity, altered dirty guard or pre-signoff DCO to
make the packet appear complete. A changed package path needs another clean
signed candidate and freshly packed evidence. Run structural scan after changes, full lint and
`oss:published-tree -- --policy --docs-update` before stabilization. Regenerate
publication catalogue/execution digests/source contract for changed/new paths.
Update owning core/Outbox README and CONTRIBUTING/development execution sections.
Immediately after signing, run the existing exact-history/range secret/leak
checks before expensive reviews/verify; retain their final gate execution.
Do not discover a synthetic fixture secret in earlier commit history only after
a successful full verify, or rewrite history without its own authorization.

Known focused commands (before the proposed manifest inputs exist):

```sh
npm --workspace ./packages/core run build
npm --workspace ./packages/outbox run build
npm --workspace ./packages/outbox run api:check
(cd packages/core && npx --no -- vitest run --config vitest.config.ts smoke/readinessStandalone.test.ts)
npx --no -- vitest run packages/outbox/test server/runtime/outbox
```

Run the new manifest/runner companion test explicitly during iteration and
through the retained `scripts/packages` selector at the final boundary. The
working-tree suite above is a focused check, not a substitute for core CI,
the real disposable SQL proof or the exact committed verifier.

The installed maintainer verifier pins exact workflow blobs and currently mirrors
the old commands. New workflow bytes must refuse before heavy verification.
An owner-authorized separately reviewed parity amendment must mirror the exact
new commands, manifest handoff, DB ownership/cleanup and failure propagation, and
demonstrate live refusal before the new workflow can receive a final stamp/push.
This proposal does not authorize editing that installed tool. Repository-local
focused proof can proceed; final verify/publication remains blocked until parity
is established. Do not edit the helper, bypass drift or use an alternate stamp.

Release preflight/publisher continue cold packing and validating their own exact
release candidate; premerge manifest identity is not npm registry provenance and
does not establish equality to a separately repacked registry archive.
Raw `test-full` and pgTAP remain diagnostics with their existing attribution.

## Local implementation checkpoint

The common runner has no package-name switch. A real cold-producer fixture with
three independent publishable workspaces executes every API before every owning
batch and imports each ordinary installed tarball. That fixture exposed the
producer's per-target cleanup of earlier independent declarations; the existing
build helper now restores them before API without altering retained artifacts.
Missing scripts/workspace, wrong commit, API failure and a digest-consistent
missing installed export refuse through the actual route. Current consumers use
the shared manifest reader; Outbox binds installed requirements to the reusable
schema utility and owns its real replay proof.

Working-tree mechanical proof uses explicitly labeled warm artifact fixtures;
it does not establish a clean committed cold candidate. Core's complete required
batch and both APIs pass. The actual Outbox workspace batch passes all schema
models and real SQL/replay: cached startup 2165 ms, child proof 2724 ms, cleanup
291 ms in one local sample. An interrupted owned-service test proves database
removal, preserved service ownership and termination of resistant child processes.
The existing synthetic source-release fixtures now declare the exact added
package scripts; their independent execution-surface equality assertion remains.
No release checker, scanner pin, neutrality allowance, API snapshot or public
runtime was changed. Final required root tests pass: 5397 tests in 590 files,
185.92 s with four workers in one local working-tree sample. Core's batch has
504 passing tests in 42 files; standalone workflow/neutrality/subscription proofs
have 280 passing tests in nine files. These are separate owners, not an aggregate
benchmark. Full lint and the project typecheck pass; focused failures and repairs
remain in the task's mechanical logs. Neutrality reports zero increases.

The installed verifier actually refuses this workflow as WORKFLOW DRIFT in zero
reported seconds, before its lock or heavy checks. A bounded mirror proposal is
prepared separately; it is not installed and cannot produce a verification
stamp. The next boundary is the stabilized control/bounds read and separately
authorized parity work. Signed candidate, cold-set evidence, two fresh native
reviews and final installed verification remain pending; no delivery receipt,
hosted gate pass or publication is claimed.

## Cost baseline and decision budgets

Measurements are one hosted main-push sample, not stable percentiles or savings.
API timestamps from run 37428448424/1 give:

| Component | Measured elapsed seconds |
| --- | ---: |
| Required test job | 303 |
| npm ci inside test | 20 |
| Required root coverage including pretest builds | 164 |
| Subscription standalone step | 5 |
| Complete core CI | 32 |
| Materialized command falsifier | 18 |
| Neutrality falsifiers | 58 |
| Install-proof job / its install / two builds | 36 / 19 / 4 + 5 |
| Typecheck job | 78 |
| Raw full-test execution / raw pgTAP execution | 326 / 122 |

Run creation to final required mechanical completion was 306 s; creation to
whole-run completion was 365 s because raw full tests ended later. Runner start
lag was 3–5 s; it is not test execution. Native admission on the merge-group
sample ran 18 s after mechanical completion, separately from product tests.
Bootstrap local verification evidence belongs to its task logs and is reported
separately; it is not a hosted timing comparison.

Measured clean-base local bootstrap: verifier 365 s, creation/install/verify
375 s; required root tests 166 s (587 files, 5370 tests), core CI 14 s, command
falsifier 42 s, neutrality falsifier 51 s. Required verify exited 0 before this
plan was authored. Full-root and pgTAP diagnostics were skipped by the default
local profile; DCO/leak range checks skipped the empty branch range. Advisory
release-check exited 2/CANNOT-DECIDE because the prior preview has no source
receipt asset. This baseline pass does not verify the plan or any new gate.
One additional existing Outbox `api:check` on its built outputs exited 0 in
0.27 s locally (`time -p`); installation/build excluded from that measurement.

Source-derived operation counts, not timings: five core builds on the existing
required test path, excluding fixture builds; one actual core consumer pack plus
separate dry-run checks. Supplied-artifact mode removes its two consumer builds
and repack, while cold set packing deliberately rebuilds prerequisites per target.
Net time cannot be inferred from fewer packs/builds. No percentage saving claimed.

Planning estimates for incremental proof: new selection falsifiers 1–5 s (the
API invocation alone has the local measurement above); deterministic
schema tests under 2 s wall time; cold current-set pack 5–20 s; isolated consumers
5–20 s; owned DB startup/readiness 3–15 s, SQL/replay 1–10 s, cleanup 1–5 s.
Target incremental required critical path for the current two-package set is
15–60 s with reused core consumer work. Future packages add their measured
owning proof cost; this is not a constant-time promise for an expanding set.
This target assumes the PostgreSQL image is already available; first/cold image
pull and container setup are unmeasured additional costs, not included in 3–15 s.
The job-owned service may start before install, so its pull/wait can also delay
cheap checks. Measure cold and cached starts explicitly before claiming a recurring
budget or net improvement; a material regression warrants the simpler route
comparison, without dropping real-DB proof. Container/network infrastructure
failure must be classified separately from a package assertion failure.
These are estimates for investigation, not hard runtime caps. Preserve the existing
20-minute test-job timeout and package pack/API/coverage budgets. Exceeding an
estimate requires attribution and a simpler-route comparison; real scope, resource,
safety or acceptance changes require replanning. Never widen a control to fit it.

Implementation measures before/after on the same runner class and candidate/base:
install, builds, packing, consumer, DB startup/query/teardown, test execution and
runner wait separately. Start with one paired focused baseline/candidate sample;
use two additional focused repetitions only if variance prevents attribution.
Use the first authorized complete local/hosted runs and reuse their logs rather
than repeating full verify for reassurance. Report sample count and raw elapsed
cost (median/range only when enough samples exist), no fabricated p95. Keep the 400-to-20
catalog-read reduction as an operation count until elapsed benefit is measured.
Also measure time to the first named API/artifact/schema refusal: the old proposed
order spent 164 + 5 s in root/subscription before new artifact checks. The revised
order spends the necessary cold preparation first (5–20 s estimate after install),
then the API and existing core contract/consumer, before broad root execution.
Existing root defects may be reported later by the early package phase; disclose
that bounded tradeoff rather than claiming every failure becomes earlier.

## Challenge, acceptance and stop

Simpler paths considered: invoking Outbox `ci` repeats already-required tests;
calling the existing manual consumer repeats warm packs and proves different
bytes; promoting raw pgTAP cannot prove the installed package/reference; a new
general gate/registry framework or required context adds maintenance without a new signal.
The clarified route adds one common inventory-driven runner and conventional
package entries. Existing consumers receive explicit artifact inputs; the shared
schema test helper takes installed module requirements. Outbox retains its owned
real-DB proof, without imposing SQL/replay semantics on other modules.

Independent feasibility and risk audits challenged hidden API invocation,
workspace discovery, private/public query-count attribution, cancellation claims,
selection scope and replay ownership. Disposition: API omission confirmed; core
duplicate CI rejected; private query counts excluded; cancellation not claimed;
new selection machinery rejected because no current public selection contract
requires it; once-valid fence/replay witness retained as the unique G5 addition.
The independent integrated-plan challenge found that cold packing refuses the
planned dirty package paths: working-tree checks now precede applicable owner
read/DCO, while exact cold evidence explicitly follows authorized signed commits.
Planning review is session-local, not a committed native delivery receipt.

The critical-loop follow-up found and corrected four decision-relevant issues:
new checks after the 164 s root suite; an optional actual-schema binding that
could miss schema growth; known verifier parity arriving after final review;
and a runtime estimate omitting cold container-image cost. Two independent
perspectives covered execution/cost and simplicity/correctness. Query-count
equality and mandatory three-run benchmarking were removed as route-induced
requirements; G3 now uses actual installed exports and native test timers.
Real catalog absence and synthetic application dedupe are explicitly distinct
from the package's delivery guarantee. That loop reviewed the plan before implementation.

Accept implementation only when all new positive cases pass and each minimal
falsifier makes the actual applicable runner nonzero; required discovery includes
every affected obligation; exact manifest bytes reach both isolated consumers;
real SQL/replay and deterministic schema assertions run without skips; cleanup
and costs are observed. Preserve all previous required checks and independent
diagnostics. Final committed candidate still needs two fresh native reviewers
for this material CI/contract work, closed findings and passing installed verify,
within the existing two automatic repair-cycle budget.
Approval of a local patch awaiting parity is not acceptance of the final gates.
Before declaring final acceptance, record the actual required execution order,
time-to-failure for minimal bad inputs, cold/cached service costs and the parity
refusal proof. An unmeasured 15–60 s target is not a passing performance result.

Stop for changed public API/SQL/runtime semantics, credentials, an unowned DB,
weaker tests/checks, installed-helper work without its own authority, exhausted
review budget, or scope beyond these failure classes. A runtime defect discovered
by new tests is diagnosed and reported before expanding this tests/wiring plan.
Keep recoverable work; no force-push, control bypass or automatic successor.

Current authority: bounded local implementation, clarified to cover future
modules through the same package inventory and runner, including repository CI
wiring, neutral test/artifact work and signed task commits after any applicable
maintainer read. The stabilized control/bounds packet and exact parity
installation are the next owner boundary; publication/PR/merge remain separate. Hosted PASS, package
publication/provenance and actual adopter acceptance remain separate evidence.
