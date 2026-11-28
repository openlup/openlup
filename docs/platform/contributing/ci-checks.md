# Contributor checks and CI

Status: current contributor guidance for stable 1.x.
Audience and purpose: contributors running local checks or diagnosing Published Tree CI.

Start with the [contribution guide](../../../CONTRIBUTING.md) for scope and the local workflow.

## Local stack bases and heavy verification

Stack setup and `OPENLUP_STACK_BASE` are defined in
[Deliver a change](../../../CONTRIBUTING.md#deliver-a-change).

Heavy local commands are optional feedback for the code being written; the
required verification is hosted CI. To run one against the reviewed candidate, use
`node scripts/agent-review-session.mjs verify-command --resource openlup:coverage -- npm run test:scoped`.
It checks the clean committed candidate and its review before and after the
command and preserves the command's exit code. With `--resource` it runs through
`ai-resource-gate`, whose policies stay binding; it refuses nesting inside another
broker or wrapper. Each broker invocation must wrap a single bounded command
rather than holding a lease open across idle polling or editing loops, and
lightweight checks (`lint`, `preflight`) must use non-database profiles such as
`openlup:typecheck` or the default lane rather than `openlup:postgres:*`.

## Optional SonarQube Cloud diagnostics

The SonarQube Cloud OSS pilot uses one public project and automatic analysis of
pull requests and `main`. Its source and test scope is defined in
[`.sonarcloud.properties`](../../../.sonarcloud.properties). Activation requires a GitHub
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
[SECURITY.md](../../../SECURITY.md) for sensitive vulnerability details.

After 30 PRs or four to six weeks, whichever is later, assess additional confirmed
defects, false/duplicate findings, analysis latency and triage time. The pilot
targets at most 30 minutes of weekly triage after calibration. Runtime and useful
finding counts are measured outcomes, not promises. Required merge admission,
coverage import, multiple Sonar projects and automated remediation require a
separate decision after this evidence.

Configuration references: [automatic analysis](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/automatic-analysis),
[quality profiles](https://docs.sonarsource.com/sonarqube-cloud/standards/managing-quality-profiles/understanding-quality-profiles),
and [PR analysis](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/pull-request-analysis).

## CI image mirror

The separate [CI image mirror](../../../.github/workflows/mirror-ci-images.yml) runs in
`openlup/openlup` on pushes to `main` that change one of its three input paths
(the image inventory, the mirror script and the workflow), and on manual dispatch
from `main`. Its single job reads only the committed
[image inventory](../../../config/ci-images.json): four PostgreSQL images (the install-proof
database, also used by pgTAP and managed-rail tests, the test harness default, and
two attribute-version witness pins), the starter Node base, the starter browser
image and the qualification Syft scanner (`qualification-syft`).
Every pin is validated before the first registry request. No Supabase CLI or
derived image set takes part.
The reviewed-batch gate and shared PostgreSQL test helper read these JSON pins
through [the shared reader and pull loop](../../../scripts/ci-image-pull.mjs). The reader
imports the JSON module directly so the same pins load in plain Node and both
Vitest projects, including jsdom. In CI and locally they try the organization
mirror first, then the upstream order with the same digest: Docker Hub, then
ECR, for all four library PostgreSQL pins. Private or absent organization
packages do not remove these public upstream fallbacks. The required
`install-packages` PostgreSQL startup step is an exception: it selects only the
GHCR mirror and requires access to that organization package. Microsoft registry
sources, such as the starter browser image's, are mirror inputs only: that image
is pulled from the organization mirror alone, with no upstream fallback.
Disposable PostgreSQL suites use `postgresSetupTimeoutMs` (600 seconds), including
the existing 300-second cold image pull and schema installation, and
`postgresTeardownTimeoutMs` (75 seconds). These are explicit integration-hook
budgets; ordinary test deadlines remain unchanged. The shared helper bounds
Docker availability to five seconds, each start/removal command to 60 seconds,
and TCP readiness to 60 seconds of wall-clock time, including connect/query
attempts and waits. After image resolution, port-conflict retries share a
90-second startup budget; failed-start cleanup still gets its 60-second removal
budget before reporting failure. Readiness destroys its throwaway client after each probe.
`closePostgres` gives all fixture pools and adapter/store close callbacks one
shared five-second close phase, then attempts every owned container removal even
if a close failed or stalled. Suite teardowns pass opaque adapter closers into
that phase instead of awaiting them first. All removals finish before cleanup
reports its collected failures. Separate elapsed timings identify the slow phase;
an already absent container is the only ignored removal error. Secondary upgrade containers are acquired by the owned `beforeAll` fixture,
registered immediately, and ready before the 60-second test bodies begin.
A body that times out before its local `finally` therefore cannot leave a pending
acquisition that returns after suite teardown. Local `finally` blocks reuse the
same bounded cleanup.

The helper's default is the pinned test PostgreSQL image; explicit images retain
their behavior unless they exactly match an inventory pin. Shared acquisition
first inspects every source locally and reuses only an exact pinned index digest;
absent or nonmatching pins require pulling, while daemon/inspection errors refuse.
It resolves once per process per exact input reference before port retries, then
runs the successful
reference with `--pull=never`. Explicit pinned overrides first verify the exact
local RepoDigest, avoiding a second pull phase after the gate resolves its image. Failed
resolutions are evicted from that process cache.
The gate, helper and pgTAP runner use the same pull implementation. It tries at
most three times per source within a 300-second pull budget measured with a
monotonic clock, including local inspections and final digest verification.
Retries share a source deadline. With multiple sources, 60 seconds of the
300-second budget is reserved across the remaining sources: a first cold pull
can use up to 240 seconds, while a stalled first mirror cannot consume every
fallback's opportunity. Fast refusals leave their unused time available. A
single source retains the full 300 seconds. A shorter caller budget scales the
reserve to 20%. Pulls receive their remaining source time, clamped to at least
one millisecond. These are execution limits, not a throughput guarantee for a
large cold layer; calibrate them against hosted cold-pull measurements. The
300-second total still leaves half the gate's 600-second hook for startup and
the migration prefix.
Retry-After seconds and Go subsecond units above the current source's equal
share of the remaining budget immediately advance to the next source.
Otherwise 1s/2s minimum waits are capped at five seconds and the remaining budget;
expiry prevents another pull. Backoff adds at most 10 seconds per failed source
(30s per image), all inside the pull budget. There are at most nine pulls per
image.
The shared loop retries transport, context-deadline, killed process timeout,
registry 5xx and 429 failures. Mirror not-found,
denied or unauthorized errors immediately fall through without retry when an
upstream source is selected. Library PostgreSQL consumers retain Docker Hub/ECR
fallback in CI and locally, except the required `install-packages` PostgreSQL
startup step, which selects only the GHCR mirror. An empty or inaccessible private
organization mirror does not by itself fail the other PostgreSQL consumers;
that required startup step has no upstream fallback and requires organization
package access.
Local daemon/disk/malformed failures, upstream non-transient errors and pinned
RepoDigest mismatches refuse rather than silently selecting another image.
The gate's offline guard rejects literal digest pins or registry source lists.

The pgTAP runner pulls its single image, the install-proof `postgres:17` pin,
through the same loop and starts it with `--pull=never`. Every pull and local
reuse requires the exact pinned index digest; the loop refuses a tag-only input.
No upstream push or registry
write occurs. Other launchers retain their existing acquisition behavior. The
package-proof PostgreSQL 17 service is started explicitly after GHCR login,
using the exact inventory digest from the organization mirror with `--pull=never`.
It is removed even when package proof fails.
An upstream source may retain an explicit tag only when it matches its JSON tag;
resolution preserves that spelling and always verifies the pinned digest.
The script resolves upstream tags to digests, copies complete indexes to
`ghcr.io/openlup/<upstream-repository>:<tag>` (slashes retained), skips identical
target tags, refuses conflicting tags and verifies the digest after copying.
Exactly two jobs receive `packages: write`: `mirror` in `mirror-ci-images.yml`
and `publish-qualified-image` in `registry-tutorial.yml`. The publisher runs only
after successful qualification for a release-event run or an explicit
`publish_image: true` dispatch, verifies and copies the downloaded OCI archive,
and executes no candidate code. This split keeps installation code away from a
write token. The mirror reads owned pins from its own
checkout, refuses a missing digest or two pins that would write different digests
to one target, and runs only SHA-pinned first-party actions plus the
dependency-free repository script. A moved tag is refused.
The writer-control witness exempts a workflow only when its text has no `write`
(case-insensitive, including comments and longer words), no backslash escape in a
double-quoted scalar and no YAML tag (`!`). Every other workflow uses the canonical
subset, with plain literal permission keys and `read`, `write` or `none` values;
remove quotes, escapes and tags from permissions. For candidate writers, it accepts plain
block jobs and single-line or block permission maps, including blank lines until
dedent. It refuses anchors, aliases, merge keys, tabs, extra YAML documents and
workflow/job defaults in candidate writers.
The publisher fingerprint also seals workflow environment, permissions, triggers
and concurrency; workflow keys must precede jobs. The qualification job's complete
permission map must be exactly `contents: read` and `packages: read`.
The token reaches login through environment and stdin after validation and resolution,
immediately before copying; a `finally` block removes the temporary registry
credentials.
The mirror never re-points an existing tag, so an owned pin's digest bump must use a
new, more specific upstream tag; the old target tag stays as it is.
Offline planning, skip/refuse and verification tests accompany exact workflow
trigger, permission, checkout and credential-transport assertions.

PostgreSQL consumers with upstream sources fall back while packages are absent or
private. The required `install-packages` PostgreSQL startup step and the starter
browser image are mirror-only exceptions: an absent or inaccessible organization
package fails `install-proof`. The organization must allow public package
creation and the initial private creation GHCR uses. After the first authorized
mirror run, the owner must link each mirror package to `openlup/openlup`, ensure
that repository has Actions `Write` access, set package visibility to `Public`,
and confirm anonymous pulls. `GITHUB_TOKEN` cannot make a package public;
linking a public repository does not change package visibility. For the GitHub
settings steps, see
[CI image mirror and container pulls](../../../docs/platform/DEVELOPMENT_AND_RELEASE.md#ci-image-mirror-and-container-pulls).

## Required and raw checks

The root application and tooling use `strict` in `tsconfig.app.json` and
`tsconfig.node.json`. The tooling project reads existing JavaScript imports with
TypeScript inference and JSDoc. The separate `tsconfig.tests.json` project keeps
its own integration-test compiler settings, including strict null checks.

Use the Node version recorded in [.nvmrc](../../../.nvmrc), npm 11.19.0 (the
`packageManager` field of `package.json`), and the committed npm lockfile. CI and
release workflows pin Node 24.21.0, which bundles npm 11.19.0, so newer Node 24
releases cannot change npm beneath the existing assertions. `.nvmrc` pins the same
24.21.0 runtime locally; the npm contract is unchanged. From
the root of a materialized public source tree, these are the commands the
mechanical/diagnostic jobs of [Published Tree CI](../../../.github/workflows/published-tree-ci.yml)
run; each comment names its job. The inherited `native-review` job additionally
checks exact-candidate admission when the maintainer enables `OPENLUP_NATIVE_QUEUE`;
its six required dependencies and merge-group metadata controls remain unchanged:

The bundle binding proof derives stock reason codes through the existing host
helper before comparing wrapper and package output. The native read proof keeps
its no-write snapshot assertions inside a `try` and removes only the inserted
tier-price rows in `finally`, so its fixture cannot affect later write cases.
These changes retain the existing cases and assertion operators.

The second opt-in payment example extends the existing narrow vendor allowance
and permits its market currency token only in its own source/test directories.
Each vendor's full-content allowance matches only its own source/test paths.
Paired real-scanner plants keep vendor and currency vocabulary outside those
paths counted, including each vendor word inside the other adapter's source
and test directories. Its offline witnesses retain all donor cases as moved-pending;
the reporting zone is allowed only on the exact readback declaration at its
exact source path, with outside-line/path plants and no baseline increase. An
excess allowance fails closed with an actionable error naming the category,
quoted path and negative remainder. Scanner-count plants exercise payment,
communications and adoption subtraction lanes.
New attempt/redaction/envelope/validity/freshness cases are counted separately. The packed payment
consumer imports both optional subpaths with ambient I/O disabled and no SDK.
Focused loopback transport tests fence every socket except their disposable
local listener; they never establish provider-account readiness.

Required root `test` accepts only success from all eight `test-full-shard` jobs;
failed, cancelled or skipped shard jobs refuse it. Main-push reuse requires a
complete successful exact-commit merge-group run, including raw pgTAP.
The `test-full-shard` and `pgtap` jobs authenticate ghcr.io pulls with the
job's `GITHUB_TOKEN` and `packages: read` before non-reused tests; login failure
fails the job.
`install-packages` and every `install-browser` shard also authenticate before
their first image pull. The package job starts its PostgreSQL service in a step
after login, using the organization mirror only.

The raw `pgtap` job, which the required `test` aggregate also requires, follows the
[managed pgTAP on plain PostgreSQL plan](../../../docs/platform/plans/neutral-postgres-pgtap.md).
`node scripts/public-ci-pgtap.mjs` applies the managed-compatibility adapter
`tests/postgres/managed-compat/supabase.sql` and replays the committed managed
chain in one transaction on the digest-pinned stock PostgreSQL 17 image, with
pgTAP, `pg_cron` and `pg_prove` from the checksum-pinned packages in
`config/ci-postgres-packages.json`. It then runs every shipped test with
`pg_prove` inside that container, using the retired Supabase CLI lane's argv
plus `--verbose`. It needs Docker, but neither the Supabase CLI nor npm
dependencies, and writes its TAP, catalog snapshot and environment fingerprint
to `.context/scratch/pgtap/`. The runner removes its own container on every
exit path it controls; an interrupted run leaves a disposable-labelled container
for the dead-owner sweep. Locally, `node scripts/pgtap-parity.mjs compare <left.log> <right.log>`
compares two TAP logs assertion by assertion and fails on any difference,
including a file present in one log only; `diff` compares two snapshots or
fingerprints. The runner takes one of the five planned `--sabotage` switches,
each of which must fail. It is not a required context of its own; the required
`test` aggregate, which native review waits for, requires it.

See [Test scope and diagnostics](testing.md#test-scope-and-diagnostics) for selection,
sharding, discovery and test-author guidance.

The required `install-proof` context aggregates `install-packages` and all six
`install-browser` shards. It requires actual success from both dependencies; failed,
cancelled or skipped jobs refuse admission. On main pushes, `install-packages`
checks `scripts/public-ci-reuse.mjs`; browser shards share its decision so a
reused producer never leaves a consumer without artifacts. Expensive steps skip
only with successful exact-commit merge-group evidence, leaving successful
dependency jobs for the aggregate. The six required context names and native-review dependencies stay fixed.

`install-packages` runs the shared package gate after both reference-profile builds,
independently of the required `test` job in a separate checkout and installation. It discovers every publishable package from `config/openlup-packages.json` and its actual npm workspace, and refuses missing `api:check`, `ci:required` or `test:consumer` scripts before packing. The existing cold producer emits one current-set manifest. All API checks run before any package's `ci:required`, which receives the same verified manifest and exact checkout commit through `OPENLUP_PACK_MANIFEST` and `OPENLUP_PACK_COMMIT`. Cold preparation clears each workspace per target, so the API phase restores each package's built declarations and prerequisites through the existing build helper; it leaves the retained tarballs untouched and includes that cost in its timing. There is no missing-script skip or package-name routing table. A new module must supply installed-artifact consumer coverage, meaningful failure cases and its owning required batch; script declarations alone do not prove that those assertions are sound. Review checks that the batch actually invokes its consumer and preserves its required tests. Keep API checks out of that batch because the shared phase already runs them.

The packed-candidate guide tutorial runs after the package gates as a blocking
step: its condition of two green merge-group runs on main has been met.
The separate registry tutorial runs trusted default-branch code after a
successful core publication, checking the release tag's commit against the
completed publication run. A maintainer may also dispatch it from the default
branch for an existing core release tag. It waits up to thirty minutes for the
matching npm set; automatic runs also require core's `latest` to match. The
tutorial is blocking after two green release runs: a failure fails its own
workflow run and reports to the maintainer; a propagation timeout warns and
defers the tutorial. It runs after publication and cannot affect it. The
separate `exact-set-qualification` job verifies and tests the exact locked npm
set against release provenance and retains a blocking qualification result
and a 90-day receipt. A dispatch with `publish_image: false` skips the publisher
job, so no write token is minted; its retained qualification receipt is the run's
receipt, with no separate publication receipt. Both jobs have `contents: read`;
qualification also has `packages: read` for the pinned PostgreSQL mirror. See the
[qualification owner](../../../docs/platform/DISTRIBUTION_EVIDENCE.md#exact-published-set-qualification)
for trust, evidence and support limits. The workflow adds no required PR check,
does not hold publication open and does not delay the next dispatch.

After package proof succeeds, `install-browser` runs the starter's installed
PostgreSQL browser journeys in six parallel shards through
[`starter-browser-ci.mjs`](../../../scripts/starter-browser-ci.mjs). Pinned official artifact
actions transfer only the verified manifest and public tarballs from the package
job, retained for one day; private browser output is never uploaded. Each shard
verifies all manifest hashes, the package inventory and the exact checkout commit
before installing, then checks installed-package confinement. The zero-based
`--groups` selections are `0`, `6`, `1`, `2`, `3,5` and `4`, covering every group once.
Each shard acquires an isolated disposable
PostgreSQL 16 per configuration through the shared test helper and `test-postgres`
inventory pin. The package job's PostgreSQL 17 service retains its package proofs. The runner
installs and seeds both demonstration configurations, verifies migration replay
and the restricted runtime identity, and starts two loopback hosts per group.
The seven shared selections are subscription care; portal; recovery extension;
combined operator operations, returns portal and shipment operations; combined
payment guidance, account preferences, embedded browser and billing profiles;
payment retry; and the remainder. Setup failures stop before another group is
acquired and report the group and phase; Playwright failures allow later groups
in that shard to retain their diagnostics. An authenticated
GHCR pull selects the pinned `starter-browser` image through the shared reader
and pull loop; mirror failure refuses without a vendor fallback or browser
download. Playwright runs the database config with one worker, traces, video and
screenshots off, read-only application inputs and temporary container results.
The private care fixture matches each host to its runtime/owner connections and
mailbox directory. Only that care directory is writable in the browser, which
runs with the host user identity to preserve private capture permissions.
The script captures output privately, scans it for credentials, removes its
hosts, containers, databases, roles and scratch files on success or failure, and
prints the public image identity, counts, timings and bounded failure diagnostics. It uploads no artifacts.
Current deadlines are 20 minutes for packages, 12 per browser shard and 2 for
the aggregate. Set each job deadline to at least 1.3 times its slowest observed
hosted run.
Playwright retries nothing. In hosted CI only, a group whose journeys fail
reruns once, with fresh databases, hosts and state, in the same shard, after the
first attempt's cleanup completed. A setup or cleanup failure is never rerun, nor
is a rerun that would not fit `OPENLUP_STARTER_BROWSER_RETRY_BUDGET_MS` (default 300000;
the workflow sets the job deadline less setup): the time already used, one more attempt
as long as the failed one, an equal estimate per later group and a reserve for the
catalogue upgrade or cleanup must fit, otherwise it prints `retry skipped: budget`. A group that passed only on the rerun is reported the same
way as a flaky Vitest file (`flaky-retry-passed: starter browser group <n>`). See the
[starter proof recipe](../../../examples/neutral-store/docs/proof.md#database-backed-purchase-acceptance-recipe)
for the selected journeys and the separate local proofs.

Dependency security has two boundaries. PR/merge-group admission refuses newly
selected vulnerable production dependencies against the exact comparison base;
an advisory affecting an unchanged dependency inherited from that base remains a
Dependabot alert, not a repository-wide merge freeze. Unknown dependency scope
is treated as production. Unavailable or incomplete audit data does not establish
PASS when dependency security inputs changed. This uses the existing
`install-proof` status; tests, API, lock, license, SBOM, pack and publish controls
remain required. Core's `ci:required` runs `release:admission`, which preserves
those controls without repeating the absolute live audit. Standalone `ci` and
`release:check` retain the absolute audit.

Publication is stricter: `packages:check --release-tag` / `--release-set` packing
runs a fresh full audit of the selected committed workspace dependency graph,
including internal prerequisites and their standalone locks, under the existing
zero-vulnerability budget. npm's production flags may conservatively include
shared dependencies also used by development tooling; optional peers absent
from the lock are not newly resolved. An audit failure retains no publication
artifacts. Manifest-only checks remain installation-free and do not audit.
The existing release gate also refuses a target with different pack/audit/publisher
control blobs from fetched main, before target code runs; older source is allowed
when these controls are unchanged. Historical release workflow definitions remain
pinned to their own commits.
The publishing workflow requires packing/audit from its current attempt; retry
all jobs after publication failure so the full audit runs again. Existing release
approvals, immutable version rules and protected credentials remain unchanged.

A module added to an existing distribution extends that package's consumer and
required batch; it does not need another npm workspace, runner or CI job.
Preserve the complete package proof and name the new module's behavior,
refusals and schema obligations. Grouping modules does not waive the
[internal dependency graph](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#internal-boundaries-and-adapter-isolation)
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
[migration contract](../../../packages/core/docs/guide/upgrade/database-migrations.md#select-the-complete-catalogue).

Core's required batch retains coverage, standalone types, documentation, release checks and its supplied-artifact consumer. Outbox's batch owns schema/SQL/replay against its installed tarball; its unit/factory/admission tests run once through the protected root selectors. The outbox workspace builds after core for root lint and test entrypoints. Package-local import checks still reject private subpaths, cross-directory escapes, aliases and other workspace dependencies; portable outbox production source also rejects provider SDKs. Missing artifacts or a required runtime refuse; there is no workspace fallback or DB skip. Only modules with SQL obligations need a database. Outbox's pinned job-owned PostgreSQL service is separate from raw pgTAP; see [the rail guide](../../../packages/outbox/README.md) for ownership and proof limits.

For communications characterization and mail-boundary witness evidence, see the
[communications contract](../../../docs/platform/CANONICAL_CONTRACTS.md#communications-import-compatibility)
and [witness ledger](../../../docs/platform/plans/oss-m04-communications-triggers.md).

To inspect the same local obligation plan the runner executes, before committing
or requesting review:

```sh
node scripts/verify-local.mjs --plan
node scripts/verify-local.mjs --plan --json
# Include the raw DB diagnostic when its inputs are in scope:
node scripts/verify-local.mjs --plan --pgtap
# Inspect the opt-in affected-test plan:
node scripts/verify-local.mjs --layered --plan --json
```

Planning is read-only and works on an unreviewed, dirty task worktree without
dependencies, a broker or scanner. It lists each phase's command, environment,
owner, reason, prerequisites, resource profile and corresponding CI context.
It also observes the selected Node/npm/scanner versions, installed compiler
version against the lockfile, comparison and scan history, cleanliness and profile
overrides and Docker availability. Shallow scan history stays unknown. Each state
has a next command; the planned install phase prepares an absent compiler. The
resource broker remains optional. These bounded read-only probes install
nothing and start no builds, tests or containers.
It does not select fewer mandatory phases, execute verification, establish native
review or create verification evidence. Exit 0 means the comparison scope is
known, even when an observed prerequisite is blocked. Output paths are
placeholders until execution.
An unreadable Git comparison reports unknown scope, retains all obligations and
exits 2; recover the missing history or valid stack pin before execution.
The candidate's changed paths describe committed changes only; `clean: false`
also warns of pending working-tree changes. Package discovery and bounded root
tooling selection remain with their existing owners, not a second selector.

The separate advisory `npm run preflight` reports cheap checks and changed-test
discovery before package preparation. Confirmed package/browser suites retain
their owning runner; an unconfirmed changed test reports `WARN` with a discovery
next step and remains missing execution proof. Every applicable check still runs.

For optional local feedback after committing and recording the required native
reviews, run the full local command set with `node scripts/verify-local.mjs` from
the task worktree root.
pgTAP is auto-selected when SQL changes under `db/` or `packages/*/sql/`; add
`--pgtap` to force explicit selection when the change reaches other database
inputs (including runtime, fixture, configuration or harness changes), or when
requesting that raw diagnostic.
The runner uses the commands below once: a single locked install, lint's package
prerequisites, both reference builds, shared package/API/coverage gates and one
`test:scoped`. Hosted shards, event-bound dependency comparison and receipt
admission remain hosted checks; this optional command is local feedback.

For a shorter opt-in local loop after review, use `node scripts/verify-local.mjs
--layered`. It keeps the same fast phases and package gates, then runs
`npm test -- <affected paths>` selected by `scripts/affected-tests.mjs`. If no
Vitest file is affected, the tests phase reports `0 affected Vitest files
(full suite runs in hosted CI)` and succeeds. The default command still runs
`test:scoped`; hosted CI and Merge Queue run all eight Vitest shards.

Each phase uses the existing native before/after review and candidate checks.
Where the optional resource broker is installed, a closed phase map selects its
existing coverage, build, typecheck and pgTAP profiles; task names never select
resources, and an unknown phase refuses before execution. Otherwise the native
wrapper runs directly. Logs retain exact commands, profiles, exits, timings and
the first root-worker observation; later synthetic fixture output cannot stand
in for it. Machine resource policy and explicit worker settings remain effective.
Tree-wide and UI neutrality run before installation and heavy phases: their
Node/Git checks need no dependencies. All thirteen mandatory phases remain;
pgTAP is auto-selected when SQL changes under `db/` or `packages/*/sql/` and
`--pgtap` still forces explicit selection. The runner consumes the explained plan;
execution still checks the current candidate and review before/after commands.
Independent read-only phases (`resource: null`) run concurrently (default
concurrency 4) before installation; build/package/root phases stay serial
because they share generated outputs. SSR output stays in a unique ignored
worktree scratch directory so external npm imports still resolve; cold package
artifacts stay outside the checkout. The first failure stops further launches
(draining any already-started read-only phases in the current wave) without an
automatic retry or reuse of earlier passes. The manual equivalents remain available:

```bash
# Cheap checks need no dependency install.
npm run oss:published-tree -- --policy
npm run oss:published-tree -- --inventory
# Or run both in one pass with shared tree/snapshot scanning:
npm run oss:published-tree -- --self-check
# dco (needs no install): the commits your branch adds to origin/main
npm run check:dco-signoff -- "$(git rev-parse origin/main)" "$(git rev-parse HEAD)"
# gitleaks: verify-local.mjs scans base..head unless config/gitleaks.toml or .gitleaksignore changed (matching CI); omit --log-opts for full history
gitleaks git . --config config/gitleaks.toml --redact --no-banner --log-opts="$(git merge-base HEAD origin/main)..HEAD"
node scripts/public-ci-neutrality.mjs --base-commit "$(git merge-base HEAD origin/main)"
node --experimental-strip-types packages/ui/smoke/neutrality.ts
# The runner uses the validated OPENLUP_STACK_BASE instead of the fork point
# for a stacked task. Keep that exact same comparison base in manual commands.

npm ci
# npm run lint and npm test build Core, Outbox and Platform through pre-scripts.
# typecheck
npm run lint
npm run oss:published-tree -- --typecheck
# install-packages, under install-proof (CI installs with: npm ci --prefer-offline --no-audit --fund=false)
npm run build
OPENLUP_REFERENCE_PROFILE=subscription OPENLUP_BUILD_OUT_DIR=dist-subscription \
  OPENLUP_SSR_OUT_DIR=dist-subscription-ssr npm run build:public-reference
# install-packages: package gates after both builds on a clean signed candidate
# Keep package gates before root tests locally: one checkout shares build outputs.
GATE_PACKS="$(mktemp -d)"
# Local SQL proof owns one ephemeral PostgreSQL container; CI passes the explicitly started container identity/port.
node --experimental-strip-types scripts/packages/required-package-gates.ts \
  --out "$GATE_PACKS" --expected-commit "$(git rev-parse HEAD)"
# test: omit bounded tooling fixtures whose inputs are untouched, including dirty files.
npm run test:scoped
# Hosted test-prep runs once before the eight test-full-shard jobs:
# node scripts/ci-test-scope.mjs (OPENLUP_VITEST_EXCLUDE_FILE -> .context/scratch/ci-test-exclude.txt)
# node scripts/build-packages-incremental.mjs (shared as the test-prep artifact)
# Hosted test-full-shard runs eight parallel independent installations with that artifact:
# node scripts/ci-vitest-shard.mjs --shard N --total 8 --skip-pretest (N = 1, 2, 3, 4, 5, 6, 7, 8)
# pgtap (Docker required; no Supabase CLI or npm install)
node scripts/public-ci-pgtap.mjs
```

The `prelint` and `pretest` scripts build Core, Outbox and Platform in dependency
order. Before direct typecheck or Vitest commands after install or package-source
edits, run `npm run pretest`; otherwise consumers may read stale `dist/` exports.

The [reviewed-forward PostgreSQL proof](../../../tests/postgres/reviewedPortableCreation.test.ts) rejects landed pin drift before replay and tests byte selection for full and partial landings; [data and migrations](../../../docs/platform/DATA_AND_MIGRATIONS.md#exact-reviewed-function-forwards) describes its catalog boundary.
See the [invoicing forward owner](../../../docs/platform/DATA_AND_MIGRATIONS.md#m09-invoicing-forward-design-and-control-approval) for managed correction finalization and parking. The fixture and registry do not install SQL.

For the managed pgTAP runner, prerequisites and proof limits, follow
[Test scope and diagnostics](testing.md#separate-db-package-and-coverage-proof).

The four `oss:published-tree` modes are distinct checks. `--policy` verifies
the public policy, catalogue, documentation ownership, generated navigation,
source-map freshness, and (when comparing committed `HEAD` against a distinct
PR, merge-group, explicit `--docs-base`, or local merge-base commit) append-only
migration history plus package API `Migration:` blocks; `--inventory` verifies
the selected tree; `--self-check` runs both `--policy` and `--inventory` in a
single pass over the tracked tree and source-release snapshot; and `--typecheck`
compares the preview's
diagnostics with its tracked compatibility debt. The source repository's
aggregate typechecker is not part of the projected command inventory and is not
a substitute for `--typecheck`.
`npm run oss:published-tree -- --sync-catalog` updates the catalogue from tracked
Git paths: it removes deleted rows and admits new safe files as `public-output`.
Pattern-admitted fragments, guide pages and manifest-pinned platform SQL
migrations remain outside per-file rows; policy paths, withheld files, untracked
files, private coordinates, and unknown direct execution entrypoints are refused. Stage the current file, publication catalogue
and policy registry before admitting a new output. Review any new class before
publishing.
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

Published Tree CI runs the mechanical checks against the actual queue group.
DCO includes the synthetic tip. Pull-request attribution uses `GITHUB_SHA` and
the exact event-base and head parents; `merge_commit_sha` in a synchronize payload
may lag. The optional local mirror runs raw diagnostics only on request or when
database inputs select pgTAP. Review and receipt mechanics are defined in
[Deliver a change](../../../CONTRIBUTING.md#deliver-a-change).

For package contract tests and installed-consumer witnesses, follow the
[platform package reference](../../../docs/platform/PLATFORM_PACKAGE_REFERENCE.md) and
[package guide](../../../packages/platform/README.md).

## Commands and lint rules

The complete projected root command inventory is `build`,
`build:public-reference`, `build:public-reference:client`,
`build:public-reference:prerender`, `build:public-reference:ssr`,
`check:dco-signoff`, `guard:client-secret-boundary`,
`guard:public-reference-site-routes`, `inventory:refresh`, `landing:merge`, `migration:finalize`, `migration:sync`, `lint`, `preflight`, `prelint`,
`oss:published-tree`, `packages:check`, `release:bump`, `release:docs-pass`, `sql:admit`, `pretest`, `test`, `test:affected`, `test:hosted`, and `test:scoped`.
This reclassifies the complete current root script inventory; all commands are
public, with `test:affected` as the local targeted wrapper and `test:scoped` as
the local wrapper around the unchanged `test` command.
`npm run build` is the public build truth; its public-reference subcommands and
guards are internal links in that bounded chain. Published Tree CI invokes the
build, sharded required root tests, DCO check, and publication checks from this inventory.
Adding or renaming any source package command requires reclassifying the whole
source command-name inventory before a new preview can be materialized.

Keep historical source/config backups outside the checkout's tool traversal.
Git-ignore alone prevents neither executable `eslint.config.*` discovery nor
linting an archived test import. Preserve archival byte/hash provenance in task
evidence; retain the scope and semantics of real test fixtures.

`npm run lint` runs ESLint over the tree, including the import boundaries in
[eslint.config.js](../../../eslint.config.js): a package under `packages/` imports
nothing outside its own directory, other code reaches a package only through
the subpaths its `exports` declare, and domain code under `src/domains` and
`server/domains` imports no configured provider SDK and no adapter,
infrastructure, runtime or route code; the config exempts domain tests.
Non-test production source under `packages/core/src` and `packages/ui/src`
also imports none of the provider SDKs listed in the config. In the neutral
starter, `client/` and `shared/` source takes runtime values from
`@openlup/platform` only through an entry the config lists as browser-safe;
`import type` declarations and `host/` code are unaffected. An inline
`import { type A }` is refused; its fix is `import type`. Package tests
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

The [import-boundary test matrix](../../../scripts/packages/eslint-import-map.test.ts)
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
