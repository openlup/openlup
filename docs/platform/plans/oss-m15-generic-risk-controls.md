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
