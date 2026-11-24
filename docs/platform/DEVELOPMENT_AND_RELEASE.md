# Development, diagnostics and releases

Status: current contributor guidance for stable 1.x.
Audience and purpose: contributors and maintainers following a change from local
verification through a pull request to a package release on npm, or to an
optional source preview, which carries no package.
The [stable API policy](../../packages/core/docs/guide/reference/stability.md#public-api)
and [install support policy](../../.github/INSTALL_SUPPORT_POLICY.md) define the
release’s commitments. A successful contributor check alone does not qualify a deployment.

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
| `node scripts/verify-local.mjs --plan` (optionally `--json`, `--pgtap`, `--layered`) | Read-only explanation of the selected local phases, including owners, reasons, prerequisite order, commands and resource profiles. Works before review on a dirty task worktree without dependencies. | Planning only; no checks, scratch output, review validation or verification evidence. Unknown Git scope exits 2 and retains all obligations. Package discovery and root tooling selection retain their existing owners. |
| `node scripts/verify-local.mjs` (add `--pgtap` for DB inputs or an explicitly requested diagnostic) | Optional full local command set after committed native review; one install and root run, serialized builds/package gates, fixed existing resource profiles when the optional broker is present. | Optional local mirror of the required hosted commands; [contributor commands](../../CONTRIBUTING.md#required-and-raw-checks) own scope and limits. Logs retain exits, timing and the first root-worker observation. No hosted admission, new stamp, retry or cached pass. |
| `node scripts/verify-local.mjs --layered` | Opt-in local affected-test selection after the same fast phases and package gates; `--plan --json` shows the exact `npm test -- <paths>` command or a zero-test skip. | Full eight-shard Vitest coverage remains in hosted CI and Merge Queue. The default local command still runs `test:scoped`. |
| `node scripts/agent-review-session.mjs verify-command -- <heavy required command>` | Native review verification before and after the command, with unchanged HEAD tree and clean worktree; optional installed host resource broker. | Command wrapper; preserves underlying commands but does not attest completeness of selected commands. Before starting, it predicts merge/carry-over against locally fetched `origin/main`; refresh that ref first. The [canonical wrapper limits](../../CONTRIBUTING.md#local-stack-bases-and-heavy-verification) include local review of unlanded stacks. It adds no proof lease or policy/inventory check. Independent PRs use their normal base; stacked PRs export the exact `OPENLUP_STACK_BASE`. No cache, hosted receipt, settings change or merge authority. |
| `node scripts/public-ci-neutrality.mjs --base-commit <full-base-sha>` and UI neutrality smoke | Tree-wide shrink-only neutrality and portable UI boundary; local and CI `self-check`. | Required. Use the exact event/comparison base, not a guessed latest main. |
| Shared `scripts/packages/required-package-gates.ts` in [required checks](../../CONTRIBUTING.md#required-and-raw-checks) | Discover each publishable workspace and its required scripts; cold-pack the current set, check all APIs, then run each owning required batch with the same artifacts. Core retains mechanical CI obligations and uses dependency-regression admission instead of the absolute release audit; Outbox owns schema/SQL/replay. | `install-packages` follows both builds in its own checkout, independently of root tests; the required `install-proof` aggregate also requires four browser shards consuming its verified manifest and tarballs. Local package preparation and tests remain serial because they share build outputs. Missing routes, artifacts or runtimes refuse. Future modules use the same semantic consumer proof; only SQL modules require a database. |
| `npm --workspace @openlup/core run ci` | Package coverage, runtime imports, type smoke, API snapshots, docs, release checks and packed-consumer smoke; local and CI `install-proof`. | Standalone `ci` includes the full live audit. Required PR/queue proof uses the shared API phase plus `ci:required` and dependency-regression admission, with manifest/commit inputs. Manual mode still builds/packs; supplied mode executes the same assertions without repacking. Separate from root Vitest discovery. |
| `npm run test:scoped` locally; `node scripts/ci-vitest-shard.mjs --shard N --total 8` in CI | Root Vitest; see [testing](../../CONTRIBUTING.md#test-scope-and-diagnostics) for discovery, selection and weighted sharding. | Required `test` aggregates all eight root shards and pgTAP and refuses failure, cancellation or skipped dependency jobs. Individually skipped cases remain missing proof. Package gates remain separate. |
| `node scripts/public-ci-pgtap.mjs` | Shipped SQL tests against the committed managed baseline and forwards on the digest-pinned stock PostgreSQL 17 image with the [managed-compatibility adapter](../../tests/postgres/managed-compat/supabase.sql) and checksum-pinned pgTAP, pg_cron and `pg_prove` packages; local and CI `pgtap`. Requires Docker only: no Supabase CLI and no npm install. | Required in CI through the `test` aggregate; a raw diagnostic locally. Start, replay, cleanup failures and unexplained new failures block delivery under contribution rules. `node scripts/pgtap-parity.mjs` compares TAP logs, snapshots and fingerprints. |
| `npm run build` and subscription-profile build | Install/build proof for reference profiles; local and CI `install-proof`. | Required. A build does not prove a browser journey, live provider or production deployment. |
| `npm run check:dco-signoff -- <full-base-sha> <full-head-sha>` | Sign-off on the full commit range; local and CI `dco`. | Required. Empty ranges and malformed identities are not success evidence. |
| Gitleaks | Secret scanning in CI `gitleaks`: the non-empty pull-request or merge-group commit range, or the complete history when that range changes `config/gitleaks.toml` or `.gitleaksignore` and on main pushes. Range scans cover everything that reaches `main` only while its merge queue is ALLGREEN, merges one entry per group with the MERGE method and has no bypass actor; changing those settings needs this scope reviewed again. Unpacked tarballs in release preflight and package workflow. | Required in those owners. Use pinned configuration/version and redacted logs; it is distinct from local publication leak checks. |
| Native session review and `native-review` | Independent semantic review through native subagents or a qualified local CLI, bound to candidate, scope and criteria; hosted receipt admission after mechanical success. `node scripts/agent-review-session.mjs status --explain` inspects local candidate alignment, required floor, open findings and delta scope without running `verify`. | Required for registered agent tasks; hosted status depends on explicit activation. `--explain` never declares readiness. Review does not grant publication or release authority. |
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
[execution ownership](../../CONTRIBUTING.md#contribution-checks) and the
[selected subscription evaluation](SUBSCRIPTION_REFERENCE.md).

### CI image mirror and container pulls

The [CI image mirror](../../.github/workflows/mirror-ci-images.yml) and shared
[image reader and pull loop](../../scripts/ci-image-pull.mjs) use only the
committed [image inventory](../../config/ci-images.json); see
[CI image mirror](../../CONTRIBUTING.md#ci-image-mirror) for pull budgets,
digest-only verification, disposable PostgreSQL timeouts and workflow permission
rules.

Apply the [owner setup requirements](../../CONTRIBUTING.md#ci-image-mirror) in
organization **Settings → Packages → Package Creation**. After the first
authorized mirror run, open each mirror under **openlup → Packages**. Use
**Connect repository** to link `openlup/openlup`, **Package settings → Manage
Actions access** to grant the required access if inheritance does not already
provide it, and **Danger Zone → Change visibility** to set the required
visibility. Confirm anonymous pulls after applying the settings. See GitHub's
[package access and visibility procedure](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)
and [repository linking procedure](https://docs.github.com/en/packages/learn-github-packages/connecting-a-repository-to-a-package).

### Benchmark portable Outbox claims

Run the [claim benchmark](../../scripts/benchmarks/outbox-claim.sql) in an
empty disposable PostgreSQL 17 database with `auto_explain`. The script installs
the unmodified standalone migration within a transaction. Its bytes match the
Native platform's communications Outbox migration. Each run rolls back schema,
fixture and index changes.

From the repository root, start a local container without network access and
run each variant three times.

```sh
benchmark_container=$(docker run --rm --detach --network none \
  --env POSTGRES_HOST_AUTH_METHOD=trust \
  --mount "type=bind,source=$PWD,target=/repo,readonly" postgres:17) || exit 1
trap 'docker stop "$benchmark_container" >/dev/null 2>&1 || true' EXIT
benchmark_log_dir=$(mktemp -d) || exit 1

# The entrypoint's temporary initialization server only listens on a Unix socket.
ready_attempts=0
until docker exec "$benchmark_container" pg_isready -h 127.0.0.1 -t 1 -U postgres >/dev/null 2>&1; do
  ready_attempts=$((ready_attempts + 1))
  if [ "$ready_attempts" -ge 30 ] ||
    [ "$(docker inspect --format '{{.State.Running}}' "$benchmark_container" 2>/dev/null)" != true ]; then
    printf '%s\n' 'Disposable PostgreSQL did not become ready over TCP.' >&2
    docker logs "$benchmark_container" >&2
    exit 1
  fi
  sleep 1
done

for terminal_rows in 10000 100000; do
  for replicate in 1 2 3; do
    for variant in baseline prior pair; do
      docker exec "$benchmark_container" psql -X -h 127.0.0.1 -U postgres \
        -v history_rows="$terminal_rows" -v variant="$variant" \
        -f /repo/scripts/benchmarks/outbox-claim.sql \
        >"$benchmark_log_dir/$terminal_rows-$replicate-$variant.log" 2>&1 || exit 1
    done
  done
done
printf 'Logs in %s\n' "$benchmark_log_dir"
```

Each fixture has 1,000 ready target events in 1,000 aggregates, 20,000 ready
events for a separate known handler and either 10,000 or 100,000 compacted
terminal events. Read the fixture summary for oldest ready age and average row
bytes. The log contains nested plans with buffer counts for one representative
batch and elapsed database time for 40 batches of 25 rows with acknowledgement
through the installed SQL functions. `prior` adds the managed aggregate
predecessor index. `pair` also adds its ready-claim index.

On PostgreSQL 17.11 (arm64 Docker, source base `9a6270350`), three runs
per variant produced these medians. Index size is the total for the table
after the synthetic drain.

| Terminal rows | Variant | Drain in ms | Events per second | Index MiB |
| ---: | --- | ---: | ---: | ---: |
| 10,000 | Baseline | 425.01 | 2,353 | 5.26 |
| 10,000 | Prior | 363.11 | 2,754 | 7.38 |
| 10,000 | Pair | 302.40 | 3,307 | 9.05 |
| 100,000 | Baseline | 285.23 | 3,506 | 17.52 |
| 100,000 | Prior | 239.26 | 4,180 | 19.65 |
| 100,000 | Pair | 254.71 | 3,926 | 21.34 |

The oldest ready target was 41 days and 16 hours. The compacted terminal
rows averaged 214 bytes per row. The planner used the extra ready-claim
index in the 10,000-row exhausted-candidate scan. At 100,000 rows it used the
base status and availability index for that scan and the added predecessor
index for the ordering barrier. Compare variants within a fixture, where the
initial queue is the same. The larger fixture chose a different plan.

The measurements cover one local synthetic fixture and the database part of a
serial drain. They exclude handler I/O, long-running writer contention,
concurrent workers and index-build impact on an operating system. Keep the
claim protocol and compaction behavior unchanged while qualifying any forward
index on both fresh and upgraded portable installations.

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

## Profiling managed database queries

The [managed query benchmark](history/managed-query-baseline-2026-11-19.md)
runs the installed ATP and OMS statements on a disposable local database.
Use it to compare plans, timing samples, date filters, and hot-SKU contention.

## Measuring delivery improvements

Use the [manual agent regression procedure](plans/agent-dx-regression.md) as a
pre-release measurement supplement to M19 A5. Its four tasks and local candidate
rehearsals remain separate from the full blind adopter journey and
[first-party consumer evidence](../../packages/core/docs/guide/reference/stability.md#release-evidence).

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

## Measure package coverage

Use a scoped Vitest V8 report to identify test gaps before proposing coverage
thresholds. An explicit source filter includes files the selected suites never
load. Start from a repository checkout with the locked dependencies installed.

```sh
set -e
npm --workspace @openlup/core run build
npm --workspace @openlup/outbox run build
npm --workspace @openlup/platform run build

coverage_dir=$(mktemp -d)
measure_coverage() {
  (
    cd "$1"
    time -p env CI=1 npx --no -- vitest run --config vitest.config.ts --maxWorkers=2 \
      --coverage --coverage.include="$3" --coverage.reporter=json-summary \
      --coverage.reportsDirectory="$coverage_dir/$2" "$4"
  )
}

measure_coverage packages/platform payments 'src/payments/**/*.ts' test/payments
measure_coverage packages/platform subscriptions 'src/subscriptions/**/*.ts' test/subscriptions
measure_coverage packages/outbox outbox 'src/{worker,postgres}.ts' test

node - "$coverage_dir" <<'NODE'
const { readFileSync } = require("node:fs");
const { join, relative } = require("node:path");
const directory = process.argv[2];

for (const scope of ["payments", "subscriptions", "outbox"]) {
  const { total, ...files } = JSON.parse(readFileSync(join(directory, scope, "coverage-summary.json"), "utf8"));
  console.log(scope, total.lines, total.branches);
  for (const [file, { lines }] of Object.entries(files).sort()) {
    const label = lines.total && lines.covered === 0 ? "zero" : "included";
    console.log(label, relative(process.cwd(), file), lines.covered, "/", lines.total);
  }
}
NODE
```

Local baseline on source `4391c8be3` with Node 24.22.2 and Vitest 4.1.12
(arm64 macOS). Coverage totals matched in two runs. Wall time includes the
test command and coverage report and excludes workspace builds.

| Suite | Tests | Source files | Files with zero covered executable lines | Lines | Branches | Wall time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Platform payments | 835 | 90 | 11 | 67.01% | 65.74% | 6.77–12.01 s |
| Platform subscriptions, including renewal | 416 | 57 | 7 | 58.40% | 52.09% | 2.28–2.29 s |
| Outbox worker and PostgreSQL adapter | 37 | 2 | 0 | 85.61% | 70.75% | 4.30 s |

Within Outbox, the worker covered 111 of 119 executable lines and the PostgreSQL
adapter covered 14 of 27.

Treat each zero as a gap in the selected suites. For example, the subscription
suite leaves `nativeSubscriptionBinding.ts` at zero. The installed-consumer
and PostgreSQL test suites can exercise behavior outside this measurement.
Use those suites to verify SQL semantics, race handling and installed
composition.

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

The [versioning policy](../../.github/VERSIONING_AND_EOL.md#package-releases)
owns the coherent package set, version model, release permissions, setup,
refusals and recovery. The [package inventory](../../config/openlup-packages.json)
determines the publishable set. Source snapshots are separate. The sequence is:

1. Before the bump, run `npm run release:docs-pass`, adding `-- --website <path>`
   when an openlup.com checkout is available, and attach its output to the
   preparation PR. Prepare the next set version, above every version npm holds, with
   `npm run release:bump -- --set <version>` in a reviewed ordinary PR, either
   separate preparation or an explicitly approved bounded implementation-and-set-bump
   contribution. It sets
   every publishable package and every exact internal pin on one, and opens each
   changelog's version section below a fresh Unreleased heading. It assembles the
   legacy body first, then validated package fragments in byte order of path,
   and deletes only consumed fragments after successful planning and writes,
   then stages those deletions and the documentation writes described below so
   preparation can read the Git inventory. It stages no other changes;
   historical sections stay byte-identical. The bump assembles
   `packages/core/docs/guide/upgrade/v<major>-<minor>-<patch>.md` from the consumed
   fragments and API diff, listing added, removed and changed declarations;
   the maintainer's agent edits that page and the listed guide pages in
   the same PR. The bump also re-pins the guide's repository links and refreshes
   its generated regions, and re-pins released repository links in each publishable
   package's `AGENTS.md` and `README.md`. If no core release tag is an ancestor of HEAD, the listing
   and page say that the previous release could not be determined. Each packed package
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
   ancestry, contexts, a byte-identical fresh source snapshot at the exact Git
   target, the set version of every publishable package and, for a
   patch set, each unchanged API snapshot. It cold-packs every package through
   the shared inventory-based prerequisite route. Before release planning, a set
   dispatch runs the adjacent starter upgrade against the retained, manifest-verified
   local tarballs, then scans every tarball and
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
   The release job tries attestation verification up to three times, ten seconds
   apart, and fails if all three attempts fail.
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

After a successful core publication, the separate
[Guide tutorial against the npm registry](../../.github/workflows/registry-tutorial.yml)
workflow runs trusted default-branch code after checking the release tag's
commit against the completed publication run. A maintainer may also dispatch
it from the default branch for an existing core release tag. The tutorial
reads the tagged page and waits up to thirty minutes for the matching npm set;
automatic runs also require core's `latest` to match. The tutorial is blocking
after two green release runs: a failure fails its own workflow run and reports
to the maintainer; a propagation timeout warns and defers the tutorial. It runs
after publication and cannot affect it. The separate `exact-set-qualification`
job reads the tagged starter as data, verifies and tests the exact locked npm
set, and retains a blocking qualification result and a 90-day receipt. Both
jobs have `contents: read`; qualification also has `packages: read` for the
pinned PostgreSQL mirror. See the
[qualification owner](DISTRIBUTION_EVIDENCE.md#exact-published-set-qualification)
for trust, evidence and support limits. This workflow adds no required PR
check, does not hold publication open and does not delay the next dispatch.

On 2026-11-15, `@openlup/platform@0.43.0` became visible on npm about 12.5 minutes
after its publish was accepted, exceeding the former ten-minute wait in
[the automatic qualification run](https://github.com/openlup/openlup/actions/runs/43691774952).

The packed-candidate tutorial in `install-packages` is blocking because its
condition of two green merge-group runs on main has been met.

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

### Core release preparation

The prepared `1.0.0` set begins the stable compatibility line and adds experimental
exact catalogue quantities, pricing helpers and registry observations, installed
lookup improvements and offline catalogue guidance. Its reader guide covers
Platform's nine native forwards at slots 142–150, explicit migration/backfill
steps, the experimental base-price writer and code-rollback limits. Upgrade the complete set together and read
[the set notes](../../packages/core/CHANGELOG.md#100); Core introduces no schema migration.
Size comparison uses the published `0.43.0` tarball; releases before `0.42.0`
remain in the source-only `CHANGELOG-HISTORY.md`. Preparation establishes no
npm publication or exact-set qualification.

The set requires Zod `^4.6.6` for GHSA-mrhx-c7xc-m3w5.
Oversized constrained collections fail before per-element errors accumulate;
bounded valid inputs and public exports are preserved. Both dependency locks
select the fixed runtime. The build uses the existing development-only Node
types for Zod's standard `URL` declaration; Core adds no runtime Node import.

### Outbox release preparation

The reviewed release workflow owns provenance-backed publication; direct directory publishing refuses. New API and shipped SQL require the next minor set.

The prepared `1.0.0` set declares Outbox's stable runtime subpaths and testing
exclusion, with unchanged runtime, exports and SQL, and an exact
`@openlup/core@1.0.0` peer. Upgrade the complete set together; no Outbox schema
migration is introduced. Read [1.0.0 notes](../../packages/outbox/CHANGELOG.md#100).
Releases before `0.42.0` are retained in the source-only `CHANGELOG-HISTORY.md`.
Size comparison uses the published `0.43.0` tarball; preparation grants no
publication or installation proof.

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
