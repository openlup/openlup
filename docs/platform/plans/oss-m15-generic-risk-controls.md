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
