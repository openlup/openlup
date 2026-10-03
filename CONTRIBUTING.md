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

## Development-preview checks

<!-- openlup-doc-impact {"unit":"tooling","digest":"sha256-273eae4d56b178424a6413a7f232b683602ac5700563a62fa645d26bc34716c0","reason":"The native session protocol adds only one explicit owner-bound full third review after two automatic cycles, preserving history, findings and two fresh roles. The contribution commands, existing required contexts and refusal requirements in this checks section remain unchanged; the manual continuation contract is explained in the native review section and protocol plan."} -->

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
`packageManager` field of `package.json`), and the committed npm lockfile. From
the root of a materialized development-preview tree, these are the commands the
eight mechanical/diagnostic jobs of [Published Tree CI](.github/workflows/published-tree-ci.yml)
run; each comment names its job. The inherited `native-review` job additionally
checks exact-candidate admission when the maintainer enables `OPENLUP_NATIVE_QUEUE`;
its six required dependencies and merge-group metadata controls remain unchanged:

<!-- openlup-doc-impact {"unit":"public-checks","digest":"sha256-163bc45102f9ec556620eac205f0af8756d01d92b188cf59a1f92c6288989c68","reason":"The fixed preview 9 recovery workflow checks the existing source commit and six required contexts before publishing its existing draft; it changes no contributor command, required CI context, or admission rule described in this section."} -->

```bash
npm ci
# Root typecheck consumes the built core package; build it after install and source edits.
npm --workspace @openlup/core run build
# npm run lint, npm run test:required and npm test also build core through npm pre-scripts
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

The `prelint`, `pretest:required` and `pretest` npm scripts build `@openlup/core`
before their respective root commands. When running
`npm run oss:published-tree -- --typecheck` directly after editing core source,
first run `npm --workspace @openlup/core run build`.
The root TypeScript projects and tests resolve core through its `dist/` exports,
as a package consumer does. Rebuild core after editing `packages/core/src`, or
those checks read the previous build. Published Tree CI runs `lint` after install
and before `--typecheck`; its `prelint` script builds core in that same job.

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
evidence expiry and the two-cycle repair/review budget. Its review base is the
candidate's fork point, `git merge-base HEAD origin/main`: a review stays current
while `main` moves ahead, and verify refuses it once that fork point changes. A
bounded routine code change gets one cold correctness review only when its
actual paths avoid known control and trust boundaries and that reviewer
confirms ordinary semantics.
Sensitive, material or unknown changes still get two; a false routine assessment
requires two full reviews of the same committed candidate within the existing
budget. Run the focused
`scripts/agent-review-session.test.ts` regressions while changing that contract;
fixtures do not prove installed enforcement. Installed verification must refuse
workflow drift before expensive checks or replacement of prior logs, and acquire
a shared heavy-verification lock before running those checks. An existing lock
is refused without stealing it or disturbing another task's checks. The required
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
A no-impact record binds the change and its owner section, not the base commit,
so it stays valid in a group whose base moved for unrelated reasons. A
pull-request checkout is identified by `GITHUB_SHA` and its exact event base and
head parents; the payload's `merge_commit_sha` is not compared, because a
`synchronize` payload can carry a lagging value.
The configured local verification mirror runs these required steps on every
run. It runs the raw diagnostics only on request, or pgTAP alone when the range
reaches database inputs.

**When the job runs.** The `native-review` job runs when the repository
variable `OPENLUP_NATIVE_QUEUE` is `enabled`. At the
[dated inspection](docs/platform/DEVELOPMENT_AND_RELEASE.md#reading-results-and-recovering),
the variable was enabled and the ruleset required the context. Changing either
remains a separate settings action. A skipped job is not evidence of admission.

The job runs after all six actual mechanical successes and waits at most twenty
minutes for a receipt.

**What each run accepts:**
- A pull-request run accepts a receipt for its current run and attempt, or a
  source receipt for its PR number and exact reviewed head and tree.
- A merge-group run accepts the pull request's source receipt when the source
  review carries over, as defined below; then no further receipt and no live
  session are needed. Otherwise it accepts a run-keyed receipt for its current
  run and attempt that carries two integration reviews (`group-session.json`).
- Both pull-request paths require an integer head repository ID, so a pull
  request whose head repository was deleted cannot be admitted.

Missing, stale, incomplete or mismatched evidence fails.

The supervisor obtains source reviews through fresh native agents in the same
task. For the pull request itself, one source receipt covers every Published
Tree CI run and attempt of the reviewed head, so it can be submitted as soon as
the pull request is open and ready, before any run exists. With `PR` set to the
pull request number, and `source-session.json` the complete native state
(`.context/scratch/agent-review/session.json` once `verify` reports `reviewed`):

```bash
node scripts/agent-review-queue.mjs input-source "$PR" \
  source-session.json > .context/scratch/agent-review/input.json
gh workflow run native-review-admission.yml --ref main --json < .context/scratch/agent-review/input.json
```

The second command is a GitHub write and requires the task's delivery authority.
The input command only creates JSON; it does not dispatch.

Admission re-verifies that receipt against the live pull request, the exact run
and the review's freshness each time. A new head needs a new review and a new
receipt. On a pull-request run, an unreadable or untrusted run-keyed artifact
does not block the source receipt; a merge-group run still refuses it, even when
the source review would carry over.

A source review carries over to a merge group when either:
- the group tree equals the reviewed tree; or
- the group is exactly the reviewed change on its queue base, which admission
  checks with `git merge-tree`, and the base's net change since the reviewed
  base touches neither the change's paths nor the admission, identity-binding,
  dependency and migration machinery (`.github/`, the review scripts, the
  identity fence, package manifests and lockfiles, migrations). Other check
  configuration is not on this list; the group's mechanical checks run with it.

Then the pull request's source receipt admits the group, with no new receipt
and no live session. The six mechanical checks on the group tree are relied on
for behavioural interaction. Otherwise the run-keyed receipt with two fresh
independent full integration reviews applies, under the same approved
criteria.

The group's `native-review` log says which route applies. It reports admission
"by its source receipt (unchanged tree)" or "(disjoint base move)", or it logs
"source receipt does not admit this merge group; waiting for a run-keyed
receipt" with the reason.

When the review does not carry over, use the run-keyed form with the observed
run, attempt and PR number. To find the run, use
`gh run list --workflow published-tree-ci.yml --event merge_group --json databaseId,attempt,headBranch`;
its branch is `gh-readonly-queue/main/pr-<PR>-…`. `group-session.json` is a new
native session for the group, not a continuation of the source session:
- prepare it where no source `session.json` is present: move the source state
  aside (step 3 of [Deliver a change](#deliver-a-change) keeps a copy) or use a
  separate checkout;
- check out the exact group head detached, with `origin/main` fetched to the
  group base;
- write an intent with the source's scope, criteria and supervisor session ID,
  and `risk` `behavior` or `unknown`, so that it requires two roles;
- obtain two fresh full reviews from reviewers who did not review the source,
  run `verify` until it reports `reviewed`, and save `session.json` as
  `group-session.json`;
- restore the source state afterwards.

Integration reviews help only when the logged reason is the group itself: the
base moved under the change's paths or the listed machinery, or the group is not
exactly the reviewed change. An expired source review needs a refresh and a new
source receipt instead. A log that shows only `needs_agent_review`, with neither
line above, means no usable source receipt was found.

```bash
node scripts/agent-review-queue.mjs input "$RUN" "$ATTEMPT" "$PR" \
  .context/scratch/agent-review/source-session.json group-session.json > .context/scratch/agent-review/input.json
gh workflow run native-review-admission.yml --ref main --json < .context/scratch/agent-review/input.json
```

Do not copy a source PASS or change the source branch to manufacture group
evidence. The supervisor submits the receipt and
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
`oss:published-tree`, `packages:check`, `release:bump`, `pretest`,
`pretest:required`, `test`, and `test:required`.
`npm run build` is the public build truth; its public-reference subcommands and
guards are internal links in that bounded chain. Published Tree CI invokes the
build, required root coverage, complete diagnostics, DCO check, and publication checks from this inventory.
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
source in `packages/core/src` and `packages/ui/src`. Explicit `pet`, `pets`,
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
(`scripts/source-preview-release.test.ts`). The source preview
falsifiers also check bounded 404 reads of the exact draft ID returned by
creation and refusal of a changed draft before publication. Under `scripts/packages`, it runs the
package release falsifiers: `release-workflow-authenticity.test.ts` plants a
defect against every control of the two package release workflows and runs
their release-event, tag-pattern, tarball and pre-publish npm checks as scripts,
and `package-release.test.ts` exercises the manifest, version, tag, npm and draft
refusals. `release-gate.test.ts` runs the release gate both workflows share
against a real Git fixture and a recorded GitHub API: main ancestry against a
fresh fetch, the six required contexts, the tag on the approved commit and the
refusal while another release or publication is in flight. It plants a defect in
the gate's source for each of those decisions and requires the edited gate to fail.
The source preview's own required-context loop is compared with the gate's
decision, verdict for verdict, in `scripts/oss-published-tree-check.test.ts`.
`set-release.test.ts` plants a defect against each set release control in its
module's source: one set version `0.N.P` across publishable packages,
`packages:check --release-set`, `release:bump --set` and its changelog section,
the patch-set API check, and the skip, resume and full states of a set.
The same directory holds the package release-shape checks and the test that
loads the lint configuration with a conditional `imports` map.
The public test job separately runs the materialized command-contract
falsifiers, which also run in the complete root scope.

`npm run packages:check` checks every `packages/*/package.json` against
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

`npm run packages:check -- --pack` also builds and packs each released package
into a temporary directory, from a package directory with no uncommitted
changes. Every packed file must be either a tracked file of that package, byte
for byte (the manifest included), or built output of a tracked non-test source.
It refuses source maps and source-map references, build-machine home paths, and
the operational coordinates the public detector knows. It prints each tarball's
integrity. `-- --out <dir>` implies `--pack`. It keeps each publishable
package's tarball in an empty directory, with a `packages-manifest.json` of
their versions and digests. `-- --release-tag openlup-<package>-v<version>`
packs only that publishable package and requires its manifest version to be
`<version>`. The command publishes nothing;
[Package releases](.github/VERSIONING_AND_EOL.md#package-releases) describes how
the protected release approval leads to direct OIDC publication.

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
section carries a `Migration:` block; the base decides which packages and
snapshots are checked, and removing or renaming a subpath counts as a removal.
A pure addition, such as a name added to an export list, has no "before", so it
needs none; a comment that opens a line is ignored, the code on its lines is
not, and the head must keep each publishable package's gates file and snapshots
readable.

The [known-red record](docs/platform/plans/public-ci-known-red.md) names the
measured failing or aborted files, reasons, incomplete obligations and triage
ownership. It is a dated measurement. When triaging a change, compare fresh
Vitest failure identities and per-file assertion counts, and pgTAP file summaries,
with the exact PR base, normalizing log timestamps and ANSI formatting first.
`test-full` and `pgtap` expose raw failures in separate diagnostic
jobs. They do not suppress tests or normalize exits. Installation, database
start/replay/cleanup and unexplained new failures block delivery; naming those
failures does not waive broken CI. Use the hosted pull-request run's raw logs
for this comparison, or a local run with `--diagnostics`. The six existing required contexts retain
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
check admits additive forwards and the separate exact reviewed function class under
[Data and migrations](docs/platform/DATA_AND_MIGRATIONS.md#additive-forward-release-path).
Reviewed function forwards use the same checker in required self-check and release
prepare. Their whole-file bytes, signatures and old/new definitions are pinned in
`config/reviewed-platform-forwards.json`; the feature PR cannot change its own
approval. The three replacements are not expand-only. See
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
release-preparation pull request runs `npm run release:bump -- --set <version>`,
which updates every publishable package's version carriers and every exact
internal pin on one, and opens each changelog's version section below a fresh
Unreleased heading. Merging it authorizes no release.
A release is then dispatched with `publish-package.yml` and package `all` for the
reviewed commit, and one maintainer approval of the protected `release`
environment authorizes every package of the set. Dispatching the set again
resumes one that stopped part way. The package workflow independently verifies the App-published immutable
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

<!-- openlup-doc-impact {"unit":"repository","digest":"sha256-904e5646a70769415ea7e72029532a9f05ecde4dc7e882101d00424043ac4f57","reason":"The root lockfile changes only the core workspace version from 0.10.0 to 0.11.0. Dependency resolution, development-preview checks, and required contributor commands remain unchanged."} -->

<!-- openlup-doc-impact {"unit":"tests","digest":"sha256-e23f5b124da515a37baee7ec68971f347f56f2e0c3a38fe498e0e293bb3565dc","reason":"Test-only delta. The neutral catalog extension fixture adds a second installed type whose count pack dimension declares the net-content role, and asserts that an option differing from the SKU net content refuses. The file stays in the complete root Vitest diagnostic scope and outside the required test selectors; the test commands and CI jobs described here are unchanged."} -->

## Pull requests

### Deliver a change

This is the order for one authorized task, from first edit to merge. Each step
points to its detailed rule.

1. **Worktree.** One task, one worktree and one branch, as in
   [AGENTS.md](AGENTS.md).
2. **Commit.** Run `npx --no -- ast-grep scan` after each change and
   `npm run lint` before committing. Commit with `git commit -s`.
3. **Native review** of the exact committed candidate, by the rules in
   [AGENTS.md](AGENTS.md) and in this section:
   - write `.context/scratch/agent-review/intent.json` in the shape the
     [native session interface](docs/platform/plans/autonomous-reviewed-delivery.md#native-session-interface)
     defines:

     ```json
     { "authorSessionId": "<your session id>",
       "intent": { "risk": "<prose|routine|behavior|unknown>", "scope": ["<changed paths>"], "criteria": "<approved criteria>", "requiredRoles": [] } }
     ```

     - `risk` sets the reviewer floor: one reviewer for `prose` or `routine`,
       two for `behavior` or `unknown`.
     - Codex may omit `authorSessionId`, which is then taken from
       `CODEX_THREAD_ID`. Every other supervisor sets it to its own session ID.
   - run `node scripts/agent-review-session.mjs prepare`;
   - launch fresh reviewers and `record` each report;
   - repeat until `verify` reports `reviewed`.

   The session state is `.context/scratch/agent-review/session.json`. Keep a
   copy of it as the source state, for example
   `.context/scratch/agent-review/source-session.json`; step 11 may need it
   after the worktree has moved on.
4. **Local verification.**
   - Where the maintainer-local layer is installed, run `openlup-dev verify` on
     the clean committed tree. It must report `REQUIRED PASS`, and it writes the
     stamp that the pre-push hook requires.
   - Elsewhere, run the [required check commands](#required-and-raw-checks).
5. **Push** with `git push -u origin HEAD`. A push is publication, within your
   delivery authority. If `main` has moved since the review, push as is: verify
   and pre-push accept the review while its fork point is unchanged. Do not
   rebase or merge `main` to catch up (see [Merge queue](#merge-queue)).
6. **Open a ready pull request** within your delivery authority, using the
   template.
7. **Submit the source receipt** right away. `PR` is the pull request number,
   and the dispatch is a GitHub write within your delivery authority:

   ```bash
   node scripts/agent-review-queue.mjs input-source "$PR" .context/scratch/agent-review/session.json > .context/scratch/agent-review/input.json
   gh workflow run native-review-admission.yml --ref main --json < .context/scratch/agent-review/input.json
   ```

   **Expiry.** Review evidence expires 24 hours after the earliest round since
   the last full review was prepared. A receipt artifact expires one day after
   upload, so by then the review has expired too. To recover:
   - re-review the same candidate: run `prepare` once with
     `"fullRefresh": true` in `intent.json`, then remove the key. The refresh
     uses one repair cycle;
   - then update the source-state copy and resubmit the receipt.
8. **Hosted checks.** The six required contexts and `native-review` must pass.
   Compare raw `test-full` and `pgtap` failures with the exact base.
9. **Maintainer read**, when the task's authority requires one before sign-off
   (the pull request states its sign-off class): wait for the maintainer to
   confirm the exact candidate SHA, within the review's 24-hour validity.
10. **Arm auto-merge** under merge authority, following the
    [Merge queue](#merge-queue) rules.
11. **Merge group.** Read the group's `native-review` log (see
    [Required and raw checks](#required-and-raw-checks)).
    - If it reports admission by the source receipt ("unchanged tree" or
      "disjoint base move"), nothing more is needed.
    - If it logs that the source receipt does not admit the group because of
      the group itself, it waits at most twenty minutes for a run-keyed
      receipt. Prepare `group-session.json` as that section describes, then
      submit `input "$RUN" "$ATTEMPT" "$PR"
      .context/scratch/agent-review/source-session.json group-session.json`.
      The same section shows how to find the run.
    - Carry-over also needs the source review within its 24-hour validity. If
      it has expired, refresh it and resubmit the source receipt (step 7).
    - If the log shows neither line, no usable source receipt was found:
      submit it (step 7).
12. **Confirm the merge**: the squash commit on `main` and its push run.

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

Commit repairs before review. Complete prior coverage and validated exact lineage
allow one fresh cold closure review of a narrow repair within unchanged intent,
scope and base. Supply neutral prior finding cards and actual repair/interactions,
never old verdicts or author history. The reviewer independently confirms semantic
risk; control, security, schema, executable instruction and unknown repairs need
two focused reviews regardless of filenames. Account for every prior material
finding and preserve inherited expiry; unavailable or expired coverage requires
two fresh full-scope reviews. Carry the two-cycle repair/review budget through
prepare and full-review escalation. Exhaustion stays blocked while the supervisor regroups
within existing authority. Changed intent requires explicit regrouping. Resolve a
textual conflict by merging `main`: that moves the fork point and gets fresh
full-scope review within the same budget. A rebase discards that lineage and
reports `needs_rescope`; it never restarts the budget or drops findings.

A fresh explicit owner decision may authorize exactly one additional full review
at cycle 3 after the two automatic cycles. This retains every prior round and
finding, the same approved intent and author, and a clean ancestor-preserving
committed candidate. It requires two fresh full reviewers. No fourth cycle or
automatic extension is permitted; unchanged prepare preserves evidence and
expiry. This decision grants no publication, merge or settings authority.

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

### Merge queue

`main` takes squash merges through GitHub's merge queue, which
builds and checks the fresh integration tree itself. The
[base-move and receipt plan](docs/platform/plans/ci-base-move-and-receipts.md)
records why these rules exist.

- **No rebasing for freshness.** Do not rebase a pull request, or merge `main`
  into it, only because it is behind. A review is bound to the branch's fork
  point, so verify and pre-push keep accepting it while the branch is behind.
  Integrate `main` only for a textual conflict, by merging it, and then obtain a
  fresh full review.
- **Arming.** Arm auto-merge only under actual merge authority, and only after
  the required checks, the native review and any required maintainer read:
  `gh pr merge <PR> --auto --squash --author-email <address>`. Use the
  maintainer's configured author address.
- **Receipts.** While native admission is active, a supervisor with task
  delivery authority does two things:
  - submits one source receipt per reviewed pull-request head, as soon as the
    pull request is open and ready;
  - when the source review does not carry over to the merge group, submits the
    run-keyed receipt with two integration reviews as soon as the group run
    exists.
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
    by the source receipt again when the review carries over; otherwise submit
    the run-keyed receipt for the new group run. The requeue uses the same
    two-retry budget, and a second timeout on the same head stops for diagnosis.
  - A timeout although a current source receipt was submitted in time is a
    defect on a pull-request run, or on a merge group whose log names no
    carry-over refusal: stop and report it. An expired receipt or review needs the
    re-review and resubmission described in step 7.

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
