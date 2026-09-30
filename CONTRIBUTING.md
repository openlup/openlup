# Contributing to OpenLup

OpenLup is in development preview. Contributions are welcome, but a source
checkout is not yet a stable framework release, a supported installation, or an
upgrade contract. The later `P1-SF` gate owns those commitments.

Start with the [platform documentation](docs/platform/README.md), then read the
[public agent guide](docs/platform/AGENT_GUIDE.md) before changing a platform
boundary. The [governance policy](.github/GOVERNANCE.md) owns contribution
admission, compatibility ownership, and maintainer capacity; accepting a pull
request does not automatically promote its subject to an official module.

For documentation changes, use the short [public writing profile and page
template](docs/platform/README.md#write-or-update-a-page). State which reader
and current preview it serves, verify commands from the stated working directory,
and separate current behavior from proposals or dated history. Correct the
owning page in the same contribution as a changed public contract; a link check
alone does not establish that an install or feature works.

## Contribution shape

Use a dedicated task worktree and branch for implementation; the coordination
checkout stays clean. Claude and Codex create that isolation automatically with
the configured repository helper before task edits, installs or tests. Continue
in an already assigned task worktree and leave other tasks' checkouts alone.

Record the outcome, scope, authority, acceptance, risk and execution/proof plan
compactly. Small tasks need no separate planning ceremony or specification.
Consider removing the cause or reusing an existing seam before adding a new
abstraction; explain a concrete benefit over a simpler alternative when needed.
Keep the accepted goal and guarantees fixed while execution notes evolve.
The [AI contribution policy](.github/AI_CONTRIBUTION_POLICY.md) owns accountability,
DCO, publication authority and independent native-session review.

Keep a change focused and explain its public contract, compatibility boundary,
and test evidence. Add or update tests for the behaviour you change. Provider
and runtime integrations must use documented ports and demonstrate both their
declared capability and their refusal behaviour without live provider access.

Do not include sensitive values, customer data, or deployment-specific details
in commits, issue reports, test fixtures, screenshots, or logs. Follow
[SECURITY.md](SECURITY.md) for responsible disclosure and sensitive-material
handling.

## Development-preview checks

Use the Node version recorded in [.nvmrc](.nvmrc), npm 11.19.0 (the
`packageManager` field of `package.json`), and the committed npm lockfile. From
the root of a materialized development-preview tree, these are the commands the
eight mechanical/diagnostic jobs of [Published Tree CI](.github/workflows/published-tree-ci.yml)
run; each comment names its job. The inherited `native-review` job additionally
checks exact-candidate admission when the maintainer enables `OPENLUP_NATIVE_QUEUE`;
its six required dependencies and merge-group metadata controls remain unchanged:

```bash
npm ci
# dco (needs no install): the commits your branch adds to origin/main
npm run check:dco-signoff -- "$(git rev-parse origin/main)" "$(git rev-parse HEAD)"
# typecheck
npm run lint
npm run oss:published-tree -- --typecheck
# install-proof (CI installs with: npm ci --prefer-offline --no-audit --fund=false)
npm run build
OPENLUP_REFERENCE_PROFILE=subscription OPENLUP_BUILD_OUT_DIR=dist-subscription \
  OPENLUP_SSR_OUT_DIR=dist-subscription-ssr npm run build:public-reference
# test: required coverage inherited from main
npm run test:required
npx vitest run server/runtime/public-reference \
  src/pages/account/v2/subscriptions/modals/RescheduleModal.test.tsx
npm --workspace ./packages/core run ci
npx vitest run scripts/oss-published-tree-check.test.ts
npx vitest run scripts/public-ci-neutrality.test.ts
# test-full: raw complete Vitest diagnostics
npm test
# self-check (needs no install)
npm run oss:published-tree -- --policy
npm run oss:published-tree -- --inventory
node scripts/public-ci-neutrality.mjs
node --experimental-strip-types packages/ui/smoke/neutrality.ts
# pgtap (Docker and Supabase CLI 2.98.2 required)
node scripts/public-ci-pgtap.mjs
# gitleaks 8.30.1, as CI pins it, over the checkout's history
gitleaks git . --config config/gitleaks.toml --redact --no-banner
```

The three `oss:published-tree` modes are distinct checks. `--policy` verifies
the public policy, catalogue, documentation ownership, generated navigation and
same-change documentation impact boundary; `--inventory` verifies the selected
tree, and `--typecheck` compares the preview's diagnostics with its tracked
compatibility debt. The source repository's aggregate typechecker is not part of
the projected command inventory and is not a substitute for `--typecheck`.
`check:dco-signoff` takes both range ends as full 40-character commit SHAs,
hence `git rev-parse`: it refuses a short SHA or a ref name with exit code 2,
and exits 1 on a range that contains no commit. In a fork, use the remote that
tracks `openlup/openlup` in place of `origin`. The subscription profile build
writes `dist-subscription/` and `dist-subscription-ssr/`, which `.gitignore`
does not cover, so do not commit them.

The native review session in `scripts/agent-review-session.mjs` checks committed
candidate lineage, complete prior coverage, closure dispositions, inherited
evidence expiry and the two-cycle repair/review budget. A bounded routine code
change gets one cold correctness review only when its actual paths avoid known
control and trust boundaries and that reviewer confirms ordinary semantics.
Sensitive, material or unknown changes still get two; a false routine assessment
requires two full reviews of the same committed candidate within the existing
budget. Run the focused
`scripts/agent-review-session.test.ts` regressions while changing that contract;
fixtures do not prove installed enforcement. Installed verification must refuse
workflow drift before expensive checks or replacement of prior logs, and acquire
a shared heavy-verification lock before running those checks. An existing lock
is refused without stealing it or disturbing another task's checks. The required
six-job commands remain unchanged; exact-candidate review evidence may be reused
by pre-push, but this process adds no general test-result cache. Prove actual
CLI and hook refusal paths in two dogfooding passes, batch material repairs, and
repeat affected scenarios before claiming live activation.

Published Tree CI also accepts `merge_group.checks_requested`. The six mechanical
jobs run against the queue's actual group checkout. DCO checks the complete
event-base-to-group range, including the synthetic tip; missing sign-off fails
without an exemption. Documentation impact uses the event's exact group base,
head, ref and tree, rather than inferring a PR head or using a stale local base.
The configured local verification mirror must exercise these same steps.

The additional optional `native-review` job is active only when the separately
approved repository variable `OPENLUP_NATIVE_QUEUE` is `enabled`. It runs after
all six actual mechanical successes and waits at most twenty minutes for a
receipt targeting its current run and attempt. Missing, stale, incomplete or
mismatched evidence fails. Turning on that variable, requiring the context and
enabling the queue are separate settings actions; merging the foundation does
not perform them. A skipped inactive job is not evidence of admission.

The supervisor obtains source reviews through fresh native agents in the same
task, then selects the observed Published Tree CI run, attempt and PR number.
From the task worktree, with `RUN`, `ATTEMPT` and `PR` set to those computed
values and `source-session.json` holding complete native state, create the
transport input:

```bash
node scripts/agent-review-queue.mjs input "$RUN" "$ATTEMPT" "$PR" \
  source-session.json > native-review-input.json
gh workflow run native-review-admission.yml --ref main --json < native-review-input.json
```

The second command is a GitHub write and requires the task's delivery authority.
The input command only creates JSON; it does not dispatch. For a queue tree that
differs from the reviewed source tree, append `group-session.json` to the input
command. That state carries two fresh full integration reviews of the exact
group base, head and tree with the same approved criteria. Do not copy a source
PASS or change the source branch to manufacture group evidence. Entire-tree
equality needs no additional review. The supervisor submits the receipt and
waits for actual CI admission within the same conversation; the maintainer does
not move prompts or reports. Compact input is limited to 56,000 bytes; oversize
evidence is refused, never truncated.

The main-only dispatch reads candidates as Git objects and uploads a validated
artifact; it runs no model and executes no candidate code. Required admission
rechecks artifact provenance, native evidence expiry, the PR head and live
queue identity before success. See the [queue follow-up plan](docs/platform/plans/autonomous-reviewed-delivery.md#approved-native-queue-follow-up-wave)
for the one-source pilot, bounded rebuild recovery and activation falsifiers.
Freshness is checked at admission, not guaranteed at the later merge; same-name
checks from a malicious writer remain outside this process-evidence boundary.

The complete projected root command inventory is `build`,
`build:public-reference`, `build:public-reference:client`,
`build:public-reference:prerender`, `build:public-reference:ssr`,
`check:dco-signoff`, `guard:client-secret-boundary`,
`guard:public-reference-site-routes`, `lint`, `prelint`,
`oss:published-tree`, `packages:check`, `pretest`, `pretest:required`,
`release:bump`, `test`, and `test:required`.
`npm run build` is the public build truth; its public-reference subcommands and
guards are internal links in that bounded chain. Published Tree CI invokes the
build, required root coverage, complete diagnostics, DCO check, and publication checks from this inventory.
Adding or renaming any source package command requires reclassifying the whole
source command-name inventory before a new preview can be materialized.

`npm run lint`, `npm test`, and `npm run test:required` each run their npm
`pre*` hook first to build `@openlup/core` from the workspace before root
imports need its `dist`. The hooks invoke only the core workspace build; they
do not invoke the root `build` or each other. Direct `node scripts/run-vitest.mjs`
calls bypass the npm lifecycle hook and require a prior core build. Direct
`eslint` calls also bypass the hook but do not import core `dist`.

`npm run lint` runs ESLint over the tree, including the import boundaries in
[eslint.config.js](eslint.config.js): a package under `packages/` imports
nothing outside its own directory, other code reaches a package only through
the subpaths its `exports` declare, and domain code under `src/domains` and
`server/domains` imports no provider SDK and no adapter, infrastructure,
runtime or route code; the config exempts domain tests. An exact alias in the
root `package.json` `imports` map counts as such code when any path it can
resolve to lies in one of those directories, including a path selected by a
condition, since Node allows a condition object as a target. A subpath pattern
alias such as `#name/*` is not matched as a pattern. Published Tree CI runs lint
in the `typecheck` job.

The projected `npm test` command owns the complete root Vitest test
scope. The independent `test-full` job invokes that command without restating
the directories and preserves its raw failure result. The required `test` job
uses `npm run test:required`, which retains every former main selector in order,
then runs the existing subscription, core and materialized contract checks plus
the neutrality CLI falsifiers. Run `npm test` for the complete public diagnostics
and narrower paths while iterating. Required success is not complete-suite success. The root Vitest
configuration does not collect the standalone `packages/core` test suite with the root configuration. From the repository root, run
`npm --workspace @openlup/core run ci` for that package's separate checks
(equivalently, use its local command from the package directory). Published Tree CI
invokes this package command separately, including its coverage, release gates and
packed-consumer checks. A green root suite alone still does not prove those checks.
CI also builds the opt-in subscription profile and runs its runtime composition
tests plus the existing renewal modal tests. The disposable database and browser
journey has its own evidence; a build or mocked test does not stand in for it.
The required test command also includes the source preview release falsifiers
(`scripts/source-preview-release.test.ts`) and, under `scripts/packages`, the
package release-shape checks and the test that loads the lint configuration
with a conditional `imports` map.
The public test job separately runs the materialized command-contract
falsifiers, which also run in the complete root scope.

`npm run packages:check` checks every `packages/*/package.json` against
[`config/openlup-packages.json`](config/openlup-packages.json), which lists each
package as released or as unreleased. A released package has the one lockstep
version, exact pins to other released `@openlup/*` packages, registry semver
ranges for every other dependency, and curated `exports`: no wildcard or
directory entries, and every target under `./dist/` except a `core-source`
target, which stays under `./src/`. It is either `private: true` or carries
exactly the public, provenance-backed `preview` publication settings and a
`repository` entry. An unreleased package is always `private: true`.

`npm run packages:check -- --pack` also builds and packs each released package
into a temporary directory, from a package directory with no uncommitted
changes. Every packed file must be either a tracked file of that package, byte
for byte (the manifest included), or built output of a tracked non-test source.
It refuses source maps and source-map references, build-machine home paths, and
the operational coordinates the public detector knows. It prints each tarball's
integrity. `-- --out <dir>` implies `--pack`. It keeps each publishable
package's tarball in an empty directory, with a `packages-manifest.json` of
their digests. `-- --release-tag openlup-source-preview/<n>` requires the lockstep
version to be `0.<n>.0`. The command publishes nothing; the package preview
channel in [`.github/VERSIONING_AND_EOL.md`](.github/VERSIONING_AND_EOL.md)
describes how a publication is staged.

The root test command has no directory or file filters. It collects the shipped
Node and DOM tests under `api`, `mcp`, `scripts`, `server`, `src` and `tests`,
including `src/lib/*Boundary*` and `*Guardrails*`. Playwright specifications
retain their separate browser/profile runners; the root Vitest command does not
claim browser journey evidence.

The `pgtap` job uses Supabase CLI **2.98.2** and a fresh local database stack,
replays the shipped managed baseline and every published forward in filename
order, with its public prerequisite SQL, then runs
all `supabase/tests`. It stops only its own project in a `finally` block. It
never links a hosted database or installs application seed data. It copies the
shipped tests unchanged, without settlement parameters or generated fixtures.
Replay uses a disposable diagnostic PostgreSQL owner with closed default grants;
assertion helper grants cover only pgTAP extension members. This profile is not
production installer authority. The pinned image workaround disables denial-hint
formatting only; role identities and permission refusals remain. Run
`node scripts/public-ci-pgtap.mjs` with Docker and the pinned CLI locally.

The self-check job runs the existing UI neutrality gate and a tree-wide ratchet
that reuses both that gate's patterns and the core source scanner. The initial
[`neutrality baseline`](config/openlup-neutrality-baseline.json) records the
counts on main at its full `sourceCommit`. Counts are pinned per exact path
(SHA-256 key) and category: a decrease elsewhere cannot pay for an increase.
Text files are scanned regardless of extension; binary files are inventoried.
The job also rejects baseline increases relative to the PR base/main push's
previous commit. For a first baseline, or to regenerate from main without
increasing debt, use `node scripts/public-ci-neutrality.mjs --write-baseline`.
After removing debt, lower the affected counts; never raise them.

The [known-red record](docs/platform/plans/public-ci-known-red.md) names the
measured failing or aborted files, reasons, incomplete obligations and triage
ownership. `test-full` and `pgtap` expose raw failures in separate diagnostic
jobs. They do not suppress tests or normalize exits. Installation, database
start/replay/cleanup and unexplained new failures block delivery; naming those
failures does not waive broken CI. The six existing required contexts retain
their coverage, with blocking lint and neutrality. Promoting diagnostic jobs to
required checks is the maintainer's ruleset decision; this contribution changes
no repository settings. Release workflows still check those six contexts, so a
red diagnostic result is not automatically a release refusal.

Documentation falsifiers are imported by the existing materialized
command-contract test entrypoint. Run
`npx vitest run scripts/oss-published-tree-check.test.ts` for routing, source-impact,
bare-runtime CLI and bundle corruption cases. Those tests create disposable Git
fixtures; they do not publish or validate the meaning of arbitrary prose.
See [Documentation maintenance](docs/platform/DOCUMENTATION.md) for regeneration,
exact comparison bases and clean versus local-draft exports. The public self-check
uses Node built-ins and repository code without installing dependencies.

A change can be released as the next source preview when the required checks of
Published Tree CI pass and its tree describes itself: the publication catalogue
lists every tracked path, and `config/openlup-source-release-contract.json`
matches the tree's bytes. Adding, removing or renaming a file, or changing a mode
or a dependency, is releasable on those terms. Before it tags, the release
workflow checks the target against the previous preview with
`assertDescendantSourceRelease` (`scripts/oss-source-release-contract.ts`). That
check admits additive forwards under
[Data and migrations](docs/platform/DATA_AND_MIGRATIONS.md#additive-forward-release-path).
It refuses edits or deletions of migration history, non-expand-only SQL, a
non-prefix portable manifest, bootstrap SQL changes, database schema types
(`src/integrations/supabase/types.ts`) and policy registry changes
(`config/openlup-policy-registry.json`). Such a change can be merged, but say so
in the pull request. [Versioning and EOL](.github/VERSIONING_AND_EOL.md#publish-refuse-and-recover)
states the complete rule. A preview carries no release asset; GitHub's release
attestation of the immutable release covers its annotated tag.

The workflow's prepare step also refuses, before it tags, a preview while a
tracked code file carries a removal marker
(`// openlup-remove-before: openlup-source-preview/<m>`) naming that preview or
an earlier one, or a comment line starting `// openlup-remove-before:` that does
not parse. Temporary compatibility files use such a marker so that a preview
cannot ship them past their announced removal.

The maintainer prepares the next npm preview version with `npm run release:bump -- <n>`
before the cut of `openlup-source-preview/<n>`. The command updates only the
lockstep package version carriers and the publishable package changelog. The
release workflow checks and packs that exact version before asking for release
approval; npm still stages the package for separate maintainer 2FA approval.

A new or renamed path also needs its row in
`config/openlup-publication-catalog.json`. After changing that catalogue, a
`package.json` or a `package-lock.json`, regenerate the contract from the
repository root and commit the result:

```bash
node --experimental-strip-types --input-type=module - <<'NODE'
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { SOURCE_RELEASE_CONTRACT_PATH, deriveSourceReleaseContract } from './scripts/oss-source-release-contract.ts';
const { contents } = deriveSourceReleaseContract((path) => existsSync(path) ? readFileSync(path) : undefined);
writeFileSync(SOURCE_RELEASE_CONTRACT_PATH, contents);
NODE
```

The snippet keeps the contract's identity and `compatibility` and rewrites its
digest fields; on an unchanged tree it rewrites the same bytes. The release
workflow's descendant check enforces the complete self-consistency, byte for byte,
before a preview is tagged. CI checks only part of it: `npm run oss:published-tree -- --inventory`
compares several digest values with the tree, but not `inventory.classDigest`
and not the contract's bytes.

The [install support policy](.github/INSTALL_SUPPORT_POLICY.md) and
[publication completeness policy](.github/PUBLICATION_COMPLETENESS.md) describe
what the preview can and cannot demonstrate. They do not turn a preview checkout
into a stable or supported artifact.

<!-- openlup-doc-impact {"unit":"tooling","digest":"sha256-c5ddbf2ebd1ff1a2ec65dcaf3702606c47b2a1989ef396995b60fa856748562f","reason":"Tooling delta. Dead scripts with no importer or command are deleted: the core CI scope and its test, and the neutralization projection. The publication contract keeps only its live exports, the coordinate detector keeps only its detection, and the published-tree output keeps its inventory helpers. Contract validation now refuses any contract that carries the retired downstream sourceSeed field, where it used to accept a well-formed one; the publication falsifier pins that refusal. The policy parser drops a refusal for a downstream plan directory that catalogued, tracked policy paths already exclude. The accounting parity test drops two cases that read absent metadata, the neutrality proof test drops probes for withheld modules this tree never had, the publication falsifier drops cases for the deleted helpers and uses a neutral withheld-guard fixture, and other script comments name things by role. The development preview checks and commands described here and the frozen required-test floor are unchanged."} -->

<!-- openlup-doc-impact {"unit":"repository","digest":"sha256-9d6dd859e0bfc53517090e495f8a552da3f42e8737ba60f1c9cc7b37904a3fd0","reason":"Repository configuration delta. The component generator configuration no longer names a Tailwind config file, the API TypeScript configuration drops an include entry for a file this tree does not have, the application TypeScript configuration drops a pointer to a planning document, and two comments name things by role. The tests TypeScript configuration is unchanged. The development preview checks and every required command described here are unchanged."} -->

<!-- openlup-doc-impact {"unit":"tests","digest":"sha256-911504d9cde1ff7490c75b1ae19b7ec0f7d4b4b5afc25d9b03bea63c88904119","reason":"Comment-only delta. Preview specs and helpers name withheld files by role instead of by path. The required test selectors, the frozen floor and the checks described here are unchanged."} -->

## Pull requests

The [autonomous delivery plan](docs/platform/plans/autonomous-reviewed-delivery.md)
uses the supervisor in the current conversation to launch independent
fresh-context subagents under the existing subscription. The maintainer controls
scope and delivery authority without reading every diff or transferring prompts,
reports or authentication between sessions. The same contract applies to Codex,
Claude Code and future agents; no model API, backend or new host is required.

Use one initial bounded review for ordinary prose or narrow routine code,
with two independent parallel reviews for sensitive or material behaviour,
executable instructions, contracts, controls and unknown risk. Review the exact
committed candidate without author history or another reviewer's verdict.
Record actual platform observations and complete findings;
blockers demonstrate an effect on correctness or acceptance, while optional
advice cannot block or require another edit after acceptance is satisfied.

Commit repairs before review. Complete prior coverage and validated exact lineage
allow one fresh cold closure review of a narrow repair within unchanged intent,
scope and base. Supply neutral prior finding cards and actual repair/interactions,
never old verdicts or author history. The reviewer independently confirms semantic
risk; control, security, schema, executable instruction and unknown repairs need
two focused reviews regardless of filenames. Account for every prior material
finding and preserve inherited expiry; unavailable or expired coverage requires
two fresh full-scope reviews. Carry the two-cycle repair/review budget through
prepare and full-review escalation. Exhaustion stays blocked while the supervisor regroups
within existing authority. Changed intent requires explicit regrouping; an
ancestor-preserving base integration gets fresh full-scope review within the
same budget.
Handle `needs_agent_review` in the active task without asking the owner to repeat
approved behaviour. After criteria, review and checks pass, stop optional edits
and proceed only through authorized delivery steps.

`scripts/agent-review-session.mjs` binds process evidence to the candidate,
intent, scope and reviewer results. Installed verify and pre-push must refuse
missing, stale, partial or unresolved evidence; live enforcement is claimed only
after installed refusal tests pass. These receipts do not cryptographically
attest remote agent execution or establish hard author/signer OS separation.
The merged authenticated verifier/controller and hosted observer remain optional
libraries, not requirements for an external model service. Existing mechanical
checks, DCO and applicable publication/merge authority remain required.

Reuse the compact task record in the PR description instead of writing another
manual. Explain material deviations, evidence and remaining limitations. Review
must assess correctness, approved scope and whether unnecessary complexity adds
maintenance cost; findings need a concrete mechanism and effect, not a quota.

Include the affected documentation owners and what changed in their explanations.
For a scoped no-impact record, challenge its reasoning as well as its fresh
fingerprint: a hash identifies the delta and owner text, not semantic correctness.
Keep generic corrections upstream; separately owned applications document their
selected immutable release and own composition. Their private operations and
adoption state are not public platform documentation inputs.
Read the [AI contribution policy](.github/AI_CONTRIBUTION_POLICY.md) before
submitting material AI-assisted work. Human accountability and DCO, independent
native review, and actual task publication authority remain required.

Use one concern per pull request. Describe the problem, the public contract that
changes, compatibility implications, and the checks you ran. Keep adopter-owned
brand, content, catalogue, local policy, and business-specific integrations out
of generic platform changes unless the proposal explicitly establishes a public
extension seam and a compatibility owner.

<!-- openlup-doc-impact {"unit":"public-policy","digest":"sha256-5bb2e80c19164bd0c6a922777d341fa2f84f2dcb09393efdc5124f5530f02c7c","reason":"Deletion delta. The actionlint configuration is deleted; its only entry suppressed an input warning for a workflow this tree does not have. The pull-request policy and checks described here are unchanged."} -->

## Developer Certificate of Origin

Every commit in a contribution must carry a sign-off:

```text
Signed-off-by: Your Name <your.email@example.com>
```

`git commit -s` adds the line. It certifies that you wrote the contribution, or
have the right to submit it under the project licence, and understand that the
contribution and its sign-off are public and permanent. There is no CLA.

Before opening a pull request, verify the range with:

```bash
npm run check:dco-signoff -- "$(git rev-parse <base-commit>)" "$(git rev-parse <head-commit>)"
```

Published Tree CI validates the same sign-off requirement for each pull-request
commit.

## License

By contributing, you license your contribution under the Apache License 2.0 in
[LICENSE](LICENSE).
