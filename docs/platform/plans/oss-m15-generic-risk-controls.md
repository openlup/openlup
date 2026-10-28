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

### M14 #401 / #406 local stack maintenance — 2026-10-27

Direct maintainer continuation authorizes local non-fast-forward DCO-signed
merges main → R1 → R2 → R3, regeneration, focused checks with two workers,
and package checks in R1/R3. No rebase, force-push, push, full verify, counted
admission, activation or release. Existing draft endpoint remains unchanged.
Current main/policy pin: `35ee4227babaa2fe16f88110af52e61d242b3296`;
the code review base remains separate. Current CONTRIBUTING additions cover
lifecycle proof, archive traversal and tmpfs PostgreSQL fixtures; prior task
history and review budgets remain intact.

R1 has three conflict files: architecture, package exports and release gates.
Retain both complete lifecycle/risk sections and registrations; M14 lifecycle
and tmpfs source/test bytes remain main's exact bytes and risk source/test
bytes remain R1's. Per-cap maxima give packed 2,029,568, unpacked 9,447,424,
files 2,712, code gzip 1,743,872 and code files 2,656; docs/browser caps stay
unchanged. These are parent reconciliation, separate from conditional
CD-M15-6a, which applies only to an exceeded measured full-stack cap.
No lockfile delta, so no reinstall. Smallest adequate solution: preserve the
existing registrations and regenerate outputs without a new runtime mechanism.
Logs and retained package artifacts: `.context/scratch/m15-main406/` per tree.

R1 candidate `22725549`: API regeneration and both documentation commands pass
with no generated-byte delta. Final post-merge policy uses the current main pin
and has five obligations, zero unanswered. Two-thread ast-grep, lint (zero
errors, 33 warnings), all workspace API checks, 23/23 risk tests (four files,
`--maxWorkers=2`), `git diff --check`, and official `packages:check` pass.
Root has no standalone API script; the supported workspace API commands run
Core, Outbox and Platform. Package artifacts and exact measurements are retained
in the scratch directory above. No lockfile or dependency changes occurred.

Self-retro: the parent maxima preserve M14's byte allocation and M15's file
allocation. Existing generators produced identical output; no additional
mechanism or unrelated repair was needed. Package preparation is serialized
with API/lint builds to avoid sharing mutable outputs.

Local integration review found that the published README still described R1's
old byte caps after parent-max reconciliation. Correct its current numbers and
the pending R1 fragment while retaining the original CD-M15-6 measurement and
reason as historical evidence. No gate values or runtime bytes change. Cascade
the signed documentation repair and refresh official package artifacts.

### M14 current-main stack maintenance — 2026-10-27

Direct maintainer grant: merge main into R1, then R1 into R2 and R2 into R3
using local non-fast-forward DCO commits; preserve both modules, regenerate,
and execute the requested focused checks with two workers and package checks
in R1/R3. No rebase, force-push, push or external mutation. Conditional
CD-M15-6a permits only exceeded full-stack caps at 102%, bytes rounded up to
5,000 and files to an integer, applied first in R1 and cascaded. Full verify,
counted native admission, activation and release remain outside this run.

Fetched main and instruction freshness pin:
`c1ca9994a8e833111e06fd7b280a6bd97c79e7ab`; code review base remains separate.
Current instructions add migration-session admission, scheduler-drain and
qualified-installation witnesses. Existing task/review history remains intact.
R1's sole conflict is publication catalogue registration: preserve both M14's
runtime-drain task page and M15's risk task page. Main's M14 source and API
changes remain authoritative; risk source is preserved. Every numeric cap
is checked against the maximum of both parents; no value changes. Lockfile
is unchanged, so no npm ci. The smallest adequate resolution is the existing
registration union and generators, without a helper or runtime edit.
Logs and retained artifacts use `.context/scratch/m15-main-current/` per tree.

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

### R2 lifecycle/tmpfs cascade — 2026-10-27

Continue the direct local grant above by merging R1 `c9f6978e` into R2.
Two conflict files: retain R2 risk delegation before M14 lifecycle architecture,
and retain complete predecessor and R2 task histories. M14 source/test files
and inherited caps come unchanged from R1; R2 risk/composition behavior is
unchanged. No lockfile delta or reinstall. Regenerate and run requested focused
checks with two workers; logs use `.context/scratch/m15-main406/`.

R2 candidate `a2923b45`: API/navigation regeneration, both documentation
commands, two-thread ast-grep, lint (zero errors, 33 warnings), all workspace
API checks and 42/42 risk tests in five files with `--maxWorkers=2` pass.
The explicit new R1-base policy correctly detects two expired fingerprints
for the merged ESLint and cold-consumer delta. Refresh the existing scoped
repository/tooling explanations in this normal signed evidence commit; their
meaning is unchanged and the checker is unchanged. No package input changes.

Self-retro: checking the exact predecessor catches stale scoped documentation
evidence that a main-relative check can mask. Preserve complete task append
sections and renew only the changed fingerprints; no new mechanism is needed.

### R2 current-main cascade — 2026-10-27

Merge R1 `2319e024` into R2 under the current local grant above. The sole
conflict is this task record's append point; preserve complete R1 and R2
histories. Source, exports, APIs and caps merge without conflict. Lockfile
unchanged; no install. Regenerate and run focused checks serially, with
two Vitest workers and exact predecessor documentation comparison.
### M14 qualification and 0.30.0 stack maintenance — 2026-10-28

Direct maintainer continuation: maintain the existing R1/R2/R3 draft stack by
local `--no-ff` merges, generated-output reconciliation and focused checks with
two Vitest workers; package checks in R1/R3. No rebase, force-push, push, remote
PR mutation, arming, activation or release. CD-M15-6a applies only if a measured
full-stack platform cap is exceeded: 102% rounded up to 5,000 bytes or one file,
first in R1, then cascaded. Existing review history and budgets are retained;
full verify and counted review remain later coordinator obligations.

Freshly fetched main/instruction pin:
`fea0854a1a5a27c1a48f8c2c9078c618f47f66a3`; the code review base is separate.
The relevant instruction delta documents qualified-runtime proof and its review
lessons. R1 starts at `2319e024`; R2 at `727280a4`; R3 at `60b0cfb8`.
Main merges into R1 without textual conflicts. Preserve M14 qualification,
installation inventories, 0.30.0 versions and released changelog history; retain
M15 risk source, exports, witnesses and pending fragments. All platform numeric
caps equal the maximum of their parent values, with no cap adjustment yet.
The lockfile changes for the released set, so run `npm ci` in each tree.
Regenerate APIs and navigation through existing commands; no runtime edit or
new mechanism is needed. Evidence is retained per tree under ignored
`.context/scratch/m15-main-fea0854a/`. Completion results and self-retro follow
in this existing record after the final full-stack measurement.

### R2 qualification/release cascade — 2026-10-28

Merge local R1 `3d32517c` under the direct local grant above. Resolve only the
task-record append conflict by preserving the complete R1 and R2 sections.
M14 source/release metadata and R2 risk delegation remain intact. The changed
lockfile requires npm ci. Regenerate with the existing commands, run the
requested focused checks with two workers, and commit with DCO sign-off.
Exact-predecessor policy runs after the merge commit establishes ancestry.
