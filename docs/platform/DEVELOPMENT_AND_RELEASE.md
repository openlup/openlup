# Development, diagnostics and preview releases

Status: development-preview guidance.
Audience and purpose: contributors and maintainers following a change from local
verification through a pull request to a package release on npm, or to an
optional source preview, which carries no package.
The current channel is evaluation-only; this process does not establish a stable
API, production deployment or supported adopter upgrade.

## Start with the right route

Run contributor commands from the repository root of a dedicated task worktree,
using Node 24.21.0 and npm 11.19.0. CI, release workflows and local `.nvmrc`
pin the same runtime (the bundled npm is 11.19.0). Package commands below
explicitly select their workspace. A maintainer's installed local helper may create that worktree and
mirror the required CI commands; it is not a public npm dependency. Other
contributors use the public commands in [CONTRIBUTING](../../CONTRIBUTING.md#required-and-raw-checks).
Never edit, install or test in a maintainer's coordination checkout.

The stages below are sequential, but CI jobs and Sonar analysis run in parallel.
Local success is preparation, not proof that a hosted run or release succeeded.
The step-by-step order for one change is
[Deliver a change](../../CONTRIBUTING.md#deliver-a-change).
Release preparation and authorization follow
[package release policy](../../.github/VERSIONING_AND_EOL.md#package-releases).

| Stage | Trigger and executor | Checks and next step |
| --- | --- | --- |
| Draft PR | Authorized branch push and PR creation | Sonar can analyze it. Published Tree CI jobs skip drafts; skipped jobs are not passing evidence. |
| Ready PR | Non-draft PR opened, reopened, updated or marked ready | Published Tree CI runs six mechanical checks and separate raw diagnostics on the integration merge ref; native admission checks review evidence. See [Deliver a change](../../CONTRIBUTING.md#deliver-a-change). |
| Merge queue | Required source checks pass and the PR is enqueued | Checks run on the actual group tree. `autoMergeRequest` means armed; `mergeQueueEntry` confirms queue entry. See [queue mechanics](../../CONTRIBUTING.md#merge-queue). |
| Main | A merge commit produces a main push | Expensive commands reuse a complete successful merge-group run only for the exact same commit; otherwise they run again. DCO, policy/neutrality and secret checks run for the push; Sonar updates its main analysis. Native admission does not run on main pushes. A merge is not a release. |
| Package release | Authorized dispatch of `publish-package.yml` for a reviewed SHA on main's first-parent line, package `all` (the set) or one package, the version, and exact notes | Unprivileged preflight refuses while any package release or publication is in flight, checks ancestry, contexts and versions, packs and scans every tarball, and decides each package by its tag, release and npm state before protected release approval. One approval covers the set; the release App creates each annotated tag `openlup-<package>-v<version>` on the target and its immutable release. |
| npm | Published package-release event from the release App | Package workflow independently checks identity, tag and tarball, re-reads npm, then publishes with OIDC provenance under `latest`. Verify its observed result; publication does not update an adopter. |
| Source preview (optional) | Authorized dispatch for reviewed SHA on main's first-parent line, next ordinal and exact notes | A source snapshot with no package. The release workflow validates the tree, creates and verifies the immutable source preview. |

Dependabot PRs are a special case: Published Tree CI selects them only for a
human `ready_for_review` event. They are update signals, not a direct merge
route; apply accepted changes on a signed branch, keeping the committed contract
snapshot unchanged for dependency and lockfile PRs. Release preparation refreshes
it with `node --experimental-strip-types scripts/source-release-preparation.ts --write`.
See the comments in [Dependabot configuration](../../.github/dependabot.yml).

## What each diagnostic proves

Commands in this table run from the task worktree's repository root unless a
workspace is explicitly selected. Detailed selectors, prerequisites and limits
remain in [Test scope and diagnostics](../../CONTRIBUTING.md#test-scope-and-diagnostics).

| Tool or command | Purpose and execution owner | Blocking status and evidence |
| --- | --- | --- |
| `npx --no -- ast-grep scan --error=no-suppress-all --error=unused-suppression <changed-path>` | Fast local structural feedback after edits; installed pre-commit scans staged TS/TSX. | Fix violations before committing. Keep `--no --` to avoid fetching another package. CLI output names the rule. |
| `npm run lint` | File-wide suppression hygiene, ast-grep scans/rule tests, ESLint and import boundaries; local and CI `typecheck`. | Required. npm prelint builds Core, Outbox and Platform first; it is not just formatting. |
| `npm run oss:published-tree -- --typecheck` | TypeScript projects checked against tracked preview compatibility debt; local and CI `typecheck`. | Required. Not equivalent to claiming zero compiler diagnostics. Run `npm run pretest` before invoking directly after package-source edits. |
| `npm run oss:published-tree -- --policy` and `--inventory` | Publication classification, documentation ownership/navigation and tree inventory; local and CI `self-check`. | Required. These check structure and recorded obligations, not the truth of arbitrary prose or runtime behavior. |
| `node scripts/verify-local.mjs --plan` (optionally `--json`, `--pgtap`) | Read-only explanation of the same local phases the runner executes, including owners, reasons, prerequisite order, commands and resource profiles. Works before review on a dirty task worktree without dependencies. | Planning only; no checks, scratch output, review validation or verification evidence. Unknown Git scope exits 2 and retains all obligations. Package discovery and root tooling selection retain their existing owners. |
| `node scripts/verify-local.mjs` (add `--pgtap` for DB inputs or an explicitly requested diagnostic) | Optional full local command set after committed native review; one install and root run, serialized builds/package gates, fixed existing resource profiles when the optional broker is present. | Optional local mirror of the required hosted commands; [contributor commands](../../CONTRIBUTING.md#required-and-raw-checks) own scope and limits. Logs retain exits, timing and the first root-worker observation. No hosted admission, new stamp, retry or cached pass. |
| `node scripts/agent-review-session.mjs verify-command -- <heavy required command>` | Native review verification before and after the command, with unchanged HEAD tree and clean worktree; optional installed host resource broker. | Command wrapper; preserves underlying commands but does not attest completeness of selected commands. Before starting, it predicts merge/carry-over against locally fetched `origin/main`; refresh that ref first. The [canonical wrapper limits](../../CONTRIBUTING.md#local-stack-bases-and-heavy-verification) include local review of unlanded stacks. It adds no proof lease or policy/inventory check. Independent PRs use their normal base; stacked PRs export the exact `OPENLUP_STACK_BASE`. No cache, hosted receipt, settings change or merge authority. |
| `node scripts/public-ci-neutrality.mjs --base-commit <full-base-sha>` and UI neutrality smoke | Tree-wide shrink-only neutrality and portable UI boundary; local and CI `self-check`. | Required. Use the exact event/comparison base, not a guessed latest main. |
| Shared `scripts/packages/required-package-gates.ts` in [required checks](../../CONTRIBUTING.md#required-and-raw-checks) | Discover each publishable workspace and its required scripts; cold-pack the current set, check all APIs, then run each owning required batch with the same artifacts. Core retains mechanical CI obligations and uses dependency-regression admission instead of the absolute release audit; Outbox owns schema/SQL/replay. | `install-packages` follows both builds in its own checkout, independently of root tests; the required `install-proof` aggregate also requires four browser shards consuming its verified manifest and tarballs. Local package preparation and tests remain serial because they share build outputs. Missing routes, artifacts or runtimes refuse. Future modules use the same semantic consumer proof; only SQL modules require a database. |
| `npm --workspace @openlup/core run ci` | Package coverage, runtime imports, type smoke, API snapshots, docs, release checks and packed-consumer smoke; local and CI `install-proof`. | Standalone `ci` includes the full live audit. Required PR/queue proof uses the shared API phase plus `ci:required` and dependency-regression admission, with manifest/commit inputs. Manual mode still builds/packs; supplied mode executes the same assertions without repacking. Separate from root Vitest discovery. |
| `npm run test:scoped` locally; `npm test -- --shard=N/6` in CI | Root Vitest; see [testing](../../CONTRIBUTING.md#test-scope-and-diagnostics) for discovery, selection and sharding. | Required `test` aggregates all six root shards and pgTAP and refuses failure, cancellation or skipped dependency jobs. Individually skipped cases remain missing proof. Package gates remain separate. |
| `node scripts/public-ci-pgtap.mjs` | Shipped SQL tests against the committed managed baseline and forwards on the digest-pinned stock PostgreSQL 17 image with the [managed-compatibility adapter](../../tests/postgres/managed-compat/supabase.sql) and checksum-pinned pgTAP, pg_cron and `pg_prove` packages; local and CI `pgtap`. Requires Docker only: no Supabase CLI and no npm install. | Required in CI through the `test` aggregate; a raw diagnostic locally. Start, replay, cleanup failures and unexplained new failures block delivery under contribution rules. `node scripts/pgtap-parity.mjs` compares TAP logs, snapshots and fingerprints. |
| `npm run build` and subscription-profile build | Install/build proof for reference profiles; local and CI `install-proof`. | Required. A build does not prove a browser journey, live provider or production deployment. |
| `npm run check:dco-signoff -- <full-base-sha> <full-head-sha>` | Sign-off on the full commit range; local and CI `dco`. | Required. Empty ranges and malformed identities are not success evidence. |
| Gitleaks | Secret scanning in CI `gitleaks`: the non-empty pull-request or merge-group commit range, or the complete history when that range changes `config/gitleaks.toml` or `.gitleaksignore` and on main pushes. Range scans cover everything that reaches `main` only while its merge queue is ALLGREEN, merges one entry per group with the MERGE method and has no bypass actor; changing those settings needs this scope reviewed again. Unpacked tarballs in release preflight and package workflow. | Required in those owners. Use pinned configuration/version and redacted logs; it is distinct from local publication leak checks. |
| Native session review and `native-review` | Independent semantic review through native subagents or a qualified local CLI, bound to candidate, scope and criteria; hosted receipt admission after mechanical success. | Required for registered agent tasks; hosted status depends on explicit activation. Review does not grant publication or release authority. |
| SonarQube Cloud automatic analysis | Additional security/reliability findings on PR pushes and main, using configured source/test scope. Runs in Sonar Cloud, not a local scanner or Actions job. | Advisory pilot; no required status, coverage import or per-PR token/login. A hotspot needs contextual review, not automatic classification as a vulnerability. |
| Dependabot | Scheduled dependency/Actions update proposals; security-update activation is a separate repository setting. | Triage signal, not test evidence or automatic approval. |
| `npm run packages:check -- --cold --out <outside-checkout-directory> --release-tag openlup-<package>-v<version>` | Inventory-based prerequisite builds and selected-package pack from cold generated output; local release proof and hosted pack/preflight. Use `--release-set <version>` for the whole set. | Release prerequisite, including a fresh full production audit before retaining artifacts. Does not publish. Requires a clean committed candidate; a working-tree preview is separate evidence. |
| `gh release verify <tag> --repo openlup/openlup` | GitHub attestation of the immutable release/tag; maintainer preparation and hosted release/package workflows. | Release evidence. It does not establish npm publication or an adopter installation. |

Core's `ci` includes license allowlisting, production-dependency SBOM and audit,
pack budgets, declaration snapshots and publish-control checks. See its
[command manifest](../../packages/core/package.json),
[release gates](../../packages/core/release-gates.json) and
[contribution guide](../../packages/core/CONTRIBUTING.md).
Admission compares dependency changes with the exact base; a new advisory for
an unchanged inherited dependency does not freeze unrelated merges. Publication
packs run the full selected dependency audit again, including standalone locks,
and a publish-only retry cannot reuse an earlier attempt's audit. See
[dependency security and required checks](../../CONTRIBUTING.md#required-and-raw-checks).
Root dependency updates and core's standalone production audit remain distinct scopes.
The reference root, Core and Platform require Zod `^4.6.6` to reject oversized
constrained collections before parsing each element (GHSA-mrhx-c7xc-m3w5).
Keep both the workspace lock and Core's standalone lock at a fixed version.
The root's scoped `@vercel/cli-config` override removes its older production
Zod 4 copy; upstream still pins that copy, so changing only the direct dependency
would leave the advisory reachable. This override does not change development
tools that require Zod 3. Existing API and consumer gates remain required; the full production audit
is required for publication as described above. No audit allowance or test
retry is added.
Core's build explicitly loads its existing development-only Node declarations
for the standard `URL` type referenced by Zod's declarations. This adds no
runtime import or dependency; declaration checking remains enabled, and the
installed NodeNext and browser/Bundler consumer proofs still apply.
Playwright specifications and explicit database/browser reference evaluation do
not become mandatory per-PR execution just because their files exist; follow
[execution ownership](../../CONTRIBUTING.md#development-preview-checks) and the
[selected subscription evaluation](SUBSCRIPTION_REFERENCE.md).

## Local maintainer layer

Without that private helper, use the public `node scripts/verify-local.mjs`
route in [required and raw checks](../../CONTRIBUTING.md#required-and-raw-checks).
Use `--plan` before review to inspect the same local obligations without running
them. The [workflow record](plans/delivery-workflow.md) distinguishes this
implemented explanation from future proof reuse and admission work.
It runs the existing local equivalents rather than replaying all hosted jobs:
one `test:scoped`, with no additional local shards or GitHub-only event checks.
It uses existing broker profiles automatically when available and runs the same
native wrapper directly otherwise. It does not install or impersonate the
maintainer layer.

Where installed, `openlup-dev doctor` diagnoses prerequisites and installation
or workflow-mirror drift. It is not a substitute for candidate verification.
After committing and recording required native reviews, `openlup-dev verify`:
- checks the workflow mirror and the shared lock;
- runs the mechanical equivalents locally, in an environment like a hosted
  runner's: a temporary directory outside every checkout, four Vitest workers
  and no global Git identity;
- must mirror the required root `npm run test:scoped` route; pgTAP remains a raw
  diagnostic selected with `--diagnostics` or when the range reaches database inputs;
  an older helper that calls `test:required` needs updating before it can verify this tree;
- adds publication leak checks and advisory release eligibility.

Its logs identify each command and exit code. Read `REQUIRED PASS` separately
from `DIAGNOSTICS RED`. A pass on a worktree that stayed clean for the whole run
records a stamp of that exact tree.

Installed pre-commit checks staged structural violations; commit-message checks
require the configured identity and sign-off. Pre-push rechecks current review
and publication leak evidence. A hook pass is not a hosted CI pass, which is the
required verification. `leak-check` inspects what the range would publish;
`release-check` is advisory and can report `CANNOT-DECIDE`. Neither replaces
release prepare or release attestation. Installation and changes to this local
layer remain maintainer-controlled and outside the public tree.
All required source and merge-group CI commands still run.

## Measuring delivery improvements

Record measurements in the existing task evidence, with actual candidate,
workflow run and attempt identities; no separate tracking service is needed.
Compare like work: a new package or API contribution, an existing-package repair,
and metadata-only delivery have different costs. Retain failed attempts and
recovery work. Two log files for one run are one attempt.

Use the same start in both routes: the functional scope is ready to stabilize,
before version bumps, release notes, pins, release-contract generation and any
route-specific maintainer reading, review or verification. Include this
preparation in the comparison. If that start cannot be reconstructed for the
baseline, report the missing cost as unknown; timing only the stabilized
candidate cannot establish a net saving.

Record these milestones separately: stable signed candidate; source checks green
and native admission; queue arming, group admission and merge; main checks green
and exact release preflight; protected release approval; every publisher job
complete; and complete consumer, integrity and provenance proof. PR creation or
publish exit zero is not the final milestone. Where completion still requires
manual observation, include that work rather than claiming an autonomous result.

Report total elapsed time, integrator active work, maintainer wait, other external
wait and runner/job seconds separately. Agent-controlled critical-path time uses
non-overlapping intervals excluding maintainer wait; parallel job durations are
not added to it. Record full reviews and verifies, questions, MFA interactions,
failures and manual recovery. Do not invent token or monetary costs without
telemetry.

Evaluate the next two naturally needed comparable sets, each with its own
required release approval; do not publish empty benchmark versions. Check whether
the combined route actually removed a second preparation PR and delivery cycle,
and whether repeated routine decisions disappeared. A working target is 20% less
agent-controlled time from the common start to final proof, including tool repair
and operation cost. Two observations detect obvious regressions; they do not
establish an average effect for every contribution class. Break-even divides
implementation and maintenance hours by active-work hours saved per comparable
set. Unknown savings or frequency means unknown return. Report safety improvements
separately if speed did not improve; local replay alone does not prove a live gain.

## Reading results and recovering

At the 2026-10-04 checkpoint, merged main was
`e7f352bd788c6f2557316c3abde5e000772d583d`: [run 37196000352, attempt 1](https://github.com/openlup/openlup/actions/runs/37196000352)
passed six mechanical checks and `test-full`; `pgtap` retained twelve named
failing files, and native admission was skipped on the main-push event.
Later checkpoints closed those pgTAP files. The
[current diagnostic record](plans/public-ci-known-red.md#current-checkpoint)
gives source/group/main provenance, assertion counts and remaining obligations.

The 2026-10-02 settings inspection found the native queue and npm-stage
variables enabled and the ruleset requiring six mechanical statuses plus
`native-review`. This is dated activation evidence, not a promise about another
repository or future settings.

When a branch's review scripts are older than trusted main's, run the receipt
from a clean checkout of the fetched, trusted main in the branch's working
directory: `node /absolute/path/to/trusted-main/scripts/agent-review-session.mjs receipt PR_NUMBER`.
It reads the branch's existing session with main's rules. Keep the stack pin.

The admission job's workflow trust boundary is described in
[Merge queue](../../CONTRIBUTING.md#merge-queue). SQL approval mechanics remain
in [Data and migrations](DATA_AND_MIGRATIONS.md#co-located-sql-and-approval-pins).

An aggregate Actions workflow can be red while its required statuses are green.
Inspect the individual job and its raw log, exact SHA, event, run and attempt.
Skipped, cancelled or timed-out execution cannot prove a passing check. The
[diagnostic debt record](plans/public-ci-known-red.md) distinguishes the current
last recorded SQL closure from archived failures; neither is permission to ignore a red
run. Compare failures with the exact base; disclose new failures and missing
execution. Required success is not complete-suite success.

Before retrying, classify the first causal failure from the stage log and run
identity. Reproduce an assertion or contract failure with a focused check, then
confirm the fix there before repeating the full gate. For confirmed resource
admission or infrastructure failures, record the cause and what changed before
using the existing retry route and budget. For a missing prerequisite, stale
candidate or missing review evidence, resolve the named refusal first. A test
timeout without broker evidence is not an admission timeout. If the cause is
unclear, retain the log and diagnose it before retrying.

When assessing a repair loop, record three times in the existing task evidence:
stage execution, resource or dependency wait, and elapsed wall time from the
start of the failed run to the end of verification after the repair. Include the
time between runs in that last figure. Use recorded start/end times and
scheduler logs. If a stage timer combines execution and wait and the log cannot
separate them, record the combined time and mark the split unknown. Overlapping
stage waits are not additive wall time. For a proposed reuse, subtract the cost
of collecting, validating and restoring evidence from the work it would save,
and distinguish that estimate from an observed saving.

Fix named local violations rather than bypassing hooks. A busy verification lock
belongs to another run; wait without removing it. Workflow-mirror drift needs
maintainer recovery. For missing native evidence, receipt timeouts or queue
recovery, follow [Deliver a change](../../CONTRIBUTING.md#deliver-a-change).

For Sonar, fix confirmed new defects in the PR and inspect the next analysis.
Triage existing findings separately by impact; do not bulk-clean unrelated code
or turn a pilot gate into a required check without a new decision. If App access
is revoked, analysis may stop; it is not a new merge blocker in this pilot.

## Releasing a package

While `@openlup/core` is below 1.0, the `@openlup/*` packages are released as
one set, independently of source previews: one set version `0.N.P` from one
commit, a tag `openlup-<package>-v<version>` per package at that commit, and
every package republished in each set. A patch set only fixes; any API,
behaviour or schema change, new package or shipped SQL is a minor set. The
[package inventory](../../config/openlup-packages.json) determines the publishable
set; the first set was core `0.12.0`. Source preview 11, which
published `@openlup/core` `0.11.0` on the `preview` dist-tag, was the last
lockstep cut that also published a package.
The [versioning policy](../../.github/VERSIONING_AND_EOL.md#package-releases)
owns release permissions, setup, detailed refusals and recovery. The sequence is:

1. Prepare the next set version, above every version npm holds, with
   `npm run release:bump -- --set <version>` in a reviewed ordinary PR, either
   separate preparation or an explicitly approved bounded implementation-and-set-bump
   contribution. It sets
   every publishable package and every exact internal pin on one, and opens each
   changelog's version section below a fresh Unreleased heading. It assembles the
   legacy body first, then validated package fragments in byte order of path,
   and deletes only consumed fragments after successful planning and writes,
   then stages exactly those deletions so preparation can read the Git inventory;
   historical sections stay byte-identical. Each packed package
   CHANGELOG keeps the current release and the two previous ones; older sections
   move verbatim to its non-packed `CHANGELOG-HISTORY.md`. Add notable-change notes under
   `packages/<package>/changes/`, with no per-file catalogue rows. A version bump
   by itself publishes nothing. Refresh the source contract's digests at release
   prep only with `node --experimental-strip-types scripts/source-release-preparation.ts --write`
   and verify with `--check`; ordinary PR/main/group policy and inventory checks
   compute live bindings and allow a stale committed snapshot while still
   validating structure, authored fields and derivation. Useful migration notes may move from Unreleased
   to the unique candidate-version section only for a real coherent new set;
   unchanged-version historical notes cannot cover an API change. Recheck the
   registry version before dispatch; a conflict requires a reviewed repair.
2. Select the exact reviewed main commit that carries the version and check its
   six mechanical contexts, then run `packages:check` with
   `--cold --out <outside-checkout-directory> --release-set <version>`.
3. With explicit authority, dispatch `publish-package.yml` from main with package
   `all`, the set version, the exact SHA and reviewed note bytes. Its unprivileged
   preflight refuses while any package release or publication is in flight, checks
   ancestry against freshly fetched main (recording its tip), contexts, a
   byte-identical fresh source snapshot at the exact Git target, the set version of every publishable package and, for a
   patch set, each unchanged API snapshot. It cold-packs every package through
   the shared inventory-based prerequisite route and scans every tarball, then
   decides each package by its tag, release and npm state, before protected
   `release` approval; dispatch itself is not approval. The release gate that
   decides ancestry, contexts and the tag's commit runs as it is at the dispatched
   main commit, never as the target's copy. A single package name still releases
   that one package, from nothing only.
4. After one owner approval, the release job runs once per package to release:
   it checks exactly the reviewed target against the main tip recorded by this
   run's preflight, repeating first-parent ancestry, audit-blob equality and the
   same required contexts, plus the remaining checks without installing or packing.
   Main may keep landing during the approval wait; the next cut re-audits against
   its own preflight tip. The tag step retains its fresh-main check and can refuse
   changed publication controls. If it passes, the release App creates the
   annotated tag `openlup-<package>-v<version>` and draft, validates the same draft ID and publishes the immutable release. Verify each completed
   release's exact note bytes, identity and GitHub attestation.
5. The App event starts package packing and independent release/tag checks.
   The same `packages:check --cold` route prepares the selected package's exact
   internal prerequisites from the inventory on a fresh runner; the checked
   output still contains only the tag's package. Cold preparation refuses
   tracked output, symlinks, unsupported layouts or dependency/build failures
   rather than using residue.
   The `npm-stage` job verifies the tarball digest, re-reads npm and publishes with OIDC
   provenance under `latest`. There is no second npm reviewer in the configured direct
   publishing route. One package's releases and publications run one at a time.
6. Observe package-workflow success and verify the exact registry version,
   integrity and provenance before offering adoption. A release success alone
   cannot prove npm success.

On partial release or package failure, stop for maintainer recovery. Do not
retag, rewrite an immutable release or republish a version. A failed publish job
may be rerun: it re-reads npm and refuses once npm holds that version or a later
one, so `latest` never moves backwards; otherwise correct forward with a new
version. Dispatching the set again resumes it: it skips a package npm holds with
the same tarball and reviewed notes, leaves a package whose release exists with
those notes but npm lacks the
version to that rerun, releases the rest, and stops on any other state. No step deploys production or changes an adopter's dependency pin.

Release snapshot freshness is checked again in protected package prepare/plan
and tag publication, including rerun/resume, without rewriting the target.
A source change to a bound input after preparation refuses until refreshed in a
reviewed preparation change; other source bytes and modes remain Git-bound.
The source-preview descendant check retains its strict snapshot equality.

### Verify the published npm artifact

Use a disposable directory outside any checkout, Node 24, npm 11.19.0 and an
authenticated `gh`. Select the package/version and full commit from the reviewed
release. This example verifies the first core set; replace both values together
for a later release. Repeat for each package before offering the whole set.

```sh
export OPENLUP_VERSION=0.12.0
export OPENLUP_COMMIT=5a851a6db5483fe1c754445ab837429f108dfd75
gh release verify "openlup-core-v$OPENLUP_VERSION" --repo openlup/openlup
npm init -y
npm install --save-exact --ignore-scripts --no-audit --fund=false "@openlup/core@$OPENLUP_VERSION"
npm view "@openlup/core@$OPENLUP_VERSION" dist --json > registry-dist.json
npm pack "@openlup/core@$OPENLUP_VERSION" --ignore-scripts --json > registry-pack.json
npm audit signatures --json --include-attestations > signatures.json
node --input-type=module - "$OPENLUP_VERSION" "$OPENLUP_COMMIT" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const [version, commit] = process.argv.slice(2);
const dist = json('registry-dist.json'), audit = json('signatures.json');
assert.deepEqual(audit.invalid, []); assert.deepEqual(audit.missing, []);
const digest = createHash('sha512').update(readFileSync(json('registry-pack.json')[0].filename)).digest();
assert.equal(dist.integrity, `sha512-${digest.toString('base64')}`);
const verified = audit.verified.find(row => row.name === '@openlup/core' && row.version === version);
const provenance = verified.attestationBundles.find(row => row.predicateType === 'https://slsa.dev/provenance/v1');
const statement = JSON.parse(Buffer.from(provenance.bundle.dsseEnvelope.payload, 'base64'));
assert(statement.subject.some(row => row.name === `pkg:npm/%40openlup/core@${version}` && row.digest.sha512 === digest.toString('hex')));
const build = statement.predicate.buildDefinition, tag = `refs/tags/openlup-core-v${version}`;
assert.deepEqual(build.externalParameters.workflow, {
  ref: tag, repository: 'https://github.com/openlup/openlup', path: '.github/workflows/publish-packages.yml',
});
assert(build.resolvedDependencies.some(row => row.uri === `git+https://github.com/openlup/openlup@${tag}` && row.digest.gitCommit === commit));
console.log('PASS: registry integrity and verified provenance match the reviewed package, tag, commit and workflow');
JS
npm view @openlup/core dist-tags.latest
```

Require each command to succeed; the final `latest` value must equal the selected
version when confirming a newly published set. `npm audit signatures` verifies
the signatures before the snippet inspects its verified bundles; decoding a raw
registry attestation alone is not signature verification. See the
[npm verification contract](https://docs.npmjs.com/cli/audit/).
Missing bundles, unsupported npm options, network/authentication failures or
unavailable release verification mean **verification unavailable**: record the
failed command, fix that prerequisite and rerun it before offering adoption.
A digest or identity mismatch is a refusal requiring maintainer investigation.
Compare the downloaded registry tarball with registry integrity and the signed
subject digest; a local preflight tarball can differ and is not that evidence.

## Cutting an optional source preview

After preview 11, a source preview is an optional source snapshot with no package. The
[versioning policy](../../.github/VERSIONING_AND_EOL.md#one-click-source-preview-workflow)
owns its permissions, setup, refusals and recovery.

1. Verify the previous preview's attestation. Release prepare checks the next
   ordinal, absent tag, ancestry, removal markers, immutable migration history,
   admitted forwards, exact publication catalogue and source contract.
2. With explicit authority, dispatch the source workflow from main with the
   exact SHA, ordinal and reviewed note bytes. Its unprivileged preflight checks
   ancestry and contexts before protected `release` approval.
3. After owner approval, the release App creates the annotated tag and draft,
   validates the same draft ID and publishes the immutable prerelease. Verify
   the completed release's exact note bytes, identity and GitHub attestation.
   The package workflow skips a preview, so no package is published.

## Documentation and distribution boundary

This guide and repo-level workflow/agent/Sonar configuration are public repository
material; they are not included by core's npm file allowlist. Core ships its own
source/build output and selected package documents, including CONTRIBUTING,
SECURITY and release-gates metadata. Installing core does not run Sonar or adopt
this repository's PR workflow. See the [package file list](../../packages/core/package.json).

The [platform index](README.md) routes readers here. Detailed contributor commands
remain in CONTRIBUTING, release rules in VERSIONING_AND_EOL, delivery and review in [Deliver a change](../../CONTRIBUTING.md#deliver-a-change), and documentation upkeep in [DOCUMENTATION](DOCUMENTATION.md).
Update this overview with the behavior it explains, regenerate navigation through
`npm run oss:published-tree -- --policy --docs-update`, as described in [Documentation maintenance](DOCUMENTATION.md#navigation-and-source-map).
