# Development, diagnostics and preview releases

Status: development-preview guidance.
Audience and purpose: contributors and maintainers following a change from local
verification through a pull request to a package release on npm, or to an
optional source preview, which carries no package.
The current channel is evaluation-only; this process does not establish a stable
API, production deployment or supported adopter upgrade.

## Start with the right route

Run contributor commands from the repository root of a dedicated task worktree,
using Node 24 and npm 11.19.0. Package commands below explicitly select their
workspace. A maintainer's installed local helper may create that worktree and
mirror the required CI commands; it is not a public npm dependency. Other
contributors use the public commands in [CONTRIBUTING](../../CONTRIBUTING.md#required-and-raw-checks).
Never edit, install or test in a maintainer's coordination checkout.

The stages below are sequential, but CI jobs and Sonar analysis run in parallel.
Local success is preparation, not proof that a hosted run or release succeeded.
The step-by-step order for one change is
[Deliver a change](../../CONTRIBUTING.md#deliver-a-change).

| Stage | Trigger and executor | Checks and next step |
| --- | --- | --- |
| Local iteration | Contributor edits in the task worktree | Run a focused structural scan and tests for changed behavior; run whole-tree lint before committing. |
| Candidate preparation | Contributor commits with DCO sign-off | Native agent tasks obtain independent review of the exact committed candidate, bound to its fork point (`git merge-base HEAD origin/main`); a branch behind `main` stays verifiable and pushable without a rebase. Where installed, run `openlup-dev verify` on the clean committed tree; pre-push refuses a task-worktree push without its stamp. Elsewhere, run the required check commands. |
| Draft PR | Authorized branch push and PR creation | Sonar can analyze it. Published Tree CI jobs skip drafts; skipped jobs are not passing evidence. |
| Ready PR | Open/reopen a non-draft PR, push updates, or mark ready | Published Tree CI runs six mechanical checks and separate raw diagnostics. Submit the source receipt as soon as the PR is open and ready. Native admission waits for six actual successes and that receipt. |
| Merge queue | Auto-merge armed under merge authority requests a merge group; no rebase for freshness | Mechanical checks run on the actual group. The source receipt admits the group when the review carries over: an unchanged tree, or a group that is exactly the reviewed change on its base (checked with `git merge-tree`) whose net base change avoids the change's paths and the admission, identity-binding, dependency and migration machinery. Otherwise submit the run-keyed receipt with two integration reviews as soon as the group run exists. |
| Main | Squash merge produces a main push | Mechanical checks and raw diagnostics run again; Sonar updates its main analysis. Native admission does not run on main pushes. A merge is not a release. |
| Package release | Authorized dispatch of `publish-package.yml` for a reviewed main SHA, package `all` (the set) or one package, the version, and exact notes | Unprivileged preflight refuses while any package release or publication is in flight, checks ancestry, contexts and versions, packs and scans every tarball, and decides each package by its tag, release and npm state before protected release approval. One approval covers the set; the release App creates each annotated tag `openlup-<package>-v<version>` on the target and its immutable release. |
| npm | Published package-release event from the release App | Package workflow independently checks identity, tag and tarball, re-reads npm, then publishes with OIDC provenance under `latest`. Verify its observed result; publication does not update an adopter. |
| Source preview (optional) | Authorized dispatch for reviewed main SHA, next ordinal and exact notes | A source snapshot with no package. The release workflow validates the tree, creates and verifies the immutable source preview. |

Dependabot PRs are a special case: Published Tree CI selects them only for a
human `ready_for_review` event. They are update signals, not a direct merge
route; apply accepted changes on a signed branch with regenerated contract bytes.
See the comments in [Dependabot configuration](../../.github/dependabot.yml).

## What each diagnostic proves

Commands in this table run from the task worktree's repository root unless a
workspace is explicitly selected. Detailed selectors, prerequisites and limits
remain in [contribution checks](../../CONTRIBUTING.md#development-preview-checks).

| Tool or command | Purpose and execution owner | Blocking status and evidence |
| --- | --- | --- |
| `npx --no -- ast-grep scan --error=no-suppress-all --error=unused-suppression <changed-path>` | Fast local structural feedback after edits; installed pre-commit scans staged TS/TSX. | Fix violations before committing. Keep `--no --` to avoid fetching another package. CLI output names the rule. |
| `npm run lint` | File-wide suppression hygiene, ast-grep scans/rule tests, ESLint and import boundaries; local and CI `typecheck`. | Required. npm prelint builds core first; it is not just formatting. |
| `npm run oss:published-tree -- --typecheck` | TypeScript projects checked against tracked preview compatibility debt; local and CI `typecheck`. | Required. Not equivalent to claiming zero compiler diagnostics. Build core first when invoking directly after source edits. |
| `npm run oss:published-tree -- --policy` and `--inventory` | Publication classification, documentation ownership/impact/navigation and tree inventory; local and CI `self-check`. | Required. These check structure and recorded obligations, not the truth of arbitrary prose or runtime behavior. |
| `node scripts/public-ci-neutrality.mjs --base-commit <full-base-sha>` and UI neutrality smoke | Tree-wide shrink-only neutrality and portable UI boundary; local and CI `self-check`. | Required. Use the exact event/comparison base, not a guessed latest main. |
| `npm run test:required` plus the other CI `test` steps | Protected root selectors, subscription composition, package CI and tooling falsifiers; local and hosted. | Required. Root required tests alone do not cover all these steps. |
| `npm --workspace @openlup/core run ci` | Package coverage, runtime imports, type smoke, API snapshots, docs, release checks and packed-consumer smoke; local and CI `test`. | Required through the test job. Separate from root Vitest discovery. |
| `npm test` | Complete root Vitest diagnostics; local and CI `test-full`. | Raw diagnostic, not a required GitHub status. Preserve actual failures and compare the exact base before attributing regressions. |
| `node scripts/public-ci-pgtap.mjs` | Shipped SQL tests against a disposable managed baseline; local and CI `pgtap`. Requires Docker and the pinned Supabase CLI. | Raw diagnostic. Start, replay, cleanup failures and unexplained new failures block delivery under contribution rules. |
| `npm run build` and subscription-profile build | Install/build proof for reference profiles; local and CI `install-proof`. | Required. A build does not prove a browser journey, live provider or production deployment. |
| `npm run check:dco-signoff -- <full-base-sha> <full-head-sha>` | Sign-off on the full commit range; local and CI `dco`. | Required. Empty ranges and malformed identities are not success evidence. |
| Gitleaks | Secret scanning of Git history in CI `gitleaks`; unpacked tarballs in release preflight and package workflow. | Required in those owners. Use pinned configuration/version and redacted logs; it is distinct from local publication leak checks. |
| Native session review and `native-review` | Independent semantic review bound to candidate, scope and criteria; hosted receipt admission after mechanical success. | Required for registered agent tasks; hosted status depends on explicit activation. Review does not grant publication or release authority. |
| SonarQube Cloud automatic analysis | Additional security/reliability findings on PR pushes and main, using configured source/test scope. Runs in Sonar Cloud, not a local scanner or Actions job. | Advisory pilot; no required status, coverage import or per-PR token/login. A hotspot needs contextual review, not automatic classification as a vulnerability. |
| Dependabot | Scheduled dependency/Actions update proposals; security-update activation is a separate repository setting. | Triage signal, not test evidence or automatic approval. |
| `npm run packages:check -- --out <outside-checkout-directory> --release-tag openlup-<package>-v<version>` | Package versions, exports, packed contents and consumer boundary; local release preparation and hosted pack/preflight. | Release prerequisite. Does not publish. Check the exact candidate, not just its package manifest. |
| `gh release verify <tag> --repo openlup/openlup` | GitHub attestation of the immutable release/tag; maintainer preparation and hosted release/package workflows. | Release evidence. It does not establish npm publication or an adopter installation. |

Core's `ci` includes license allowlisting, production-dependency SBOM and audit,
pack budgets, declaration snapshots and publish-control checks. See its
[command manifest](../../packages/core/package.json),
[release gates](../../packages/core/release-gates.json) and
[contribution guide](../../packages/core/CONTRIBUTING.md).
Root dependency updates and core's production audit are different scopes.
Playwright specifications and explicit database/browser reference evaluation do
not become mandatory per-PR execution just because their files exist; follow
[execution ownership](../../CONTRIBUTING.md#development-preview-checks) and the
[selected subscription evaluation](SUBSCRIPTION_REFERENCE.md).

## Local maintainer layer

Where installed, `openlup-dev doctor` diagnoses prerequisites and installation
or workflow-mirror drift. It is not a substitute for candidate verification.
After committing and recording required native reviews, `openlup-dev verify`:
- checks the workflow mirror and the shared lock;
- runs the mechanical equivalents locally, in an environment like a hosted
  runner's: a temporary directory outside every checkout, four Vitest workers
  and no global Git identity;
- runs the raw `test-full` and pgTAP diagnostics only with `--diagnostics`, or
  pgTAP alone when the range reaches database inputs;
- adds publication leak checks and advisory release eligibility.

Its logs identify each command and exit code. Read `REQUIRED PASS` separately
from `DIAGNOSTICS RED`. A pass on a worktree that stayed clean for the whole run
records a stamp of that exact tree.

Installed pre-commit checks staged structural violations; commit-message checks
require the configured identity and sign-off. Pre-push rechecks current review
and publication leak evidence. In a task worktree it also requires the
verification stamp of the exact pushed tree; it does not rerun verification. A hook pass
is not a hosted CI pass. `leak-check` inspects what the range would publish;
`release-check` is advisory and can report `CANNOT-DECIDE`. Neither replaces
release prepare or release attestation. Installation and changes to this local
layer remain maintainer-controlled and outside the public tree.

## Reading results and recovering

At the 2026-10-04 checkpoint, merged main was
`e7f352bd788c6f2557316c3abde5e000772d583d`: [run 37196000352, attempt 1](https://github.com/openlup/openlup/actions/runs/37196000352)
passed six mechanical checks and `test-full`; `pgtap` retained twelve named
failing files, and native admission was skipped on the main-push event.
The [current diagnostic record](plans/public-ci-known-red.md#current-checkpoint)
gives source/group/main provenance, assertion counts and remaining obligations.

The 2026-10-02 settings inspection found the native queue and npm-stage
variables enabled and the ruleset requiring six mechanical statuses plus
`native-review`. This is dated activation evidence, not a promise about another
repository or future settings.

An aggregate Actions workflow can be red while its required statuses are green.
Inspect the individual job and its raw log, exact SHA, event, run and attempt.
Skipped, cancelled or timed-out execution cannot prove a passing check. The
[diagnostic debt record](plans/public-ci-known-red.md) distinguishes the current
finite SQL debt from archived failures; neither is permission to ignore a red
run. Compare failures with the exact base; disclose new failures and missing
execution. Required success is not complete-suite success.

Fix named local violations rather than bypass hooks. A busy verification lock
belongs to another run; wait without removing it. A pre-push refusal for a
missing stamp needs `openlup-dev verify` on the clean committed tree. Workflow-mirror drift needs
maintainer recovery, not an alternate verifier. The supervisor handles missing
native-review evidence in the active task with fresh independent reviewers;
retain lineage and the existing two-cycle budget. Optional review advice does
not add acceptance obligations. A `native-review` timeout is a missing or late
receipt, not a review failure; in a merge group, the job log names why the
source receipt did not carry over. For its recovery, see the receipt-timeout rule in
[Merge queue](../../CONTRIBUTING.md#merge-queue). See [review policy](../../.github/AI_CONTRIBUTION_POLICY.md#admission-native-review-and-dco)
for the complete protocol.

For Sonar, fix confirmed new defects in the PR and inspect the next analysis.
Triage existing findings separately by impact; do not bulk-clean unrelated code
or turn a pilot gate into a required check without a new decision. If App access
is revoked, analysis may stop; it is not a new merge blocker in this pilot.

## Releasing a package

While `@openlup/core` is below 1.0, the `@openlup/*` packages are released as
one set, independently of source previews: one set version `0.N.P` from one
commit, a tag `openlup-<package>-v<version>` per package at that commit, and
every package republished in each set. A patch set only fixes; any API,
behaviour or schema change is a minor set. Today the set has one package,
`@openlup/core`, and its first set is `0.12.0`. Source preview 11, which
published `@openlup/core` `0.11.0` on the `preview` dist-tag, was the last
lockstep cut that also published a package.
The [versioning policy](../../.github/VERSIONING_AND_EOL.md#package-releases)
owns release permissions, setup, detailed refusals and recovery. The sequence is:

1. Prepare the next set version, above every version npm holds, with
   `npm run release:bump -- --set <version>` in a reviewed ordinary PR. It sets
   every publishable package and every exact internal pin on one, and opens each
   changelog's version section below a fresh Unreleased heading. A version bump
   by itself publishes nothing.
2. Select the exact reviewed main commit that carries the version and check its
   six mechanical contexts, then run `packages:check` with `--release-set <version>`.
3. With explicit authority, dispatch `publish-package.yml` from main with package
   `all`, the set version, the exact SHA and reviewed note bytes. Its unprivileged
   preflight refuses while any package release or publication is in flight, checks
   ancestry, contexts, the set version of every publishable package and, for a
   patch set, each unchanged API snapshot. It packs and scans every tarball, then
   decides each package by its tag, release and npm state, before protected
   `release` approval; dispatch itself is not approval. The release gate that
   decides ancestry, contexts and the tag's commit runs as it is at the dispatched
   main commit, never as the target's copy. A single package name still releases
   that one package, from nothing only.
4. After one owner approval, the release job runs once per package to release:
   it repeats those checks without installing or packing, then the release App
   creates the annotated tag `openlup-<package>-v<version>` and draft, validates
   the same draft ID and publishes the immutable release. Verify each completed
   release's exact note bytes, identity and GitHub attestation.
5. The App event starts package packing and independent release/tag checks. The
   `npm-stage` job verifies the tarball digest, re-reads npm and publishes with OIDC
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
remain in CONTRIBUTING, release rules in VERSIONING_AND_EOL, review rules in the
AI contribution policy, and documentation upkeep in [DOCUMENTATION](DOCUMENTATION.md).
Update this overview with the behavior it explains, regenerate navigation through
`npm run oss:published-tree -- --policy --docs-update`, and retain existing
same-change ownership checks instead of introducing another diagnostic registry.
