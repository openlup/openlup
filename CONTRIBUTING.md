# Contributing to OpenLup

OpenLup is in development preview. Contributions are welcome, but a source
checkout is not yet a stable framework release, a supported installation, or an
upgrade contract. The later stable-framework gate owns those commitments.

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

## Use a package or contribute source

For an application task, start from your application's root with Node 24 and
npm 11.19.0: `npm install --save-exact @openlup/core@<version>`, where `<version>`
is the current set on npm (`npm view @openlup/core version`); install every
`@openlup/*` package you use at that same version. Read the installed
`AGENTS.md` and its [typed wiring example](packages/core/AGENTS.md#wiring-example),
then use the [adopter route](docs/platform/adopter-kit/README.md). No OpenLup
clone or contributor check is needed to compose an installed package. Your
application's instructions and task authority govern that work.

The remaining commands in this guide require an OpenLup source checkout.

## Contribution shape

Before planning a module or npm name, follow the canonical
[package placement decision](docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#package-placement-decision-canonical).

Before implementing, obtain the accountable human's task scope and the applicable
maintainer authorization under the [AI contribution policy](.github/AI_CONTRIBUTION_POLICY.md).
Record whether it covers only local work or also publication, pull-request
submission and merge. Review evidence cannot extend those rights.

A new explicitly approved bounded module programme may include implementation
and set-version preparation in one pull request under
[package release policy](.github/VERSIONING_AND_EOL.md#package-releases).
Delivery or merge delegation applies only when the applicable maintainer-local
policy and that programme explicitly grant it; this guide does not activate it
or extend existing tasks. The [agent guide](AGENTS.md#change-and-verification-rules)
owns freshness, required maintainer reads and the retained authority boundaries.

Use a dedicated task worktree and branch for implementation; the coordination
checkout stays clean. Claude and Codex create that isolation automatically with
the configured repository helper before task edits, installs or tests. Continue
in an already assigned task worktree and leave other tasks' checkouts alone.

If no maintainer helper is configured, use ordinary Git isolation. In a local
fork, `origin` normally names your fork: add `upstream` for
`https://github.com/openlup/openlup.git` if needed. From the coordination checkout,
the following example uses a new task name `my-change`:

```sh
git fetch upstream main
OPENLUP_BASE="$(git rev-parse upstream/main)"
git worktree add -b codex/my-change ../openlup-my-change "$OPENLUP_BASE"
cd ../openlup-my-change
```

Retain that full base SHA in the task record, then install and run the public
checks in this task worktree. A maintainer helper, native review access and
upstream write rights are not prerequisites for preparing a local contribution.

Record the finite observable outcome, smallest complete scope and exclusions,
authority and delivery boundary, acceptance and sufficient completion evidence,
risk and execution/proof plan compactly. Plans and handoffs inherit these boundaries
under the [agent guide](docs/platform/AGENT_GUIDE.md#change-and-verification-rules);
discoveries do not automatically add obligations. Small tasks need no separate
planning ceremony or specification.
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

### Contribute existing adopter code, then refactor

Code that already runs in an adopter's application reaches OpenLup in a fixed
order, so that the adopter can later replace its own copy without any change
its users or operators can observe.

1. **Characterize first.** Before contributing, the adopter writes tests in its
   own repository that pin the slice's current behaviour: results, errors and
   refusals. Rewritten with neutral names and synthetic data, they become the
   witness.
2. **Import with unchanged logic.** The first OpenLup pull request brings the
   slice with its logic unchanged, written fresh in the OpenLup worktree with
   neutral names, literals, copy and identifiers from the start; adopter files,
   history, tests and fixtures are never copied, and the neutrality rules apply
   from the first commit. Private values, customer data and deployment details
   never enter a commit.
   The witness lands in the same pull request as package tests, and the
   package's tests join the required test selection, so required CI runs them
   while the package is still unreleased. As with `packages/outbox`, extend the
   root Vitest configuration so `npm test` discovers the new package tests;
   the four hosted shards feed the required `test` aggregate.
3. **Refactor in later pull requests.** Each refactoring pull request keeps the
   witness unchanged. A refactor changes nothing a consumer can observe:
   results, side effects, ordering, errors and fault modes, operational logs,
   defaults, load order, policy, schema and SQL object names, configuration
   names, URLs, cron paths and persisted keys. A performance change qualifies only with identical
   observable results. Anything else is a behaviour change: propose and review
   it as one, with its own changelog entry, never inside a refactoring pull
   request.
4. **Check before release.** Before the release dispatch, the contributor packs
   the release candidate and gives the adopter its commit and tarball checksums;
   the adopter installs those tarballs without committing them and runs its
   characterization against them. A difference is fixed in OpenLup before
   publication.
5. **Adopt thinly.** The adopter replaces its copy by changing imports and
   adapter bindings only. It keeps its own persisted names and maps the
   package's neutral names in its adapter.

## Development-preview checks

Pricing P2a moves the incumbent authority, subscription policy and token suites,
and the pure error-mapping case, into platform `test/pricing/` discovery. Root
and package discovery already include this directory; no duplicate required
selector is added. The reference retains configuration/readiness composition
coverage and one browser-schema/error-identity binding guard. Both pricing
entries extend the existing optional-peer-free cold consumer and declaration
compilation.

The M05 catalog module relocates eight existing catalog suites into the platform
package's `test/catalog/` discovery, preserving their assertions. Root discovery
already includes that directory, so no duplicate selector or second invocation
is added. The reference observed-responder binding has one local guard. Both
catalog entries join the existing SDK-absent cold consumer and declaration
compilation; its installed witness checks the unchanged canonicalizer, authority
error identity, exact selection and unauthorized draft refusal. Local dirty-tree
checks do not replace the supervisor's committed-candidate package proof.


The installed communications consumer checks the exact contracts value inventory
and renders a synthetic message with network access refused and optional peers
absent. That entry contains pure rendering/building and copy-injected factories;
its browser gate measures the complete built runtime export closure. P3 changes
only this prior empty-value expectation and its rendering proof, retaining the
other installed-consumer, missing-peer and type checks.


The M04 communications import extends the existing platform consumer and required
selection with its retained reference witnesses. The isolated contracts entry
compiles without optional provider peers; the mixed server entry compiles after
selecting the existing PostgreSQL peers. Its packed proof checks no-egress capture,
optional-driver refusal, four exact canonical sparse SQL projections and durable
receipt replay, conflict and access refusal in the existing owned disposable
PostgreSQL lane. B3 adds useful installed polling, sync, recipient-directory and
consent operations after the complete canonical catalogue is installed by the
existing reference runner in a separately owned cluster. Negative fixtures reject
no-op stores, wrong tokens, false delivery and repeat execution; the required
native PG/binding selectors also cover upgrade, replay, ACL refusal and atomic
rollback. Managed paths, concrete mail protocol mapping and activation remain
reference-owned; no check, budget or clean-candidate gate is relaxed.
These additions do not create another runner or relax required coverage. The
producer still requires a clean committed candidate, so local uncommitted checks
must be followed by the supervisor's exact signed-candidate package gate. The
[M04 ledger](docs/platform/plans/oss-m04-communications-triggers.md#verification-ledger)
retains the cumulative case/time allowance and preview limits.

The platform packed consumer includes the opt-in OIDC adapter: imports and
construction remain inert without the selected JWT library, selecting an absent
library produces the documented availability refusal, and the direct account-link
store retains the optional PostgreSQL-driver refusal. Real issuer certification
is separate from this cold proof. Its disposable local recipe, prerequisite
refusals and command are owned by [identity conformance](docs/platform/IDENTITY.md#real-issuer-oidc-recipe);
it runs outside default CI and requires the cached pinned issuer image.

The runtime-forward checker also binds eight exact legacy policy retirements
by table, name and preceding CREATE POLICY statement hash. It requires their
ordered DROP statements before the fixed grants and rejects missing, duplicate
or additional policy operations. Both PR and release-history tests check these
refusals and require approval before the forward's introducing commit. These
checks admit one reviewed contraction; they do not grant general policy edits.

The reviewed runtime-forward checker admits an exact pinned five-function SQL
file and an optional identity capabilities file with fixed service-only client
writes, operator activation inserts and invitation email reads. Tests exercise both PR history and release
history admission, including independently repinned forbidden columns, roles,
writes, functions and changed execution attributes. The control must already
exist before the SQL feature's base and introducing commit. Passing these tests
is admission evidence, not proof that a draft overlay is the shipped chain.


<!-- openlup-doc-impact {"unit":"tooling","digest":"sha256-7754f9a24ad3a5e6f570d6599e69a966ef6655741c48b1bb48f041236192b975","reason":"The shared admission function and predicate refuse control characters other than tab and line feed in migration SQL (parser parity with PostgreSQL), with focused and tracked-rail regression tests. The Additive forward release path in DATA_AND_MIGRATIONS documents this refusal. Contributor commands, required test selection and gate order in this section remain unchanged."} -->

Start with the [development, diagnostics and preview-release sequence](docs/platform/DEVELOPMENT_AND_RELEASE.md)
for where each check runs, Draft/Ready/queue/main triggers, blocking versus
diagnostic results, and the source-to-npm handoff. This section owns the detailed
contributor commands; the overview links here rather than replacing them.

`npm run oss:published-tree -- --policy` also keeps agent guidance in place.
It refuses an `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` or `.cursor/rules` file
anywhere but the repository root or a package root. It also refuses an adopter
kit whose `docs/platform/adopter-kit/dependabot.template.yml` group misses a
published `@openlup/*` package. Move such a file or extend the pattern; do not
add an exception.

### Local stack bases and heavy verification

Ordinary independent pull requests use the existing fork-point base. Stacking
is optional. For an upper branch, export `OPENLUP_STACK_BASE=<full-predecessor-SHA>`
before documentation checks, native `prepare`/`record`/`verify`, and final local
verification. The pin must be an ancestor of HEAD and a descendant of its fork
point. It is the reviewed candidate's base; changing or
removing it does not reuse an old review. Documentation uses that same base,
including its no-impact fingerprints. Hosted event attribution still wins.

Review the upper change relative to this exact predecessor, with the predecessor's
contracts as context. Source and group admission independently require the
reviewed base to have reached actual `main`; an unchanged group tree cannot
waive that prerequisite. A predecessor-only landing
then preserves the upper candidate, coverage, reports, expiry and repair history.
Default unstacked reviews retain their existing fork-point refusal rules.

For each heavy final local command, use:

```sh
node scripts/agent-review-session.mjs verify-command --resource openlup:coverage -- npm run test:scoped
```

Keep every required command below, including package gates and coverage; this
wrapper adds no test selection, cache, stamp or authority. It first checks the
clean committed candidate, policy, inventory, predicted merge and native review.
When the predicted tree differs from HEAD, the existing policy/inventory checks
run on that combined tree in a disposable checkout. A conflict or stale aggregate
stops before expensive work; resolve by merging main and regenerate, never rebase
the reviewed lineage merely for freshness. This is local early feedback, not
hosted admission or a claim of deployment readiness.

Output exclusion is scoped to the real worktree, so separate projects and task
worktrees do not wait for unrelated output directories. When `ai-resource-gate`
is installed on PATH, the wrapper additionally uses its bounded host CPU/RAM
admission; CI and an already brokered process keep their existing scheduler.
Its resource key is per worktree; host capacity alone coordinates independent
projects. Select the existing broker profile for the actual command with
`--resource` (for example `openlup:coverage`, `openlup:build` or
`openlup:typecheck`). An installed broker requires this explicit selection;
the wrapper supplies no CPU, memory, worker-count or timeout policy of its own.
The broker's configured admission policy and refusal remain binding. A busy
worktree output lease refuses immediately. The lease is released only by its owner;
inspect a stranded owner before cleanup. Nested wrappers refuse immediately:
wrap the underlying required command once. The stack pin is removed from heavy
child environments so independent test repositories resolve their own bases.
Preflight is repeated after waiting, source identity is checked after execution,
and native review is checked again after success. A changed source or expired
review supplies no final evidence. Existing maintainer-local stamps and hooks
remain required where installed.

### Optional SonarQube Cloud diagnostics

The SonarQube Cloud OSS pilot uses one public project and automatic analysis of
pull requests and `main`. Its source and test scope is defined in
[`.sonarcloud.properties`](.sonarcloud.properties). Activation requires a GitHub
App installation and project import by an authorized organization owner; the
file alone does not activate scanning. Keep automatic repository import off.
The pilot adds no required check, scanner job, coverage run or package dependency.
Do not enable automatic and CI-based analysis on the same project.

Use custom JavaScript and TypeScript quality profiles focused on security
vulnerabilities, security hotspots and reliability rules that add a signal beyond
the current ESLint configuration. A hotspot is a request for contextual review,
not a confirmed vulnerability. Retain supported GitHub Actions and Docker security
rules. Keep existing import, port, neutrality, type, secret, migration, API and
publication checks authoritative; do not reproduce them as new Sonar obligations.
Compare individual overlapping rules before deactivating them in the Sonar
profile. Never disable existing repository controls to accommodate a finding.
Duplication and cognitive complexity are advisory; coverage is not imported in
automatic analysis and must not be a pilot gate condition. Keep the project gate
informational in GitHub, including for merge groups.

The scope retains entrypoints, domains, adapters, browser code, package source,
MCP and executable tooling together. Tests and fixtures are classified separately;
generated types, build output and PostgreSQL SQL are excluded from production
analysis. Check the first analysis for the expected source/test classification,
language coverage and unresolved TypeScript context. Incomplete analysis is not
a clean security result. Record the analyzed commit and active profiles when
assessing findings; a PR result needs a current target-branch analysis.

The PR author resolves confirmed new defects in that PR and checks the next
analysis. Triage existing `main` findings once, then select small regression-tested
repairs by demonstrated impact. Do not create issues automatically for every
finding or combine unrelated cleanup. Deduplicate findings by mechanism and
location, including Gitleaks findings. Record false positives or accepted cases
with a reason in Sonar; do not add blanket source suppressions. Follow
[SECURITY.md](SECURITY.md) for sensitive vulnerability details.

After 30 PRs or four to six weeks, whichever is later, assess additional confirmed
defects, false/duplicate findings, analysis latency and triage time. The pilot
targets at most 30 minutes of weekly triage after calibration. Runtime and useful
finding counts are measured outcomes, not promises. Required merge admission,
coverage import, multiple Sonar projects and automated remediation require a
separate decision after this evidence.

Configuration references: [automatic analysis](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/automatic-analysis),
[quality profiles](https://docs.sonarsource.com/sonarqube-cloud/standards/managing-quality-profiles/understanding-quality-profiles),
and [PR analysis](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/pull-request-analysis).

### Required and raw checks

Use the Node version recorded in [.nvmrc](.nvmrc), npm 11.19.0 (the
`packageManager` field of `package.json`), and the committed npm lockfile. CI and
release workflows pin Node 24.21.0, which bundles npm 11.19.0, so newer Node 24
releases cannot change npm beneath the existing assertions. `.nvmrc` pins the same
24.21.0 runtime locally; the npm contract is unchanged. From
the root of a materialized development-preview tree, these are the commands the
mechanical/diagnostic jobs of [Published Tree CI](.github/workflows/published-tree-ci.yml)
run; each comment names its job. The inherited `native-review` job additionally
checks exact-candidate admission when the maintainer enables `OPENLUP_NATIVE_QUEUE`;
its six required dependencies and merge-group metadata controls remain unchanged:

<!-- openlup-doc-impact {"unit":"public-checks","digest":"sha256-0f53d76126bb6c40cdd7bc03ed7114f24836b4ea75ee30c26a09c95d0e173568","reason":"Merge-commit landing support. The source-preview release preflights accept a target only on main's first-parent line, so a commit inside a pull request merged as a merge commit is refused; under squash history every main ancestor is first-parent, so behaviour there is unchanged. The required contexts and contributor commands described here are unchanged."} -->

Required root `test` accepts only success from all four `test-full-shard` jobs;
failed, cancelled or skipped shard jobs refuse it. Main-push reuse requires a
complete successful exact-commit merge-group run, including raw pgTAP.
See [Test scope and diagnostics](#test-scope-and-diagnostics) for selection,
sharding, discovery and test-author guidance.

The required `install-proof` job runs the shared package gate after both reference-profile builds, independently of the required `test` job in a separate checkout and installation. It discovers every publishable package from `config/openlup-packages.json` and its actual npm workspace, and refuses missing `api:check`, `ci:required` or `test:consumer` scripts before packing. The existing cold producer emits one current-set manifest. All API checks run before any package's `ci:required`, which receives the same verified manifest and exact checkout commit through `OPENLUP_PACK_MANIFEST` and `OPENLUP_PACK_COMMIT`. Cold preparation clears each workspace per target, so the API phase restores each package's built declarations and prerequisites through the existing build helper; it leaves the retained tarballs untouched and includes that cost in its timing. There is no missing-script skip or package-name routing table. A new module must supply installed-artifact consumer coverage, meaningful failure cases and its owning required batch; script declarations alone do not prove that those assertions are sound. Review checks that the batch actually invokes its consumer and preserves its required tests. Keep API checks out of that batch because the shared phase already runs them.

A module added to an existing distribution extends that package's consumer and
required batch; it does not need another npm workspace, runner or CI job.
Preserve the complete package proof and name the new module's behavior,
refusals and schema obligations. Grouping modules does not waive the
[internal dependency graph](docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#internal-boundaries-and-adapter-isolation)
or make multi-capability readiness available before its reviewed prerequisite.

For the planned foundation package and each later module that changes peers,
dependencies, public exports or the relevant import graph, extend the same
packed consumer with this cold proof before accepting the module candidate:

1. Install the actual core/platform tarballs and outbox when selected, with
   ordinary required dependencies and without optional provider SDKs. Verify
   their physical absence and independent resolution: no workspace links,
   repository or ancestor `node_modules` may supply them. `--omit=optional`
   alone does not prove isolation.
2. Classify the current export inventory and import every public nonadapter
   entry in a fresh process, without secrets, provider initialization or SQL.
   Compile its declarations in both NodeNext and Bundler mode without those
   SDKs; nonadapter declarations must not leak required SDK types.
3. Exercise the supported adapter's explicit, stable refusal naming the missing
   SDK or configuration, with no fetch, install or implicit fallback. Then
   install the selected SDK and run the adapter's actual consumer/conformance
   behavior and refusals without live provider access; mocking an import alone
   is insufficient.

Keep this in the existing required package gate. Cover the actual delta while
still importing all nonadapter exports after the change; final release proof
retains the complete required set. A failed cold consumer blocks candidate
acceptance even when unit tests pass. This specifies later foundation/module
proof, not a claim that today's core/outbox gate already tests platform.
Only schema-owning modules need database proof, including deterministic fresh
and upgrade/replay boundaries under the
[migration contract](docs/platform/DATA_AND_MIGRATIONS.md#module-catalogues-and-installed-histories).

Core's required batch retains coverage, standalone types, documentation, release checks and its supplied-artifact consumer. Outbox's batch owns schema/SQL/replay against its installed tarball; its unit/factory/admission tests run once through the protected root selectors. The outbox workspace builds after core for root lint and test entrypoints. Package-local import checks still reject private subpaths, cross-directory escapes, aliases and other workspace dependencies; portable outbox production source also rejects provider SDKs. Missing artifacts or a required runtime refuse; there is no workspace fallback or DB skip. Only modules with SQL obligations need a database. Outbox's pinned job-owned PostgreSQL service is separate from raw pgTAP; see [the rail guide](packages/outbox/README.md) for ownership and proof limits.

For communications characterization and mail-boundary witness evidence, see the
[communications contract](docs/platform/CANONICAL_CONTRACTS.md#communications-import-compatibility)
and [witness ledger](docs/platform/plans/oss-m04-communications-triggers.md).

```bash
npm ci


# Direct typecheck consumes built Core, Outbox and Platform declarations.
npm run pretest
# npm run lint and npm test also build all three through npm pre-scripts
# dco (needs no install): the commits your branch adds to origin/main
npm run check:dco-signoff -- "$(git rev-parse origin/main)" "$(git rev-parse HEAD)"
# typecheck
npm run lint
npm run oss:published-tree -- --typecheck
# install-proof (CI installs with: npm ci --prefer-offline --no-audit --fund=false)
npm run build
OPENLUP_REFERENCE_PROFILE=subscription OPENLUP_BUILD_OUT_DIR=dist-subscription \
  OPENLUP_SSR_OUT_DIR=dist-subscription-ssr npm run build:public-reference
# install-proof: package gates after both builds on a clean signed candidate
# Keep package gates before root tests locally: one checkout shares build outputs.
GATE_PACKS="$(mktemp -d)"
# Local SQL proof owns one ephemeral PostgreSQL container; CI passes its job service identity/port.
node --experimental-strip-types scripts/packages/required-package-gates.ts \
  --out "$GATE_PACKS" --expected-commit "$(git rev-parse HEAD)"
# test: omit bounded tooling fixtures whose inputs are untouched, including dirty files.
npm run test:scoped
# Hosted test-full-shard runs four parallel independent installations, each with:
# node scripts/ci-test-scope.mjs (OPENLUP_VITEST_EXCLUDE_FILE points to runner temp)
# npm test -- --shard=N/4 (N = 1, 2, 3, 4)
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

The `prelint` and `pretest` scripts build Core, Outbox and Platform in dependency
order. Before direct typecheck or Vitest commands after install or package-source
edits, run `npm run pretest`; otherwise consumers may read stale `dist/` exports.

For the managed pgTAP runner, prerequisites and proof limits, follow
[Test scope and diagnostics](#separate-db-package-and-coverage-proof).

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

The required root shard jobs fetch complete Git history so their
neutrality CLI falsifiers can read the exact pinned prior fixture blobs. This
preserves their selectors and refusal assertions while supplying the history
those assertions require.

The native review session binds the committed candidate to its fork point (or
`OPENLUP_STACK_BASE` pin), tree, intent and fresh reviewer reports. Stable
material finding IDs require closure; evidence expires 24 hours after the
earliest counted PASS report for the current candidate. Unchanged prepare
preserves evidence. Three repair cycles are automatic; `needs_owner` then
requires an owner decision recorded with `continue "<note>"`, adding three.
A rethink remains recommended practice. `prepare --new` records a changed
intent or a rebase in the same append-only session history; findings, reviewers
and the repair count carry on. Only `continue` adds cycles. Put the
simplicity pre-check in the first review request as prose. See the
[native session interface](docs/platform/plans/autonomous-reviewed-delivery.md#native-session-interface).
A branch remains verifiable while main advances without changing its fork point.
Routine code needs one cold reviewer who confirms ordinary semantics; sensitive,
material or unknown changes require two. Paths and modes can raise that floor,
and semantic uncertainty requires two fresh reviews of the same candidate.
Run the focused
`scripts/agent-review-session.test.ts`, `scripts/agent-review-queue.test.ts` and
`scripts/agent-review-gate.test.ts` batch while changing that contract;
fixtures do not prove installed enforcement. Installed verification must refuse
workflow drift before expensive checks or replacement of prior logs, and acquire
an output lock scoped to the actual task worktree before running those checks.
An existing lock is refused without stealing it or disturbing another task's
checks; unrelated worktrees use the host broker's capacity limits. The required
six-job commands remain unchanged; exact-candidate review evidence may be reused
by pre-push, but this process adds no general test-result cache. The local
verification stamp records that one exact clean tree passed. Pre-push requires
it, and it never lets a check be skipped. Prove actual
CLI and hook refusal paths in two dogfooding passes, batch material repairs, and
repeat affected scenarios before claiming live activation.

Published Tree CI also accepts `merge_group.checks_requested`. The six mechanical
jobs run against the queue's actual group checkout. DCO checks the complete
event-base-to-group range, including the synthetic tip; missing sign-off fails
without an exemption. Documentation impact uses the event's exact group base,
head, ref and tree, rather than inferring a PR head or using a stale local base.
A no-impact trailer binds the change and its owner, not the owner section's
prose or the base commit, so it stays valid in a group whose base moved for
unrelated reasons, including an edit of that section. A
pull-request checkout is identified by `GITHUB_SHA` and its exact event base and
head parents; the payload's `merge_commit_sha` is not compared, because a
`synchronize` payload can carry a lagging value.
The local verification mirror must match these workflow commands before final
delivery. A workflow change needs its separately authorized mirror update; focused
tests cannot replace that final gate or stamp. The mirror runs raw diagnostics
only on request, or pgTAP alone when the range reaches database inputs.

**When the job runs.** The `native-review` job runs when the repository
variable `OPENLUP_NATIVE_QUEUE` is `enabled`. At the
[dated inspection](docs/platform/DEVELOPMENT_AND_RELEASE.md#reading-results-and-recovering),
the variable was enabled and the ruleset required the context. Changing either
remains a separate settings action. A skipped job is not evidence of admission.

The job runs after all six actual mechanical successes and waits at most twenty
minutes for a receipt.

**Receipt admission.** A pull-request run accepts a summary receipt for its PR
number and exact reviewed head and tree. One receipt covers every run and
attempt of that head while the review is current. A merge-group run accepts it
only when the source review carries over, as defined below. Missing, stale,
incomplete or mismatched evidence fails.

After fresh native source reviews and a passing local `verify`, the supervisor
posts the receipt as a PR comment as soon as the pull request is open and ready:

```bash
node scripts/agent-review-session.mjs receipt "$PR" | gh pr comment "$PR" --body-file -
```

Posting is a GitHub write within the task's delivery authority. Receipt generation
only prints the comment body. It contains the marker
`<!-- openlup-native-review-receipt v2 -->` and a fenced JSON summary with
`pr`, `base`, `head`, `tree`, `risk`, `reviewers`, `verdict`, `expires` and
`sessionDigest`; it carries no full session history.

The trusted-main `agent-review-queue.mjs wait` accepts receipt comments from
a user with write, maintain or admin permission and selects the newest valid
receipt for the live PR head. It checks repository permission rather than public
organization membership, caches each login's result for the wait, and refuses
bots and failed permission lookups. It fetches source objects with `transfer.fsckObjects=true`,
recomputes the tree and reviewer floor from the changed paths and modes, and
checks the base and expiry. Git runs through `/usr/bin/git` with
`PATH=/usr/bin:/bin`. The receipt base must equal the single fork point of the
reviewed head and actual main. Receipts have no separate stack-pin field: an
exact pinned predecessor landing becomes that fork point and preserves review;
an older landed ancestor is refused. A new head needs new review and a new receipt.

A source review carries over to a merge group when either:
- the group tree equals the reviewed tree; or
- the group is exactly the reviewed change on its queue base, which admission
  checks with `git merge-tree`, and the base's net change since the reviewed
  base touches neither the change's paths nor the admission, identity-binding,
  dependency and migration machinery (`.github/`, the review scripts, the
  identity fence, package manifests and lockfiles, `db/platform/migrations/`,
  `supabase/migrations/` and the platform migration manifest). Other check
  configuration is not on this list; the group's mechanical checks run with it.

Then the source receipt admits the group without another receipt or live session.
The six mechanical checks on the group tree cover behavioural interaction.
Otherwise admission rejects the group with "merge main and re-review": merge
`main` into the source branch, commit, obtain fresh review and post a new receipt.
There is no separate integration-review receipt route.

The supervisor follows actual admission in the same conversation; the maintainer
does not move prompts or reports. A receipt timeout needs submission or expiry
recovery, as [Merge queue](#merge-queue) describes. Freshness is checked at
admission, not guaranteed at the later merge; same-name checks from a malicious
writer remain outside this process-evidence boundary.

### Commands and lint rules

The complete projected root command inventory is `build`,
`build:public-reference`, `build:public-reference:client`,
`build:public-reference:prerender`, `build:public-reference:ssr`,
`check:dco-signoff`, `guard:client-secret-boundary`,
`guard:public-reference-site-routes`, `lint`, `prelint`,
`oss:published-tree`, `packages:check`, `release:bump`, `pretest`, `test`, and `test:scoped`.
This reclassifies the complete current root script inventory; all commands are
public, with `test:scoped` as the local wrapper around the unchanged `test` command.
`npm run build` is the public build truth; its public-reference subcommands and
guards are internal links in that bounded chain. Published Tree CI invokes the
build, sharded required root tests, DCO check, and publication checks from this inventory.
Adding or renaming any source package command requires reclassifying the whole
source command-name inventory before a new preview can be materialized.

`npm run lint` runs ESLint over the tree, including the import boundaries in
[eslint.config.js](eslint.config.js): a package under `packages/` imports
nothing outside its own directory, other code reaches a package only through
the subpaths its `exports` declare, and domain code under `src/domains` and
`server/domains` imports no configured provider SDK and no adapter,
infrastructure, runtime or route code; the config exempts domain tests.
Non-test production source under `packages/core/src` and `packages/ui/src`
also imports none of the provider SDKs listed in the config. Package tests
retain their package isolation even when composing with a provider.
Provider composition exemptions use `*.test.<extension>` and
`*.testFixtures.ts`, matching the existing test convention.
The boundaries cover static imports and re-exports, literal or plain-template
`import()`, type imports, and literal or plain-template `require()` and
`module.require()` calls; they do not resolve aliases or stored specifiers.
An exact alias in the
root `package.json` `imports` map counts as such code when any path it can
resolve to lies in one of those directories, including a path selected by a
condition, since Node allows a condition object as a target. A subpath pattern
alias such as `#name/*` is not matched as a pattern. Published Tree CI runs lint
in the `typecheck` job.

The [import-boundary test matrix](scripts/packages/eslint-import-map.test.ts)
reuses one linter per loaded configuration across that configuration's samples.
Each import-map scenario loads its own configuration. Both boundary helpers
reject parser failures and unmatched files before checking the expected rule;
syntax tables exercise every supported loader form for each owning rule family.
Separate path tables exercise package names, path spellings and depth boundaries
with one canonical load. This preserves the syntax and path obligations without
repeating their full Cartesian product. Type-only edges keep both accepted type
loads and refused value loads. The platform package source proof remains: its
provider allowlist and member-call loaders cover cases outside ESLint's current
selectors, so that check cannot yet be removed as duplicate coverage.

`npm run lint` first checks file-leading blank-line suppressions with
`scripts/ast-grep/check-filewide-ignore.mjs`; this check cannot be suppressed
by an ast-grep directive. It then scans with the structural rules in
`scripts/ast-grep/rules` (configured by `sgconfig.yml`), refuses bare or unused
suppressions, runs the cases in `scripts/ast-grep/rule-tests`, then runs ESLint.
These rules catch ordinary mistakes; review handles deliberate evasion.
ESLint's boundary rules check import paths; the structural rules check calls,
reads and literals. A non-test `.ts` or `.tsx` module under `server/bff` reaches
the database only through a port or the actor data gateway:
it does not load the database client SDK through an import or re-export, `import
= require`, or an `import()`, `require()` or `createRequire()(...)` call whose
argument names it, and does not reference `createClient`, `.from` or `.rpc`,
whether by name, as a member, through a string index, through direct object
destructuring (including aliases and defaults), through `.call`, `.apply`
or `.bind`, or behind parentheses, a comma operator, a type or non-null
assertion or a prefix `await`, `void`, `!` or `typeof` (standard static
`Array`, `Buffer` and typed-array `.from` methods excepted). Client-factory
references include shorthand object values and runtime class names. A pure
alias/interface name by itself, or ordinary string data, is not a client-factory
value. Direct
`logger` or `console` diagnostics may print the SDK package name; a stored
path remains blocked because it can be used for a module load. Domain code under
`server/domains`, `src/domains` and `packages/core/src` reads no environment
variable: it has no `.env` or `["env"]`
access, and no destructuring of `env` in a declaration, parameter default,
assignment or loop head, on an expression that involves `process` or
`import.meta`, however that expression is wrapped or asserted, and no import,
`require()`, `createRequire()(...)`, dynamic import or re-export of
`node:process`; the rule does not follow a value through an intermediate
variable. The same domain code contains no two-letter uppercase string, template
or template-type literal in any position. Such literals can introduce country
or region policy; syntax alone does not establish their meaning. Test files are
exempt, and so are fixtures and test helpers from the country rule. Files that
predate a rule are listed in its `ignores`: delete an entry when its file is
fixed and never add one. A justified exception, such as a genuine non-country
code or a genuine non-database `from` member or destructuring key, is an
`// ast-grep-ignore: <rule-id>` comment on the line before the code,
with the reason in a comment above it. The comment names the exact rule id,
which in a `.tsx` file is the `-tsx` variant, such as
`domain-no-country-literals-tsx`. A new rule states the platform rule it
enforces, blocks only at zero findings, and has at least one valid and one
invalid case. A first-line `ast-grep-ignore` followed by a blank line is
file-wide and is rejected, including BOM-prefixed or triple-slash comments,
even when it names a rule. A line exception must
sit directly above its target; an unused exception is rejected. After each edit,
run a focused scan with both suppression checks; replace the example path with
your changed files:

```sh
npx --no -- ast-grep scan --error=no-suppress-all \
  --error=unused-suppression server/bff/admin/platform/me.ts
```

Before committing, run `npm run lint` for the independent file-wide-ignore
check, whole-tree scan, rule tests and ESLint. Keep `--no --`: without it npx can
fetch an unrelated registry package of the same name when the local binary is missing.
While iterating, `npx --no -- ast-grep run --pattern '<code pattern>' --lang ts`
lists every structural match, and `--rewrite '<replacement>' --update-all`
applies a mechanical edit; call the binary `ast-grep`, because `sg` is also a
system command on Linux.

`portable-no-industry-contracts` and its TSX variant guard the clean portable
source in every package's `src` (`packages/*/src`), so a newly imported module
package is checked from its first commit. Explicit `pet`, `pets`,
`dog`, `dogs`, `cat` or `cats` components in identifiers, property/type names,
static declaration/access keys and literal types belong in adopter code, not generic
contracts. For example, `petId`, `dogWeightKg`, `CatProfile` and
`Record<"petId", string>` fail. `watchdog`, `dogfoodEvidence`, comments and
ordinary runtime string values pass, as does forwarding opaque
`Record<string, unknown>` extension data. Tests and fixtures are exempt. The
rule covers TS/TSX syntax; it does not infer types, track aliases, inspect
arbitrary payload values, or classify legacy application schemas. Provider
isolation remains an ESLint responsibility. The existing packed-core audit
also refuses the configured provider content, including the Vercel SDK
namespace, in actual package artifacts. These checks add no command or CI job.

### Test scope and diagnostics

Use the pinned Node version in [.nvmrc](.nvmrc), npm 11.19.0 and the committed lockfile in your task worktree. Start with the affected behavior, then complete [required and raw checks](#required-and-raw-checks). Focused tests do not replace required package, lint, policy or verification gates.

#### Run and inspect

After `npm ci`, use:

```sh
# Builds Core, Outbox and Platform, then runs the affected root tests.
npm test -- server/domains/subscription

# Ordinary local root gate: excludes only eligible untouched tooling fixtures.
npm run test:scoped

# Unfiltered root suite. Ensure no exclusion file is inherited.
npm test

# Discovery only; direct Vitest does not build package prerequisites.
npm run pretest
npx --no -- vitest list --filesOnly
npx --no -- vitest list --filesOnly --project=node server/domains/subscription

# Native review changes: pure session/hosted tables plus real Git witnesses.
npm test -- scripts/agent-review-session.test.ts scripts/agent-review-queue.test.ts scripts/agent-review-gate.test.ts

# Separate Core suite; includes coverage, API/docs/release and packed consumer.
npm --workspace @openlup/core run ci
```

Unset `OPENLUP_VITEST_EXCLUDE_FILE` when requesting an unfiltered run. Outbox and Platform tests also run locally with `npm --workspace @openlup/outbox test` or `npm --workspace @openlup/platform test` after building prerequisites; their package configs use Node and do not inherit root setup. Their installed consumers belong to the shared package gate, not that local command.

Hosted `test-full-shard` jobs run `npm test -- --shard=N/4` in four independent installations. They apply the same event-based selection before sharding. Required `test` accepts only success from the whole matrix; failure, cancellation or a skipped shard job refuses. There is no `test:required` script or separate `test-full` job. A successful shard can still report individually skipped cases; record missing proof.

#### Choose a location and proof

| Test | Placement and execution |
|---|---|
| Domain, server, API, MCP or tooling logic/contract | Adjacent descriptive `.test.ts`; root Node project discovers `api`, `mcp`, `scripts`, `server` and `src`. |
| Browser interaction | `src` `.test.tsx`; `.test.ts` under `src/components`, `src/hooks` or `src/test` also uses jsdom. A Node-project .ts test requiring DOM must declare `@vitest-environment jsdom`. |
| Package unit/characterization | `packages/outbox/test` and `packages/platform/test` are root-discovered. Core `smoke/` and `test/` use its separate Node config and required Core batch. |
| Cross-boundary/DB | Existing `tests/platform`, `tests/postgres` or `tests/golden-master` Node roots. The [additional cross-boundary DOM root](vitest.config.ts) uses jsdom for `.test.tsx`. Do not assume every `tests/` directory is collected. |
| Durable SQL behavior | `supabase/tests` for managed pgTAP; selected portable/installed DB conformance stays with its owning runner. |
| Browser journey | Explicit Playwright/profile runner; not root Vitest. Follow the [subscription](docs/platform/SUBSCRIPTION_REFERENCE.md) or [identity](docs/platform/IDENTITY.md) owner. |

The [root config](vitest.config.ts) is the exact discovery inventory: it accepts `.test.ts`/`.spec.ts` in its Node roots, and `.test.tsx`/`.spec.tsx` in its DOM roots. Checkout helper discovery is narrowly `tests/preview/checkout/helpers/**/*.test.ts`. Prefer `.test` names consistent with adjacent files and boundary rules; in `packages/outbox/test` and `packages/platform/test` use `.test.ts` only, because their package-local configs collect only that suffix. Verify a new file appears with `list --filesOnly`; placement alone is not execution evidence.

Use the smallest proof that can detect the failure:

| Proof | What it must detect |
| --- | --- |
| Unit table | Incorrect decision or edge case. |
| Contract/conformance | Broken success, refusal or boundary translation. |
| Characterization/golden/effect transcript | Changed observable behavior. |
| Real Git/process witness | Incorrect CLI, object, environment, exit or workflow refusal behavior. |
| SQL | Broken role, constraint, transaction, concurrency or replay behavior. |
| Packed consumer | Broken installed artifact or workspace leakage. |
| Browser journey | Broken interaction in the selected mounted application. |

Extend an existing meaningful case first; add a test for changed behavior, a discovered defect, or a required contract/refusal/replay boundary. Migrations, status mappings and idempotency rules require failure/replay regressions. Demonstrate adapter capabilities and refusals without live providers. Preserve the unchanged [adopter characterization witness](#contribute-existing-adopter-code-then-refactor) during refactoring. Do not test private implementation shape or add a harness solely to test the harness.

Keep executable tests tied to a current offered contract, installed safety
boundary or selected reference behaviour. Historical migration spellings,
withheld commands, deployment inventory counts and adopter presentation are not
platform acceptance requirements. Removing an obsolete assertion requires its
ended duty or equivalent surviving proof; a similar test name is insufficient.
Unmounted UI may defer interaction proof until that exact UI is selected, while
installed authorization, money, persistence and replay controls remain tested.
Retire dormant scenarios from the source tree rather than adding skips or
runner exclusions; reintroduce neutral scenarios when their contract is selected.
Remove their uncalled helper modules with them. Test a supplied tool's actual
entrypoint or consumer; a helper retained solely for a withheld wrapper does not
create a public acceptance obligation. SQL asset and documentation checks preserve
readability, valid destinations and current behavior, rather than exact comment
wording or a requirement that a useful link appear only once.

#### Keep fixtures deterministic and work fast

Reuse [root setup](src/test/setup.ts), [Git environment scrub](tests/setup/scrub-git-env.ts), [render providers](src/test/render.tsx) and existing owner-local fixtures when applicable. Use synthetic, profile-valid inputs. Inject time, randomness and external ports; restore timers, environment stubs, module state, mocks and resources you change. Tests must not depend on file order, another test or a shard's membership.

Prefer table-driven pure cases and the minimum real boundary witnesses that prove the requirement. Retain real Git/process/DB witnesses where the requirement depends on actual process behavior, SQL permissions, transactions or concurrency. Do not replace those witnesses with mocks. Use temporary repositories with explicit identity, bounded child processes and owned cleanup; never mutate the contributor's repository or use ambient/live services. Follow [database fixture rules](docs/platform/DATA_AND_MIGRATIONS.md#database-test-fixtures-and-witnesses).

Root test/hook defaults are 10 seconds, or 30 with coverage; externally supplied duration pins may raise them. These are deadlines, not expected runtimes or whole-file budgets. Process spawning, repeated tree copies, compilers, npm packs/installs, containers and intentional deadline waits are likely costs. Measure expensive additions and record command, revision, environment, workers and observed duration in existing task evidence. Simplify repeated setup or decision matrices before raising a timeout; give necessary integration work an explicit bounded deadline sized for hosted runners. Preserve `retry: 0` and required proof.

To find optimisation targets, read the per-file durations Vitest prints in a hosted shard log (`✓ <file> (<n> tests) <ms>`) or locally with `npm test -- <path>`, and rank by file time. On 2026-10-19 the slowest root files were repository-tooling tests (`scripts/packages/outbox-consumer-proof.test.ts`, `scripts/source-preview-release.test.ts`, `scripts/public-ci-neutrality.test.ts`), each 40–80 s; slim one by moving decisions into table-driven cases and keeping only the real-process witnesses its requirement needs.

Local worker defaults are 75%, coverage 50%; the wrapper lowers them under contention. Use `VITEST_MAX_WORKERS` for ordinary local reproduction; CI coverage and explicit serial mode have their own config. Do not change global limits, skip assertions or invent a new speed gate to make one test green.

#### Extend tooling selection conservatively

[ci-test-scope.mjs](scripts/ci-test-scope.mjs) contains eligible bounded tooling rows. **New and unlisted tests always run. A new tooling test does not need a row.** Add one only when skipping untouched inputs saves useful work and its complete dependency closure is understood.

Declare every actual nonshared repository input the test or imported code reads: source, configuration, manifests, documentation, inventory, package outputs and reference wiring. Use an exact path or a directory prefix ending in `/`; no globs. Fixture strings are not reads of the corresponding real repository files. Prefer a broader prefix to incomplete precision.

All rows already share `scripts/`, `tests/setup/`, `src/test/` and `src/checkout/machine/commerceRequestCache.ts`. Every root file and every dot-prefixed segment anywhere also runs everything. Package rows conservatively include `packages/`. Repository-wide inventory/policy/neutrality/removal scans stay unlisted. When a row gains a new read, extend it; when its closure becomes uncertain or tree-wide, remove it.

Review input completeness against the actual test/import closure. Extend [scope falsifiers](scripts/ci-test-scope.test.ts) for the new dependency behavior; row-derived tests alone cannot discover an omitted input. Preserve shared triggers, rename/deletion coverage, identical shard selection and errors selecting everything.

PR/group scope uses the merge-base with the event's exact base. Local scope uses `origin/main` plus committed, staged, unstaged and untracked paths. For a deliberate alternative local base:

```sh
(
  scope_file=$(mktemp) || exit 1
  trap 'rm -f "$scope_file"' EXIT
  export OPENLUP_VITEST_EXCLUDE_FILE="$scope_file"
  node scripts/ci-test-scope.mjs --base <ref> &&
    npm test
)
```

Unknown events, malformed metadata or unavailable Git history exclude nothing. Selection is an optimization, never a failure waiver. Keep the project-level exact-path seam; root `--exclude` cannot replace it.

#### Separate DB, package and coverage proof

[Required checks](#required-and-raw-checks) owns the full command sequence. `install-proof` builds both profiles and runs [shared package gates](scripts/packages/required-package-gates.ts): cold-pack the publishable inventory once, all API checks first, then each `ci:required` with verified manifest/commit. Keep local package preparation before root tests because generated outputs are shared. New modules extend the owning package's consumer and required batch; do not add a workspace or job without a separate need.

Core required coverage is V8: statements/lines 80%, branches 65%, functions 75%, plus no nonempty production file with zero covered lines. Root config has percentage thresholds when explicitly running coverage; public CI does not run root coverage or its separate no-zero helper. Outbox/Platform have no separate percentage gate. Keep installed-artifact and meaningful failure assertions; percentages do not replace them.

Root tests include required disposable Docker/PostgreSQL proofs. Some older tests explicitly skip when Docker is absent; a skip does not prove that boundary. Installed Outbox/Platform consumers require their owned database and refuse missing infrastructure. For managed SQL use `node scripts/public-ci-pgtap.mjs` with Docker, locked dependencies and Supabase CLI 2.98.2. It validates committed migration bytes, replays baseline/forwards with public prerequisites, runs all supplied SQL tests and cleans only its own project. Commit migration candidates before this runner; it refuses dirty migration bytes. It never links a hosted database or installs application seed data; it copies the shipped SQL tests unchanged. Replay uses a disposable diagnostic owner with closed default grants, so this profile is not production installer authority, and the pinned image workaround hides only denial-hint formatting.

pgTAP remains a raw diagnostic, while root `test` and package `install-proof` are required. Triage actual exits, failed/aborted files, skipped prerequisites and new failures against the exact base; [historical diagnostic evidence](docs/platform/plans/public-ci-known-red.md) grants no waiver. Neither mocks, static SQL assertions, listing, a build nor a green aggregate proves an unexecuted DB/browser/provider obligation.

Local root coverage (`npm test -- --coverage <path>`) runs Vitest directly when
the host-local broker helper is absent, with the same arguments, environment
and coverage-summary handling as an already admitted run. A focused subset still
uses root percentage thresholds; it does not establish full-suite coverage.

Keep documentation falsifiers independently discoverable for routing, impact, bare-runtime CLI and bundle corruption; never import one test file from another. Disposable fixtures prove those refusals, not arbitrary prose meaning. Follow [lint rules](#commands-and-lint-rules), including valid/invalid cases for new ast-grep rules, and [documentation impact](docs/platform/DOCUMENTATION.md#impact). Fixtures still obey neutrality and secret-handling policy.

### Package, policy and release checks

`npm run packages:check -- --manifest-only` checks every `packages/*/package.json` against
[`config/openlup-packages.json`](config/openlup-packages.json), which lists each
package as released or as unreleased. A released package `packages/<name>` is
named `@openlup/<name>` and has its own `MAJOR.MINOR.PATCH` version, exact pins
to the current versions of other released `@openlup/*` packages, registry semver
ranges for every other dependency, and curated `exports`: no wildcard or
directory entries, and every target under `./dist/` except a `core-source`
target, which stays under `./src/`. It is either `private: true` or carries
exactly the public, provenance-backed publication settings and a `repository`
entry. Its `publishConfig.tag` stays `preview`, so only the release workflow's
explicit `--tag latest` moves `latest`. An unreleased package is always
`private: true`. A new package stays unreleased through its module's pull
requests and becomes publishable only in the module's final one, where the
reference application composes it, so a set never republishes a half-built
package.

`npm run packages:check` (also `--pack`, retained for existing callers) builds and packs each released package
into a temporary directory, from a package directory with no uncommitted
changes. Every packed file must be either a tracked file of that package, byte
for byte (the manifest included), or built output of a tracked non-test source.
Artifact checks enforce the per-package byte/file caps, content allowlist and
browser-entry budgets. Only `--release-set <version>` checks growth against the
last released baseline and requires explanations in the new set's changelog
section and release body, as described in
[Package artifact limits](.github/VERSIONING_AND_EOL.md#package-artifact-limits).
The privileged release job explicitly selects `--manifest-only`; its separate
unprivileged cold producer still checks every artifact before publication.
Every concrete `exports` target, including JavaScript, declarations and
`core-source`, must be present in the tarball. The core documentation check also
requires relative Markdown links in shipped files to target packed files, not
just files present in the source checkout.
Destination checks are conservative: unsupported boundaries, raw ampersands or
angle characters, Unicode whitespace and malformed percent encoding refuse with
an actionable error. Use literal punctuation or percent-encoded filenames and
ASCII whitespace before optional titles. This keeps ambiguous Markdown from
silently checking a different file.
It refuses source maps and source-map references, build-machine home paths, and
the operational coordinates the public detector knows. It prints each tarball's
integrity. `-- --out <dir>` implies `--pack`. It keeps each publishable
package's tarball in an empty directory, with a `packages-manifest.json` of
their versions and digests. `-- --release-tag openlup-<package>-v<version>`
packs only that publishable package and requires its manifest version to be
`<version>`. The command publishes nothing;
[Package releases](.github/VERSIONING_AND_EOL.md#package-releases) describes how
the protected release approval leads to direct OIDC publication.

For managed pgTAP execution and its prerequisites, follow
[Test scope and diagnostics](#separate-db-package-and-coverage-proof).

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

Within one ratchet invocation, the pinned counts-mode scanners reuse the measured
base result only when the complete base and working inventories have identical
paths and bytes, including baseline, scanner and binary files. Both inventories
and pin checks still run; any difference executes both scanner chains. This
relies on the current deterministic counting interfaces, so scanner changes must
revisit that assumption. Separate CLI invocations never share scan results.

For pull requests and merge groups, the required `--policy` self-check also
compares the exact hosted event base with the checkout's Git objects. It refuses
edits, deletions and mode changes to existing managed or portable migrations,
backdated versions, unbound portable forwards and non-expand-only new SQL.
The portable manifest must preserve its prior baseline and forward prefix.
The CLI returns a failing exit when this comparison refuses a candidate.
This database-free comparison does not derive the live object inventory digest.
The source contract continues to bind the manifest bytes, and the portable
runner compares `objectInventorySha256` with the selected database catalogue
after applying migrations (falsified by
`server/adapters/postgres/migrationRunner.test.ts`).
Against the same base, `--policy` refuses a change that removes or changes a
line of a publishable package's API snapshot (`release-gates.json`
`packageSurface`) unless that package's single `## [Unreleased]` changelog
section carries a `Migration:` block, or a real coherent set bump above the base
has moved it into the unique candidate-version section while leaving a unique
empty Unreleased section. The candidate section must match the package manifest
and set; stale notes at an unchanged version, another version, duplicate
sections or a mixed set refuse. The base decides which packages and
snapshots are checked, and removing or renaming a subpath counts as a removal.
A pure addition, such as a name added to an export list, has no "before", so it
needs none; a comment that opens a line is ignored, the code on its lines is
not, and the head must keep each publishable package's gates file and snapshots
readable.

This is a textual, base-bound signal, not semantic migration certification. A
marker in a code fence or a reused block can satisfy it; declaration text that
reappears in order can look additive. Behaviour or schema changes and withdrawal
followed by re-admission of a package still need semantic review. Reviewers must
check the actual compatibility change and useful before/after migration steps;
the API snapshots, tests and release classification remain separate obligations.
Keep useful migration notes in Unreleased until release preparation. A newly
approved bounded programme may combine the implementation and set bump in one
PR: the bump moves those notes into the candidate-version section and opens a
fresh empty Unreleased section. Do not duplicate notes into that empty section
to satisfy the gate. Separate implementation and release-preparation PRs remain
available within their actual authority.

The [diagnostic debt record](docs/platform/plans/public-ci-known-red.md#current-checkpoint) separates the last recorded checkpoint from earlier failures.
It records closure of the twelve SQL files and keeps earlier failures archived;
full-root and managed SQL diagnostics are expected green. Matching named debt is not
permission to ignore a red run. When triaging a change, compare fresh
Vitest failure identities and per-file assertion counts, and pgTAP file summaries,
with the exact PR base, normalizing log timestamps and ANSI formatting first.
The required `test` aggregate exposes root failures; `pgtap` remains a raw
diagnostic job. They do not suppress tests or normalize exits. Installation, database
start/replay/cleanup and unexplained new failures block delivery; naming those
failures does not waive broken CI. Use the hosted pull-request run's raw logs
for this comparison, or the corresponding local commands. The six existing required contexts retain
their coverage, with blocking lint and neutrality. Promoting diagnostic jobs to
required checks is the maintainer's ruleset decision; this contribution changes
no repository settings. Release workflows still check those six contexts, so a
red root suite now refuses release through `test`; raw pgTAP retains its diagnostic status.

For independently discovered documentation falsifiers and their proof limits,
follow [Test scope and diagnostics](#test-scope-and-diagnostics). Documentation
regeneration and export remain owned by [Documentation maintenance](docs/platform/DOCUMENTATION.md).

A change can be released as the next source preview when the required checks of
Published Tree CI pass and its tree describes itself: the publication catalogue
lists every tracked path, and `config/openlup-source-release-contract.json`
matches the tree's bytes. Adding, removing or renaming a file, or changing a mode
or a dependency, is releasable on those terms. Before it tags, the release
workflow checks the target against the previous preview with
`assertDescendantSourceRelease` (`scripts/oss-source-release-contract.ts`). That
check admits additive forwards and the separate exact reviewed function class under
[Data and migrations](docs/platform/DATA_AND_MIGRATIONS.md#additive-forward-release-path).
Reviewed function forwards use the same checker in required self-check and release
prepare. Their whole-file bytes, signatures, old/new definitions and runtime
privileges are pinned in `config/reviewed-platform-forwards.json`. The runtime
list admits the five-function capability forward and an optional service-only
identity capabilities forward. Required self-check keeps the whole registry
unchanged from the feature comparison base; release compares each forward's own
entry, list position and shared registry fields with its introduction parent, so later
controls may append approvals. A feature cannot approve itself. These forwards
are not expand-only. See
[the exact class](docs/platform/DATA_AND_MIGRATIONS.md#exact-reviewed-function-forwards)
and its refusal tests in `scripts/source-preview-release.test.ts`.
It refuses edits or deletions of migration history, unapproved non-expand-only SQL, a
non-prefix portable manifest, bootstrap SQL changes, database schema types
(`src/integrations/supabase/types.ts`) and policy registry changes
(`config/openlup-policy-registry.json`). Nonmigration schema or policy changes
may still merge after their ordinary checks, but must be called out in the pull
request because the release-time check refuses them. [Versioning and EOL](.github/VERSIONING_AND_EOL.md#publish-refuse-and-recover)
states the complete rule. A preview carries no release asset; GitHub's release
attestation of the immutable release covers its annotated tag.
The protected release job creates the draft with the saved note bytes, checks
that same release ID and publishes by ID, changing only its draft flag. It never
discovers a draft through a paginated release list.

The workflow's prepare step also refuses, before it tags, a preview while a
tracked code file carries a removal marker
(`// openlup-remove-before: openlup-source-preview/<m>`) naming that preview or
an earlier one, or a comment line starting `// openlup-remove-before:` that does
not parse. Temporary compatibility files use such a marker so that a preview
cannot ship them past their announced removal.

Platform modules are contributed package-first: a reusable module becomes an
`@openlup/*` package with documented extension seams, and the reference
application consumes that package. Source-only changes are for the reference
application and documentation. While `@openlup/core` is below 1.0, the
packages are released as one set, independently of source previews: one set
version `0.N.P` from one commit, with each package tagged
`openlup-<package>-v<version>` at that commit and republished in every set. A
reviewed pull request, either release preparation alone or an explicitly approved
bounded implementation-and-set-bump contribution, runs
`npm run release:bump -- --set <version>`,
which updates every publishable package's version carriers and every exact
internal pin on one, and opens each changelog's version section below a fresh
Unreleased heading. Merging it authorizes no release.
A release is then dispatched with `publish-package.yml` and package `all` for the
reviewed commit, and one maintainer approval of the protected `release`
environment authorizes every package of the set. Dispatching the set again
resumes one that stopped part way; preflight requires completed releases to keep
the exact reviewed release-note bytes in both skip and resume states. The package
workflow independently verifies the App-published immutable
release, tag and attestation, then publishes the checked tarball through npm
OIDC with `--tag latest`, without another approval.
[Package releases](.github/VERSIONING_AND_EOL.md#package-releases) lists every
check and the maintainer setup.

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


The opt-in identity Auth/mail/database runner requires
`--phase email-trust|joint`; only the exported runner's optional `Setup.phase`
defaults to `email-trust`. Both phases replay the complete committed managed
chain, including the identity capabilities forward, and prove association under
the shipped grants. Every successful handler response is followed immediately by
a database read requiring its returned contact's normalized email and principal
link; confirmed and declared-provider scenarios also link a pre-existing unlinked
contact. The joint phase additionally checks unconfirmed soft provisioning and
first-login confirmation, refuses provisioning and existing-email linking under
automatic confirmation, preserves contact ownership after anonymous signup, and
requires no mail or account creation for unknown-address login. Refusal snapshots,
subscriber preservation and the public-catalogue fingerprint remain. The
[identity conformance guide](docs/platform/IDENTITY.md#conformance-and-outstanding-evidence)
describes prerequisites and proof limits. Default suites, required selectors,
CI activation and verification order remain unchanged.

<!-- openlup-doc-impact {"unit":"repository","digest":"sha256-3596f948904d4961b2dbc38a72006c3b2124a02cd29c604e736228e3d3787502","reason":"The compose container receives the optional invitation TTL. No service, route, contributor command or verification selector changes; the runtime and identity owners describe the setting and refusal behavior."} -->

<!-- openlup-doc-impact {"unit":"tests","digest":"sha256-9bc9d077d462c3b6b310bc4a61a79297acbcacc587ac490b1e067256431d8ed6","reason":"The component journey, optional captured-mail browser proof and direct disposable PostgreSQL proof reuse the existing runners. The PostgreSQL proof uses Node for server cryptography and explicitly binds the shared storage mocks and an empty URL query to window for the browser adapter; it needs no DOM. Test commands, execution ownership and full required verification duties remain unchanged; installation proofs continue to require their owned local services."} -->

## Pull requests

### Local contribution handoff

If your agent lacks native-subagent capability or you lack upstream write
authority, finish the authorized local change, signed commits and
[public required checks](#required-and-raw-checks), then hand off the existing
task record and commits to an authorized maintainer or supervisor. Include the
approved scope and delivery limits, full comparison base and head SHAs, changed
paths, check commands with exit codes, and unresolved or unavailable evidence.
For the fork setup above, obtain the committed head and validate DCO against the
recorded base:

```sh
git rev-parse HEAD
git diff --stat "$OPENLUP_BASE" HEAD
npm run check:dco-signoff -- "$OPENLUP_BASE" "$(git rev-parse HEAD)"
```

Stop there within local authority. Do not invent a review receipt or claim hosted
admission from local checks. The authorized supervisor takes ownership of native
review of the exact committed candidate, required verification, the PR head
source receipt comment, actual admission, and queue follow-through. Any
publication or merge also needs its applicable authority. The supervisor can be
the author only when that person has the required capabilities and rights.

### Deliver a change

This is the order for a task with an authorized submission supervisor, from
first edit to merge. An author preparing a local handoff follows the section
above; the supervisor owns the protected steps below. Each step points to its
detailed rule.

Record effective maintainer authority once in the existing finite task record:
actors, allowed coordination, local/DCO/submission/receipt/reply scope, actual
merge/release-dispatch grants and any authorized adopter continuation. Reconcile
later direct instructions. Do not ask again for an already granted routine
step, or treat another agent's request as a human grant. Required sensitive
reading, exact merge scope and protected release approval still apply.

1. **Worktree.** One task, one worktree and one branch, as in
   [AGENTS.md](AGENTS.md).
2. **Stabilize and commit.** Start with the useful vertical slice and a
   before/after witness that rejects the incompatible predecessor when preserving
   behavior. Run focused contract/API/platform probes and existing native artifact
   checks before coverage or the broad root gate. For core, after its build,
   `npm --workspace @openlup/core run release:pack` checks native class/file and
   aggregate byte limits without substituting for final committed cold proof.
   Measure baseline headroom and generated-file amplification early; passing one
   class does not waive an aggregate cap. Diagnose contract, fixture, OS/permission,
   supervisor-input or hard-budget failures separately. Focused green never waives
   the complete required gate, and UNKNOWN is not a flake or retry permission.
   Run `npx --no -- ast-grep scan` after each change
   and `npm run lint` before committing, along with the applicable contract tests
   and working-tree package, API, neutrality and budget checks. If the task requires
   a maintainer read before sign-off, present one stabilized packet of API,
   npm-publishing, security-control and release-control changes and proposed gate
   budgets, and obtain that read before `git commit -s`. A working-tree pack
   preview is labelled as such; it does not replace the clean committed pack
   proof or final verification.
3. **Supervisor's native review** of the exact committed candidate, by the rules in
   [AGENTS.md](AGENTS.md) and in this section:
   - write `.context/scratch/agent-review/intent.json` in the shape the
     [native session interface](docs/platform/plans/autonomous-reviewed-delivery.md#native-session-interface)
     defines:

     ```json
     { "authorSessionId": "<your session id>",
       "intent": { "risk": "<prose|routine|behavior|unknown>", "scope": ["<changed paths>"], "criteria": "<approved criteria>" } }
     ```

     - read [Review lessons](#review-lessons) and put the simplicity pre-check,
       the smallest adequate alternative considered, in the first request as prose.

     - `risk` sets the reviewer floor: one reviewer for `prose` or `routine`,
       two for `behavior` or `unknown`.
     - Codex may omit `authorSessionId`, which is then taken from
       `CODEX_THREAD_ID`. Every other supervisor sets it to its own session ID.
   - run `node scripts/agent-review-session.mjs prepare .context/scratch/agent-review/intent.json`;
   - launch fresh reviewers and `record` each report;
   - repeat until `verify` reports `reviewed`. Three repair cycles are automatic;
     after `needs_owner`, only an owner decision recorded with
     `node scripts/agent-review-session.mjs continue "<note>"` adds three more.
     A rethink remains recommended practice.

   Preliminary local semantic snapshots help prepare the owner packet but are
   not this committed native admission. Preserve their findings and any real
   task-specific limit separately from the actual prepared session state; neither
   an informal round count nor an absent session resets or consumes native quota.
   This distinction never bypasses an actually applicable exhausted limit.

   The session state is `.context/scratch/agent-review/session.json`;
   `prepare --new <intent.json>` records a changed intent or a rebase in the same
   append-only session history; findings, reviewers and the repair count carry on.
   Only `continue` adds cycles.
4. **Local verification.** Finish source, generated inventories and tracked
   task/plan edits before the final proof interval. Build, pack, consumer and root
   commands sharing mutable dist/output run sequentially; parallelize only truly
   disjoint inputs. Put observations during the run in existing ignored evidence
   or PR records. A tracked delta invalidates the frozen final candidate: repeat
   affected cheap checks, then satisfy the native final gate on the actual new
   identity. Reuse only native-valid caches; no general result cache or skipped
   gate is introduced.
   - Where the maintainer-local layer is installed, run `openlup-dev verify` on
     the clean committed tree. It must report `REQUIRED PASS`, and it writes the
     stamp that the pre-push hook requires.
   - Elsewhere, run the [required check commands](#required-and-raw-checks).
5. **Push** with `git push -u origin HEAD`. A push is publication, within your
   delivery authority. If `main` has moved since the review, push as is: verify
   and pre-push accept the review while its fork point is unchanged. Do not
   rebase or merge `main` to catch up (see [Merge queue](#merge-queue)).
6. **Open a ready pull request** within your delivery authority, using the
   template. End its description with your `Signed-off-by:` line: the merge
   commit takes its message from the description, and the DCO check certifies
   merge commits too.
7. **Post the source receipt** right away. `PR` is the pull request number;
   posting the comment is a GitHub write within your delivery authority:

   ```bash
   node scripts/agent-review-session.mjs receipt "$PR" | gh pr comment "$PR" --body-file -
   ```

   **Expiry.** Evidence expires 24 hours after the earliest counted PASS report
   for the current candidate. If expired, use `prepare --new <intent.json>`,
   obtain fresh reports, verify and post the refreshed receipt.
8. **Hosted checks.** The six required contexts and `native-review` must pass.
   Compare required root and raw `pgtap` failures with the exact base.
9. **Revalidate authority and evidence.** The pull request states its sign-off
   class and actual delivery grant. Recheck the live head and applicable
   review/receipt identity and expiry before each write. Any later material
   delta requiring a maintainer read returns to step 2 before its sign-off;
   required reads, closed material findings and current checks precede merge.
10. **Arm auto-merge** under merge authority, following the
    [Merge queue](#merge-queue) rules.
11. **Merge group.** Read the group's `native-review` log (see
    [Required and raw checks](#required-and-raw-checks)). Carry-over needs no
    further receipt. If carry-over fails, merge `main` and re-review, then post
    the new source receipt. If the source evidence expired, refresh it and
    repost (step 7). If no usable receipt was found, submit it (step 7).
12. **Confirm the merge**: the merge commit on `main` and its push run.

A repair commit restarts from step 3 for the new candidate.

### Native review and accountability

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

Commit repairs before review. Give fresh reviewers the open finding cards and
obtain passing review of the new tree by the required reviewer count. Stable
finding IDs remain open until a report lists them in `closes`; every material
finding must be closed. Expiry is 24 hours from the earliest counted PASS report
for the current candidate. Reviewers must be cold, distinct from every author
recorded in the session history and each other, and not reused from earlier candidates.

Three repair cycles are automatic. `needs_owner` then requires the owner to
continue, narrow or stop; `continue "<note>"` records an authorized continuation
and adds three cycles. A rethink remains recommended practice: question the
criteria and checking tool, group findings by root cause, consider simpler
alternatives and record `pattern → simpler path`. This grants no delivery or
settings authority. `prepare --new` records a changed intent or a rebase in the
same append-only session history; findings, reviewers and the repair count carry
on. Only `continue` adds cycles. A version-1 session file from before
2026-10-19 cannot be converted: delete `.context/scratch/agent-review/session.json`
and prepare again. A conflict or
failed queue carry-over is resolved by merging `main` and re-reviewing.

Handle `needs_agent_review` in the active task without asking the owner to repeat
approved behaviour. After criteria, review and checks pass, stop optional edits
and proceed only through authorized delivery steps.

`scripts/agent-review-session.mjs` binds process evidence to the candidate,
intent, scope and reviewer results. Installed verify and pre-push must refuse
missing, stale, partial or unresolved evidence; live enforcement is claimed only
after installed refusal tests pass. These receipts do not cryptographically
attest remote agent execution or establish hard author/signer OS separation.
Source objects are trusted through Git's own hashing, with
`transfer.fsckObjects=true` on hosted fetches. The earlier signed-receipt
controller and hosted observer are retired. No external model service is
required. Existing mechanical checks, DCO and applicable
publication/merge authority remain required.

Reuse the compact task record in the PR description instead of writing another
manual. Explain material deviations, evidence and remaining limitations. Review
must assess correctness, approved scope and whether unnecessary complexity adds
maintenance cost; findings need a concrete mechanism and effect, not a quota.

Include the affected documentation owners and what changed in their explanations.
For a scoped no-impact record, challenge its reasoning as well as its fresh
fingerprint: a hash identifies the delta and its owner, not semantic correctness.
`--policy` prints every accepted reason.
Keep generic corrections upstream; separately owned applications document their
selected immutable release and own composition. Their private operations and
adoption state are not public platform documentation inputs.
Read the [AI contribution policy](.github/AI_CONTRIBUTION_POLICY.md) before
submitting material AI-assisted work. Human accountability and DCO, independent
native review, and actual task publication authority remain required.

### Review lessons

Each rethink ends with a one-line lesson. Before cycle 1 of a review, the author
reads this list and records a short simplicity pre-check in the first review
request as prose: the smallest adequate alternative considered. It is not a JSON
field or an encoded gate.

The supervisor appends each new lesson here, with its date and task, in the same
delivery when its approved scope includes this file; otherwise it adds them in
one bounded documentation change after delivery, which may collect several
lessons. When a lesson recurs, the supervisor promotes it into the guidance it
concerns in that same delivery and replaces the entry here with a pointer.
Promotion adds guidance only: it never relaxes a control, budget, review or
authority rule. This route grants no submission, merge or scope authority of its
own: a lessons change is an ordinary delivery under existing authority, and a
promotion stays within its approved scope. The rethink record and the task's
terminal self-retro carry the lesson until it lands. No other tracker is kept.

- 2026-10-19, native review simplification rethink: Resetting state and
  hand-copying fields across a session boundary drops whichever control was
  forgotten → never discard state: append a new intent and candidate to the
  same append-only history so every existing check still applies.
- 2026-10-15, module-boundary lint rule: cycles 0–2 each found another
  import-specifier escape → replace a growing denylist with an allowlist of the
  canonical forms, or reuse the resolver.
- 2026-10-15, the same rule and the owner's review of the rethink: hardening a
  checker cycle after cycle → question the criterion and the tool first.
- 2026-10-15, the review-cycle rule change itself: its compatibility proof
  checked an in-flight lineage at cycle 3, which then reached old-rule owner
  cycles 4 and 5 before the merge and was refused → a validator rule change
  must accept or explicitly migrate in-flight lineages; prove it against every
  live session's stored state just before merge, not only its current cycle.
- 2026-10-17, stacked-PR proof on module branches: squash landings defeat
  stacking, because any insertion into a shared list next to a predecessor's
  conflicts once it squash-lands → a merge-commit queue fixes it, because the
  merge base becomes the predecessor's head.
- 2026-10-17, module package pull requests: stacked pull requests that each
  regenerate one shared record (a doc-impact marker, a contract digest)
  conflict once the lower one squash-lands → stack only pull requests without
  single-instance records, merge `main` once before each turn otherwise, and
  check `git merge-tree` against the queue base before relying on carry-over.
- 2026-10-17, parallel module work: parallel heavy local test runs cause load
  timeouts → parallelize writing and serialize heavy test runs; after a load
  timeout the complete gate is rerun without the concurrent load, and the
  timeout never counts as a pass.
- 2026-10-18, M03 P-contracts lint boundary: each review cycle found another
  call shape that loads a module (wrapped `require`, `module.require`, process
  builtins) → refuse the ambient loader identifiers themselves, and
  `import.meta`, instead of chasing callee shapes.
- 2026-10-18, M03 P-contracts and B0: a renamed fixture or new path failed the
  neutrality ratchet only in the hosted self-check → run
  `node scripts/public-ci-neutrality.mjs` and
  `node --experimental-strip-types packages/ui/smoke/neutrality.ts` locally
  before every push.
- 2026-10-18, M02 C1, making `@openlup/platform` publishable: code, checks and
  fixtures that assumed the package was private or outside the release set had
  to change with the flag → grep every reader of the package's
  `publish`/`private` state (package inventory, package and release checks,
  consumer fixtures) before flipping it.
- 2026-10-18, OSS programme doc-impact records: one marker per unit, bound to
  the section prose, made every open pull request conflict on, or expire with,
  a hot section → bind the answer to the change and keep it in the change's own
  commits.

### Merge queue

**Workflow trust boundary.** Checking out `main` for the admission script does
not pin the `native-review` job definition: on PR and merge-group events,
`.github/workflows/published-tree-ci.yml` comes from the candidate tree. A PR
could replace admission with a successful no-op and self-admit under the same
required context. Native source review requires two independent reviewers for
`.github/` changes, and carry-over refuses a changed-tree group when the base
move touches `.github/`. These controls depend on review and on admission
actually running; they cannot enforce themselves against edited workflow YAML.
Another guard in that same YAML has the same limitation. The remaining in-repo
control is review of workflow edits. Closing the bypass requires a separately
authorized owner settings action: a ruleset-required workflow whose definition
is pinned to a trusted source outside the candidate's control, rather than only
requiring a same-name status. This hardening changes no ruleset or settings.

After a merge, the main-push jobs may reuse the successful merge-group run for
that exact commit. The probe validates the public repository, queue workflow,
latest run/attempt and seven successful checks: the six required contexts
and raw pgTAP. Missing, incomplete, contradictory or unavailable evidence runs
the normal commands. Pull requests and merge groups always run their commands;
DCO, policy/neutrality and secret checks also run for each main push. The six
main-push contexts still complete, so package release checks keep their existing
contract. This is commit equality, with no cross-commit cache or new retry.

`main` takes merge commits through GitHub's merge queue, which
builds and checks the fresh integration tree itself. A merge commit's message
is the pull request description, so the description ends with the author's
`Signed-off-by:` line; the DCO check certifies the merge commit and the merge
group's tip like any other commit. The
[base-move and receipt plan](docs/platform/plans/ci-base-move-and-receipts.md)
records why these rules exist.

- **No rebasing for freshness.** Do not rebase a pull request, or merge `main`
  into it, only because it is behind. A review is bound to the branch's fork
  point, so verify and pre-push keep accepting it while the branch is behind.
  Integrate `main` only for a textual conflict, by merging it, and then obtain a
  fresh full review.
- **Arming.** Arm auto-merge only under actual merge authority, and only after
  the required checks, the native review and any required maintainer read:
  `gh pr merge <PR> --auto --author-email <address>`; the queue sets the merge
  method. Use the maintainer's configured author address. Confirm arming only
  by a non-null GraphQL `mergeQueueEntry` on the pull request, never by
  `autoMergeRequest`.
- **Receipts.** While native admission is active, a supervisor with delivery
  authority posts one source receipt per reviewed PR head as soon as the pull
  request is open and ready, using step 7. A group that cannot carry over is
  rejected: merge `main` and re-review, then post the new source receipt.
  Posting a receipt comment does not retrigger CI: after the 20-minute wait expires, rerun the `native-review` job.
- **Flakes.** A removal counts as a flake only when the same job passed on the
  same tree, or a `gh run rerun` passed without a code change. One requeue for a
  flake uses the existing two-retry budget. A second removal of the same head
  stops for diagnosis. A `native-review` red caused by a missing or late receipt
  is not a flake.
- **Receipt timeout.**
  - On a pull-request run, submit or check the source receipt, then rerun the
    failed `native-review` job. The rerun is a GitHub write; it requires
    authority that covers reruns.
  - In a merge group, requeue under merge authority. The new group is admitted
    by the source receipt again when the review carries over. A carry-over
    refusal requires merging `main` and re-reviewing. The requeue uses the same
    two-retry budget, and a second timeout on the same head stops for diagnosis.
  - A timeout although a current source receipt was submitted in time is a
    defect on a pull-request run, or on a merge group whose log names no
    carry-over refusal: stop and report it. An expired receipt or review needs the
    re-review and resubmission described in step 7.

**Stacked pull requests.** Once a predecessor merges, the merge base of a pull
request stacked on it is the predecessor's head, so the stacked change merges
onto `main` without conflict, even where it regenerates the same records or
inserts lines next to the predecessor's. Stack pull requests that build on each
other or touch the same shared files:
- A stacked branch contains its predecessors, and its generated files are
  computed on that cumulative tree. Export `OPENLUP_STACK_BASE` with the exact
  predecessor head for documentation, native review and final local checks.
  Its doc-impact answers and reviewed diff then cover its own change.
- Open it as a draft with its predecessor's branch as the base, after
  `npm run oss:published-tree -- --policy --docs-base <predecessor-head>` with
  the pinned SHA. Review its own diff with predecessor context; readiness and
  source receipts wait for the prerequisite.
- When the predecessor merges, GitHub retargets the pull request to `main`,
  because head branches are deleted on merge. Continue only once the first
  parent of `refs/pull/<PR>/merge` is `main`'s head; if that ref is stale,
  close and reopen the pull request and check again. Then rerun its checks
  against `main` by marking it ready; if it is already ready, convert it to
  draft first, which clears auto-merge. Then submit its source receipt and arm
  it: the receipt and queue admission require a pull request against `main`,
  and admission takes only the first queue entry. Keep the original pin: the same
  unchanged candidate remains locally reviewed after its predecessor lands.
  Admission verifies the pinned base is on actual main, not merely present on
  the source branch. Each upper PR still needs its own source receipt.
- Before relying on carry-over, check `git merge-tree --write-tree` of the queue
  base and the head. The canonical carry-over rule applies: unchanged tree or
  exact disjoint application relative to the reviewed predecessor. Other base
  changes are rejected: merge `main` and re-review.
- If another change on `main` conflicts with it, merge `main` into it once (do
  not rebase), regenerate its shared records and get a fresh full review, as
  for a textual conflict.
- If a predecessor changes, merge its new head into each stacked pull request
  above it (do not rebase); each result is reviewed again under the usual repair
  rules and budget.
- A second ejection of the same head stops the stack for diagnosis.

Each stacked pull request is still one concern. Stacking changes no review,
receipt or merge rule.

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
