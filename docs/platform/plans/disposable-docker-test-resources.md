# Disposable Docker test resources reclaim themselves

Status: approved 2026-10-29 (owner decisions D1–D7 below); merge cut-line
landed in #432. Activation (D2) is recorded under "Activation evidence"; the
worker-cap measurement (D3) follows.

## Outcome and boundary

After a crashed, killed or interrupted test owner, its disposable Docker
containers become reclaimable without a person deciding what is safe to delete,
and a local `npm test` no longer overloads the shared local Docker engine.
Unlabeled resources are never removed automatically.

The outcome is finite:

- an ownership-label contract on the disposable containers created by the root
  test tree and its listed proof scripts;
- a liveness-based sweep owned by OpenLup's own test lifecycle;
- run-scoped cleanup through the same liveness rule;
- signal-safe cleanup for the Supabase CLI and compose runners;
- a measured local worker-cap default.

A start-slot limiter ships only if the measurement shows that worker caps alone
are insufficient.

OpenLup stays provider-neutral. No new code depends on a maintainer's local
broker. A host broker that implements the same contract, such as the reference adopter's
`ai-resource-gate docker-reap`, reclaims the same containers; neither side calls
the other. The existing wrapper already reads the broker's lock directory when
one is present (`run-vitest.mjs` `hasActiveLane`). That optional read is
unchanged and is not extended.

## Authority and execution

Grant recorded for this task (D4): local work, commits, push, PR and merge
after the required gates and native counted review. Activation follows D2;
any other removal of existing Docker resources, production and credentials are
not granted. DCO identity: Bart Roszkowski <dev@openlup.com>. One writer: this
session's supervisor.

- Policy revision and source base (freshly fetched): `e5ba63ab1e77643968d79ec0c37e3bfdbea8d90a`.
- Worktree `.worktrees/docker-test-resource-reclaim`, branch
  `claude/docker-test-resource-reclaim`.
- **M14 interaction.** Active M14 work owns these files:
  - `tests/postgres/runM14EffectHandover.ts` and `tests/postgres/m14ApplicationCohort.ts`,
    with their own labelled actor containers and networks;
  - the `m14*` test files.

  At least `m14InstallQualification`, `m14MigrationSessionAdmission`,
  `m14QualifiedBaseline`, `m14QualifiedComposition`, `m14QualifiedSession`,
  `m14ReleasedSchemaUpgrade` and `runM14EffectHandover` start PostgreSQL
  through the shared `runPostgresContainer`. Labelling that helper therefore
  labels M14's PostgreSQL containers too. This task edits no M14 file and touches
  no running container. Labelling M14 containers through the shared helper
  needs the M14 coordinator's consent (D6). Without it, the merge waits until M14
  lands.

## Current facts (verified at the base)

The 2026-10-29 audit was taken on an older checkout. At the base:

| Site | Observed at base |
| --- | --- |
| [`runPostgresContainer`](../../../tests/helpers/postgresContainer.ts) | `docker run -d` with `--tmpfs /var/lib/postgresql/data` (`9cc41e0b`), no `--rm`, no labels. Name `<prefix>-${process.pid}`. Each Docker call is bounded at 30 s with `SIGKILL`. 71 call sites in 52 files. A SIGKILLed `run` whose retry `rm -f -v` also times out leaves a `Created` container (55 were found on this host). Readiness is a separate exported call, `waitForPostgresTcpReady`. |
| Vitest lifecycle ([config](../../../vitest.config.ts)) | Vitest ^4.1. No `globalSetup` or `globalTeardown`. Two projects with `extends: true`. Local `maxWorkers` is 75% (12 of 16 cores here). If a `beforeAll` times out while a start is pending, `container` stays unassigned and `afterAll` removes nothing. Package-local configs (`packages/*`) have their own setup. |
| [`run-vitest.mjs`](../../../scripts/run-vitest.mjs) | Uses the host-local broker script only for coverage runs, and that script is absent from public checkouts, so plain `npm test` runs ungated. Drops to 50% workers when the 1-minute load exceeds the core count. Has no SIGINT or SIGTERM handler, so a group Ctrl-C ends it before any post-exit step. Nothing limits Docker starts across workers or runs. |
| Nested runs | [`outbox-consumer-proof.test.ts`](../../../scripts/packages/outbox-consumer-proof.test.ts) spawns a nested `run-vitest.mjs` that inherits the parent's environment. |
| [`runAcceptance.mjs`](../../../tests/identity/runAcceptance.mjs) | **Audit corrected:** the node-postgres container already has `--tmpfs`, its own ownership label and `rm -f -v` (line 226). Remaining gaps: the image is tag-only `postgres:16`, there are no signal handlers, and the managed path runs `supabase stop --no-backup` only in `finally`. |
| [`public-ci-pgtap.mjs`](../../../scripts/public-ci-pgtap.mjs), [`runIdentityEnvelopeConformance.mjs`](../../../tests/postgres/runIdentityEnvelopeConformance.mjs) | `supabase stop --no-backup` runs only in `finally`. No SIGINT or SIGTERM handlers. |
| [`runOidcIdentityConformance.mjs`](../../../tests/postgres/runOidcIdentityConformance.mjs) | Compose `down --volumes` runs only in `finally`. No signal handlers. |
| [`platform-cold-consumer.ts`](../../../scripts/packages/platform-cold-consumer.ts) | **Audit corrected:** the nested container is at line 1643, not 893. It already has `--rm`, tmpfs and CPU/memory limits, but no label, and it uses tag-only `postgres:16`. Line 1694 already carries `openlup-proof=<owner>`. |
| [`objectStorageConformance.test.ts`](../../../server/adapters/s3/objectStorageConformance.test.ts) | **Audit corrected:** it already has `--rm`. Its `exec("docker", …)` calls in `beforeAll` and `afterAll` have no timeout. No label. |
| Good patterns | [`outbox-disposable-postgres.ts`](../../../scripts/packages/outbox-disposable-postgres.ts): label, `--rm`, tmpfs, signal handlers and checked owned cleanup. [`outbox-consumer-proof.test.ts`](../../../scripts/packages/outbox-consumer-proof.test.ts): a separate fixture-owner process. |

[CONTRIBUTING: Test scope and diagnostics](../../../CONTRIBUTING.md#test-scope-and-diagnostics)
currently says the container lifecycle "does not authorize pruning other test
runs' resources". This plan changes that statement, so it needs D1.

## Ownership contract (shared with the reference adopter)

A disposable container carries these labels at creation:

- `dev.disposable=1`
- `dev.disposable.owner_pid=<pid of the long-lived owning process>`
- `dev.disposable.owner_start=<epoch seconds of the owner's start, host clock>`
- `dev.disposable.host=<hostname -s>` (Node: `os.hostname()` up to the first `.`)
- on Linux only, `dev.disposable.pidns=<readlink /proc/self/ns/pid>`; macOS sets
  no `pidns` label

Node computes `owner_start` as `Date.now() - process.uptime() * 1000`, rounded
to seconds; shell owners compute it from the UTC `lstart` parse below. The
owner decided this contract jointly for the reference adopter and OpenLup on 2026-10-29 (D7).

OpenLup also adds `dev.disposable.run=<run id>`, which readers of the shared
contract ignore.

**When the owner is dead.** The owner is dead only when either holds:

- `process.kill(pid, 0)` fails with `ESRCH`.
- The pid is alive and is recycled: its current start time, from
  `ps -o lstart= -p <pid>` run with `LC_ALL=C TZ=UTC` and parsed to epoch,
  differs from `owner_start` by more than 2 s.

Both values come from the host clock. The Docker VM's clock, which stamps
`.Created`, is used only for the 60 s age floor, so OrbStack VM drift cannot
make a live owner look recycled. No locale-dependent token is stored.

**Keep conditions.** Any of these means keep:

- `EPERM`;
- any parse failure;
- malformed `owner_pid` (not digits, leading zero, more than nine digits, or
  at most 1); for a live PID, missing or malformed `owner_start` keeps too.
  ESRCH proves death without a start-time parse, matching the shared reader;
- a different host;
- an age under 60 s, for the host-wide sweep (run-scoped sweeps of a run's own
  label skip this floor; see Design 5);
- an unanswering daemon;
- on Linux, a sweeper whose PID namespace differs from the one recorded in the
  creator's `dev.disposable.pidns` label, or a missing label. Example: a
  `--network host` container or a devcontainer sharing the socket and hostname.

macOS records no namespace label and has a single host PID space.

Each decision is logged with its reason. Removal uses `docker rm -f -v <id>` on
the inspected ID only.

**Owner pid.** The owner is the process that creates and removes the container:

- the Vitest worker, for `runPostgresContainer`;
- the script process, for the `.mjs` runners and proof scripts.

## Design

1. **One contract module.** A new module in `scripts/` (proposed name disposable-docker.mjs) is plain ESM, so
   tests, TypeScript scripts and `.mjs` runners can all import it.
   `postgresContainer.ts` already imports `scripts/ci-image-pull.mjs` the same
   way.
   - It exports label arguments, a pure `classify(container, probe, now)`, and a
     bounded `sweep({ mode, selector })`.
   - Each Docker call is limited to 10 s with `SIGKILL`, and a sweep to 60 s in
     total. A missing or unanswering Docker means report and return, never throw
     into the run.
   - There is no separate "remove by run" path. Run cleanup is `sweep` with the
     selector `dev.disposable.run=<id>` under the same liveness rule, so it can
     never remove a live owner's container.
2. **Creators carry the contract:**
   - `runPostgresContainer` (subject to D6);
   - `objectStorageConformance.test.ts`, which also gets a 30 s timeout on its
     `exec` calls;
   - the nested container in `platform-cold-consumer.ts` at line 1643;
   - the node-postgres container in `runAcceptance.mjs`.

   Existing labels and ownership checks stay. The outbox proof containers are
   not labelled. Their own cleanup is the thing under test, and a concurrent
   sweep could otherwise hide a regression in it.
3. **Run identity and sweep.**
   - The top level of `vitest.config.ts`, which runs in the main process before
     any worker spawns, always assigns a **fresh** `OPENLUP_DISPOSABLE_RUN`.
     It never reuses an inherited value, so a nested run never shares the
     parent's id.
   - Workers and spawned children inherit it from the main process.
   - A root `globalSetup` (a new file in `tests/setup/`) runs one bounded
     dead-owner sweep across the host. It is idempotent per run id, so
     inheritance into both projects causes at most one sweep.
   - Its teardown runs the run-scoped sweep. Vitest closes its worker pool
     afterwards, so the wrapper also sweeps after every child exit, including
     success. This closes the late-worker and `beforeAll`-timeout gaps through
     the same liveness and age rules.
4. **Wrapper signal safety.** `run-vitest.mjs` installs SIGINT and SIGTERM
   handlers. They forward the signal to the Vitest child, wait for it to exit
   (bounded), then run one run-scoped sweep and exit with the conventional code.
   The wrapper also sweeps after a successful child exit, because global
   teardown can observe workers that have not closed yet. It reads the run id
   the child received from a value it passes down;
   it never uses an inherited one.
5. **Sweep mode.** `OPENLUP_DISPOSABLE_REAP` takes `report`, `remove` or `off`.
   The run-scoped sweep always removes (only its own run, liveness-checked,
   without the age floor). The host-wide dead-owner sweep shipped as `report`;
   activation (D2) made `remove` the default. An unrecognised value reports.
   With `CI=true`, the host-wide sweep is `off`, so hosted CI behaviour stays
   unchanged.
6. **Signal-safe stack runners.** These install SIGINT and SIGTERM handlers that
   run their existing owned cleanup once, bounded, then exit 130 or 143:
   - `public-ci-pgtap.mjs` and `runIdentityEnvelopeConformance.mjs`:
     `supabase stop --no-backup`;
   - `runAcceptance.mjs`: `supabase stop --no-backup` plus the labelled
     node-postgres removal;
   - `runOidcIdentityConformance.mjs`: compose `down --volumes`.

   The outbox pattern is the model. After a SIGKILL these stacks stay outside
   the sweep, because the CLI and compose own their labels (D5).
7. **Overload: worker cap first.**
   - The measurement below sets the local default for Docker pressure, through
     the existing `localWorkerCap` and wrapper seams.
   - Only if no worker cap meets the latency bar does a start limiter ship: a
     fixed directory (`OPENLUP_DOCKER_START_DIR`, default
     `/tmp/openlup-docker-start`, not the per-user `$TMPDIR`) of atomic `mkdir`
     slots with dead-holder reclaim.
   - `runPostgresContainer` acquires the slot before its 60 s startup deadline
     starts and holds it for `docker run` only. Holding it across the separate
     readiness call would leak it.
   - The limiter would cover OpenLup helper starts only, not other projects.
     That is part of D3.

**Simplicity check.**

- Already done, but not enough: tmpfs plus `-v` stopped the volume leak but not
  the container leak (55 `Created` containers after `9cc41e0b`).
- What cannot cover it: per-file handlers do not run on SIGKILL, and `--rm` does
  not remove a `Created` container.
- What is added: a liveness rule, the smallest way to tell a dead owner's
  container from a live session's. One sweep function serves both the
  host-wide and the run-scoped case.
- What is kept local: OpenLup has its own sweep and no broker dependency.
- What is deferred: the start limiter, until worker caps are measured.

## Cut-lines

**Merge.** One PR (D1, D4 and D6 granted):

- design items 1–6 and the item 7 worker-cap default, if measured;
- the host-wide sweep in `report`;
- the CONTRIBUTING and
  [DATA_AND_MIGRATIONS fixture](../DATA_AND_MIGRATIONS.md#database-test-fixtures-and-witnesses)
  owner sections, updated in the same change;
- registration of any new runnable file the published-tree check requires
  (`npm run oss:published-tree -- --policy` must pass);
- evidence E1–E9.

**Activation.** Separate owner go-ahead (D2 and D3), after merge:

1. Run one `report` sweep on the live host and record the exact set.
2. Flip the host-wide sweep to `remove`.
3. Apply the measured worker-cap default, and add the start limiter only if the
   measurement requires it.

**Out:**

- the M14 actor and network harness;
- network and volume sweeping;
- automatic reclaim of SIGKILLed Supabase CLI or compose stacks;
- [`setup-subscription.mjs`](../../../scripts/public-reference/setup-subscription.mjs) (its persistent developer
  stack is intended);
- package-local Vitest configs;
- labelling the outbox proof containers;
- pinning tag-only `postgres:16` by digest (a separate supply-chain change);
- legacy unlabeled garbage, image pruning and launchd or cron agents;
- any call into the reference adopter's broker;
- hosted CI changes.

## Acceptance evidence

**E1. Classifier table** (pure, with injected probes):

| Case | Decision |
| --- | --- |
| `ESRCH` | dead |
| Alive, start within 2 s of `owner_start` | keep |
| Alive, start more than 2 s from `owner_start` (recycled pid) | dead |
| Live PID, `owner_start` missing or malformed | keep |
| `EPERM` | keep |
| Unparsable `lstart` or `.Created` | keep |
| Missing, non-`1` or malformed labels | keep |
| Foreign host | keep |
| PID-namespace mismatch or missing label on Linux | keep |
| Age 59 s | keep |
| Daemon timeout | keep |

**E2. Real-daemon proof with a SIGKILLed owner.**

1. A separate owner process creates a labelled container through
   `runPostgresContainer`, scoped by a per-test selector label. It reports
   ready and is then SIGKILLed.
2. Show the failure class at the base: the same procedure leaves the container
   behind after its owner died, and nothing reclaims it.
3. With the change, the scoped sweep removes it.
4. In the same sweep, these survive:
   - a container whose owner is alive while another process runs the `remove`
     sweep concurrently;
   - an unlabeled container;
   - a container labelled for a foreign host;
   - a container younger than 60 s.
5. A second case SIGKILLs the owner during `docker create`, leaving the
   container in `Created` state, and proves the same reclaim.

The test may lower the 60 s floor through the `minAgeSeconds` argument, which
the run-scoped sweeps also use. One case keeps the default and proves the 60 s
keep.

**E3. Locale and clock.**

- Parse the real `ps -o lstart=` of a live process under inherited `pl_PL`,
  `en_GB` and `C` environments. All three must give the same epoch.
- Record, for information, the host-to-VM clock offset (host `Date.now()` against `.Created` of a
  freshly created container), once on a fresh boot and once after a sleep/wake
  cycle.
- For a live Node owner and a live shell owner, the label's `owner_start` and
  the parsed `lstart` agree within 2 s. If they do not, stop and raise it with
  the reference adopter: the shared 2 s rule would misjudge live owners.
- The host-to-VM offset only affects the 60 s age floor. If it exceeds 30 s,
  record it as a residual risk.

**E4. Interrupted and nested runs.**

- Send SIGINT and SIGTERM to the **process group** of
  `npm test -- <two Docker suites>` while a start is in flight. No container
  with that run's label may remain after the wrapper exits.
- SIGKILL the Vitest main process. It leaves containers behind. The next run's
  `report` lists exactly those containers, and `remove` deletes them.
- In the `beforeAll`-timeout case, nothing remains after teardown.
- A nested `run-vitest.mjs`, started from a live parent run, gets a different
  run id. Its teardown leaves the parent's containers in place.

**E5. Setup runs once.** One sweep and one run id per `npm test`, across both
projects.

**E6. Daemon unavailable or hung.** A fake `docker` that sleeps, injected
through a seam, makes the sweep report and return within 60 s. The run
outcome is unchanged.

**E7. Stack runners.** For each runner in item 6, a SIGTERM delivered
mid-run runs its owned stop exactly once.

**E8. Regressions.** These pass with their assertions unchanged:

- [`postgresContainerCleanup.test.ts`](../../../tests/postgres/postgresContainerCleanup.test.ts)
- `postgresContainer.test.ts`
- `outbox-consumer-proof.test.ts`, including its own-cleanup proofs
- `referenceIdentity.test.ts`
- `oidcComposition.test.ts`
- `objectStorageConformance.test.ts`

**E9. Required gates.** The required and raw checks in CONTRIBUTING, native
committed review and final verification. For each, record the command,
revision, Node version, worker count and duration.

## Worker-cap measurement plan (cost and benefit)

**Question.** Which local worker cap gives the shortest reliable run without
starving the shared engine? Does anything beyond a worker cap need to ship?

**Setup.**

- Host: 16 cores, OrbStack. Record the CPU and memory allocation, and confirm
  `power.pause_in_sleep` is off.
- Code: the merge candidate's revision, with the host-wide sweep in `report`.
- Isolation: no other Docker-heavy run active. Admit runs through the host
  broker's `docker-heavy` lane when installed; otherwise schedule outside M14
  heavy windows.

**Stage 1: Docker-pressure subset.**

- Run `npm test -- tests/postgres` with `VITEST_MAX_WORKERS` set to 12 (the
  current 75%), 8, 6 and 4.
- Take two samples per cell: 8 runs.
- Then run two concurrent subset runs at the current default and at the best
  cell: 4 runs.

**Stage 2: Whole-suite confirmation.**

- Whole `npm test` at the current default and at the chosen cell, two samples
  each: 4 runs.
- Only if no cell passed the latency bar: one start-limiter prototype with K
  set to 4 and to 2, one whole-suite run each: 2 runs.
- Hard cap: 18 runs.

**Signals per run:**

- wall-clock time and exit status;
- failed, timed-out and aborted files, with hook timeouts named;
- peak run-labelled containers, sampled every 2 s;
- peak daemon memory, from `docker stats --no-stream` every 10 s;
- p95 latency of `docker version`, sampled every 5 s;
- host 1-minute load;
- containers remaining after exit.

**Decision rule.**

- Reliability bar: zero infrastructure failures, `docker version` p95 under 2 s,
  and the same result under two concurrent runs.
- Pick the cell with the lowest median wall-clock that meets the bar.
- Keep 75% unless another cell meets the bar and is at least 10% faster on both
  samples, or 75% fails the bar.
- The start limiter ships only if no worker cap meets the bar.
- Record the table in this plan's evidence.

**Cost.** About 12 subset runs and 4–6 whole-suite runs of machine time.
Record the first baseline duration, estimate the rest, and stop if the
estimate exceeds 6 hours.

## Risks and checks

**Worst failure: removing a live session's container.** Every one of these
must hold before removal:

- the label is present;
- same host, and on Linux the same PID namespace;
- for the host-wide sweep, age of at least 60 s;
- the owner is dead, by `ESRCH` or by a start time more than 2 s from
  `owner_start`.

Any uncertain reading means keep. Run cleanup follows the same rule except the
age floor: it selects only its own run's label, whose owners have exited. The
host-wide sweep shipped in `report`; it became `remove` only after a recorded
report set (D2, under "Activation evidence").

**Assumption most likely false: the owner pid is long-lived.** If a Vitest
worker were recycled while its container was still in use, the sweep would see
a dead owner. E2 proves that a live worker's container survives a concurrent
`remove` sweep.

**Clock offset between the host and the Docker VM.** Removed from the liveness
decision by `owner_start` (D7); it only shifts the 60 s age floor. E3 measures
it.

**Other projects' contract containers are swept on purpose.** One sweep serves
both repositories. D1 decides whether that is allowed.

## Owner decisions

Decided 2026-10-29. The owner instructed, in the coordinating reference-adopter session:
"jakie decyzje odnosnie Openlup? zarekomenduj najlepsze rozwiazania i podejmij
decyzje zgodnie z rkeomendacjami" (recommend the best options and decide
accordingly). The coordinator relayed the resulting decisions to this task:

- **D1. Yes.** OpenLup's sweep may remove dead-owner `dev.disposable=1`
  containers on the same host, whichever project created them, under the
  shared liveness rule (D7). The CONTRIBUTING pruning statement is reworded.
- **D2. Yes, conditional.** After merge, run one host-wide `report` sweep and
  record its exact set. If every entry is a dead-owner labelled container, flip
  the host-wide sweep to `remove` without asking again. If any live-owner or
  unexpected entry appears, stop and report.
- **D3. Yes.** Accept the measured worker-cap default under the decision rule
  above. The start limiter ships only if no worker cap meets the bar. The 6 h
  and 18-run caps apply.
- **D4. Yes.** Delivery grant: local work, commits (OpenLup identity), push, PR
  and merge after the required gates and OpenLup's native counted review.
  Production and credentials stay excluded.
- **D5. Yes.** SIGKILLed Supabase CLI and compose stacks stay a manual,
  reviewed removal.
- **D6. Yes.** M14's PostgreSQL containers may be labelled through the shared
  helper, so they become sweepable only after a crashed owner. M14's own
  harness files stay out of scope. Merge timing avoids changing the helper
  under an in-flight M14 proof run, for example by landing between M14
  checkpoints.
- **D7. Resolved 2026-10-29** in the reference-adopter session, for the shared
  contract: the `owner_start` label compared within 2 s ("owner_start label
  (Recommended)"), and the Linux-only `pidns` label ("Yes, on Linux
  (Recommended)"). The reference adopter implements the same
  contract in its companion change.

## Independent challenge

One fresh independent reviewer read the plan against the code at the base
(2026-10-29). It returned FAIL with 2 blockers, 6 major and 4 minor findings.
All 12 findings were checked and adopted.

**Blockers:**

- **Nested run reused the parent's run id.** A nested `run-vitest.mjs` would
  have inherited the run id, and run teardown removed by label alone.
  - Now: always a fresh id, cleanup through liveness only, and E4 covers the
    nested run.
- **M14 already uses the shared helper.** The plan wrongly said M14 was
  unaffected.
  - Now: the Authority section is corrected and D6 is added.

**Majors:**

- **Host clock against VM clock.** Now: the `owner_start` label (D7, resolved).
- **Same hostname, different PID namespace.** Now: the `pidns` keep rule.
- **Wrapper had no signal handlers.** Now: item 4, and E4 signals the process
  group.
- **Slot held across the separate readiness call.** Now: the slot covers
  `docker run` only, and is acquired before the deadline.
- **Slots under `$TMPDIR` were per-user.** Now: a fixed directory, and the
  limiter is scoped to OpenLup.
- **Limiter shipped without evidence; matrix was single-sample.** Now: worker
  caps are measured first, the limiter is conditional, and runs are two-sample.

**Minors:**

- **Setup ran once per project, and env propagation was unproven.** Now:
  config-level id, idempotent setup and E5.
- **Unlisted creators.** Now: the OIDC runner, the developer setup script and
  package configs are classified.
- **A sweep could mask the outbox proofs' own-cleanup checks.** Now: those
  containers are not labelled.
- **Weak failure-class evidence; facts and CI gaps.** Now: a real
  concurrent-sweep case, the facts table completed, and the published-tree
  check added.

A second challenge of this revision has not been run. Run it before approval
if the owner wants one.

## Evidence and remaining work

The plan was prepared from the verified base above. Cheap checks on this plan
file:

- the plan is registered as `public-output` in
  [the publication catalogue](../../../config/openlup-publication-catalog.json);
- `node --experimental-strip-types scripts/oss-published-tree-check.ts --policy`
  exited 0 on Node 24.22.1 for the committed tree;
- every relative link and anchor resolves.

Implementation author: a Codex CLI session in this worktree, briefed and
supervised by this task's Claude supervisor, who verified the result and owns
commits and delivery. Codex's sandbox could not reach Docker; the supervisor ran
the real-daemon witnesses from the host shell.

Implementation choices:

- Process-owned Symbol state survives Vitest's separate config/setup module
  loaders, so both inherited projects share one run id and one host sweep; an
  inherited `OPENLUP_DISPOSABLE_RUN` is always discarded.
- Vitest closes its worker pool after global teardown, so the wrapper also runs
  the run-scoped sweep after every child exit, including success. Both sweeps
  keep the liveness rule; since activation neither applies the age floor.
  Run-scoped cleanup stays on in CI.
- One owned-stack helper ([owned-stack-cleanup.mjs](../../../scripts/owned-stack-cleanup.mjs))
  shares the existing checked cleanup between signals and `finally`, with a 30 s
  cleanup budget. Long CLI stages run asynchronously so a signal can interrupt
  them. Existing command timeouts are preserved: 240 s for the identity runners
  and none for the pgTAP CLI and test stages.

Evidence (Node 24.21.0, Docker 29.8.2 under OrbStack, this host):

| Boundary | Result |
| --- | --- |
| E1, E3 | `scripts/disposable-docker.test.ts`: 33 passed. This includes the real `ps` parse under pl_PL, en_GB and C, and Node `owner_start` within 2 s. |
| E2, E4 nested | `tests/postgres/disposableDockerReap.test.ts`, real daemon: 5 of 5 passed in 6.7 s. Covered: SIGKILLed `run` owner and `Created`-state owner, each left behind before the sweep and then removed; a live owner kept under a concurrent `remove` sweep, plus unlabeled and foreign-host survivors; a nested run's sweep leaving the parent run; a young dead owner kept by the 60 s floor. |
| E3 clock | The host-to-VM creation offset was 87 ms on this run. A sleep/wake measurement was not taken; it only affects the 60 s floor. |
| E4 interrupt | Native review cycle 0 (both reviewers) reproduced a leak: the run-scoped sweep kept the 60 s floor, so a container started just before a group SIGINT stayed. Repair: the wrapper's post-exit sweep uses no age floor; liveness still applies. `disposableDockerReap.test.ts` now signals a detached wrapper's process group (SIGINT and SIGTERM) while an env-gated fixture case holds a helper container; it fails without the repair and passes with it. |
| E4, E5, E6 | `scripts/disposable-run-lifecycle.test.ts`, `scripts/run-vitest.test.ts`: real Vitest project loaders with fake Docker; one id and one sweep per run; SIGINT, SIGTERM, child signal, success and queued-signal cases; a hung fake Docker returns within budget. |
| E7 | `scripts/owned-stack-cleanup.test.ts`: once-only cleanup across signal and `finally`, including a queued SIGTERM. No real Supabase or compose stack was started for this proof. |
| E8 | 7 files, 84 passed, including `postgresContainer*` and the S3 conformance on the real daemon. A second focused set passed 402 tests: publication check, image pull, identity, OIDC and wrapper suites. |
| Parity | `classify` keeps containers labelled `com.supabase.cli.project`, matching the shared shell reaper (cycle 0 advice). |
| E9 | Pending: lint, typecheck, `verify-local`, native counted review. |

## Activation evidence (D2)

Host sweep on 2026-10-29 at 12:58Z against `origin/main` `4ec36fde`, after #432
landed, on the maintainer host (Docker 29.8.2 under OrbStack):

- the shared reaper's `docker-reap --dry-run --json`:
  `would_remove` 0, `kept_live` 0, `kept_unknown` 0, `kept_young` 0,
  `skipped_foreign` 0, `failed` 0;
- OpenLup's own `sweep({ mode: "report", selector: "dev.disposable=1" })`:
  an empty set;
- the host held 10 other containers, all unlabeled Supabase CLI services of
  another project. Neither sweep listed them, and nothing was removed.

The set had no live-owner or unexpected entry, so under D2 the host-wide sweep
now defaults to `remove`. The set was empty, not a set of dead owners; the
removal path itself is proven by the real-daemon witnesses above.

The same change drops the 60 s floor from the run-scoped teardown sweep
(coordinator review of #432). Plain Vitest has no wrapper post-exit sweep, so a
container created by a helper child that exited seconds before teardown stayed
behind. `disposableDockerReap.test.ts` now runs plain Vitest over an env-gated
fixture whose helper child creates one run-labelled container and exits. With
the floor the container survives; without it the run leaves nothing. Lifecycle
tests pin the new `remove` default and the `report` fallback for an
unrecognised mode. If the Docker VM clock runs ahead of the host, the zero-floor
sweep still keeps a just-created container as too young; the next host sweep
reclaims it after 60 s.

