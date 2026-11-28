# Contributor testing

Status: current contributor guidance for stable 1.x.
Audience and purpose: contributors choosing, placing, running and maintaining tests in the source tree.

Start with the [contribution guide](../../../CONTRIBUTING.md) for scope and the local workflow.

## Test scope and diagnostics

Use the pinned Node version in [.nvmrc](../../../.nvmrc), npm 11.19.0 and the committed lockfile in your task worktree. Run the tests being written locally, in hosted parity with `npm run test:hosted -- <files>`; [required and raw checks](ci-checks.md#required-and-raw-checks) describe hosted CI and optional full local verification.

### Run and inspect

For SQL investigations, use the
[current-definition recipe](../../../docs/platform/DATA_AND_MIGRATIONS.md#find-the-current-sql-function-definition):
anchor `CREATE [OR REPLACE] FUNCTION`, follow manifest baseline/forward order,
and compare full signatures and later `DROP FUNCTION` statements. A caller or
an earlier migration is not the effective definition. Check behavior and replay
at the owning witness; a textual `GREATEST` match alone proves no invariant.

For a read-only prerequisite check before setup, use the
[verification plan](ci-checks.md#required-and-raw-checks).

After `npm ci`, use:

```sh
# Builds Core, Outbox and Platform, then runs the affected root tests.
npm test -- server/domains/subscription

# Auto-discover affected root tests (reverse imports, #imports, contract pins) and run them.
npm run test:affected
npm run test:affected -- --dry-run
npm run test:affected -- --hosted --no-postgres

# The same, the way a hosted test shard runs them; at least one file is required.
npm run test:hosted -- scripts/ci-test-scope.test.ts

# Advisory self-checks over the change since the fork point, before prepare.
npm run preflight

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

# Package command changes: detect stale synthetic command expectations first.
npm test -- scripts/source-preview-release.test.ts -t "builds its synthetic workspace manifests with the pinned public execution surfaces"

# Packing/release changes: exercise the affected fixture and refusal boundaries.
npm test -- scripts/packages/required-package-gates.test.ts scripts/packages/set-release.test.ts

# Separate Core suite; includes coverage, API/docs/release and packed consumer.
npm --workspace @openlup/core run ci
```

`test:hosted` runs the named root test files through `npm test` with the
settings of a hosted `test-full-shard` job: `CI=true`; no coverage (a
`--coverage` flag or coverage environment is dropped); no external duration
pins, so the flat test timeout applies; no exclusion file, so every named file
runs; three workers, the Vitest default on the 4-vCPU hosted runner; and the
runner's `TZ=UTC` and `LANG=C.UTF-8`. Git sees `GIT_CONFIG_GLOBAL=/dev/null`, no
`GIT_AUTHOR_*` or `GIT_COMMITTER_*` variables and `user.useConfigOnly`, so a
fixture commit without explicit identity fails locally as it does on a runner,
instead of using an identity guessed from the host name. It does not reproduce
the hosted runner's CPU speed; size bounds for hosted runners as described below.
Locale overrides (`LC_*`), a system gitconfig and `OPENLUP_STACK_BASE` are also
removed; other local environment variables pass through unchanged.

Run `npm run preflight -- --fast` before reporting a change ready and before starting reviewers.
It checks worktree cleanliness, mergeability against `origin/main` (skipped when `OPENLUP_STACK_BASE`
points to an unlanded stack base), both neutrality gates, ast-grep scan and hygiene, `eslint-changed`
on changed non-deleted JS/TS files, conditional `client-secret-boundary` and `site-routes` guards, the
published-tree self-check (`oss:published-tree -- --self-check`, including committed-tree append-only
migration history and package API `Migration:` blocks when `HEAD` differs from its base), pure-Node
migration manifest/projection/5-profile inventory parity (`migration projection`), changelog fragments, added
test-line date/expiry warnings, `gitleaks`, conditional guide-contract and package-manifest checks,
and DCO sign-off across all commits (merge commits included). `WARN` and `SKIP` statuses surface
without failing `--fast`. If fetch fails, it uses the local `origin/main`.
The fast tier does not replace full preflight or hosted CI.

Run `npm run preflight -- --area` for a Docker-free, area-scoped check over changes since
`git merge-base HEAD origin/main` plus uncommitted and untracked files: it runs `eslint changed`,
`migration manifest` (pure-Node canonical manifest, projection, and 5-profile inventory parity when
manifest, SQL, projection, or inventory inputs changed), triggered Docker-free, consumer-pack-free
tooling guard tests from `scripts/ci-test-scope.mjs` (plus `scripts/catalog-document-boundary.test.ts`
on catalog, script or doc edits) through `test:hosted`, and `sql admit` when SQL under `db/` or
`packages/*/sql/` changed.

Run `npm run preflight -- --affected` to run default preflight with test discovery expanded via
`scripts/affected-tests.mjs` (reverse-import graph and contract-pin rules) so source-only edits
also run their affected root Vitest suites through `test:hosted`. `--fast`, `--area`, and `--affected`
are mutually exclusive.

Without flags, `npm run preflight` is advisory and exits non-zero
only when a check reports `FAIL`. It reads the change since
`git merge-base HEAD origin/main`, plus uncommitted and untracked files, and prints
one `PASS`, `WARN`, `SKIP` or `FAIL` line per check:

- the published-tree typecheck of the required `typecheck` job, after the package build;
- the ast-grep scan from [lint rules](ci-checks.md#commands-and-lint-rules);
- `ast-grep hygiene`: the first-line file-wide `ast-grep-ignore` check and
  `ast-grep` rule tests (`ast-grep test --skip-snapshot-tests`);
- `eslint changed`: ESLint on changed non-deleted JS/TS files before package builds;
- `client-secret-boundary`: `node --experimental-strip-types scripts/check-client-secret-boundary.ts`
  when `src/`, `server/`, `api/`, `config/environment-variables.json`, or the guard script changed;
- `site-routes`: `node scripts/site-routes.mjs --public-reference` when `config/site-routes.json`,
  `config/public-reference-site-routes.json`, or `scripts/site-routes*` changed;
- `migration manifest`: pure-Node canonical migration manifest, package projection,
  and 5-profile inventory parity (`count`, `exactTailCount`, `tail`, and
  `objectInventorySha256`) in Wave 1 before package builds/typecheck when
  manifest, SQL, projection, or `tests/postgres/current-installation-inventory.json`
  inputs changed;
- `sql admit`: `npm run sql:admit` when SQL under `db/` or `packages/*/sql/`
  changed; reports `WARN` when the working tree has uncommitted or untracked
  changes;
- `npm run inventory:refresh` when SQL under `db/` or `packages/*/sql/` changed;
  it has no check mode, so a rewritten inventory stays in the working tree and
  is reported for commit. It needs Docker and reports `WARN` without it; because
  it refreshes five disposable installations, a preflight on an SQL change may
  take longer than three minutes;
- a `changes/*.md` fragment for each released package whose `src/` changed;
- on added lines of test files, literal ISO dates within 400 days of now and
  expiries or TTLs under ten minutes; these simple patterns can misfire, so
  explain a false positive instead of contorting the test;
- `gitleaks` with the repository configuration, when it is on `PATH`;
- `test:hosted` for the changed root test files;
- the tree-wide neutrality ratchet of the required `self-check` job,
  `node scripts/public-ci-neutrality.mjs`, against the fork point.

Unset `OPENLUP_VITEST_EXCLUDE_FILE` when requesting an unfiltered run. Outbox and Platform tests also run locally with `npm --workspace @openlup/outbox test` or `npm --workspace @openlup/platform test` after building prerequisites; their package configs use Node and do not inherit root setup. Their installed consumers belong to the shared package gate, not that local command.

Disposable PostgreSQL fixtures mount `/var/lib/postgresql/data` as `tmpfs`.
This covers the PostgreSQL image's declared data volume before container
creation, so an interrupted worker cannot leave an anonymous data volume.
Normal and failed-start teardown still removes the owned container with
`docker rm -f -v`; other anonymous mounts are removed too. A worker killed
with `SIGKILL` can still leave a container, including one in `Created` state:
temporary data storage prevents the volume leak. Disposable creators also label
the owner PID, host-clock start epoch, short hostname and (on Linux) PID namespace
with `dev.disposable.*`, plus the fresh test run ID. A same-host sweep reclaims
only `dev.disposable=1` containers at least 60 seconds old whose owner is gone
or whose PID start differs by more than two seconds; uncertainty keeps them.
`OPENLUP_DISPOSABLE_REAP=remove` (default), `report` or `off` controls the
once-per-run host sweep; `CI=true` disables that sweep. Teardown and the wrapper
sweep only their own run selector under the same liveness rule, including on CI,
without the age floor: an exited helper child's container goes at teardown, and
after its Vitest child exits the wrapper removes one started just before Ctrl-C.
Nested runs get independent IDs. Unlabeled containers are never removed.
The container-helper regression checks exact owned container and volume IDs
for normal teardown and port-bind failure, without relying on global counts.

For the Node scheduler drain boundary, run
`npm test -- --run tests/postgres/nodeHostRuntimeDrain.test.ts`. Its dedicated
PostgreSQL sessions prove same-session exclusion and replacement-host admission
only after the original callback drains. Missing Docker or PostgreSQL fails the
witness rather than skipping it; this focused run does not replace the required
package, coverage or full verification gates.

Hosted `test-prep` runs `node scripts/ci-test-scope.mjs` and `node scripts/build-packages-incremental.mjs` once and uploads the exclusion list and built workspace `dist/` outputs as the `test-prep` artifact. Hosted `test-full-shard` jobs download that artifact and run `node scripts/ci-vitest-shard.mjs --shard N --total 8 --skip-pretest` (deterministic weighted LPT sharding over `config/vitest-shard-weights.json` that places `GIT_FIXTURE_SUITES` members one per shard first, the lightest sharing a shard only when there are more members than shards, bypassing redundant per-shard `pretest` builds) in eight independent installations. Required `test` accepts only success from the whole matrix and from the `pgtap` job; failure, cancellation or a skipped dependency job refuses. There is no `test:required` script or separate `test-full` job. A successful shard can still report individually skipped cases; record missing proof.

Vitest keeps `retry: 0`. In hosted CI (`CI=true`) only, each shard reruns its failed test files once in the same job, one file after another when there are several, before the check reports, because a merge-queue entry is ejected on its first failing check. The shard passes only if every file passed on the first run or appears as passed in the rerun's report; a file missing, skipped or not run on the rerun fails it. More than 10 failed files, or any first-run error no test file accounts for (an unhandled error or rejection, an interrupted run, or a non-zero exit whose report shows no failed file), is not treated as transient: the shard fails without a rerun. Local runs never retry. Every file that passed only on the rerun prints `flaky-retry-passed: <file>`, emits a `Flaky test retried` warning annotation and is listed in the job summary; the retry is not acceptance. A file that repeatedly reports `flaky-retry-passed` is a defect to fix, for example a test that depends on order or on shared state.

Channel preservation tests live in `packages/platform/test/channels` and are
discovered by the existing root Node project. The reference's adjacent guard
tests cover off/portable selection; `tests/postgres/m17ChannelReference.test.ts`
uses actual imported locked rows in local managed compatibility PostgreSQL,
with adapter defaults revoked before installation, to prove page/capture/CAS
order, original money groups, current-run recovery and
ACK debt. This local witness does not qualify hosted managed or provider access. The paired PostgreSQL boundary
fixture and selected-native inventory proofs live under `tests/postgres`;
managed pgTAP retains 48 source-boundary assertions and the existing dispatch
owner witness. Installed artifact proof belongs in `tests/platform/channels`;
the canonical cold runner requires all three channel entries and checks their
imports and both declaration modes. Registration alone does not establish
passing final canonical verification.
These local witnesses do not establish real-provider or hosted qualification.

### Choose a location and proof

| Test | Placement and execution |
|---|---|
| Domain, server, API, MCP or tooling logic/contract | Adjacent descriptive `.test.ts`; root Node project discovers `api`, `mcp`, `scripts`, `server` and `src`. |
| Browser interaction | `src` `.test.tsx`; `.test.ts` under `src/components`, `src/hooks` or `src/test` also uses jsdom. A Node-project .ts test requiring DOM must declare `@vitest-environment jsdom`. |
| Package unit/characterization | `packages/outbox/test` and `packages/platform/test` are root-discovered. Core `smoke/` and `test/` use its separate Node config and required Core batch. |
| Cross-boundary/DB | Existing `tests/platform`, `tests/postgres` or `tests/golden-master` Node roots. The [additional cross-boundary DOM root](../../../vitest.config.ts) uses jsdom for `.test.tsx`. Do not assume every `tests/` directory is collected. |
| Durable SQL behavior | `supabase/tests` for managed pgTAP; selected portable/installed DB conformance stays with its owning runner. |
| Browser journey | Explicit Playwright/profile runner; not root Vitest. Follow the [subscription](../../../docs/platform/SUBSCRIPTION_REFERENCE.md) or [identity](../../../docs/platform/IDENTITY.md) owner. |

The [root config](../../../vitest.config.ts) is the exact discovery inventory: it accepts `.test.ts`/`.spec.ts` in its Node roots, and `.test.tsx`/`.spec.tsx` in its DOM roots. Checkout helper discovery is narrowly `tests/preview/checkout/helpers/**/*.test.ts`. Prefer `.test` names consistent with adjacent files and boundary rules; in `packages/outbox/test` and `packages/platform/test` use `.test.ts` only, because their package-local configs collect only that suffix. Verify a new file appears with `list --filesOnly`; placement alone is not execution evidence.

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

Extend an existing meaningful case first; add a test for changed behavior, a discovered defect, or a required contract/refusal/replay boundary. Migrations, status mappings and idempotency rules require failure/replay regressions. Demonstrate adapter capabilities and refusals without live providers. Preserve the unchanged [adopter characterization witness](../../../CONTRIBUTING.md#contribute-existing-adopter-code-then-refactor) during refactoring. Do not test private implementation shape or add a harness solely to test the harness.

Acquisition server characterization belongs under
`packages/platform/test/marketing/server/`. The cross-boundary
`tests/postgres/acquisitionEvidenceParity.test.ts` witness uses the existing
container helper, applies the hash-checked migration-manifest prefix and calls
package ports through a login granted only the acquisition runtime role. Docker
absence throws as missing proof. The fixture owner is used only for setup, state
inspection and the original implementation's append-only trigger proof. Port
operations and separate SQL privilege-denial assertions use the runtime role,
retaining all 11 cases. The reference retains retirement, admin-auth binding and
notification-copy checks.

### Sufficient evidence and material test gaps

Before counted review, clarify the approved behavior, its failure boundary and
the smallest discriminating executed proof in the existing task record. A few
sentences or a small table suffice; this is not an inventory of every branch or
another audit. The review brief links to that record and states scope/exclusions.

An actual reachable defect violating the accepted contract blocks regardless of
test presence. A material proof gap identifies a required, unproved behavior class
or boundary, a credible mistake mechanism at the changed boundary, and why all
relevant executed proofs fail to distinguish it. Include scenarios requiring
refusal. A test's existence, name or coverage percentage alone proves none of this.
The map does not waive a newly discovered required boundary or a mandatory gate.

Mutation is a bounded way to challenge that proof, not a completeness target.
Reachability and nonequivalence are necessary but insufficient for a blocking
mutation finding. Additional variants within an already discriminated class are
advice unless they expose such a mechanism or a separate obligation. For example,
equal document/predecessor IDs in every fixture can hide an argument swap when the
contract permits different IDs; one distinct case may resolve it. A swap where
the contract requires equality, or arbitrary new amount-specific corruption, does
not itself justify an endless series of cases. Missing required replay proof
remains material if removing its protection could create a second fiscal effect.

Choose proof by the boundary: a real-DB table can test translation and durable
effects, but a superuser does not prove role restrictions, sequential rows do not
prove concurrency, and final DB state may miss duplicate external effects. Keep
required role, transaction, concurrency, installed-artifact and fault witnesses.
Changing proof technique within the approved requirement is autonomous; weakening
that requirement or changing a characterization witness's meaning needs its
applicable owner decision. Never rewrite acceptance merely to obtain PASS.

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

### Keep fixtures deterministic and work fast

Reuse [root setup](../../../src/test/setup.ts), [Git environment scrub](../../../tests/setup/scrub-git-env.ts), [render providers](../../../src/test/render.tsx) and existing owner-local fixtures when applicable. Use synthetic, profile-valid inputs. Inject time, randomness and external ports; restore timers, environment stubs, module state, mocks and resources you change. Tests must not depend on file order, another test or a shard's membership.

Prefer table-driven pure cases and the minimum real boundary witnesses that prove the requirement. Retain real Git/process/DB witnesses where the requirement depends on actual process behavior, SQL permissions, transactions or concurrency. Do not replace those witnesses with mocks. Use temporary repositories with explicit identity, bounded child processes and owned cleanup; never mutate the contributor's repository or use ambient/live services. Follow [database fixture rules](../../../docs/platform/DATA_AND_MIGRATIONS.md#database-test-fixtures-and-witnesses).

The [disposable PostgreSQL helper](../../../tests/helpers/postgresContainer.ts) removes its
explicitly named test container together with its anonymous data volumes on
pre-start cleanup, failed startup and final removal. PostgreSQL images declare
those volumes even without an explicit mount; removing only the container leaves
them behind. Docker retains named volumes with this operation. The
[cleanup regression](../../../tests/postgres/postgresContainerCleanup.test.ts) uses its own
unique containers and volumes against a real Docker daemon, checks bind-conflict
retry and other startup errors, and preserves a named volume and another
container. Cross-run reclamation is limited to the labelled dead-owner contract
above; it never authorizes pruning unlabeled resources or a live owner's stack.

Root test/hook defaults are 10 seconds locally, or 30 with coverage or in hosted CI (`CI=true`), where shared runners slow tooling tests about twofold; externally supplied duration pins may raise them. Tests and hooks under `tests/postgres/` have a 60-second floor, preserving any larger derived or explicit per-test budget. These are deadlines, not expected runtimes or whole-file budgets. Process spawning, repeated tree copies, compilers, npm packs/installs, containers and intentional deadline waits are likely costs. Measure expensive additions and record command, revision, environment, workers and observed duration in existing task evidence. Simplify repeated setup or decision matrices before raising a timeout; give necessary integration work an explicit bounded deadline sized for hosted runners. When you set or raise one, record the case's worst time from hosted shard logs in the task evidence. Preserve `retry: 0` and required proof.

To find optimisation targets, read the per-file durations Vitest prints in a hosted shard log (`✓ <file> (<n> tests) <ms>`) or locally with `npm test -- <path>`, and rank by file time. On 2026-10-19 the slowest root files were repository-tooling tests (`scripts/packages/outbox-consumer-proof.test.ts`, `scripts/source-preview-release.test.ts`, `scripts/public-ci-neutrality.test.ts`), each 40–80 s; slim one by moving decisions into table-driven cases and keeping only the real-process witnesses its requirement needs.

Ordinary local workers default to 37.5% of cores (6 of 16 on the measured
host) from the config; `--maxWorkers` also accepts a percentage. Vitest reads
the `VITEST_MAX_WORKERS` environment variable as an integer and lets it override
both, so the `npm test` wrapper first resolves any percentage in it, its own or
the caller's, the way Vitest resolves a config percentage: available cores times
the whole-number part of the percent, rounded, at least one. Through the
wrapper, coverage defaults to 50% of cores, or 40% under contention; a direct
`vitest --coverage` run uses the 37.5% config default. Plain local runs inside `verify-command` or an active resource
broker instead default to at most four workers and the host's core count. A
positive broker CPU-token count further caps workers at one less than that
count, with a minimum of one, leaving capacity for the main process and child
compilers. Explicit `VITEST_MAX_WORKERS` or `OPENLUP_VITEST_MAX_WORKERS` pins take
precedence. The wrapper logs this verification default. CI scheduling and
coverage retain their existing policies. Use `VITEST_MAX_WORKERS` for focused
reproduction; do not skip assertions or introduce a speed gate to make a test green.

Real package-size witnesses run separately for each package (30 seconds) and
browser entry (15 seconds), so adding modules does not multiply one case's
work. Their Git, npm-pack and browser-bundler children are bounded at 5, 20 and
10 seconds respectively. The two-bundle growth refusal has a 25-second case
budget. The source-release stale/fresh/dirty/changed witness retains its real
CLI state transitions in one 60-second case, with 10-second fixture Git and CLI
bounds. These limits enclose the necessary child work; they do not alter size,
release or refusal assertions or enable retries.

### Extend tooling selection conservatively

[ci-test-scope.mjs](../../../scripts/ci-test-scope.mjs) contains eligible bounded tooling rows. **New and unlisted tests always run. A new tooling test does not need a row.** Add one only when skipping untouched inputs saves useful work and its complete dependency closure is understood.

Declare every actual nonshared repository input the test or imported code reads: source, configuration, manifests, documentation, inventory, package outputs and reference wiring. Use an exact path or a directory prefix ending in `/`; no globs. Fixture strings are not reads of the corresponding real repository files. Prefer a broader prefix to incomplete precision.

The Outbox companion reads `config/ci-images.json` through its image helper;
image-pin-only changes therefore retain its real interruption and refusal
witnesses even when unrelated bounded tooling fixtures are excluded.

Non-control PostgreSQL suite closures live in
[config/ci-postgres-suite-closures.json](../../../config/ci-postgres-suite-closures.json)
(`schemaVersion: 1`, sorted suite keys and sorted extra paths or `@`-prefixed
axes expanded via `PG_AXES`, always combined with `PG_BASE_INPUTS` and the
suite path itself). Hardcoded control suites (`tests/postgres/nativeStoreForwardCatalog.serviceRole.test.ts`,
`tests/postgres/nativeStoreForwardCatalog.noServiceRole.test.ts`,
`tests/postgres/reviewedBatchForwards.test.ts`, and
`tests/postgres/subscriptionExactInstallation.test.ts`), `PG_BASE_INPUTS`,
`PG_AXES`, `SHARED_INPUTS`, `ROOT_DOC_FILES`, and `NON_BAILOUT_SCRIPTS` stay
hardcoded in
[ci-test-scope.mjs](../../../scripts/ci-test-scope.mjs) (`scripts/ci-test-scope.mjs` is
a `NATIVE_CATALOG_CONTROLS` control file). `loadPostgresSuiteClosures` parses
the registry fail-closed with a duplicate-key JSON scanner and rejects syntax
errors, duplicate keys, unknown axes, broad `tests/postgres/` prefixes,
unsorted keys/inputs, or collisions with control suites. When a PR
adds SQL under `db/platform/migrations/` or `supabase/migrations/`,
[reviewed-platform-forward.ts](../../../scripts/reviewed-platform-forward.ts) enforces
that [config/ci-postgres-suite-closures.json](../../../config/ci-postgres-suite-closures.json)
remains strictly valid and append-only; non-SQL cleanup PRs may narrow or remove
entries.

All rows already share `tests/setup/`, `src/test/`, `src/checkout/machine/commerceRequestCache.ts`, and every non-allowlisted path under `scripts/` (fail-closed: runners, Docker, builds, fixtures, package scripts, migration helpers, `preflight.ts`, `oss-*.ts`, and any new or unknown script trigger the complete suite; only `scripts/**/*.test.*` / `*.spec.*` and the explicit `NON_BAILOUT_SCRIPTS` allowlist — guarded by the AST exemption-safety test in [ci-test-scope.test.ts](../../../scripts/ci-test-scope.test.ts) — avoid the global bailout, and every listed test always retains itself). Every root file outside the allowlisted root documentation files (`README.md`, `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md`, `GOVERNANCE.md`, `CHANGELOG.md`) and every dot-prefixed segment anywhere also runs everything; root documentation edits still run `scripts/documentation-cli.test.ts` and all unlisted doc/policy checks. Package rows conservatively include `packages/`. Repository-wide inventory/policy/neutrality/removal scans stay unlisted. When a row gains a new read, extend it; when its closure becomes uncertain or tree-wide, remove it.

Review input completeness against the actual test/import closure. Extend [scope falsifiers](../../../scripts/ci-test-scope.test.ts) for the new dependency behavior; row-derived tests alone cannot discover an omitted input. Preserve shared triggers, rename/deletion coverage, identical shard selection and errors selecting everything.

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

In hosted CI (`.github/workflows/published-tree-ci.yml`), `scope-gate` runs `node scripts/ci-test-scope.mjs --workflow-outputs` without installing workspace dependencies and emits five fail-closed outputs (`run_pgtap`, `run_reference_build`, `run_package_gates`, `run_install_browser`, `run_install_pack`). Every output defaults to `true` on `push`, missing/malformed base SHAs, Git errors, root non-doc files, dot-segments, shared setup inputs, or non-allowlisted `scripts/` changes; any file deletion or rename also triggers `run_package_gates=true` (and `run_install_pack=true`) so `packages/core` `docs:check` repository-link existence checks run. `pgtap`, `install-pack`, and `install-packages` use step-level pass-through (keeping `public-ci-dependencies.mjs` active on non-reused runs and preserving `success` job conclusions for `public-ci-reuse.mjs`), while `install-browser` skips its 6 matrix runners when `run_browser == 'false'` and `install-proof` requires either `BROWSER_RESULT=success` or the explicit pair `RUN_BROWSER=false` with `BROWSER_RESULT=skipped`.

### Separate DB, package and coverage proof

[Required checks](ci-checks.md#required-and-raw-checks) owns the full command sequence. `install-packages`, under the required `install-proof` aggregate, builds both profiles and runs [shared package gates](../../../scripts/packages/required-package-gates.ts): cold-pack the publishable inventory once, all API checks first, then each `ci:required` with verified manifest/commit. Keep local package preparation before root tests because generated outputs are shared. New modules extend the owning package's consumer and required batch; do not add a workspace or job without a separate need.

The [catalogue installed-consumer proof](../../../scripts/packages/platform-cold-consumer.ts)
evaluates the [catalogue SQL descriptor](../../../packages/platform/src/catalog/sql.ts)
from Git HEAD and checks its paths, positions and hashes against the committed
[canonical manifest](../../../config/platform-migration-manifest.json). It compares the
packed descriptor with those tuples and verifies each packed SQL file's SHA-256.
Importing the catalogue and composition entries must work without the packaged
SQL manifest.

Core required coverage is V8: statements/lines 80%, branches 65%, functions 75%, plus no nonempty production file with zero covered lines. Root config has percentage thresholds when explicitly running coverage; public CI does not run root coverage or its separate no-zero helper. Outbox/Platform have no separate percentage gate. Keep installed-artifact and meaningful failure assertions; percentages do not replace them.

Root tests include required disposable Docker/PostgreSQL proofs. Some older tests explicitly skip when Docker is absent; a skip does not prove that boundary. Installed Outbox/Platform consumers require their owned database and refuse missing infrastructure. For managed SQL use `node scripts/public-ci-pgtap.mjs` with Docker; it needs neither the Supabase CLI nor npm dependencies. It validates committed migration bytes, starts one disposable stock PostgreSQL 17 container with the checksum-pinned pgTAP, `pg_cron` and `pg_prove` packages and the managed-compatibility adapter, replays baseline/forwards with public prerequisites, runs all supplied SQL tests and removes only its own container. Commit migration candidates before this runner; it refuses dirty migration bytes. It never links a hosted database or installs application seed data; it copies the shipped SQL tests unchanged. Replay uses a disposable diagnostic owner with closed default grants, so this profile is not production installer authority or a managed-host certification.

In CI, pgTAP is required through the root `test` aggregate, as is package `install-proof`; locally it remains a raw diagnostic. Triage actual exits, failed/aborted files, skipped prerequisites and new failures against the exact base; [historical diagnostic evidence](../../../docs/platform/plans/public-ci-known-red.md) grants no waiver. Neither mocks, static SQL assertions, listing, a build nor a green aggregate proves an unexecuted DB/browser/provider obligation.

Local root coverage (`npm test -- --coverage <path>`) runs Vitest directly when
the host-local broker helper is absent, with the same arguments, environment
and coverage-summary handling as an already admitted run. A focused subset still
uses root percentage thresholds; it does not establish full-suite coverage.

Keep documentation falsifiers independently discoverable for routing, navigation, bare-runtime CLI; never import one test file from another. Disposable fixtures prove those refusals, not arbitrary prose meaning. Follow [lint rules](ci-checks.md#commands-and-lint-rules), including valid/invalid cases for new ast-grep rules, and [documentation navigation](../../../docs/platform/DOCUMENTATION.md#navigation-and-source-map). Fixtures still obey neutrality and secret-handling policy.
