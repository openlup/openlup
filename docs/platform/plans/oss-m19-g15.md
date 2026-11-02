# Application upgrade and diagnosis tooling

Status: first committed candidate received two failing native reviews for one
exit-classification defect. The staged repair below awaits its required fresh
maintainer read before DCO; native closure and canonical verification remain pending.

## Finite outcome and authority

Deliver one `openlup` bin in `@openlup/platform` for application-file upgrade
plan/apply and the composed application's one diagnosis command. Extension-kit,
starter and deployment work belong to other workers and are excluded. No engine
behavior, SQL migration, provider execution or application activation changes.

The G15 worker operates under the distribution supervisor and programme lead.
Bart Roszkowski is the accountable human. The accepted programme delegates local
work, DCO commits, submission, receipts and merge through existing gates in the
lead's order. No publication, release dispatch, tags, hosted resources, costs,
credentials, settings or production grant exists. The stabilized API, npm bin
and publication-data changes received the designated maintainer read before the
first DCO commit, conditional on the bounded proof repair below. A later change
to the accepted bin requires another read before its repair commit. Two
independent fresh reviewers assess every signed candidate. Canonical
verification waits for the lead to name this PR next to land; focused work uses
its own shared admission gate. No native review cycle or queue retry is consumed.

Worktree `oss-m19-g15`, branch `codex/oss-m19-g15`. Code and current policy base:
`bb0008481a11267ec6dbe3e7e531299777cddc19`, freshly recovered from `origin/main`
on 2026-11-01. Ordinary Git worktree isolation was used because no configured
helper was available. The other distribution worktrees remain untouched.

The later direct scope grant permits the bin's npm-generated lock metadata, one
package README link, and one additive bin documentation-owner row. The separate
publication-data grant permits only the matching platform scripts/bin digest and
one exact executable registration; no check logic changes. Paths outside the
original programme list are `package-lock.json`, `config/doc-routing.json`,
`scripts/oss-publication-policy.ts` and `scripts/oss-publication-contract.ts`.
Shared files contain only task-owned additions or the exact required digest and
lifecycle export-assertion update. No numeric release budget changes.

## Stabilized proposal and smallest adequate scope

Bin: `openlup` → `packages/platform/src/lifecycle/openlup.mjs`. The tool-only
executable lives in the existing lifecycle module so the platform source root
continues to contain only module directories. It imports the compiled public
lifecycle entry by package name; no launcher, new module, graph exception or
additional tarball allowance is introduced. One exact-file owner row routes
this bin to the canonical CLI contract.

The existing lifecycle entry adds `verifyApp`, `APP_VERIFICATION_BOUNDARY` and
its report/finding types. Diagnosis delegates to the existing `checkReadiness`
using application-owned contributions, bindings and schema observer. No second
module catalogue or diagnosis command is introduced. Findings state observed
facts, cause, fix, recheck and declared/bound/checked/unknown evidence. Ports and
routes sharing a subject report their respective binding facts separately.

Upgrade delegates to the existing `planAppUpgrade` and `applyAppUpgrade`.
Snapshots supply exact UTF-8 managed bytes and compatible schema ordinals;
unlisted files remain application-owned and upstream-unchanged local edits are
preserved. Apply checks all conflicts before writing and resumes exact completed
bytes. It needs exclusive access; a whole upgrade is not atomic and concurrent
hostile filesystem mutation is outside this contract. No SQL, install, deploy,
version marker or upgrade hook runs.

Verify loads no application implicitly. Explicit `--app` trusts a module
exporting `createVerificationInput()`. It must reuse actual composition facts,
keep stdout clean, avoid host/effect startup and close its read-only observer
resources. The CLI provides no sandbox or proof of binding honesty. Only the
supplied schema observer runs; catalog presence does not prove SQL bodies,
privileges, provider delivery or a live timer. JSON format version is 1; exit
codes are 0 complete/satisfied, 1 unsatisfied/conflict, 2 unknown, 64 invalid
invocation/JSON and 74 operation/loading failure. Raw application errors are
withheld; operation failure can follow a partial file upgrade.

## Acceptance and sufficient executed evidence

| Boundary | Discriminating proof and result |
| --- | --- |
| Report correctness | Package-local diagnosis file: 3 cases PASS, including colliding port/route names, declaration-only bindings, unavailable and wrong-database observations, repair to ready and no route/job execution |
| Installed CLI | Actual npm-created executable in a disposable consumer; help, invalid input, missing app, unknown, text/JSON findings, exact repair keys and recheck commands PASS |
| Real-version upgrade | Integrity-pinned published platform/core pairs 0.35.0 and 0.36.0; the app executes each platform's public lifecycle entry with coherent peer pins. Divergent later-sorted file refuses before every write; actual SIGKILL after the first rename, exact resume, startup refusal of partial state and local theme/policy preservation PASS |
| Real schema diagnosis | Existing core schema probe over an owned PostgreSQL 17 fixture in a read-only transaction: stale migration identity, missing table, binder and schedule detected. Applying the report-named fixture migration and fixing bindings reaches ready; PASS |
| Artifact identity | Working-tree pack content matches materialized package source/derived-file rules; no findings. This is preliminary evidence, not final committed-candidate install proof |

These assertions are wired into the existing required platform cold-consumer
path and invoke no model. The fixture harness prepares archives, dependencies
and database repairs; the CLI never performs those setup actions. Published
archive unavailability or integrity mismatch fails the proof, with no synthetic
or workspace substitute. This is file/entrypoint proof, not a complete store,
database-version upgrade, provider certification or independent-adopter result.

## Checks, measurements and remaining gates

Pinned Node 24.21.0/npm 11.19.0 asserted. `npm ci` passed. Final `npm run lint`
(including all three prerequisite builds) passed with zero errors and 33 existing
warnings. Structural scan passed. Public typecheck passed all five projects with
zero unresolved edges and zero consumer errors. Generated lifecycle API snapshot
and API check passed; no other package API report changed.

Real repaired platform working pack: 2,112,963 packed bytes, 9,837,138 unpacked bytes,
2,844 files. Against integrity-verified published 0.36.0 (2,104,577 packed bytes,
9,809,502 unpacked bytes, 2,840 files): +8,386 packed bytes, +27,636 unpacked bytes,
+4 files. Existing code/docs/total size and file caps all pass. No cap raise.

The maintainer accepted the read candidate tree
`8669a23104f35015869305785d91a839f9353004`, with only the registry reliability
repair required before sign-off. The post-repair source snapshot, before updating
this task-record evidence, is tree
`e0b72951382dbf56e86dd334b3e6abb90fed99f5`. It includes the original task-record
blob; it is not a self-reference to this record's final tree. That first post-read
repair changed only `scripts/packages/distribution-cli-proof.ts` and this evidence
record. The later exit repair below also changes the bin. Final candidate
identities belong in the checkpoint, avoiding a self-referential task hash.

The proof now makes at most two attempts per immutable archive, each with a
60-second fetch/body deadline and a 195-second enclosing process limit. The one
retry honors seconds or HTTP-date `Retry-After`; its wait is bounded at 60 seconds.
A longer requested wait refuses with an explicit budget error rather than
retrying early. Without a valid header, the retry delay is one second. HTTP 429,
402/403 and 503 with a retry header produce a named quota error distinct from
unavailable. No mirror or synthetic substitute. Load-sensitive CLI, archive
extraction, application startup and SQL-harness children now allow 60 seconds;
existing outer verification budgets and release caps are unchanged.

Post-repair scratch regression: 11 deterministic cases of the exact emitted
fetch code pass, including network/body failure, numeric/date Retry-After,
quota versus unavailable, two-attempt bound and excessive retry-delay refusal.
The installed real-version CLI and actual PostgreSQL proof pass again. The
three package diagnosis cases pass again. At that stage the code under `packages/platform` was byte-identical to the
accepted tree. The later bin repair below adds 31 packed and 107 unpacked bytes
to that measurement; the current re-measured totals are above.

Policy/navigation was regenerated on the would-be committed set. Ownership,
repository and tooling obligations use exact delta-bound no-impact commit
trailers: the additive owner route follows existing rules; the lockfile only
records the bin; required contribution commands, outer budgets and publication
check logic remain unchanged. Canonical CLI guidance and the package link explain
the new surface. The tooling digest was recomputed after the proof repair. The
signed change must actually pass policy before native review; an unrecorded
trailer is not a PASS.

PR-body text prepared for later authorized submission:

> The real-version proof depends on registry.npmjs.org for SHA-512-pinned
> @openlup/platform and @openlup/core archives at 0.35.0 and 0.36.0 (about 2 MB
> per platform archive plus the smaller core peers). Each download permits two
> 60-second attempts, honors Retry-After with a bounded wait and names quota
> failures. Two red runs caused by HTTP 429 or a registry outage mean the proof
> moves to a cache the same day.

## First review and staged exit repair

The signed first candidate is head
`3b9cd387eb53829e8545b7445935d103839815eb`, tree
`8c70acc4ec81da7072301e8e26b2352ae193d90b`. Its policy check passed with all
seven obligations answered; commit gitleaks passed. Two independent fresh native
reviews both failed for the same concrete defect (G15-A1 and G15-B-1): a valid
`--app` module's JavaScript syntax or type error was classified as exit 64 rather
than the already documented operation/loading failure 74. No other material
finding was returned. Both reports are recorded; neither is a PASS. This is one
completed candidate evaluation, native cycle 0 of 3, with both findings open.

The discriminating installed test failed against the old packed bin with
`64 !== 74`. The staged repair marks the end of explicit invocation/snapshot
validation before importing lifecycle/application code. The catch then uses both
the operation phase and exception kind: malformed invocation/JSON remains 64;
application syntax/type failures become 74 with state failed and raw errors
withheld. No public wording, API, ownership, engine or refusal contract changes.
The proof adds actual module syntax/top-level type/factory syntax/factory type
cases, an empty-app-path refusal and malformed snapshot JSON alongside existing
refusal/recovery cases. The repaired packed executable passes them and the full
focused real-version/actual PostgreSQL witnesses again. Existing 11 deterministic
registry checks also pass; no registry-outage/quota red run occurred.

The post-exit-repair source snapshot before this task-record update is tree
`bd3d8cefd68dfb8a098f1f54b5cf7127796653c1` (the preceding task-record blob is
retained in that snapshot). The staged delta over the signed first candidate is
only the bin, its existing proof script and this task record. A real new pack
passes content/size checks with the re-measured totals above and no cap change.
The required new read precedes DCO for this bin repair; no repair commit or new
native preparation exists yet. The current repair count remains 0; after read
and commit, ordinary prepare accounts for the next candidate in the same history.

No native PASS, receipt, push, PR or canonical verification exists. After the
new read: sign the repair with the fresh exact tooling no-impact trailer, obtain
actual policy PASS, prepare and launch two new independent fresh reviewers with
both finding cards for explicit closure. Then request the lead's verify turn.
Canonical verify, push and PR creation remain held for that explicit instruction.
Do not extend work into the separately assigned distribution rows.

Initial drafting lacked installed structural tooling and exposed missing bin
ownership/publication registration. The first lint found the misplaced launcher
and an embedded fixture boundary; both were repaired. The first focused unit
run found port/route-name ambiguity; its regression now passes and the installed
consumer also covers that class. These are pre-review repairs, not native cycles.
One earlier focused admission timed out after 542 seconds and was repeated as
instructed; the post-read rerun was admitted after 393 seconds. All heavy work
waited for actual admission. No authority or budget was reset.

Self-retro: reuse the package-root tool seam instead of weakening module rules;
report binding facts instead of inferring a kind from a shared subject. The
current authority register already settled publication-data scope and should be
read before repeating that coordination question. Bounded retries and realistic
child deadlines address registry/load noise without replacing immutable inputs
or weakening refusal. The first review exposed a missing failure class:
constructor-based error classification → explicit input/operation boundary.
The task carries that lesson; no out-of-scope guidance edit or successor is added.

## Landing preflight stopped on unchanged importer tests

At 2026-11-02T18:01:22Z, the existing-test-first landing preflight stopped before any fetch,
merge, read packet or new native review. Committed source remains head
`f19a5e1991f44ff9831d1f7c083291ef205080a6`, tree
`b98d82dc572d79efabc57509c119d70ea9dfa023`. The previous native source review
is closed at cycle 1 of 3 and expires at 2026-11-02T22:00:43.357Z; it does not
waive this failing mandatory preflight. No existing test was changed.

Pinned Node 24.21.0/npm 11.19.0 and the focused admission gate were used.
Package boundary plus the complete lifecycle directory passed: 4 files, 2,863
tests. The broader source-scan-pattern selection passed: 26 files, 443 tests.
The existing importer/package-surface run was serial. Its first completed file
reported this exact failure summary:

```text
scripts/source-preview-release.test.ts (718 tests | 46 failed)
× builds its synthetic workspace manifests with the pinned public execution surfaces
```

That test's assertion at line 1726 compares every synthetic package execution
surface with its pinned digest. The platform fixture at line 325 has scripts but
no bin, whereas the accepted execution surface includes the one new `openlup`
bin. This is a concrete fixture/input mismatch; no assertion or control is
relaxed here, and the remaining failure causes are not claimed independently
diagnosed. The existing tests remain byte-identical to the reviewed source.

After the red file was observed, the owned Vitest process received graceful
SIGINT (exit 130). The remaining selected files have no completed result; no
PASS is claimed for them. No fetch, merge, canonical verify, push, PR, receipt
or queue action followed. The supervisor receives the failure rather than an
existing-test edit.

Completed unchanged files with passing results:

- `packages/platform/test/channels/channelPackageBoundary.test.ts`
- `packages/platform/test/commerce/browserSafety.test.ts`
- `packages/platform/test/commerce/commerceOrderDraft.test.ts`
- `packages/platform/test/commerce/effects/commerceSalesChannelSeam.test.ts`
- `packages/platform/test/commerce/omsOrderSubscriptionContinuityCharacterization.test.ts`
- `packages/platform/test/communications/contentDefaults.test.ts`
- `packages/platform/test/communications/klaviyo/permissions.test.ts`
- `packages/platform/test/communications/marketingSyncCompatibility.test.ts`
- `packages/platform/test/composition/httpBinding.test.ts`
- `packages/platform/test/composition/nodeHost.test.ts`
- `packages/platform/test/data/binding.test.ts`
- `packages/platform/test/data/supabaseClientFactory.test.ts`
- `packages/platform/test/data/supabaseGateway.test.ts`
- Fulfillment adapter tests: 2 files.
- `packages/platform/test/http/runtime.test.ts`
- `packages/platform/test/http/security.test.ts`
- `packages/platform/test/identity/emailTrustPolicy.test.ts`
- `packages/platform/test/lifecycle/appUpgrade.test.ts`
- `packages/platform/test/lifecycle/appVerification.test.ts`
- `packages/platform/test/lifecycle/postgresInstallQualification.test.ts`
- `packages/platform/test/marketing/consentEvidence.test.ts`
- `packages/platform/test/packageBoundary.test.ts`
- Payment adapter tests: 1 file.
- `packages/platform/test/promotions/acquisitionOrchestrationParity.test.ts`
- `packages/platform/test/promotions/promoDataPort.test.ts`
- `packages/platform/test/promotions/promotionClaims.test.ts`
- `packages/platform/test/promotions/promotionQuoteBinding.test.ts`
- `packages/platform/test/promotions/quotePromotionV2.test.ts`
- `packages/platform/test/promotions/thresholdShippingParity.test.ts`

Completed unchanged failing file:

- `scripts/source-preview-release.test.ts`

Other files selected in the interrupted root invocation, without a completed
result (these still need their required execution after the blocker is resolved):

- `scripts/check-publishable-gap-enumeration.test.ts`
- `scripts/documentation-cli.test.ts`
- `scripts/oss-published-tree-check.test.ts`
- `scripts/packages/changelog-fragments.test.ts`
- `scripts/packages/eslint-import-map.test.ts`
- `scripts/packages/package-manifest-policy.test.ts`
- `scripts/packages/package-size-policy.test.ts`
- `scripts/packages/package-tarball-gate.test.ts`
- `scripts/packages/packages-check.test.ts`
- `scripts/packages/platform-cold-consumer.test.ts`
- `scripts/packages/reference-delegation-consumer.test.ts`
- `scripts/packages/release-gate.test.ts`
- `scripts/packages/release-workflow-authenticity.test.ts`
- `scripts/packages/set-release.test.ts`
- `scripts/public-ci-neutrality.test.ts`
- `scripts/public-ci-payment-allowance.test.ts`
- `scripts/reviewed-batch-forward.test.ts`
- `scripts/source-release-preparation.test.ts`
- `server/adapters/postgres/dataGateway.test.ts`
- `tests/platform/catalog/m05Composition.test.ts`
- `tests/platform/channels/channelConsumer.test.ts`
- `tests/platform/inventory/inventoryConsumer.test.ts`
- `tests/postgres/m14InstallQualification.test.ts`
- `tests/postgres/partnerAcquisition.test.ts`

Logs and discovery inventory remain under `.context/scratch/g15-landing-*`.
An initial direct wrapper launch lacked npm's local-bin PATH and failed before
any test; the actual run used the pinned toolchain and local-bin PATH.

Self-retro: the importer search exposed a synthetic-manifest assumption omitted
by the earlier focused proof. Keep the existing assertion and resolve its input
through the supervisor's scope decision; do not narrow proof to obtain green.

## Forced integration and authorized fixture follow-up

The maintainer identified the existing synthetic-manifest input as stale after
the deliberate, accepted execution-surface change. The one authorized test
fixture line now copies the real platform bin exactly:

```diff
-  "packages/platform/package.json": json({ name: "synthetic-platform", scripts: PLATFORM_SCRIPTS }),
+  "packages/platform/package.json": json({ name: "synthetic-platform", scripts: PLATFORM_SCRIPTS, bin: { "openlup": "./src/lifecycle/openlup.mjs" } }),
```

No other line in that test, no assertion, pin, control or other existing test
changes. The fixture now describes the same scripts/bin surface as the accepted
real manifest, following the existing core fixture's form. This is a test-only
follow-up, not a product or public-contract repair. Complete rerun results follow
in this same record; a different failure cause stops further edits.

Fresh main `ef157a2da88b799e8040ecd21c9727e25858a2b3` and reviewed head `f19a5e1991f44ff9831d1f7c083291ef205080a6` had exactly
one conflicted file. The signed pure merge is `876e9431f52ac6ead90714e620454635f65f43f9`, tree
`56aec622ef76f01fff823a1295c92ebc221473e3`, with exactly those two parents. The earlier
execution notes remained unstaged and were excluded from that merge. All other
shared-file merges were automatic. One inherited whitespace warning in an
upstream migration was left unchanged; the own delta passes whitespace checks.

The following historical proof describes the pure merge before the later bin
relocation. Its original path literals are retained only to reproduce the pinned
hashes and equal catalog sets; the current bin path is the lifecycle path above.

The sole catalog conflict consisted of these three disjoint-addition hunks:

1. G15: `docs/platform/plans/oss-m19-g15.md`; main: `docs/platform/plans/oss-m19-forward-class.md`, `docs/platform/plans/oss-m19-g10.md`, `docs/platform/plans/oss-m19-g11.md`, `docs/platform/plans/oss-m19-g12p.md`, `docs/platform/plans/oss-m19-g14x.md`, `docs/platform/plans/oss-m19-g16.md`, `docs/platform/plans/oss-m19-g18.md`, `docs/platform/plans/oss-m19-g4g3-control.md`, `docs/platform/plans/oss-m19-g9.md`, `docs/platform/plans/oss-m19-integration-trailer.md`, `docs/platform/plans/oss-m19-kit.md`, `docs/platform/plans/oss-m19-r0.md`, `docs/platform/plans/oss-m19-starter.md`.
2. G15: packages/platform/src/openlup.mjs (historical merge path); main: `packages/platform/src/migrations/qualifiedInstall.ts`, `packages/platform/src/migrations/rdsControlRoles.ts`, `packages/platform/src/migrations/selectedCatalogProjection.ts`.
3. G15: `scripts/packages/distribution-cli-proof.ts`; main: `scripts/packages/consumer-evidence.mjs`, `scripts/packages/consumer-evidence.test.ts`.

Resolution retained each original row literal and class, inserted their sorted
additive union and preserved all automatic bytes outside the conflict markers.
No row was reformatted or reordered. The exact five added G15 path entries before
and after are equal, with no removed path:

- `docs/platform/plans/oss-m19-g15.md`
- `packages/platform/src/lifecycle/appVerification.ts`
- packages/platform/src/openlup.mjs (historical merge path)
- `packages/platform/test/lifecycle/appVerification.test.ts`
- `scripts/packages/distribution-cli-proof.ts`

With `LC_ALL=C`, the old and pure-merge sorted plus/minus content hashes match:
all files `47b03b7ccd34fe77b102de8bca7508c463d02afdd7ded71add491070e25c68ae`; excluding the catalog
`649ff3459f3fe6c18fb1d0b29c8fe03711d0b4380fafabea1d7926246f341298`. Stable patch-id changes
from `9ec18ac49ae0c994812f67b21bb257a3561eab04` to
`3e5aa8bb1d717d264b3e8bb9d5e87237e66ba59e` as catalog hunk context
moves among upstream additions. The equality of content-line hashes and path
sets demonstrates that the own source delta is unchanged. The later one-line
fixture and execution-record prose are explicit exceptions, outside this pure
merge comparison. No additional semantic integration delta exists.

Exact proof commands (old and merge bases pinned, headers excluded):

```sh
export LC_ALL=C
git diff bb0008481a11267ec6dbe3e7e531299777cddc19..f19a5e1991f44ff9831d1f7c083291ef205080a6 | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' | sort | shasum -a 256
git diff ef157a2da88b799e8040ecd21c9727e25858a2b3..876e9431f52ac6ead90714e620454635f65f43f9 | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' | sort | shasum -a 256
git diff bb0008481a11267ec6dbe3e7e531299777cddc19..f19a5e1991f44ff9831d1f7c083291ef205080a6 -- . ':(exclude)config/openlup-publication-catalog.json' | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' | sort | shasum -a 256
git diff ef157a2da88b799e8040ecd21c9727e25858a2b3..876e9431f52ac6ead90714e620454635f65f43f9 -- . ':(exclude)config/openlup-publication-catalog.json' | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' | sort | shasum -a 256
git diff bb0008481a11267ec6dbe3e7e531299777cddc19..f19a5e1991f44ff9831d1f7c083291ef205080a6 | git patch-id --stable
git diff ef157a2da88b799e8040ecd21c9727e25858a2b3..876e9431f52ac6ead90714e620454635f65f43f9 | git patch-id --stable
```

## Executable placement and bounded fixture recovery

The complete importer/source-scan selection completed: 55 files, 5,578 tests
passed and three failed. The source-preview manifest fixture now passes all
718 cases. The source-root inventory assertion failed with `expected
[ 'openlup.mjs' ] to deeply equal []` in `eslint-import-map.test.ts:485`.
It requires the platform source root to contain module directories only.
The executable therefore moves into the existing lifecycle directory; no test,
module graph or lint configuration changes. All active package/lock/bin,
publication, owner-route and documentation references follow that move.
Historical merge-proof path literals above describe their pinned merge only.

The moved executable needs exactly two reasoned line-level lint directives on
its existing dynamic imports. This tool loads the installed package's public
compiled lifecycle entry by npm name, just as an adopter process does. A relative
source `index.js` is not shipped there. The module graph continues to forbid
platform module self-imports; the tool lives in lifecycle to preserve the
directory-only source-root inventory. No indirect loader or blanket disable is
introduced. Removing only those two added directive lines produces bytes exactly
equal to the original executable (`cmp` against the original Git blob). The bin
name, options, output, exits and executable statements are unchanged.

The execution-surface digest changes only because the manifest bin value changes:
old `sha256-b741019609f4df89ea2083e5956461c9ecda23b8ed8142e993b8f8c75905acc1`;
new `sha256-996ffd9d83a8604e189709a43367a3a31b1a89efbc0bd92444e4b8c47ed78ffe`.
The catalog digest and matching publication-policy pin change together. Recompute
with the repository function on the real manifest:

```sh
node --experimental-strip-types --input-type=module -e 'import {readFileSync} from "node:fs"; import {packageExecutionDigest} from "./scripts/oss-publication-policy.ts"; console.log(packageExecutionDigest(JSON.parse(readFileSync("packages/platform/package.json","utf8"))))'
```

The existing source-preview fixture copies the new bin path exactly; its scripts
and assertions are unchanged. No other execution-surface pin or control changes.
The two cold-consumer failures remain pending exact compiler diagnosis and a
separate minimal synthetic-core fixture repair; no assertion is relaxed.

The exact declaration failure was captured before repairing the existing fixture:
`appVerification.d.ts(1,80): error TS2307: Cannot find module
'@openlup/core/readiness' or its corresponding type declarations.`
The same fixture also failed with `ERR_PACKAGE_PATH_NOT_EXPORTED: Package
subpath './readiness' is not defined by "exports"`.

- `scripts/packages/platform-cold-consumer.test.ts`: add only the missing synthetic core readiness export, import-only runtime stub and the six requested declaration exports to repair those two diagnostics; preserve every assertion and strict declaration check. This is one additional existing test file.
- `scripts/source-preview-release.test.ts`: its synthetic platform manifest copies the real bin key/path after the execution-surface pin; the earlier 718-case rerun passed, and the relocation changes only that path value.

The synthetic readiness function deliberately throws if invoked; these fixture
cases prove importability and declarations, not readiness evaluation. Real
readiness remains covered by the existing evaluator and application diagnosis
proofs. The real cold-consumer path reads the verified pack manifest, rechecks
both core/platform archive hashes and installs both actual tarballs. Real core
already exports `./readiness`, so it has no synthetic-export omission. Its
real-packed lifecycle cases passed in the complete preceding run; canonical
verification is still pending.

`runPlatformColdConsumer` imports lifecycle in its runtime export loop;
`proveLifecycleConsumer` emits a namespace import; `compileConsumer` emits
value/type imports checked in NodeNext and Bundler modes. The distribution CLI
proof invokes the installed executable and writes a published-version snapshot
application that resolves/imports lifecycle. The CLI itself imports the public
lifecycle entry for upgrade and verification. Neither repair changes those paths.

The repaired cold-consumer file passes all 108 tests (60.65 seconds), including
both previously failing runtime/declaration cases. The moved executable passes
file-level ESLint and full repository lint: zero errors, 33 existing warnings;
its two directives are used and reasoned. The original and directive-stripped
executable SHA-256 are both
`f8de509d077426ae76b66928f2266dea7d47bb8cd455c048ab69317ffb41bd5c`.
The only executable-file diff after the rename adds this directive immediately
before each of its two existing dynamic public-entry imports:

```diff
+    // eslint-disable-next-line no-restricted-syntax -- tool entry, not a platform module: it loads the installed package's published entry by name, exactly as an adopter's process would; the module graph forbids this for modules, and the file lives in lifecycle only because src holds module directories only
```

A complete final-tree selection and package measurements are still pending.

## Neutral test inventory evidence

The public inventory groups three adapter-specific test paths neutrally:
fulfillment adapter tests (2 files) and payment adapter tests (1 file). The
complete exact inventory stays in the private scratch JSON supplied with the
local proof. No scanner, ratchet, baseline or executable changes. The preceding
complete run passed all 55 selected files and 5,581 tests with no failures or
pending cases.

Inventory: 55 unique relative paths, sorted in byte order. Its canonical bytes
are compact JSON (an array of strings, no spaces) encoded as UTF-8 followed by
one LF. SHA-256: `19a086278234a5b58d1c95401b2e2c7fb3218ae5316b762e21f67753c32f2840`.
Reproduce from the private proof artifact:

```sh
shasum -a 256 .context/scratch/g15-landing-exact-test-inventory.json
```

## Second integration before source review

Fresh main is `21c057038b25db6bdf490496a341df5b2f1fdbcc`. The previous head
`1f8766d11df24bcad6fc2a47e56306a1adc67110` (base `ef157a2da88b799e8040ecd21c9727e25858a2b3`)
merged without a textual conflict or hand edit. The pure merge is
`480bc4dd332c2ac23f3f946c44d4c5ba861f51c0`, tree
`c99569e303770ebc4cf0ba772c25bb964fd6fa3f`, exactly equal to the tree computed
by `git merge-tree --write-tree --name-only --no-messages HEAD origin/main`
before merging. The shared cold-consumer additions from main are preserved.

Sorted plus/minus content lines match before and after in all three groups:

- All files: SHA-256 `454ef3334f5ae6ad57b6aad67b83fb2cf74a5473669af83ecc3fb2ce8ab7dc3f`; stable patch-id before = after `51855d36f926a7d502fd3036840f8ea45de5da2f`.

- Excluding the catalog: SHA-256 `f160995367271f9308f6d1b93b6ae5c5fce03e6ca70c60b222dc61f7d57ec5fe`; stable patch-id before = after `e6157eab9a1885853cdf5c59942aa2f607725450`.

- Excluding the catalog and both shared cold-consumer files: SHA-256 `5f6529e8b524166e83605fb906069f157c0bb6eb429e98752db6b209b6a9051f`; stable patch-id before = after `e53e6d16821cde73c1f59cade7c15cc1fa564c0f`.

There are no added or removed own content lines in any comparison, including
the cold-consumer pair. The five own added catalog paths are equal before/after
and no path is removed. This equality describes the pure merge; this later
execution note is excluded. Reproduce with `LC_ALL=C` and these ranges:

```sh
git diff ef157a2da88b799e8040ecd21c9727e25858a2b3..1f8766d11df24bcad6fc2a47e56306a1adc67110 | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' | sort | shasum -a 256
git diff ef157a2da88b799e8040ecd21c9727e25858a2b3..1f8766d11df24bcad6fc2a47e56306a1adc67110 | git patch-id --stable
git diff ef157a2da88b799e8040ecd21c9727e25858a2b3..1f8766d11df24bcad6fc2a47e56306a1adc67110 -- . ':(exclude)config/openlup-publication-catalog.json' | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' | sort | shasum -a 256
git diff ef157a2da88b799e8040ecd21c9727e25858a2b3..1f8766d11df24bcad6fc2a47e56306a1adc67110 -- . ':(exclude)config/openlup-publication-catalog.json' | git patch-id --stable
git diff ef157a2da88b799e8040ecd21c9727e25858a2b3..1f8766d11df24bcad6fc2a47e56306a1adc67110 -- . ':(exclude)config/openlup-publication-catalog.json' ':(exclude)scripts/packages/platform-cold-consumer.ts' ':(exclude)scripts/packages/platform-cold-consumer.test.ts' | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' | sort | shasum -a 256
git diff ef157a2da88b799e8040ecd21c9727e25858a2b3..1f8766d11df24bcad6fc2a47e56306a1adc67110 -- . ':(exclude)config/openlup-publication-catalog.json' ':(exclude)scripts/packages/platform-cold-consumer.ts' ':(exclude)scripts/packages/platform-cold-consumer.test.ts' | git patch-id --stable
git diff 21c057038b25db6bdf490496a341df5b2f1fdbcc..480bc4dd332c2ac23f3f946c44d4c5ba861f51c0 | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' | sort | shasum -a 256
git diff 21c057038b25db6bdf490496a341df5b2f1fdbcc..480bc4dd332c2ac23f3f946c44d4c5ba861f51c0 | git patch-id --stable
git diff 21c057038b25db6bdf490496a341df5b2f1fdbcc..480bc4dd332c2ac23f3f946c44d4c5ba861f51c0 -- . ':(exclude)config/openlup-publication-catalog.json' | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' | sort | shasum -a 256
git diff 21c057038b25db6bdf490496a341df5b2f1fdbcc..480bc4dd332c2ac23f3f946c44d4c5ba861f51c0 -- . ':(exclude)config/openlup-publication-catalog.json' | git patch-id --stable
git diff 21c057038b25db6bdf490496a341df5b2f1fdbcc..480bc4dd332c2ac23f3f946c44d4c5ba861f51c0 -- . ':(exclude)config/openlup-publication-catalog.json' ':(exclude)scripts/packages/platform-cold-consumer.ts' ':(exclude)scripts/packages/platform-cold-consumer.test.ts' | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' | sort | shasum -a 256
git diff 21c057038b25db6bdf490496a341df5b2f1fdbcc..480bc4dd332c2ac23f3f946c44d4c5ba861f51c0 -- . ':(exclude)config/openlup-publication-catalog.json' ':(exclude)scripts/packages/platform-cold-consumer.ts' ':(exclude)scripts/packages/platform-cold-consumer.test.ts' | git patch-id --stable
```

The instruction delta on main adds the starter source/extraction witness to the
existing required cold consumer. No new test file was added on main; its new
cases in the existing shared test file are included in the same 55-file
selection. The exact sorted private inventory and its hash above are unchanged.
The complete selection and all checks will be repeated on the merged tree.

The equal own added catalog set for this second merge is:

- `docs/platform/plans/oss-m19-g15.md`
- `packages/platform/src/lifecycle/appVerification.ts`
- `packages/platform/src/lifecycle/openlup.mjs`
- `packages/platform/test/lifecycle/appVerification.test.ts`
- `scripts/packages/distribution-cli-proof.ts`
