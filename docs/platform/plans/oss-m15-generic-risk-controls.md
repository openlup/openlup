# M15 generic risk controls

Status: development-preview contribution, R1 local candidate. No activation,
release, installed adopter acceptance or stable support is claimed.

## Approved R1 boundary

Contribute the existing risk runtime with unchanged logic through isolated
`@openlup/platform/risk`, type-only `risk/contracts` and Node-only `risk/server`
entries. Core retains its evaluator, rules and vocabulary. Native and managed
persistence remain distinct. The only SQL addition is a byte-identical package
asset of the existing native post-order control catalogue unit, never an
installation chain. No new package, mandatory pg dependency, SQL forward or
reviewed-forward class is introduced.

Authority: accountable author Bart Roszkowski; R1 author/integrator may implement,
run focused proofs and create local DCO commits in the assigned task worktree.
The direct task excludes pushing, PR creation and full verify-local; the
coordinator owns later full verification and delivery. R2 reference delegation,
admin handlers and composition, R3 privacy, M14 operations/portability, activation
and set-version preparation are excluded. The existing reference implementation
remains until R2. No merge or release-dispatch authority is granted.

Code/review base: `ef861a76dad97c0b744f6f25c04b04f4ac44c5fe`.
Instruction freshness pin: `ef861a76dad97c0b744f6f25c04b04f4ac44c5fe`
(fetched main at resume and handoff, 2026-10-27; relevant instructions unchanged).
The coordinator approved isolated placement, unchanged donor interactions and
measurement without reserving M14 headroom. O3 privacy approval applies to R3.

## Acceptance and proof

The smallest adequate solution packages the existing factories and Core engine,
uses the public commerce money projection and structural injected clients, and
projects the existing SQL unit. A new engine, registry, worker, package or
installation framework adds no required outcome. Type-only structural contracts
have a bidirectional compiler witness against the unchanged inferred schemas.

Fresh synthetic public cases discriminate schema strictness/coercion, money and
payment refusals, key/hash/evidence preservation, error mapping, browser isolation,
adapter translation and seven SQL scenarios on each rail. Runtime database calls
use separate non-superuser sessions; native fixture grants are test composition,
not a production permissions contract. The managed fixture grants only the
commerce reads needed by its injected evidence client; the baseline risk RPC
grants alone do not provide those reads. Managed SQL reuses the existing five
blocklist pgTAP assertions. Paid-order packed consumption must demonstrate a useful
assessment and a missing-payment refusal before subsequent refactoring.

Preserved differences include native shadow case creation versus managed no case;
managed timestamp/evidence fingerprinting versus native omission; managed
succeeded payment versus native settled evidence; managed decisions after closure
versus native refusal; and native active/reason semantics versus managed timed
blocklist matches and generic reason projection. Shadow review/block can still
acknowledge fulfillment without dispatch even with no SQL hold. Managed admin
readback deliberately projects `replayed: false`.

## Evidence and handoff

Focused execution results, pack measurements, commit identities and preliminary
review findings are recorded here before handoff. Full verify-local and counted
native admission remain with the coordinator. No hosted or adopter evidence is
inferred from local passes.

### Local authoring result — 2026-10-27

The interrupted staged/unstaged import was recovered in place. The resulting
runtime and schema statements match all eight existing public source donors
with imports excluded; hashing is byte-identical. The SQL asset matches the
canonical unit and SHA-256 above. No Core/Outbox source, installation-chain SQL,
M14 path, reference binding, activation or package version changed.

Implementation commits:

- `a4a90a5c` — `feat(platform): import unchanged risk runtime (M15 R1)`.
- `3915b5f51a98c76031a4e67e4b3d27b9c2201d8e` —
  `test(platform): preserve risk SQL rails and packed consumption (M15 R1)`.

Both commits carry Bart Roszkowski's instructed DCO sign-off. The authoring
endpoint is signed local commits and focused evidence only; pushing, opening a
PR, full verify-local, arming and delivery remain outside this run's grant.

### Focused proof

All final commands below exited 0 on the implementation tree. Logs and the
measurement script remain under ignored `.context/scratch/m15-r1/`; they are
local observations, not hosted evidence. Direct Vitest invocations use
`--maxWorkers=2`, with test suites and package builds serialized.

| Check | Command/result |
| --- | --- |
| Structural rules | `npx --no -- ast-grep scan --error=no-suppress-all --error=unused-suppression` — PASS |
| Lint and package builds | `npm run lint` — PASS, zero errors; 33 existing warnings |
| Tooling compiler | `npx --no -- tsc -p tsconfig.node.json` — PASS |
| Server compiler | `npx --no -- tsc -p tsconfig.api.json` — PASS |
| Risk compiler witness | `npx --no -- tsc --ignoreConfig --noEmit --skipLibCheck --strict --module NodeNext --moduleResolution NodeNext --target ES2022 --esModuleInterop --resolveJsonModule --allowImportingTsExtensions packages/platform/test/risk/*.test.ts tests/postgres/riskControl.conformance.test.ts` — PASS; all ten schema output types agree bidirectionally |
| API snapshots | `npm --workspace @openlup/platform run api:check` — PASS; only the three risk API reports were added |
| Package artifacts | `npm run packages:check` — PASS, all three packages, no findings |
| Risk package cases | `npx --no -- vitest run packages/platform/test/risk --maxWorkers=2` — 23/23 PASS, 101 ms summed test time |
| Native/managed SQL | `npx --no -- vitest run tests/postgres/riskControl.conformance.test.ts --maxWorkers=2` — 14/14 PASS, 10.33 s test time; includes the existing five managed blocklist pgTAP assertions |
| Packed consumer | `npx --no -- vitest run scripts/packages/platform-cold-consumer.test.ts -t M15 --maxWorkers=2` — selected case PASS, 4.59 s test time; 86 unrelated cases excluded by the name filter, no source skips added |
| Companion boundaries | `npx --no -- vitest run packages/platform/test/packageBoundary.test.ts scripts/packages/eslint-import-map.test.ts scripts/packages/package-manifest-policy.test.ts scripts/packages/package-size-policy.test.ts scripts/packages/package-tarball-gate.test.ts --maxWorkers=2` — 2,731/2,731 PASS |
| Documentation impact | `npm run oss:published-tree -- --policy --docs-update` — PASS; five obligations, zero unanswered; navigation regenerated |
| Donor preservation | `node .context/scratch/m15-r1/donor-preservation.mjs` — eight unchanged non-import statement comparisons PASS |
| Whitespace and DCO | `git diff --check` and `npm run check:dco-signoff -- <full-base> <full-head>` — PASS |

The PG witness uses separate non-superuser runtime/browser sessions, not owner
execution for the behavior under test. It distinguishes native invoker versus
managed definer permissions, shadow case/hold behavior, review lifecycle and
actor refusal, replay/conflicts (including changed timestamp and evidence),
payment-evidence obligations, and blocklist identity/activity/time/reason rules.
The packed trial consumes the actual export, returns a useful allow result,
refuses missing payment before writing, and rejects a private package path.

The 36 forecast behavior cases are eight schema, eight assessor, six adapter
and fourteen SQL cases. Browser isolation and packed consumption add two explicit
cases: **38 explicit new cases**. The existing package boundary suite also
expands its three per-source tables over thirteen new source files: **39 more
instances**, giving a **77-case discovery increase** against the code base.
The five pgTAP assertions are reused, not newly authored cases. Local selected
risk test time sums to 15.021 s; it is not a comparable hosted median and does
not settle the programme's hosted time allowance.

### Platform artifact measurement

Measured after the successful official package check, using its existing
`measurePack` implementation on the actual extracted platform tarball. Caps are
unchanged; only the new type-only browser-entry allowance was added.

| Metric | Measured | Existing cap | Headroom |
| --- | ---: | ---: | ---: |
| Packed bytes | 1,895,207 | 1,925,000 | 29,793 |
| Unpacked bytes | 8,873,947 | 8,970,000 | 96,053 |
| Files | 2,562 | 2,580 | 18 |
| Code gzip bytes | 1,621,370 | 1,648,000 | 26,630 |
| Code files | 2,508 | 2,520 | 12 |
| Docs gzip bytes | 63,739 | 73,728 | 9,989 |
| Docs files | 5 | 10 | 5 |

The new `risk/contracts` browser bundle is 20 gzip bytes against its 32-byte
allowance. This measurement reserves no M14 headroom; pack and programme test
allowances must be reconciled against actual earlier-module landings.

### Review, deviations and remaining gates

Two independent fresh-context read-only preliminary reviewers inspected the
complete bounded comparison against implementation candidate
`3915b5f51a98c76031a4e67e4b3d27b9c2201d8e`. Both returned PASS with no material
findings, ran no suites/builds, and considered the direct factories/existing
harness the smallest adequate solution. No preliminary repair cycle was needed.
These observations establish no counted native admission, receipt or expiry;
the coordinator owns later arming and recovery of any native session state.

Fit-report adjustments within R1:

- Port declarations live directly in `packages/platform/src/risk/contracts/ports.ts` instead of a
  redundant top-level port relay. Schema output shapes have explicit type-only
  declarations plus the bidirectional compiler witness, keeping Zod out of
  contract declaration/runtime closures.
- Fingerprint assertions share the assessor case rather than a separate test
  file. The descriptor stays in `packages/platform/src/risk/server/sql.ts`; no additional schema-probe
  mechanism is necessary for this unchanged sparse SQL projection.
- The case forecast excluded two explicit isolation cases and expansion of the
  existing per-source tables; the measured discovery increase is recorded above.
- The shared `docs/platform/PLATFORM_PACKAGE_REFERENCE.md` needs no separate recipe in R1:
  the owning architecture contract and package README describe the unchanged
  host seams. No unrelated sibling API report changed.
- Full verify-local and draft submission from the coordinator stack endpoint
  were expressly excluded by the direct authoring instruction. They were not
  attempted; focused passes do not substitute for those later gates.

Recovered failures were resolved before review: six lint errors from sibling
contract import spelling were corrected to the existing canonical entry path,
API snapshots were regenerated after import rewiring, and a stale staged deleted
port relay was removed before the documentation checker. Initial ad-hoc compiler
invocations needed TypeScript 6's `--ignoreConfig` and the repository's extension
settings; the final strict risk command and repository compiler projects pass.
No lint control, SQL behavior, timeout or skip was relaxed.

No unresolved R1 code question remains. The coordinator still owns full
verification, counted reviews, post-M14 pack/test-budget reconciliation and any
later draft delivery. R2/R3 and S1 retain their separate accepted boundaries.

Self-retro: recovery found one actual authoring defect class—noncanonical import
spelling caused six lint errors. Reusing the existing accepted entry spelling
resolved it without changing a guard. Inspecting the staged deletion also avoided
mistaking an index mismatch for a documentation defect. No additional process or
abstraction was justified; no formal rethink was required.

### M14 main integration — 2026-10-27

Direct maintainer continuation: merge freshly fetched `origin/main` into the
assigned R1 branch with `git merge --no-ff origin/main`, preserve both modules,
regenerate derived outputs, run the requested focused checks with two Vitest
workers, and create local Bart Roszkowski DCO commits. No push, cap change,
release or activation is authorized. This bounded integration does not complete
the coordinator's full verification or native admission obligations above.

Main and current instruction freshness pin:
`80cb0e7063206a9fead36b4e6680c9a83fa3e108`.
The relevant instruction delta adds M14 proof, exact SQL neutrality inventory
and review lessons; earlier R1 scope and delivery restrictions remain applicable.
The code review base remains separately recorded above.

All 11 conflicts are shared additions: documentation routing/catalogue,
architecture and documentation ownership, generated source map, ESLint graph,
package README, browser budgets, package boundary and import-map inventories,
and installed-consumer export classification. Retain operations content and
append risk entries beside it. The generated source map starts from main for
regeneration in the separate follow-up commit. No runtime algorithm is edited.
The smallest adequate resolution is the union of these existing registrations;
no helper, dependency or raised cap is needed. Dependency versions and lockfile
are unchanged, so no reinstall is required.

Integration commit: `1c7e5ae6f69bea8f06dd26d1e487913b55c7e278`, with the
original R1 head and fetched main as its two parents and the instructed DCO
trailer. Regeneration is a separate signed follow-up. Platform `api:update`
completed without changing any API report bytes. `oss:published-tree -- --policy`
first refused the stale source map; `--policy --docs-update` regenerated the
combined operations/risk navigation and passed all five documentation obligations
with zero unanswered. The committed release snapshot remains release-prep owned;
the checker confirms live computed bindings. Neither module's source, tests or
API reports differ from its corresponding parent.

Focused integration results (logs under ignored
`.context/scratch/m15-r1-main-merge/`):

| Check | Result |
| --- | --- |
| `npx --no -- ast-grep scan --error=no-suppress-all --error=unused-suppression` | PASS |
| `npm run lint` | PASS; zero errors, 33 existing warnings |
| `npm run api:check --workspaces --if-present` | PASS for core, outbox and platform; root has no standalone API script |
| `npm run packages:check` | FAIL solely on the five platform size caps below; all packages packed and no other findings |
| `npx --no -- vitest run packages/platform/test/risk --maxWorkers=2` | PASS, 23/23 in four files |
| `npx --no -- vitest run scripts/packages/platform-cold-consumer.test.ts -t M15 --maxWorkers=2` | PASS, 1 selected; 86 unrelated cases excluded by the name filter |
| `npx --no -- vitest run packages/platform/test/packageBoundary.test.ts scripts/packages/eslint-import-map.test.ts --maxWorkers=2` | PASS, 2,746/2,746; verifies the merged module inventories |

The actual platform tarball was independently measured with the existing
`measurePack` implementation and matches every official gate finding. These are
main's caps, with no adjustment in this integration:

| Metric | Measured | Cap | Result |
| --- | ---: | ---: | --- |
| Packed bytes | 1,932,551 | 1,925,000 | Exceeds by 7,551 |
| Unpacked bytes | 9,044,275 | 8,970,000 | Exceeds by 74,275 |
| Files | 2,647 | 2,628 | Exceeds by 19 |
| Code gzip bytes | 1,654,451 | 1,648,000 | Exceeds by 6,451 |
| Code files | 2,592 | 2,574 | Exceeds by 18 |
| Docs gzip bytes | 64,287 | 73,728 | Within by 9,441 |
| Docs files | 5 | 10 | Within by 5 |

The size gate remains a delivery blocker for the coordinator. The direct task
explicitly requires reporting rather than changing caps; no capacity workaround
or unrelated repair is added. Full verification, counted native admission and
remote delivery remain outside this local continuation.

Self-retro: using the union of existing registrations and the existing generators
kept integration free of new mechanisms. Measuring the combined artifact exposed
five concrete budget overruns despite each lane's earlier local evidence; retain
that combined-artifact check before delivery. No successor work was opened.

### CD-M15-6 platform pack budget — 2026-10-27

The direct maintainer continuation authorizes only the coordinator's CD-M15-6
cap adjustment in this assigned R1 worktree, its required records and focused
checks, and a local Bart Roszkowski DCO commit. This supersedes the prior
continuation's cap-change exclusion for these five values only. The coordinator
acts as owner delegate for the gate-cap read; this is delegated technical review,
not a claim that the human personally read the diff. No push, PR creation, full
verify-local, release or activation is authorized here. Full verification,
counted native reviews and later delivery remain with the coordinator.

Instruction freshness: freshly fetched main remains
`80cb0e7063206a9fead36b4e6680c9a83fa3e108`; the applicable instruction paths
are unchanged. This continuation starts at `7a1886aa`; the branch review base
is `git merge-base HEAD origin/main`, separately from the policy freshness pin.

Reason: M15 full stack measured after M14 #397: packed 1,939,078; unpacked 9,077,757; files 2,659; code gzip 1,660,986; code files 2,604; +~2% for S1 and repairs (coordinator delegate read CD-M15-6).

The coordinator measured the full stack at R3 head `5aaa4a4a`; these figures
are supplied decision evidence, not a fresh R3 measurement in this R1 run.
Following M11's P-1 first-crossing precedent, R1 raises only these platform caps:

| Metric | Previous cap | CD-M15-6 cap |
| --- | ---: | ---: |
| Packed bytes | 1,925,000 | 1,980,000 |
| Unpacked bytes | 8,970,000 | 9,260,000 |
| Files | 2,628 | 2,712 |
| Code gzip bytes | 1,648,000 | 1,695,000 |
| Code files | 2,574 | 2,656 |

The smallest adequate change edits the five existing values and records the
decision in the existing changes fragment and package budget documentation,
as M14 recorded its finite allocation. Docs caps, browser caps, baseline,
versions and every other package remain unchanged. No reason-field schema,
new package, test harness or runtime change is needed. The existing
`scripts/packages/package-size-policy.test.ts` reads the real caps and checks
class/aggregate overflow refusals and actual packed contents.

Acceptance is a passing official package check, the existing artifact-budget
test, ast-grep scan, lint, documentation policy and a signed local commit with
the requested title. Serialize package builds and tests because they share
generated outputs. The official pack gate requires committed package inputs,
so create the signed candidate after lint and documentation checks, then run
the official pack and artifact test and record their results here.

Focused results (logs under ignored `.context/scratch/m15-r1-cap-*.log`):

| Check | Result |
| --- | --- |
| `npm run packages:check` | PASS, all three packages, no findings; platform has 2,647 packed files |
| `npx --no -- vitest run scripts/packages/package-size-policy.test.ts --maxWorkers=2` | PASS, 47/47; 3.57 s total, 2.87 s test time |
| `npx --no -- ast-grep scan --error=no-suppress-all --error=unused-suppression` | PASS |
| `npm run lint` | PASS, zero errors and 33 existing warnings; all package builds and eight structural rule suites pass |
| `npm run oss:published-tree -- --policy --docs-update` | PASS, five obligations and zero unanswered; navigation regeneration produces no changed bytes |

The official package check and cap tests used the signed candidate's exact
package inputs. The subsequent evidence addition changes only this unpacked
task record. This closes the five-cap local blocker reported above; it does
not complete the coordinator's full-stack verification or native admission.
Only the four files for caps, fragment, package budget explanation and this
task record change in this continuation. No push was performed.

Self-retro: the existing pack gate's clean-package requirement dictated the
commit/check order. A signed candidate followed by an evidence-only amendment
kept that control intact without a bypass, new schema or duplicate test. No
formal rethink or additional process change was needed.

### M14 #400 stack integration — 2026-10-27

Direct maintainer grant: integrate fetched main into R1, then local R1 into R2
and R2 into R3 with non-fast-forward DCO-signed merges. No rebase or push.
If the full stack exceeds a platform cap, CD-M15-6a authorizes only exceeded
caps to be sized at 102% of that measurement, bytes rounded up to 5,000 and
files up to an integer, in R1 and cascaded. Other caps stay unchanged.
Acceptance: regenerated API/navigation, requested focused checks with two
Vitest workers in each worktree, package checks in R1/R3 and a measured R3
artifact table against caps. Full verify, counted admission and delivery remain
with the coordinator; these local observations grant no readiness or release.

Main/instruction freshness pin: `a03d920eec32bfb3d0de90b9a12535cc57f88d53`;
review base remains the candidate fork point, separately from this policy pin.
The current instruction delta adds M14 transfer proof and the filesystem
identity lesson. Five conflict files: doc routing, architecture, generated source
map, package exports and release gates. Preserve both risk and portability
registrations/contracts; main is authoritative for portability. Resolve generated
source map through the generator. Each cap is the maximum of the two parents,
which retains the existing CD-M15-6 values. No lockfile delta or reinstall.
Smallest adequate solution: union the existing registrations and regenerate;
no runtime changes, new helpers or controls. Focused execution logs are under
ignored `.context/scratch/m15-main400/` in each worktree.

R1 merge candidate: `c722a154`. API update, documentation policy and
`--docs-update`, two-thread ast-grep, lint (zero errors, 33 warnings), workspace
API checks and 23/23 risk tests pass. Root has no `api:check`/`api:update` script,
so the supported workspace commands run all three packages. Official
`packages:check -- --out .context/scratch/m15-main400/packs` passes for all three
packages with no findings. Existing `measurePack` on the retained platform
tarball records packed 1,948,811; unpacked 9,108,271; files 2,659; code gzip
1,669,304; code files 2,604; docs gzip 65,158; docs files 5. Every cap is met.
This evidence-only follow-up changes no packed input. Full-stack measurement
remains R3's next acceptance step. No external write occurred.

Self-retro: existing JSON registrations and generators resolved five shared
conflicts without changing module behavior. The clean-package gate required
committing the candidate before packing; retain its exact artifact for the
measurement instead of introducing a second pack or a new measurement tool.

## R2 — reference delegation, captured workflow and inert composition

Approved outcome: one packaged implementation serves reference risk hashing,
paid-order assessment, persistence and admin handlers; a default-off recipe binds
the existing commerce outbox risk slot once. Preserve captured checkout/client/UI,
trusted actor injection and all donor differences, including managed admin
`replayed: false`, shadow fulfillment suppression and timestamp fingerprints.
No corrections, SQL, privacy implementation, M14 paths, activation, versions,
pushes or PRs belong to this run. O3's approved bounded privacy contributor stays
with R3; no retention period or managed erasure claim is introduced here.

Authority: Bart Roszkowski is the accountable author. The direct R2 instruction
allows reading, editing and small local DCO-signed commits in the assigned
`claude/oss-m15-r2-risk-reference-delegation` worktree. It expressly prohibits tests,
Vitest, pgTAP, builds, installs, lint and compiler execution while another machine
verification runs. That instruction overrides pre-sign-off execution for this
local authoring handoff; it grants no submission, merge or release authority.
The coordinator retains the verify slot, counted reviews and subsequent delivery.

Stack/code base: `2e7d70ad` (R1). Instruction freshness pin:
`ef861a76dad97c0b744f6f25c04b04f4ac44c5fe` (freshly fetched `origin/main`,
2026-10-27); relevant instruction paths are unchanged. No rebase or main merge.
The complete fit report §4 and coordinator stack plan were read before editing.

Smallest adequate solution: named compatibility exports, the unchanged handler
with injected existing BFF responder, direct bound callables and an inert
contribution with no handlers or schedules. The host passes the returned
`outboxRisk` into its existing `createOutboxDispatchRegistry`; a second executor,
worker, registry or default BFF route would add behavior and is excluded.

Acceptance/proof plan: retain the existing five handler guards, reference client/UI,
R1 adapter/SQL/timestamp witnesses; add 19 neutral admin cases, eight composition
cases, four browser/client cases and four installed-artifact/compiler/isolation
cases. Each independent table row counts. Refusals must precede the relevant
port/effect, actor identity must come from authorization, and one paid event must
assess once before at most one fulfillment. Execution, API generation and docs
navigation remain deferred under the machine rule; written tests are no PASS
claim. Preliminary read-only review will inspect the signed candidate and its
preserved donor statements; it creates no native admission or review expiry.

### R2 execution continuation — 2026-10-27

The direct continuation instruction lifts the earlier machine execution hold:
dependencies are installed and this run owns serial generators, the listed
focused/compiler/lint/API/package and real-PG checks, R2-only repairs, generated
outputs and local DCO-signed commits. Vitest uses at most two workers. The
endpoint remains local commits and measured evidence; no push, donor behavior
correction, R3 or M14 change is authorized. Counted native review, full root
verification, budget approval and delivery remain with the coordinator.

Execution starts from `04907f22`; the full R1 stack pin above is unchanged.
Refreshed `origin/main` still resolves to
`ef861a76dad97c0b744f6f25c04b04f4ac44c5fe`, with no applicable instruction delta.
The existing preliminary finding/review history remains intact. Command logs
and measurements are retained under ignored `.context/scratch/m15-r2/` and the
results below distinguish local observations from outstanding delivery gates.

Initial execution found one R2-only defect: the browser route fixture annotated
its result with schema-inferred types under the app's non-strict-null compiler
profile. Its nullable event fields then became optional and failed assignment
to the explicit package port. Using `AdminRiskCaseDetail` from the type-only
package contracts fixes the fixture without changing values or donor semantics.
The app compiler and all four affected cases pass after that change.

API regeneration changes only `composition.api.md` and `risk-server.api.md`.
The latter includes the existing HTTP/BFF declaration closure through type
imports; it introduces no runtime edge to those modules. Initial policy and
docs-update commands refuse three unanswered impact obligations; the next
commit supplies delta-bound no-impact trailers for configuration, repository
and tooling, preserving their existing compatibility/check contracts. Navigation
generation and policy are rerun after those trailers become readable in Git.

Local focused results at this checkpoint: 79/79 risk/reference/browser cases,
5/5 selected M15 installed cases (86 unrelated cases filtered), 2,671/2,671
boundary/import-map cases, 14/14 real-PG cases including the existing managed
pgTAP assertions, and the four repaired browser cases pass. API/server, tooling,
app and strict risk contract compiler checks pass. Lint passes with zero errors
and 33 warnings; the structural scan and platform API check pass.

Discovery confirms 19 admin, eight composition, four browser and four packed
R2 cases, plus nine instances in the existing per-source boundary tables:
**R2 +44; R1 +77; combined +121**, exceeding the unchanged +100 allowance by
**21**. No finite budget exception or hosted timing approval is inferred.

One API compiler attempt overlapped the tail of the boundary run; both passed,
but the API compiler was rerun alone and that serial pass is the counted result.
Subsequent execution is serial. Full command results and pack reconciliation
follow below after the clean-commit artifact check.

### R2 executed proof and artifact reconciliation — 2026-10-27

The local execution candidate is
`bcfec20f0aadde0e5f309149bda3338482f9b807` —
`fix(risk): verify browser fixture and generate API reports (M15 R2)`.
Its DCO sign-off is Bart Roszkowski's instructed sign-off. The final evidence-only
commit changes this task record; package inputs remain identical. Every command
below uses the full R1 `OPENLUP_STACK_BASE`; direct Vitest uses `--maxWorkers=2`.
The root has no `api:check` script, so the platform workspace owns that command.

| Command | Observed local result |
| --- | --- |
| `npm run pretest` | PASS; Core, Outbox and Platform build |
| `npm --workspace @openlup/platform run api:update` | PASS; only `composition.api.md` (+24 lines) and `risk-server.api.md` (+504 lines) change |
| `npm run oss:published-tree -- --policy` | Initial exit 1 for three missing impact answers; after the scoped trailers, PASS, eight obligations and zero unanswered |
| `npm run oss:published-tree -- --policy --docs-update` | Same initial refusal; after the trailers, PASS; regenerated navigation has no byte delta |
| `npx --no -- vitest run packages/platform/test/risk server/domains/risk server/adapters/postgres/riskControl.test.ts server/adapters/supabase/riskAdminPort.test.ts server/adapters/supabase/riskOrderPaid.test.ts server/runtime/public-reference/m15RiskBinding.test.ts src/public-reference/riskReviewRoutes.test.tsx src/domains/risk/riskClient.test.ts src/pages/admin/RiskReviewPage.test.tsx --maxWorkers=2` | PASS, 15 files / 79 cases |
| `npx --no -- vitest run scripts/packages/platform-cold-consumer.test.ts -t M15 --maxWorkers=2` | PASS, five selected cases; 86 unrelated cases filtered, no new source skips |
| `npx --no -- vitest run packages/platform/test/packageBoundary.test.ts scripts/packages/eslint-import-map.test.ts --maxWorkers=2` | PASS, two files / 2,671 cases |
| `npx --no -- tsc -p tsconfig.api.json` | PASS; repeated serially after the initial overlap noted above |
| `npx --no -- tsc -p tsconfig.node.json` | PASS |
| `npx --no -- tsc -p tsconfig.app.json` | Initial exit 2 on the R2 fixture; PASS after the type-only fix |
| `npx --no -- tsc --ignoreConfig --noEmit --skipLibCheck --strict --module NodeNext --moduleResolution NodeNext --target ES2022 --esModuleInterop --resolveJsonModule --allowImportingTsExtensions packages/platform/test/risk/*.test.ts tests/postgres/riskControl.conformance.test.ts` | PASS, including the unchanged schema/contract type witness |
| `npx --no -- vitest run src/public-reference/riskReviewRoutes.test.tsx --maxWorkers=2` | PASS, all four affected cases after the fixture fix |
| `npm run lint` | PASS, zero errors / 33 warnings; includes package builds and eight structural-rule fixture suites |
| `npx --no -- ast-grep scan --error=no-suppress-all --error=unused-suppression` | PASS after the source change and after lint |
| `npm --workspace @openlup/platform run api:check` | PASS |
| `npx --no -- vitest run tests/postgres/riskControl.conformance.test.ts --maxWorkers=2` | PASS, 14 cases on the two actual PostgreSQL rails, including reused managed pgTAP assertions; 11.70 s summed test time |
| `npx --no -- vitest list packages/platform/test/risk tests/postgres/riskControl.conformance.test.ts server/runtime/public-reference/m15RiskBinding.test.ts src/public-reference/riskReviewRoutes.test.tsx scripts/packages/platform-cold-consumer.test.ts packages/platform/test/packageBoundary.test.ts --maxWorkers=2 --json` | PASS; discovery confirms R1 +77, R2 +44, combined +121; JSON retained in ignored evidence |
| `npm run packages:check -- --out .context/scratch/m15-r2/artifacts` | PASS on the clean committed candidate, three packages and no findings; retained actual tarballs and producer manifest |
| `node --experimental-strip-types .context/scratch/m15-r2/measure.mjs .context/scratch/m15-r2/artifacts` | PASS; existing `measurePack`/`checkPackBudget` functions on the extracted official tarballs, no findings |
| `npm run oss:published-tree -- --inventory` | PASS, 6,459 tracked public paths |
| `git diff --check` | PASS |
| `npm run check:dco-signoff -- "$OPENLUP_STACK_BASE" HEAD` | Exit 2: the historical deferred spelling supplies a symbolic endpoint, which this checker refuses |
| `npm run check:dco-signoff -- "$OPENLUP_STACK_BASE" "$(git rev-parse HEAD)"` | PASS, all six R2 commits through the execution candidate signed off; use the full-digest spelling for the final evidence commit too |

The producer manifest binds the retained pack proof to the exact execution
candidate above. All values below are measured/cap; no cap or package control
changed. This evidence reserves no M14 or R3 headroom.

| Metric | Core | Outbox | Platform |
| --- | ---: | ---: | ---: |
| Packed bytes | 167,341 / 327,680 | 39,165 / 81,920 | 1,898,755 / 1,925,000 |
| Unpacked bytes | 712,626 / 1,392,640 | 133,216 / 266,240 | 8,890,843 / 8,970,000 |
| Files | 224 / 420 | 41 / 90 | 2,571 / 2,580 |
| Code gzip bytes | 143,737 / 276,480 | 20,930 / 43,008 | 1,623,846 / 1,648,000 |
| Code files | 213 / 400 | 33 / 70 | 2,517 / 2,520 |
| Docs gzip bytes | 17,213 / 49,152 | 13,216 / 26,624 | 63,969 / 73,728 |
| Docs files | 10 / 20 | 6 / 12 | 5 / 10 |

The type-only `risk/contracts` browser bundle measures 20 gzip bytes against
32. Relative to recorded R1, Platform adds 3,548 packed bytes, 16,896 unpacked
bytes, nine files, 2,476 code gzip bytes, nine code files and 230 docs gzip bytes.
Platform headroom is 26,245 packed bytes, 79,157 unpacked bytes, nine total files,
24,154 code gzip bytes, three code files and 9,759 docs gzip bytes.

Two independent fresh-context read-only reviewers (`r2_final_review_a` and
`r2_final_review_b`) inspected the complete R1-to-execution-candidate delta,
including the generated declarations and repaired browser fixture. Both returned
PASS with no material findings or optional advice, independently closed the two
earlier finding cards, and considered direct delegation/the incumbent slot/the
existing harness the smallest adequate approach. They ran no tests, builds or
generators and changed no review-session state. These are preliminary local
semantic reviews, not counted native admission or a new expiry/counter history.

Remaining delivery gates: the combined +121 discovery increase exceeds the
programme's +100 allowance by 21; the coordinator must obtain the finite budget
decision and hosted-time reconciliation. Full root verification/coverage and
counted native review remain coordinator-owned. The checker also reports the
pre-existing committed binding snapshot as stale and explicitly reserves its
refresh for release preparation; local policy/inventory pass. No release-prep
snapshot, donor behavior, R3 privacy, M14 file, cap, timeout, source skip, version,
SQL, activation or external state changed. No push was attempted.

Self-retro: executing the app compiler caught one fixture-only type defect missed
by static authoring and the server compiler. The direct type-only import fixed
it without an assertion, abstraction or behavior change. One initial compiler
overlap required a 7.6-second serial rerun; subsequent commands waited for actual
process completion. The deferred DCO spelling required full endpoint resolution.
No formal rethink or additional process was justified.

### R2 authored cases and deferred commands

The written witness has **35 explicit new cases**: `adminHandlers.test.ts` has
15 individual cases plus four independent decision rows (19);
`m15RiskBinding.test.ts` has three individual cases plus five independent outcome
rows (8); `riskReviewRoutes.test.tsx` has four; the existing cold-consumer suite
has four independent `RISK_WORKFLOW_PROOFS` rows (admin, NodeNext, Bundler,
isolation). The installed admin scenario exercises the actual managed readback
through the handler and deliberately expects `replayed: false` after a SQL reply
of true. Existing five handler guards, client/UI cases, R1 adapter/SQL and managed
timestamp-conflict witnesses remain unchanged.

Three new production package files also expand the existing three per-source
boundary tables by an expected nine instances. That makes an expected R2
**44-case discovery increase**, pending actual discovery. R1 recorded 77, so the
combined expected increase is 121 before R3, above the +100 programme allowance.
No cap, skip, timeout or budget changed here; the coordinator must reconcile the
actual discovery/hosted time and obtain the finite budget read before delivery.

Run the following serially from this worktree **after the machine rule is lifted**.
Keep `OPENLUP_STACK_BASE` pinned to the full R1 predecessor:

```sh
export OPENLUP_STACK_BASE=2e7d70ad25aeea42736394aebbf0e87f0b9a4c79
npm run pretest
npm --workspace @openlup/platform run api:update
npm --workspace @openlup/platform run api:check
npx --no -- ast-grep scan --error=no-suppress-all --error=unused-suppression
npm run lint
npx --no -- tsc -p tsconfig.api.json
npx --no -- tsc -p tsconfig.node.json
npx --no -- vitest run packages/platform/test/risk server/domains/risk server/adapters/postgres/riskControl.test.ts server/adapters/supabase/riskAdminPort.test.ts server/adapters/supabase/riskOrderPaid.test.ts server/runtime/public-reference/m15RiskBinding.test.ts src/public-reference/riskReviewRoutes.test.tsx src/domains/risk/riskClient.test.ts src/pages/admin/RiskReviewPage.test.tsx --maxWorkers=2
npx --no -- vitest run tests/postgres/riskControl.conformance.test.ts --maxWorkers=2
npx --no -- vitest run scripts/packages/platform-cold-consumer.test.ts -t M15 --maxWorkers=2
npx --no -- vitest run packages/platform/test/packageBoundary.test.ts scripts/packages/eslint-import-map.test.ts --maxWorkers=2
npm run packages:check
npm run oss:published-tree -- --policy --docs-update
npm run oss:published-tree -- --policy
npm run oss:published-tree -- --inventory
git diff --check
npm run check:dco-signoff -- "$OPENLUP_STACK_BASE" HEAD
```

API generation is intentionally deferred, rather than hand-writing a generated
snapshot. Expected affected reports are `risk-server.api.md` and
`composition.api.md`; the new BFF/HTTP declaration closure must be reviewed.
Do not accept unrelated sibling regeneration. The installed compiler cases use
strict NodeNext/Bundler consumers with `skipLibCheck` for optional peer declaration
closures; they prove the entrance's requests/results and required actor/responder,
not absence of all optional peer declaration dependencies. The isolation case
separately bundles actual installed browser/contracts entries, refuses the server
browser bundle and private paths, and proves that pg is absent.

Required full verification, coverage, API and navigation generation, actual
case/time/pack measurements and counted review remain with the coordinator. No
execution, hosted PASS, installation proof or budget exception is claimed here.

### R2 preliminary review history

Two independent cold read-only reviewers inspected the full
`2e7d70ad25aeea42736394aebbf0e87f0b9a4c79..583c3f49f2fc6a75ded17636384e7a0ff52bd367`
comparison with the binding criteria and simplicity pre-check. Both used reads
and Git only; no suite, compiler or generator ran. They identified two material
cards, repaired in the next signed candidate:

- **R2-P1 / reviewer A:** the fingerprint delegate omitted the existing public
  `safeRiskString` helper. An existing source importer would fail, violating
  unchanged delegation. Restore the named package export and extend the existing
  fingerprint case with an identity assertion; no new behavior case is needed.
- **R2-P2 / reviewers A and B (B1):** the selected-route witness called a
  `Contribution` descriptor's erased `(...args: never[]) => unknown` signature
  with HTTP arguments. The server compiler includes this test and would reject
  it. Recover `typeof binding.services.list` at that witness boundary, as in the
  existing M12 pattern; preserve the metadata API and actual callable.

This is one preliminary repair iteration, not a native prepare/admission cycle.
No existing native session, findings, counter or expiry was reset or inferred.
Fresh reviewers must inspect the repaired committed candidate and explicitly
close both cards. All deferred execution obligations remain open.

### R2 local authoring handoff — 2026-10-27

Signed implementation commits:

- `d86106821614ec4ce395312051f463ef4b313dc2` — reference runtime/schema/port delegation.
- `273ca0ac` — captured admin workflow, inert composition and 31 written cases.
- `583c3f49f2fc6a75ded17636384e7a0ff52bd367` — four packed workflow cases and deferred command ledger.
- `6684d9fd692830f3323c3d6d4e964d441fc2cd2e` — close preliminary helper-export and route-witness findings.

Two new independent fresh-context reviewers inspected the **complete** repaired
base-to-`6684d9fd692830f3323c3d6d4e964d441fc2cd2e` comparison. Both returned
preliminary static PASS, explicitly closing R2-P1 and R2-P2 with no further
material findings. They considered direct delegates, responder injection and the
existing slot the smallest adequate solution. All four review contexts used
reads/Git only. No native receipt, admission or evidence expiry is established;
the coordinator retains the later counted review and verification route.

Observed local proof is limited to clean Git whitespace checks and DCO trailers
on the instructed local commits. A handoff fetch still resolves `origin/main` to
the instruction pin above with no relevant instruction delta. No tests, pgTAP,
builds, install, lint, compiler, API generation, policy checker or broad verify ran.
The tree is an authored candidate, not a verified delivery candidate.

Fit-report placement adjustments: the eight cross-boundary composition cases
live beside `m15RiskBinding.ts`, where they exercise the actual existing commerce
registry; the four installed/compiler/isolation cases extend the existing
cold-consumer harness. Separate package `bindings.test.ts` and a new consumer
harness would duplicate those proofs. The admin case suite calls the packaged
binding directly. No behavioral requirement was narrowed. The captured escalated
UI refusal is preserved even though the server advertises allowed actions.
Generated snapshots/navigation remain unmodified because their commands require
the deferred build/verification slot. These are explicit remaining gates, not
accepted deviations from behavior or proof requirements.

Small add-only shared-companion edits:

- `packages/platform/src/risk/server/index.ts`: export the new handler and binding.
- `packages/platform/src/composition/index.ts`: export the inert risk contribution.
- `eslint.config.js`: add only the risk schema value edge and HTTP/BFF type edges
  to `risk/server`; no other graph permission changes.
- `scripts/packages/platform-cold-consumer.ts`: add installed workflow proofs,
  their existing-esbuild import and invocation in the official consumer run.
- `scripts/packages/platform-cold-consumer.test.ts`: add four independent rows.
- `config/openlup-publication-catalog.json`: add seven public-output records.
- `packages/platform/README.md`: append the binding/slot recipe.
- `docs/platform/ARCHITECTURE_AND_EXTENSIONS.md`: append R2's delegation contract.
- `docs/platform/plans/oss-m15-generic-risk-controls.md`: append this R2 task/evidence
  record; retain R1's history unchanged.

No package.json export, R1 fragment, API snapshot, release gate, version, lockfile,
SQL, M14 source or default BFF router changed. Remaining coordinator decisions:
actual case/time/pack reconciliation and any finite budget exception; after the
machine rule is lifted, run the exact commands above, review generated API/docs
deltas, then complete required verification and counted reviews. No open R2 code
or donor-policy question is identified by the static reviews.

Changed paths (complete R2 delta):

```text
config/openlup-publication-catalog.json
config/public-reference-capability-manifest.json
docs/platform/ARCHITECTURE_AND_EXTENSIONS.md
docs/platform/RUNTIME_AND_SELF_HOSTING.md
docs/platform/plans/oss-m15-generic-risk-controls.md
eslint.config.js
packages/platform/README.md
packages/platform/changes/m15-r2.md
packages/platform/src/composition/index.ts
packages/platform/src/composition/riskContribution.ts
packages/platform/src/risk/server/bindings.ts
packages/platform/src/risk/server/index.ts
packages/platform/src/risk/server/riskAdminCasesHandler.ts
packages/platform/test/risk/adminHandlers.test.ts
scripts/packages/platform-cold-consumer.test.ts
scripts/packages/platform-cold-consumer.ts
server/adapters/README.md
server/adapters/postgres/riskControl.ts
server/adapters/supabase/riskAdminPort.ts
server/adapters/supabase/riskOrderPaid.ts
server/domains/risk/orderPaidRiskPort.ts
server/domains/risk/riskAdminCasesHandler.ts
server/domains/risk/riskFingerprint.test.ts
server/domains/risk/riskFingerprint.ts
server/runtime/public-reference/m15RiskBinding.test.ts
server/runtime/public-reference/m15RiskBinding.ts
src/domains/risk/README.md
src/domains/risk/contracts.ts
src/domains/risk/ports.ts
src/public-reference/riskReviewRoutes.test.tsx
```

Self-retro: the first static review caught an omitted compatibility helper and
an erased descriptor signature in a new witness. Restoring the named export and
recovering the known callable type closed both without changing public metadata
or donor behavior. The lesson is to compare the complete exported surface and
use the established concrete-callable witness pattern; no new abstraction or
process was justified, and no formal rethink was needed. Machine contention
prevented execution evidence, so no runtime delay or performance claim is made.

### R2 predecessor integration — 2026-10-27

Direct maintainer instruction authorizes the local no-fast-forward merge of
`claude/oss-m15-r1-risk-import` at `7a1886aa599a96a9d1fef90769583e7251342aa3`
into R2 at `c88f5894`, conflict resolution preserving M14 and both M15 slices,
serial generation, the requested focused checks with two Vitest workers, and
separate DCO-signed merge/regeneration commits. No push, cap change, release,
behavior correction or counted review is in this continuation. Bart Roszkowski
remains the accountable author; the coordinator retains subsequent delivery.

Instruction freshness: freshly fetched `origin/main` is
`80cb0e7063206a9fead36b4e6680c9a83fa3e108`, separate from the original R1 stack
base. The predecessor contains that main commit and M14 #397. The only merge
conflict is this record's append point: retain predecessor R1 integration
evidence before the entire R2 record. Source and configuration merge without
conflicts; preserve generated inputs and regenerate outputs in the next commit.
Acceptance is the two local signed commits, preserved source intent, focused
check results and exact Platform pack measurements against unchanged caps.
Known M14 size excess remains reportable and blocks a passing package gate;
this instruction grants no budget waiver.

Integration merge: `aadc7b072547dedfe033dd613b0c478297ba2c2a`; parents are
`c88f589435676743e5a603fce1eac68a6945141e` and
`7a1886aa599a96a9d1fef90769583e7251342aa3`. The merge has the instructed
Bart Roszkowski DCO trailer. Comparing the merge against its parents confirms
R2 risk/composition sources and M14 operations sources/tests are unchanged.
Release-gate bytes equal the predecessor's; no cap was adjusted.

Serial regeneration completed successfully: Platform `api:update`, followed by
`oss:published-tree -- --policy`, then `--policy --docs-update`. Every generated
output is byte-identical to the merged inputs, so this separate regeneration
commit records the result rather than inventing generated changes. The policy
comparison now uses main `80cb0e70`, with nine obligations and zero unanswered.
The pre-merge policy probe used the older HEAD's merge-base and reported one
unanswered configuration obligation; committing the merge restores the actual
main comparison and the existing scoped impact answer without a policy edit.

Focused results for the merge candidate (Node 24.22.1, npm 11.19.1; command logs
and measurement JSON under ignored `.context/scratch/m15-r2-predecessor-merge/`):

| Command | Result |
| --- | --- |
| `npx --no -- ast-grep scan --error=no-suppress-all --error=unused-suppression` | PASS; structural scan used `RAYON_NUM_THREADS=2` |
| `npm run lint` | PASS; zero errors, 33 warnings, all eight structural-rule fixture suites pass |
| `npm run api:check --workspaces --if-present` | PASS for Core, Outbox and Platform; root has no standalone API script |
| `npx --no -- vitest run packages/platform/test/risk --maxWorkers=2` | PASS, 42 tests in five files |
| `npm run packages:check` | FAIL, exactly five Platform size-cap findings; all three packages packed with no other findings |
| `node --experimental-strip-types .context/scratch/m15-r2-predecessor-merge/measure.mjs` | PASS as measurement; all five budget findings reproduced with the existing `measurePack` and `checkPackBudget` functions |
| `git diff --check` | PASS |

The independent Platform tarball integrity equals the official gate's integrity:
`sha512-M2LKdqqc/yAl0uhbNlipnbiQvLQSGuyLoMn4lGL2VVQpy7XZXamsNKXpc63biJ6AVq97oDPu88O+NaPQqlf/yQ==`.
The follow-up evidence changes only this non-packed task record; package inputs
and measurements remain those of the merge candidate.

| Platform metric | Measured | Unchanged cap | Result |
| --- | ---: | ---: | --- |
| Packed bytes | 1,936,088 | 1,925,000 | Exceeds by 11,088 |
| Unpacked bytes | 9,061,171 | 8,970,000 | Exceeds by 91,171 |
| Files | 2,656 | 2,628 | Exceeds by 28 |
| Code gzip bytes | 1,656,903 | 1,648,000 | Exceeds by 8,903 |
| Code files | 2,601 | 2,574 | Exceeds by 27 |
| Docs gzip bytes | 64,499 | 73,728 | Within by 9,229 |
| Docs files | 5 | 10 | Within by 5 |

The requested local integration is complete with the known package gate failure
reported. Full verification, counted review, budget reconciliation and later
delivery remain with the coordinator; no push, waiver or release is claimed.

Self-retro: the single append conflict needed only preservation of both evidence
sections. Existing generators confirmed that no generated-byte repair was
necessary, avoiding manual output edits. The initial policy probe's old base
resolved after the merge commit; retain that distinction when interpreting a
mid-merge policy result. No extra mechanism or successor work was added.

### R2 M14 #400 cascade — 2026-10-27

Current direct local grant and policy pin are recorded in the M14 #400 stack
integration section above; this continuation supersedes prior cap exclusions
only through CD-M15-6a. Merge local R1 `c722a154` into R2, preserving both
architecture additions and complete task histories (the two conflict files).
M14 source comes from main unchanged; R2 runtime remains unchanged. Regenerate
API/navigation and execute the requested focused checks with two workers.
No package-lock delta or reinstall; no push, counted admission or full verify.

R2 integration candidate `73a0e110`: all requested focused checks pass—two-thread
ast-grep, lint (zero errors, 33 warnings), all workspace API checks and 42/42
risk tests in five files with `--maxWorkers=2`. API regeneration and both
documentation policy commands pass with no generated-byte changes. This final
merge adds only R1's non-packed evidence to the checked tree; its sole conflict
is the task record append point, preserving both histories. Package inputs,
runtime and tests are identical to the focused-check candidate. Logs remain in
`.context/scratch/m15-main400/`. Full verify/admission remain deferred.

Self-retro: the shared task record's append point causes evidence-only merge
conflicts; retaining whole sections preserves the audit history with no runtime
repair, helper or new tracking mechanism. No further improvement is justified.

Final R2 policy against the exact new R1 stack base initially refused two stale
delta digests: the M14 merge changed shared ESLint/cold-consumer bytes. Refresh
only the existing scoped no-impact answers in this evidence commit; the risk
architecture still owns the graph and the existing consumer command still owns
these added witnesses. No checker, command, test selection or control changes.

## Approved R3 boundary — 2026-10-27

Outcome: a bounded M03-compatible risk privacy contributor, explicit unavailable
coverage and retained/unresolved obligations under injected policy, with deferred
host-injected portability. The owner's O3 approval is recorded in the coordinator
stack plan; it supplies no retention duration or full managed erasure claim.
This is new integration, not an unchanged donor extraction.

Authority: Bart Roszkowski is accountable. The direct R3 instruction authorizes
read/edit work and small local DCO commits on `claude/oss-m15-r3-risk-privacy`.
No push, PR, merge, release, activation or adopter operation is authorized here.
No test, Vitest, pgTAP, build, install, lint or compiler command may run while the
other machine verification occupies the slot. This direct restriction also
defers documentation policy/generation, package/API generation and all required
pre-commit execution; no verification pass is inferred from static inspection.

Code base: R1 `2e7d70ad25aeea42736394aebbf0e87f0b9a4c79`; the coordinator will
later rebase this author branch onto R2. Policy freshness: fetched `origin/main`
at `ef861a76dad97c0b744f6f25c04b04f4ac44c5fe` on 2026-10-27; AGENTS.md,
CONTRIBUTING.md and AI contribution policy are unchanged from the R1 pin.
No predecessor, other worktree, process or shared output is changed by this run.

Scope: five logical risk resources cover assessments/evidence/subject hashes,
blocklist entries, review cases/hold links, case-event notes/actor links and
idempotency. Native embedded fingerprints and managed replay rows share the
logical replay obligation. Commerce owns hold records themselves. Host read
ports map M03's resolved subject to actual rail-specific links in the shared
transaction, without discovering identity through email equality. Credential
payloads refuse via the existing M03 document validator. Complete resource
policy permits only retention or unresolved; malformed, partial, foreign or
erase declarations remain unresolved. No deletion adapter, SQL, retention period,
new registry, worker or managed capability is introduced.

Exclusions: R2 delegation/admin/workflow/reference-binding files, all M14 files,
installation-chain SQL, default registration and release-set preparation.
The smallest adequate solution uses M03's existing registry/orchestration and
read-only risk ports; a generic erasure engine or transfer framework would add
unsupported behavior. Portability accepts only an opaque host-owned value,
deferred by default, without executing or certifying a future contract.

Acceptance/proof plan: 16 explicit neutral cases (10 contributor cases and six
M03 fit cases) cover missing owners, malformed/incomplete policy, resource
coverage, credential refusal, resolved identity/transaction forwarding,
read-only export, retention, unresolved policy, authorization/subject failure,
managed refusal, rollback, receipt replay and deferred/host-bound portability.
One additional module-boundary case admits only the new public identity-contracts
edge and preserves refusal of identity server/internal and risk browser edges:
**17 explicit new cases** in total. The registry fit is both a compiler assignment
and actual M03 runtime composition.
The rollback witness uses an injected in-memory unit of work: it checks composition,
not SQL atomicity or installed provider permissions. No persistence changes need
a new real-PG witness. All cases remain unexecuted in this authoring run.

### R3 execution and delivery handoff

Shared companions changed additively: the risk server barrel (two exports), four
publication catalogue entries, the package README risk section, the architecture
risk owner section and this existing module record. No package export map,
release gate, API report or R1 fragment is edited. Identity's owner page and the
R3 fragment explain retained-data and managed-erasure limits. API snapshots and
generated navigation must be regenerated by the integrator after serialized
builds are allowed, then reviewed as exact deltas. Publication catalogue rows
are authored here; source-release digests remain S1's responsibility.
The preliminary source review additionally required a one-item additive
`identity/contracts` edge in `eslint.config.js` and one bounded witness in
`scripts/packages/eslint-import-map.test.ts`. This represents R3's approved M03
dependency, like the existing marketing contributor edge; it grants no identity
server/internal or browser imports. The architecture boundary inventory is
updated with it. Those shared companions are explicitly part of the handoff.

Run later from this worktree after the machine slot is granted and after the
coordinator establishes the exact R2 predecessor:

```sh
export OPENLUP_STACK_BASE=<full-R2-predecessor-SHA>
npx --no -- ast-grep scan --error=no-suppress-all --error=unused-suppression
npm run oss:published-tree -- --policy
npm --workspace @openlup/platform run api:update
npm run lint
npx --no -- tsc -p tsconfig.node.json
npx --no -- tsc -p tsconfig.api.json
npx --no -- tsc --ignoreConfig --noEmit --skipLibCheck --strict --module NodeNext --moduleResolution NodeNext --target ES2022 --esModuleInterop --resolveJsonModule --allowImportingTsExtensions packages/platform/test/risk/privacyContributor.test.ts packages/platform/test/risk/privacyPortFit.test.ts
npx --no -- vitest run packages/platform/test/risk --maxWorkers=2
npx --no -- vitest run packages/platform/test/identity/privacyContracts.test.ts packages/platform/test/identity/privacyHandlers.test.ts --maxWorkers=2
npm --workspace @openlup/platform run api:check
npm run packages:check
npx --no -- vitest run packages/platform/test/packageBoundary.test.ts scripts/packages/eslint-import-map.test.ts scripts/packages/package-manifest-policy.test.ts scripts/packages/package-size-policy.test.ts scripts/packages/package-tarball-gate.test.ts --maxWorkers=2
npm run oss:published-tree -- --policy --docs-update
git diff --check
npm run check:dco-signoff -- "$OPENLUP_STACK_BASE" HEAD
```

The integrator owns any generated snapshot/owner-impact follow-up, actual pack
measurement against M14 growth, full official verify-local, two counted sensitive
reviews and eventual authorized draft delivery. Preliminary read-only feedback
does not establish counted admission, evidence expiry or a verification stamp.
No review budget or session history is reset here.

Fit-report adjustments: the direct task expressly excludes R2's reference binding,
so registration is demonstrated through M03's registry rather than modifying that
binding. Retention is the only resolved disposition; implementing deletion of
audit/replay facts would exceed O3. Production code is smaller than the forecast
because M03 already owns authorization, transactions and receipt replay. Generated
companions and execution evidence are deferred by the machine restriction.

Open integration questions: the host must supply its actual rail-specific subject
mapping, grants, retention policy and later portability contract. Those are
deliberately injected deployment decisions, not defaults for R3 to invent.

Self-retro: source inspection found that logical replay ownership must include
native embedded fingerprints as well as managed replay rows. One logical resource
avoids a rail-specific registry without losing that obligation. No formal rethink
or added persistent mechanism was needed. Verification delay is imposed by the
shared machine slot; no execution timing or PASS is claimed.

### Preliminary source review and repair

Implementation commits: `a38eddc3` (bounded contributor and owner explanations),
`dd83f9bc` (16 privacy cases, catalogue and task record), all with instructed
human DCO sign-off. Two independent fresh-context read-only reviewers inspected
`dd83f9bcaf2253d93cd643b6e0ec4e0b0f693e9a` against the R1 base. Neither ran
tests, build, lint, compilers or verification scripts. Both independently found
the undeclared identity-contracts graph edge (canonical card `R3-REV1`; the second
report named the same mechanism `R3-REVIEW-2-1`). One also found `R3-REV2`:
a runtime null result from a bound reader bypassed malformed-inventory refusal.

Repair commit `f319d6f5f0a3d2877a53a20a18a364dadf37927b` declares only the public
contracts edge with a new focused admission/
refusal case, and validates inventories whenever a reader is bound. The existing
coverage case now includes a runtime null regression. Two new independent
fresh-context read-only reviewers (`r3_repaired_one`, `r3_repaired_two`) inspected
that complete committed candidate against the R1 base. Both returned preliminary
source PASS, explicitly closing `R3-REV1` / `R3-REVIEW-2-1` and `R3-REV2`, with no
remaining material finding. Both considered the direct ports and existing M03
orchestration the smallest adequate solution. Neither ran any restricted command.
Execution is still deferred. One preliminary repair iteration is recorded, without creating or
resetting a native admission session or its counters/expiry.

Final authoring evidence: `git diff --check` passes for the complete R3 range;
the three implementation/test/repair commits carry the instructed human
`Signed-off-by` trailer. The final evidence-only documentation commit adds these
observations; it does not change the source candidate reviewed above. No API,
compiler, test, lint, pack, documentation-policy or official verify PASS is claimed.
No push or pull request was attempted. The authoring endpoint is locally committed
source and tests, with exact deferred commands above, awaiting R2 integration.

Review lesson: a newly reused public contract still needs its explicit module
edge; read the existing graph alongside the import. A bound adapter's malformed
null result must not share the fallback for an absent adapter. Both repairs use
existing controls and add no new mechanism; no regroup condition was reached.

### R3 local rebase handoff — 2026-10-27

The owner's direct instruction authorized rebasing the four R3 commits from R1
onto local R2 `c88f589435676743e5a603fce1eac68a6945141e`, with local conflict
resolution only. That integration is complete. The six conflicted files were the
architecture page, package README, risk server barrel, publication catalogue,
module record and ESLint graph. Both rounds' additions are retained; the graph
combines R2's schema/HTTP/BFF edges with R3's public identity-contracts edge.
R2's reference binding, admin binding and composition implementation are unchanged.
Original commit identities above remain historical review provenance.

Git range comparison and whitespace checks are the only new evidence. All four
commits retain DCO trailers; no restricted verification command ran. The existing
deferred verification and review obligations remain open. The existing policy pin
is retained; policy freshness was not refreshed during this local-only rebase.

Self-retro: Git split the module-record conflict around a shared command suffix;
appending the complete R3 section after the intact R2 record preserved both command
ledgers without interleaving them. No behavioral edit or new mechanism was needed.

### R3 serialized verification continuation — 2026-10-27

The owner's direct continuation lifts the earlier machine-slot restriction for
this worktree and authorizes the deferred generators, focused tests, compilers,
lint, API and package checks, in-scope repairs and local DCO commits only. Run
serially with Vitest `--maxWorkers=2`. R2 reference binding, donor behavior and
all M14 files remain excluded; no push or external delivery is authorized.
The R2 stack base is `c88f589435676743e5a603fce1eac68a6945141e`.
Freshly fetched `origin/main` remains
`ef861a76dad97c0b744f6f25c04b04f4ac44c5fe`; the applicable policy files have no
delta from the retained instruction pin. Earlier preliminary reviews and their
one repair iteration remain historical evidence, without a native admission or
verification stamp. Full root verification/coverage, counted native review and
the programme discovery-budget decision remain coordinator-owned.

Execution repairs within R3:

- The first platform `api:update` failed with missing `@openlup/core` built
  declarations. `npm run pretest` built the installed workspace prerequisites;
  generation then passed. No dependency or donor change was needed.
- The first boundary/policy batch passed 2,745 cases and failed two: the R3
  import-map assertion still expected the pre-R2 graph, and Platform had 2,523
  code files against 2,520. The assertion now includes the intact R2 edges.
  Moving the tiny privacy binding factory into `privacyContributor.ts` removes
  three packed code files (source, JavaScript and declaration), with the same
  public barrel exports and opaque/deferred portability behavior. No cap changed.
- The focused strict compiler exposed Vitest's generic `vi.fn` return-type
  loss in the new M03 unit-of-work fixture. A spy on the normally typed method
  preserves its generic signature and the existing assertions; the compiler
  and all risk cases then passed. Production behavior is unchanged.

| Command | Result |
| --- | --- |
| `npm run pretest` | PASS, prerequisite Core/Outbox/Platform builds, serially |
| `npm --workspace @openlup/platform run api:update` | Initial prerequisite failure above; PASS after builds and again after consolidation; only `risk-server.api.md` changes, +311 lines |
| `npx --no -- vitest run packages/platform/test/risk --maxWorkers=2` | PASS, seven files / 58 cases; repeated after the binding move and fixture repair, 526 ms final wall time |
| `npx --no -- vitest run packages/platform/test/identity/privacyContracts.test.ts packages/platform/test/identity/privacyHandlers.test.ts --maxWorkers=2` | PASS, two files / eight cases, 147 ms wall time |
| `npx --no -- vitest run packages/platform/test/packageBoundary.test.ts scripts/packages/eslint-import-map.test.ts scripts/packages/package-manifest-policy.test.ts scripts/packages/package-size-policy.test.ts scripts/packages/package-tarball-gate.test.ts --maxWorkers=2` | Initial two failures above; PASS after repair, five files / 2,744 cases, 11.34 s wall time |
| `npx --no -- tsc -p tsconfig.node.json` | PASS |
| `npx --no -- tsc -p tsconfig.api.json` | PASS |
| `npx --no -- tsc --ignoreConfig --noEmit --skipLibCheck --strict --module NodeNext --moduleResolution NodeNext --target ES2022 --esModuleInterop --resolveJsonModule --allowImportingTsExtensions packages/platform/test/risk/privacyContributor.test.ts packages/platform/test/risk/privacyPortFit.test.ts` | Initial fixture error above; PASS after the typed-method spy |
| `npm run lint` | PASS before and after the fixture repair; zero errors / 33 existing warnings, eight structural-rule fixture suites pass |
| `npx --no -- ast-grep scan --error=no-suppress-all --error=unused-suppression` | PASS after each repair |
| `npm --workspace @openlup/platform run api:check` | PASS, all declared Platform surfaces |
| `npx --no -- vitest list packages/platform/test/risk tests/postgres/riskControl.conformance.test.ts server/runtime/public-reference/m15RiskBinding.test.ts src/public-reference/riskReviewRoutes.test.tsx scripts/packages/platform-cold-consumer.test.ts packages/platform/test/packageBoundary.test.ts scripts/packages/eslint-import-map.test.ts --maxWorkers=2 --json` | PASS; 2,850 selected discovered cases, retained in ignored `.context/scratch/m15-r3/discovery.json`; discovery only does not claim execution of SQL/cold-consumer suites |

Current discovery has 10 contributor and six M03 fit cases, one import-map case,
and three existing per-source boundary instances for the single added production
file: **R3 +20**. The boundary/import-map pair is now 2,675 cases versus R2's
2,671. With recorded **R1 +77** and **R2 +44**, the combined increase is
**+141**, exceeding the unchanged +100 programme allowance by **41**. The
binding consolidation reduced R3 discovery by three generated boundary instances,
without removing an explicit behavior or refusal case. This local timing is not
comparable hosted evidence and approves no budget exception.

Documentation policy initially refused the two missing repository/tooling impact
answers. Scoped no-impact trailers accompany this repair commit: the approved
identity-contracts edge and its R2-compatible witness change no check invocation,
loader syntax/path coverage or refusal contract; the architecture risk owner
already explains the new dependency. During consolidation one policy attempt
failed reading the unstaged deleted source; staging that deletion and catalogue
delta restored normal evaluation. Both policy/generation commands must pass with
the committed trailers; generated navigation has no byte delta. Official package
measurement follows the committed package candidate and is recorded below.

### R3 committed artifact evidence and local endpoint

Execution candidate: `4a7a0b18568b81d08171afd0e6be58653f77b171`
(`fix(risk): complete privacy integration proof (M15 R3)`). All package inputs
are committed and clean. The following evidence-only commit changes this task
record outside every package, so it does not change the measured package bytes.

| Command | Result |
| --- | --- |
| `npm run oss:published-tree -- --policy` | PASS after the scoped impact trailers; three obligations, zero unanswered |
| `npm run oss:published-tree -- --policy --docs-update` | PASS after the trailers; navigation regenerated with no byte delta |
| `npm run packages:check -- --out .context/scratch/m15-r3/artifacts` | PASS, three packages, no findings; actual tarballs and producer manifest retained in ignored evidence, bound to the execution candidate |
| `node --experimental-strip-types .context/scratch/m15-r3/measure.mjs .context/scratch/m15-r3/artifacts` | PASS; manifest SHA-256 checks, existing `measurePack`/`checkPackBudget` on extracted official tarballs, and all 16 built Platform browser-entry measurements; zero findings, JSON retained in ignored evidence |
| `git diff --check c88f589435676743e5a603fce1eac68a6945141e HEAD` | PASS for the complete R3 range; working/index whitespace checks also pass |
| `npm run check:dco-signoff -- c88f589435676743e5a603fce1eac68a6945141e 4a7a0b18568b81d08171afd0e6be58653f77b171` | PASS, all five R3 commits through the execution candidate signed off; the final evidence commit is checked with its full endpoint too |

Actual artifact values below are measured/cap. No cap, timeout, skip, release
gate, version, donor implementation, R2 reference binding or M14 file changed.

| Metric | Core | Outbox | Platform |
| --- | ---: | ---: | ---: |
| Packed bytes | 167,341 / 327,680 | 39,165 / 81,920 | 1,901,652 / 1,925,000 |
| Unpacked bytes | 712,626 / 1,392,640 | 133,216 / 266,240 | 8,907,429 / 8,970,000 |
| Files | 224 / 420 | 41 / 90 | 2,574 / 2,580 |
| Code gzip bytes | 143,737 / 276,480 | 20,930 / 43,008 | 1,627,904 / 1,648,000 |
| Code files | 213 / 400 | 33 / 70 | 2,520 / 2,520 |
| Docs gzip bytes | 17,213 / 49,152 | 13,216 / 26,624 | 64,157 / 73,728 |
| Docs files | 10 / 20 | 6 / 12 | 5 / 10 |

`risk/contracts` remains 20 / 32 minified gzip bytes. All other browser entries
fit their existing limits; the detailed ignored measurement records each value.
Relative to recorded R2, Platform adds 2,897 packed bytes, 16,586 unpacked bytes,
three files, 4,058 code gzip bytes, three code files and 188 docs gzip bytes.
Remaining Platform headroom is 23,348 packed bytes, 62,571 unpacked bytes, six
total files, 20,096 code gzip bytes, **zero code files**, 9,571 docs gzip bytes
and five docs files. This reserves no M14 headroom.

Remaining issues and delivery boundary: focused R3 execution is green. The
combined +141 discovery increase still needs the coordinator's finite budget
decision (+41 above the unchanged allowance) and comparable hosted timing.
Full root verification/coverage and counted independent sensitive review of the
current committed tree remain open at the coordinator endpoint. Earlier
preliminary source reviews are historical, not current native admission.
Policy still reports the pre-existing committed binding snapshot stale and
reserves its refresh for release preparation; computed bindings and policy pass.
Deployment-specific subject mapping, grants, retention and future portability
remain injected host responsibilities. No full managed erasure, retention period,
release preparation, push, PR, merge, release or adopter operation is claimed.

Self-retro: executable proof found a stale post-rebase expectation, a generic
mock typing defect and a three-code-file budget excess that static reviews had
missed. The smallest repair colocates the existing binding factory rather than
raising a cap, and a typed-method spy avoids an unsafe assertion. Reading the
focused compiler result before starting broad lint would have avoided one
redundant lint pass. Lesson: generic orchestration fixtures need their strict
compiler witness; packed file budgets should shape a small module's physical
layout. No formal regroup condition was reached and no successor work is opened.

### R3 predecessor integration — 2026-10-27

Direct maintainer instruction authorizes merging local predecessor
`claude/oss-m15-r2-risk-reference-delegation` at
`9aeed14510ca4dda57b258a62ed560e6433b5728` into this R3 branch, resolving
conflicts while preserving M14, predecessor M15 and R3 intent, serial generation,
focused checks with two workers, and separate DCO-signed merge/regeneration
commits. Bart Roszkowski remains accountable. No push, rebase, force operation,
cap change, release or external delivery is authorized by this continuation.
Full verification, counted review and budget reconciliation remain coordinator
work; the requested local endpoint reports known cap failures without a waiver.

Freshly fetched policy main is `80cb0e7063206a9fead36b4e6680c9a83fa3e108`,
also the merged candidate's fork point. The current contribution-policy delta
adds M14 proof/inventory guidance and review lessons; both modules' guidance is
preserved. Merge commit `afdbdccdd7ac7505c79b7aa69c2cf59c028e21b8` has parents
`fd504e9d4b9935099d21034880bc99a7b25729f5` and the predecessor above, with the
instructed DCO sign-off. The only conflict was this record's append point:
retain the predecessor's entire R2 integration record before the entire R3
history. All 16 risk source files and seven risk test files equal pre-merge R3;
all 28 operations source files and 14 operations test files equal the predecessor.
Release-gate bytes equal the predecessor exactly, including every existing cap.

Platform `api:update`, then `oss:published-tree -- --policy`, then
`--policy --docs-update` passed. Generated outputs are byte-identical to the
merged inputs; this separate regeneration commit records that result rather
than editing generated bytes. Policy reports nine obligations, zero unanswered;
the pre-existing committed binding snapshot remains stale with refresh reserved
for release preparation, while computed bindings and the policy check pass.

Evidence is retained under ignored `.context/scratch/m15-r3-predecessor-merge/`.
Execution used Node 24.22.1 and npm 11.19.1, with `RAYON_NUM_THREADS=2` and
`VITEST_MAX_WORKERS=2` / `OPENLUP_VITEST_MAX_WORKERS=2` on the focused checks.

| Command | Result |
| --- | --- |
| `npx --no -- ast-grep scan --error=no-suppress-all --error=unused-suppression` | PASS, including the explicit two-thread scan |
| `npm run lint` | PASS, eight structural-rule fixture suites; zero errors / 33 warnings |
| `npm run api:check --workspaces --if-present` | PASS for Core, Outbox and Platform; root has no standalone `api:check` script |
| `npx --no -- vitest run packages/platform/test/risk --maxWorkers=2` | PASS, seven files / 58 tests, 1.05 seconds |
| `npm run packages:check` | FAIL, exactly five Platform size-cap findings; all three packages packed, no other findings |
| `node --experimental-strip-types .context/scratch/m15-r3-predecessor-merge/measure.mjs` | PASS as measurement; existing `measurePack` / `checkPackBudget` reproduce the same five findings |
| `git diff --check` | PASS |

The independently measured tarball matches the official gate's integrity:
`sha512-ILXL35zSRznICDetZq4Mw16GJ6ANML1mjKXpVbYXS4zP+s4bRlWUuhb2r16mXkHmlPvWSUxFah10kOQ9xJXPTg==`.
Measurements bind the merge commit; this follow-up only changes the non-packed
task record, leaving every package input unchanged.

| Platform metric | Measured | Unchanged cap | Result |
| --- | ---: | ---: | --- |
| Packed bytes | 1,939,078 | 1,925,000 | Exceeds by 14,078 |
| Unpacked bytes | 9,077,757 | 8,970,000 | Exceeds by 107,757 |
| Files | 2,659 | 2,628 | Exceeds by 31 |
| Code gzip bytes | 1,660,986 | 1,648,000 | Exceeds by 12,986 |
| Code files | 2,604 | 2,574 | Exceeds by 30 |
| Docs gzip bytes | 64,685 | 73,728 | Within by 9,043 |
| Docs files | 5 | 10 | Within by 5 |

Self-retro: preserving both append-only evidence sections resolved the sole
conflict without touching source behavior. Regeneration required no byte changes;
reusing the existing measurement functions and matching official tarball
integrity supplied exact evidence without changing caps or adding a mechanism.
No useful further process change or successor work was identified.

### R3 M14 #400 cascade — 2026-10-27

Direct local grant and current instruction pin are recorded in the M14 #400
stack integration section above. Merge local R2 `764f4664` into R3 without
rebasing or pushing. Two conflict files: architecture and this task record;
preserve R3 privacy and all predecessor/M14 text. M14 transfer sources remain
main's exact bytes; R3 risk behavior remains unchanged. Regenerate API/navigation,
run the requested focused checks with two workers, then commit before the
package gate and measure the retained full-stack tarball against every cap.
CD-M15-6a is conditional on actual exceeded caps. No package-lock delta or
reinstall. Full verify, counted native review and delivery stay with coordinator.

R3 focused results on merge candidate `aefb4bd0`: two-thread ast-grep, lint
(zero errors, 33 warnings), all three workspace API checks and 58/58 risk tests
in seven files with `--maxWorkers=2` pass. All-workspace API regeneration and
both documentation commands pass without generated-byte changes. The official
package check retains all three tarballs and reports no findings. Existing
`measurePack` reads that exact platform artifact, with integrity
`sha512-REDiP1ng4Co1SxDBD9O//zVdZRmFqKqsp9MWzwdKi3R1V6l9sCIqA8uf/CfPwmi2ZIIg+3MnHaPpSc8d91fsTw==`.

| Full-stack platform metric | Measured | Cap | Headroom |
| --- | ---: | ---: | ---: |
| Packed bytes | 1,955,117 | 1,980,000 | 24,883 |
| Unpacked bytes | 9,141,753 | 9,260,000 | 118,247 |
| Files | 2,671 | 2,712 | 41 |
| Code gzip bytes | 1,675,879 | 1,695,000 | 19,121 |
| Code files | 2,616 | 2,656 | 40 |
| Docs gzip bytes | 65,550 | 73,728 | 8,178 |
| Docs files | 5 | 10 | 5 |

Every metric is within its cap. CD-M15-6a is therefore not triggered: no cap
changes or 102% rounding are applied, and CD-M15-6's recorded reason remains
historical evidence. A final evidence-only merge imports R2's refreshed
delta-bound documentation answers and preserves both task append sections;
all package inputs equal `aefb4bd0`, so the measurements and focused checks
remain applicable. Final documentation checks use each exact local predecessor
as `OPENLUP_STACK_BASE`. No lockfile, dependency, version, runtime behavior,
SQL, timeout or test selection changed. No push or external delivery occurred.

Self-retro: checking the explicit new predecessor exposed stale documentation
impact digests hidden by a main-relative comparison. Refreshing the existing
scoped answers preserves their meaning without editing unrelated guidance.
The retained official tarball supplies full-stack measurements directly; no
cap raise or additional test mechanism was needed. Local integration review
reports are retained with this run's ignored scratch evidence; counted native
review, full verify and later delivery remain coordinator obligations.

Explicit-stack documentation checks also required R3's two existing no-impact
answers to be refreshed for the merged shared-file bytes. This merge carries
the scoped graph/refusal explanations; no guidance contract changes. A probe
against the incoming R2 head before committing correctly refused that head as
not yet an ancestor; final validation uses the committed merge and exact R2.
