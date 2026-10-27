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
