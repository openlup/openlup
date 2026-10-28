# M14 Node runtime drain task

## Composed HTTP shutdown continuation, 2026-10-28

The authorized correction keeps the local HTTP listener available until every
already admitted scheduler callback settles, including a callback waiting for
advisory-lock acquisition before its compatibility request. The existing cached
shutdown promise, stopped-registration fence and failure aggregation remain.
The smallest adequate change defers listener cleanup behind the existing drain;
it adds no shutdown framework, timeout, cancellation, dependency or scheduler API.

- Base and supplied current instruction revision are separately pinned to
  `535349050419abe5122bd74fa6766c58947be3dd`. Worktree:
  `/private/tmp/openlup-m14-composed-shutdown`; branch:
  `codex/oss-m14-composed-shutdown`.
- Scope: `nodeHost.ts`, its existing composition tests, the runtime/package
  owners, this existing record and one package changelog fragment. The API
  snapshot follows its normal producer when verification is authorized.
  Other runtime, database, release-control and shared-documentation paths remain
  with the coordinating supervisor.
- Actors and authority: the active supervisor delegated this bounded source
  correction and source/static preparation to one author; the supervisor owns
  two fresh independent native reviewers and later integration/release
  preparation. Two-way task coordination is authorized. This author has no
  commit, DCO, push, PR, merge, release, settings or credential authority.
  Required sensitive-boundary read by the supervisor precedes any DCO sign-off.
- Acceptance/proof: a real local Node HTTP runtime serves the scheduler's actual
  compatibility request after acquisition is blocked, stop fences its timer,
  and acquisition resumes. Assert the listener survives the pending acquisition,
  the authenticated endpoint executes once without a scheduler error, stopped
  callbacks cannot acquire again, and job release precedes session closure.
  Existing unlock/timer/listener/lock failures and repeated-stop tests retain the
  refusal/cleanup evidence. The existing PostgreSQL witness retains the distinct
  session ownership/replacement-admission proof.
- Execution: the supervisor later allocated one local focused heavy slot with
  the existing fail-fast resource broker. Own lockfile installation used Node
  24.21.0/npm 11.19.0 and a separate npm cache. The sandboxed attempt hit DNS
  refusal and was interrupted (exit 130); an escalated retry installed 727
  packages in 13 seconds (exit 0). No dependencies, auth or proof stamps were
  copied. No PostgreSQL/full verification, counted review, DCO or commit has
  run in this continuation; earlier histories below are unchanged.
- Focused results (all terminal exit 0 except the expected predecessor failure):
  AST scan, public inventory, documentation policy (one obligation, none
  unanswered), three-package manifest check and strict prerequisite builds
  passed. A temporary frozen predecessor module/test snapshot, removed in
  `finally`, failed the composed regression because the real endpoint executed
  zero times instead of once. The corrected production source hash remained
  `fa0fd1b8f40a6c5820094389cf12450d1cb07807798b20ac28a9be2a87ef2966`.
  Discovery found both selected host/scheduler test files; their corrected run
  passed 65/65. The normal Platform API producer/check passed; its only tracked
  delta is the composition stop JSDoc. Mandatory lint passed with zero errors
  and 33 existing warnings. `git diff --check` passed.
- Actual pre-DCO pack measurement used current built files and the existing
  content/cap/browser-entry policy functions, with no findings for any package.
  Platform: 1,929,113/2,029,568 tarball bytes; 1,662,287/1,743,872 code-gzip
  bytes; 59,504/73,728 docs-gzip bytes; 2,628/2,628 total files and
  2,574/2,574 code files. Core and Outbox also fit their current caps. This
  working-candidate measurement does not claim the clean committed artifact
  gate or release growth check. No cap, version or package file count changed.
- Risk/remaining work: listener closure now waits for admitted HTTP users; no
  drain timeout is added. Generated navigation remains the supervisor's
  shared-path responsibility. Required committed package, PostgreSQL and full
  verification remain with later supervisor allocation. Delivery remains
  blocked on remaining proof, the sensitive-boundary read and independent
  review.
- Self-retro at source handoff: the existing drain promise provides the needed
  dependency order without another lifecycle operation. The initial sandboxed
  network attempt delayed installation; use the already authorized network
  escalation for that phase. No additional process machinery is needed.

## Prior runtime-drain history

Status: resumed for current-candidate proof and owner-authorized delivery
(2026-10-27). Earlier baseline failures and positive probes below retain their
historical inputs. Full current verification and independent review remain owed.
Authority comes from the human instructions recorded below, not from this record.

- Outcome: stopping a Node host fences its stopped registrations and retains
  per-job cluster ownership until callbacks already admitted have completed and
  released their locks. Overlapping callbacks using the same dedicated PostgreSQL
  session cannot double-run; a replacement host stays excluded during drain and
  can run after release.
- Code base: `bb12776c381ae35085edd00db793ccecc40b31fd`;
  current instruction revision supplied by the coordinator:
  `ca33647ec80aef932490c0c6fb54b01fc483f287`. Policy and review base are separate.
  Worktree `/private/tmp/openlup-m14-runtime-drain`, branch
  `codex/oss-m14-runtime-drain`.
- Actual contexts: coordinator `01a17945-72cc-71d3-afcf-a8f04fa8503f`; sole
  test/source writer `01a179fb-1f32-7b33-b2e7-14834bad4de5`. First C authors,
  preliminary findings and historical proof remain in their separate task record.
- Authority: human/master-approved bounded M14 runtime safety work, one assigned
  writer; coordinator owns dependency installation, broker and execution of all
  tests/gates. No child agents, external messaging, submission, merge, release,
  credentials or settings authority is delegated to this writer. The master
  explicitly authorized light production repair only after the coordinator
  observed all five baseline failures. Heavy execution remains separately gated.
- Scope: existing `nodeHost.ts`, `nodeScheduler.ts`, and (only if the real probe
  demonstrates the need) `advisoryLock.ts`; their existing tests, one owner-local
  real-PostgreSQL witness, composition/scheduler API snapshots and one own
  `m14-runtime*.md` fragment. Shared canonical docs, navigation, package gates,
  indexes, versions and lockfiles are coordinator-owned and untouched here.
  First C appUpgrade in `/private/tmp/openlup-m14-lifecycle` is completely frozen.
- Exclusions: no new production files, dependency, module, cancellation/timeout
  framework, persistent coordinator or lease engine. No changes to unrelated
  auth, error, resource-cleanup or later-registration guarantees.

The selected smallest adequate API change is explicit `stopAll(): Promise<void>`:
stop/fence the current registrations synchronously, await their admitted work
including lock release, and preserve later registration. A separate drain member
would add a second lifecycle operation although the only production caller is
`nodeHost.ts`; that caller already returns a cached shutdown promise. Never hide
asynchronous drain behind a `void` signature. The coordinator observed the failing
probes before the light production repair grant; snapshots still await their
actual producer during an authorized heavy execution turn.

Acceptance and discriminating proof:

| Boundary | Prepared evidence |
| --- | --- |
| Stopped callback cannot acquire or run; later registration works | Existing scheduler test file, stopped-registration probe |
| Stop waits through body and asynchronous unlock | Existing scheduler test file, independently controlled callback/unlock latches |
| Host closes dedicated lock only after admitted work releases it | Existing host shutdown test file, active callback latch and invocation order |
| Same-session PostgreSQL reentrancy cannot duplicate work | `tests/postgres/nodeHostRuntimeDrain.test.ts`, dedicated owner/replacement clients |
| Replacement exclusion during drain, then execution after release | Same real-PostgreSQL witness, two hosts and callback latch; missing Docker fails |
| Compatibility and cleanup | Existing stopAll later-registration, host cached promise, aggregate failures, auth/error and lock cleanup tests retained |

Execution plan: coordinator installs only this worktree's dependencies when
resource priority permits, runs/discovers the prepared probes against unchanged
production and records failures, then authorizes the bounded existing-seam repair.
After repair, the coordinator owns focused regression, package/API, policy/lint
and required gates. Native final review waits for the actual stable predecessor;
no counted review or repair cycle has begun here, and this candidate does not
reset any other task's findings or budgets. Read the current canonical
[contribution instructions](../../../CONTRIBUTING.md#instruction-freshness-and-handoffs)
at resume/handoff.

Risk: PostgreSQL session-scoped acquisition is reentrant, so a Set-shaped fake is
insufficient proof. Shutdown must not end that session while a callback owns a
job. A pending acquisition also needs ownership before its first await; a failed
unlock must not permit a reentrant reacquisition. Preserve cleanup attempts and
the existing aggregate failure order even when a timer stop throws.

Evidence and failures: no install, test, heavy command, production change or API
snapshot change has been performed by this writer. Prepared tests are not PASS
evidence. Execution remains scheduled by the coordinator. Lightweight
`git diff --check` passed for the tracked patch. The writer read the relevant
policy delta from the code base to the supplied current revision; only marketing
guidance changed on these instruction/architecture/runtime paths.

Temporary resource hold (2026-10-26): Master M14 verified the human-approved
isolated coverage measurement window. Finish only the already-submitted bounded
runtime `npm ci --ignore-scripts --no-audit --no-fund` broker job (queue 300 s,
execution 600 s); no test/build/PG/full-verification job is active in this lane.
After that job exits, launch no new heavy command or replacement retry until
the master's explicit resume. Do not interrupt active processes, modify broker
settings or touch another task's work. Light reads and packet work may continue
outside frozen inputs. This scheduling hold changes no scope, acceptance,
review counters/expiry or draft delivery authority. First C stays frozen and
retains delivery priority. Falsification must actually run after the hold before
production repair begins; prepared tests remain unexecuted meanwhile.
The sole pre-hold queued install exited 74 after 302 seconds with
`failure_class=queue_timeout`, `budget_wait/aged_queue_reservation`; it was never
admitted and installed no dependencies. This lane is drained: no active or
queued heavy jobs remain. No replacement was launched. Resume still requires
the master's explicit scheduling signal; falsifiers and the three production
owners remain unchanged and unexecuted.

Scheduling/freshness update (2026-10-27): measurement window 4 is released for
A's first heavy GO only. C remains light-only until the master's explicit turn;
enqueue no `openlup:m14:heavy` waiter behind an active holder because the
installed unfiltered oldest-queue selection can obstruct its later phases.
No broker/profile/control change is needed or authorized. Current fetched/read
policy is `ef861a76dad97c0b744f6f25c04b04f4ac44c5fe`: marketing instruction/owner
deltas and the 0.29.0 platform docs-gzip cap of 73,728 bytes, with the other
caps unchanged in VERSIONING. Code base stays bb12776; no catch-up merge or
rebase was performed. No new heavy job was launched or queued in this update.

## Authorized baseline execution, 2026-10-27

Master explicitly granted one runtime-only baseline batch in B's review gap.
Immediately before launch, common locks/queues were empty and machine usage
was zero. Used fail-fast broker admission, with no waiter or second batch:

```sh
PATH=/opt/homebrew/Cellar/node@24/24.21.0_1/bin:$PATH VITEST_MAX_WORKERS=2 \
ai-resource-gate run --execution-timeout 600 --lane tooling --cpu 2 \
  --memory-mb 2048 openlup:m14:heavy -- sh -c \
  'npm ci --ignore-scripts --no-audit --no-fund &&
   npm run pretest &&
   npx --no -- vitest run --project=node packages/platform/test/scheduler/nodeScheduler.test.ts packages/platform/test/composition/nodeHost.test.ts tests/postgres/nodeHostRuntimeDrain.test.ts'
```

Actual admission: waited 0 seconds, tooling lane, 2 CPU / 2048 MiB. Own npm ci
installed 727 packages in four seconds. Core, outbox and platform prerequisite
TypeScript builds passed at this code base's actual 0.28.0 set. Frozen hashes for
the three production files and three selected tests matched before/after.
No production, API, selector or first-C change occurred.

Vitest exited 1: **57 passed / 5 failed / 62 total**, three files, 6.24 seconds
total (5.98 seconds tests). All failures were the intended mechanisms:

- Real PostgreSQL dedicated session: overlapping invocation called the body
  twice instead of once, establishing reentrant same-session acquisition.
- Real PostgreSQL host: the owner session was already closed and not queryable
  while the old handler latch was still held, establishing early lock-session
  release rather than a fixture or role-setup failure.
- Existing host witness: `lock.close` ran once before admitted work completed.
- Scheduler witness: a stopped registration's callback still acquired/ran.
- Scheduler witness: stop completion became true before body/unlock latches.

These are executed negative proofs, not qualifying PASS or final review.
No infrastructure/fixture failure or timeout occurred. Per-test finally blocks
settled callbacks, closed both dedicated clients, and the existing helper logged
successful owned container removal (524 ms). Post-batch broker showed zero
locks and zero queued jobs. Full run output, frozen hashes and prepared-test
patch are in ignored `.context/scratch/runtime-baseline-20261027/`.

The finite baseline GO is consumed. No new heavy job/retry or production/API
repair is authorized by its result; await the master's next bounded execution
instruction. The proposed explicit `stopAll(): Promise<void>` and smallest
existing-seam repair remain proposals. No native session/review cycle has begun.
First C remains at its separate provisional-parent preparation and is unchanged.

Self-retro: the real session distinguished PostgreSQL reentrancy from the
set-based fake; the five prepared probes failed promptly and cleaned up without
timeouts. The caller inventory still supports the explicit stopAll promise
contract rather than a second lifecycle member. No further process change is
justified by this baseline.

## Authorized light repair, 2026-10-27

The master explicitly granted this same sole writer light repair after the
observed baseline. The coordinator compared all three production owners from
the code base to current B and found no changes, so the baseline mechanisms
still apply. Baseline inputs, log and frozen hashes remain immutable; repaired
source hashes intentionally differ. This grants no build, test, install, lint,
AST, PostgreSQL execution, retry, DCO, native preparation or counted review.

Implemented within the three existing production seams:

- Each registration has a stopped fence. Callback admission records a promise
  before acquisition starts; that promise includes acquisition, body and unlock.
  `stopAll()` synchronously fences all current registrations, attempts every
  timer stop and waits for all admitted promises with `allSettled`. A single
  failure keeps its identity; multiple failures use a scheduler aggregate.
  Stopped registrations stay fenced while later registrations remain supported.
- `createPgAdvisoryLock` reserves the actual numeric advisory key before its
  first await. Pending and held acquisitions, including hash collisions, skip.
  False/error acquisition clears the reservation; failed unlock retains it
  through dedicated-session closure. Direct release still issues its existing
  SQL without requiring a preceding tracked acquisition.
- Host shutdown starts timer fencing synchronously, closes the listener and
  closes the lock only after drain settles, whether drain succeeds or fails.
  The public host stop promise remains cached. The original timer/lock/listener
  error ordering is retained; every owned cleanup is attempted.

Caller compatibility: `nodeHost.ts` is the only production `stopAll` caller and
now chains lock disposal after its explicit promise. The reusable scheduler test
awaits the new return while retaining later-registration assertions. External
structural implementations must return a drain promise; callers disposing shared
resources must await it. Host `stop(): Promise<void>` is unchanged. The own change
fragment records this migration. Composition/scheduler snapshots have not been
handwritten or regenerated.

Focused unit witnesses were added for pending-acquisition drain, draining all
work despite another acquisition failure, stopping/fencing every registration
despite a throwing timer, lock pending/held collision refusal, false/error
acquisition recovery, failclosed unlock, and host cleanup after unlock failure.
The two real-PostgreSQL falsifiers remain unchanged after baseline execution.
All new positive proof remains pending. Only static reading and
`git diff --check` have run during this repair; no PASS claim is made.

Proposed canonical owner prose is retained only in ignored
`.context/scratch/runtime-drain-owner-proposal.md` for the coordinator's later
handoff. Shared docs/navigation/package gates/versions/locks and frozen First C
remain untouched. No review history, finding or retry counter was reset.

Repair self-retro: retaining the existing lifecycle method and numeric lock key
avoids a second drain operation or lease engine. `allSettled` at both existing
shutdown seams preserves cleanup despite failures. No further scope/process
change is justified; the next useful evidence is the authorized executed probe.

## Authorized non-Docker proof and import repair, 2026-10-27

The coordinator executed one authorized fail-fast proof batch with common locks
and queues empty: admitted wait 0, tooling lane, 2 CPU / 2048 MiB, execution
budget at most 600 seconds. No Docker call was made. Own prerequisite builds for
core, outbox and platform passed, AST passed, and all three changed unit files
passed **78 / 78 tests** in 225 ms. The native API producer generated exactly the
scheduler and composition reports from actual dist using a temporary two-record
input projection; all other reports remained byte-identical. This is not a full
API-check result. Output is retained in ignored
`.context/scratch/runtime-unit-proof-20261027/run.log`.

The batch exited 1 only at focused lint: the authored PostgreSQL witness imported
four source modules through forbidden deep workspace paths. The authorized
light repair replaces those imports with existing declared public entries:
`@openlup/platform/composition`, `/kernel` and `/scheduler`. Production, generated
API reports, other tests and lint controls remain unchanged by this repair.
Baseline five-red logs and frozen input hashes remain immutable.

Static `git diff --check` passed after the import edit. Lint rerun, positive
real-PostgreSQL proof, cold/full API checks and native review remain pending a
new explicit execution grant; no test/lint/build/Docker/PG command was run by
the writer for this repair. The original five negative baseline results and
78 positive unit results retain their separate exact inputs.

Self-retro: the cross-boundary witness belongs on the package's declared exports;
replacing the four deep imports fixes the lint boundary without new production
exports, rules or ignores. No further scope or process change is justified.

The subsequent authorized first-C producer turn first reran only this witness's
focused ESLint command in its own runtime worktree: exit 0. No unchanged unit
suite, API producer or PostgreSQL witness was rerun. The 78 unit PASS and two
actual API outputs retain their earlier exact source inputs; positive real-PG,
full/API/cold/native proof and final runtime integration remain pending.

## Receiving-machine source handoff, 2026-10-27

The owner directly narrowed the receiving-machine endpoint to source corrections
and a handoff to the originating author session. Keep #405 a draft. No tests,
`verify`, dependency installation, build, package measurement, native admission,
ready transition or merge is authorized in this receiving run. This later grant
supersedes the historical writer's local scheduling restrictions for the bounded
source/documentation work; it does not supply missing proof.

Receiving coordinator: Codex chat `01a17e97-d95d-7581-beb5-ab5ee9ad007c`.
Policy pin read: `a03d920eec32bfb3d0de90b9a12535cc57f88d53`; code checkpoint
`5eac3ce64e51d6a901aee3938714aaa2c6b36699`; predecessor checkpoint
`da3a47d7f32f303ddaa6160d93dd6066239e6716`. No freshness integration was
performed. The five-red baseline and earlier positive witnesses keep their
historical inputs; none qualifies this stack.

Static inspection found the three existing production seams already contain the
bounded drain repair. This receiving delta adds the missing package/runtime
owner explanation, publication-catalogue entry and existing substrate routing
for the PostgreSQL witness. It introduces no further production behavior.
Generated navigation, owner-impact fingerprints, API compatibility, cumulative
pack limits, installed/cold proof, current PostgreSQL proof, independent FULL
review and full clean-tree `--pgtap` verification remain for the author machine.
No review session, PASS, receipt, expiry or repair-cycle claim was created.

The source remains uncommitted here: required pre-commit checks and sensitive
packet stabilization have not run. Preserve the working-tree delta or its exact
handoff patch; do not bypass the hooks to publish it. Reconcile the C+D repair
into this dependent candidate only through the ordinary documented stack route.

Self-retro: the access preflight initially confused a model-session failure with
file permissions. A disposable write/read/cleanup probe and a successful retry
of the existing Sol 6.1 session resolved that distinction before source editing.
The useful simplification here is owner metadata for the existing repair;
another shutdown mechanism would add no accepted behavior.


## Owner-authorized corrected draft checkpoint, 2026-10-27

After the source-only handoff preparation, the owner directly instructed this
receiving session to commit and push its corrections into the existing #405
draft instead of ending with a separate prompt. This supersedes the earlier
no-commit/no-push endpoint for this run. The actual grant covers DCO checkpoint
commits, ordinary dependency-stack integration and updating the existing draft.
The owner still forbids local tests and `verify` on this machine. No required
proof is waived for readiness, admission or delivery: this checkpoint is
unverified, with no PASS, receipt, ready transition, auto-merge or queue admission.
The receiving supervisor remains `01a17e97-d95d-7581-beb5-ab5ee9ad007c`; all
recorded authors, exclusions, findings and review budgets remain applicable.
Use ordinary Git hooks and signing; no bypass or copied proof stamp is allowed.
Generated metadata, regression execution, package measurements, independent
review and final verification remain owed on the author's proving machine.

## Author-machine continuation and effective authority, 2026-10-27

The owner resumed required tests and full verification of all five corrected M14
drafts here, then explicitly instructed: "merguj jak mozesz zeby calosc doprowadzic
do konca". This supersedes the earlier draft-only and source-only endpoints for
this run. Master `01a17909-94d4-7cc0-b40f-9a8782a0986f` coordinates the existing
C+D, runtime, E1, E2 and F tasks. The actual grant covers necessary in-scope
repairs, signed checkpoints, draft updates and, after required proof and reviews,
ready, source receipt/admission, required source/group checks and merge queue.
All M14 sessions retain the owner's standing bidirectional communication grant.
No release, npm publication, deployment, production, real provisioning/cutover,
credentials, account/settings change or other-repository action is authorized.

Fresh policy pin: `a03d920eec32bfb3d0de90b9a12535cc57f88d53`, fetched and compared
separately from the code head `533ec09574fbe3c42bcbc6ebc7f054fe16fa0608` and
predecessor `32644012ce5a7b5a3962c33098a337296f359e95`. The dedicated existing
worktree and all ignored historical evidence were preserved. Historical and
receiving source authors, including the master, remain excluded from independent
reviews; no native session or PASS has been manufactured.

With Node 24.21.0 and npm 11.19.0, the actual current source selection in the three
existing scheduler/advisory-lock/host test files passed 78/78 tests. This is
focused source proof, not a built or installed PostgreSQL qualification. The
first cheap checks exposed two documentation defects: the shipped task record
was absent from the publication inventory and generated navigation was stale.
Registering that exact record and regenerating navigation repaired the inventory.
The policy check then found the historical compound install/test transcript
ambiguous to the npm command parser; line breaks retain its exact arguments while
making the separate npm invocations explicit. No classifier, allowlist or guard
was weakened. Current policy (two obligations, zero unanswered), inventory and
ast-grep checks passed. Logs are retained in the master's existing execution
evidence directory, `/private/tmp/m14-verification-20261027`.

Fresh build/API production, cumulative pack measurements, current real PostgreSQL,
cold/installed/coverage proof, two independent FULL reviews and clean-tree full
verification remain required before delivery. The predecessor must actually land
before dependent admission. Existing failures and counters are preserved.

Self-retro: registering an already-shipped task record exposed actionable policy
defects before broad tests; direct inventory and transcript repairs sufficed.
No extra runtime mechanism, checker exception or timeout increase was needed.

## Actual predecessor integration preparation, 2026-10-27

Master `01a17909-94d4-7cc0-b40f-9a8782a0986f` delegated runtime-only preparation
to its `m14_runtime_delivery` worker in the already assigned worktree. The
owner's actual author-machine grant above covers required tests, full/native
verification, readiness, source receipt/admission, required source and merge-group
checks and merge for the five existing M14 PRs. The standing two-way
communication grant remains effective; the originating user message is
`01a17f18-81d3-7602-9229-db425d5124ca` in the master's thread. The master retains
coordination, heavy scheduling and sensitive-packet/native delivery ownership.
This worker's present turn ends before commit, DCO, native preparation or push.
No release, npm publication, deployment, live/account/settings action or separate
repository is in scope. Earlier narrower writer grants remain historical.

Fresh applicable policy was read at main
`75d08b8207053fe9a5207e003b625133685ffdf4`, separately from runtime HEAD
`533ec09574fbe3c42bcbc6ebc7f054fe16fa0608`. The policy delta since a03d920 is
the disposable PostgreSQL tmpfs fixture paragraph in CONTRIBUTING. The actual
C+D predecessor is `b040add7f9fbc5cdd461881f09421cb0a6700145`. An ordinary
two-parent merge of that dependency is prepared without conflicts and left
uncommitted. It carries C's sigma-alias repair, current caps and tmpfs fixture
changes without modifying those responsibilities. No mechanical-integration
exemption or inherited runtime proof is claimed: runtime's first candidate still
requires its ordinary full proof and two independent FULL reviews.

Before integration, the three owned dirty files were copied with SHA-256
identities to `/private/tmp/m14-runtime-owned-wip-20261027` and preserved in
explicit owned stash `ba4b9f740aa6887111b9fc44be863fa71cc99161`. Applying only
that stash restored all three files byte-for-byte; the backup patch and stash
remain available. All earlier transcripts, findings, failures and evidence are
preserved. Runtime still has no initialized native session or counted PASS.

The package scheduled-jobs owner, runtime owner, migration fragment and existing
composition/scheduler API snapshots describe the explicit drain promise. Their
producer validation remains owed. The real-PostgreSQL witness already has its
publication and substrate routing entries; its exact file is now registered as
a public direct execution entrypoint so the documented focused command can be
run through the source command contract:

```sh
npm test -- --run tests/postgres/nodeHostRuntimeDrain.test.ts
```

No broader execution surface, classifier exception or production mechanism was
added. The root test configuration already discovers this witness. The existing
78-test source selection and historical PostgreSQL evidence retain their stated
inputs; no new test result is asserted here.

While the merge is pending, precommit metadata checking uses actual HEAD
ancestor `32644012ce5a7b5a3962c33098a337296f359e95`, never the future nonancestor
b040add7 pin. Its initial policy/navigation run reported five obligations and
one unanswered inherited application-lifecycle obligation: C's no-impact
trailer is not yet in runtime HEAD ancestry. Resolve attribution through the
ordinary signed integration after precommit checks, rather than manufacturing
an impact exception or future base. Only after that merge is committed may
`OPENLUP_STACK_BASE=b040add7f9fbc5cdd461881f09421cb0a6700145` be exported for
runtime checks, review and final verification. C must actually land on main
before dependent delivery. Build/API producer, cumulative pack measurement,
current PostgreSQL and installed/cold/coverage/full verification remain pending.
No heavy command or waiter was started during E1's reserved execution slot.

The final light preparation check ran under Node 24.21.0/npm 11.19.0:
ast-grep passed, `git diff --check` passed, and policy/navigation reported six
obligations with only the same inherited C lifecycle obligation unanswered.
CONTRIBUTING now documents the exact focused PostgreSQL command and its proof
limits beside the fixture instructions; the exact source-entrypoint registration
therefore has an owning explanation. Logs are in the owned backup directory as
`ast.log` and `policy-final-prep.log`. The pending merge, this metadata work and
the current candidate have not been committed or independently reviewed.

Self-retro: backing up and hashing only the three owned edits made the dependency
merge reversible and verified their exact restoration. Keeping the merge pending
also exposed the expected inherited-impact attribution limit before any costly
verification; no control relaxation or extra runtime abstraction was necessary.

## Authorized current working proof, 2026-10-27

The master granted one finite runtime working-proof phase after E1's working
phase ended. The pending merge and existing source stayed fixed throughout
execution. Node 24.21.0, npm 11.19.0 and this worktree's own dependencies were
used. No install, full verify, DCO, commit, native session or push was performed.
Evidence is in `/private/tmp/m14-runtime-working-proof-20261027`; the resulting
staged-tree packet is working proof for the master's sensitive read, not clean
committed-candidate or native evidence.

Fresh builds passed for core (1.220 seconds), outbox (0.372 seconds) and platform
(2.892 seconds). All three actual API producers/checks passed without rewriting
a snapshot. The existing composition/scheduler snapshots therefore match the
built declarations, including `stopAll(): Promise<void>` and host drain notes.

The actual cumulative tarballs passed the repository artifact allowlist, packed
content/source checks, all size/file caps and every complete browser-entry
bundle cap, with zero findings. The current platform measurements are code gzip
1,661,321 / 1,743,872 bytes, tarball 1,934,304 / 2,029,568 bytes, unpacked
9,002,283 / 9,447,424 bytes, code files 2,574 / 2,574 and total files
2,628 / 2,628. Docs gzip is 65,460 / 73,728 bytes. No cap, baseline, version,
manifest or lockfile was changed. Core packed bytes are 167,341 and outbox
39,165; their artifact/budget checks also passed. Full digests, browser values,
caps and tarballs are retained in `packs/measurements.json` and `packs/`.

The actual current three runtime source suites passed 78/78 tests. Both real
PostgreSQL dedicated-session/host-drain cases then passed with the built public
exports (1.77 seconds tests, 2.00 seconds total). Missing Docker refused the
initial sandbox run, rather than skipping qualification; the same authorized
witness passed through ordinary `require_escalated` Docker access. Fixture
teardown completed successfully, and a bounded read of containers matching this
witness's `node-host-drain-` prefix returned no remaining containers.

Canonical `npm run lint` passed under `openlup:typecheck` in 26.628 seconds
(zero errors, 33 existing warnings). Published typecheck passed under that same
profile in 22.564 seconds: all five projects, zero unresolved edges and zero
consumer-side errors. These are working-tree results; final clean committed
verification and independent review remain owed.

Execution diagnostics remain visible. The first finite driver incorrectly used
the task-named tooling resource for every step. The master's correction arrived
after its final typecheck child had already started; that child was allowed to
finish safely, then the outer lock exited. Those original lint/typecheck passes
remain diagnostic observations; both were qualified again under the required
typecheck profile. Successful standalone builds were not repeated merely to
change their profile. The first pack refused the sandbox's global npm-cache
write; an isolated task-owned cache resolved it without changing global files.
The first unit invocation combined the package's relative include with root
paths and discovered zero tests; the corrected root Node project ran all 78.
Neither input failure is claimed as a product regression or qualifying PASS.

The corrected remaining phases were serialized with normal `--wait`, the actual
worktree numeric suffix `wt521061927005047226`, and existing profiles:
`openlup:tooling` (2 CPU / 2,048 MB) for pack/unit work,
`openlup:postgres` (2 CPU / 6,144 MB) for real PostgreSQL, and
`openlup:typecheck` (4 CPU / 6,144 MB) for lint/published typecheck. No nested
broker, timeout increase, budget relaxation or leftover heavy waiter was used.
The pending-merge policy diagnostic remains attributed to actual HEAD ancestor
32644012 until ordinary signed integration makes b040add7 an ancestor. Runtime
still owes its first two independent FULL reviews, native verification and full
clean-tree proof; predecessor delivery remains required before admission.

Self-retro: the incorrect initial resource profile and test selector cost one
small refused/empty probe plus repeated lint/typecheck. Dispatch each existing
phase profile directly and use the root project for root-relative test paths.
Actual packs fit the already approved reserves, so another cap change or runtime
mechanism would add no accepted benefit.

## Necessary E1 dependency integration preparation, 2026-10-27

Before runtime's first native review or full verification, the master found one
real documentation-owner conflict and five shared owner/control paths between
the qualified-install controls and runtime. The finite existing-PR dependency
order is now C → E1 → runtime → E2 → F. This is necessary stack integration,
with the approved runtime outcome, exclusions, authority and budgets unchanged;
it creates no successor task or new contract. The master's actual preflight is
retained in `/private/tmp/m14-verification-20261027/linear-stack-preflight.json`.

The existing clean runtime checkpoint
`d94753fe22ed8497abd9ddaa9309e23699a187d3` remains preserved. A normal
`--no-commit --no-ff` merge now integrates exact E1 dependency
`3a8d4a7165f5ef3df13bdc8da9d6a3e3ca17a529`. Its sole content conflict in
DOCUMENTATION's Ownership section is resolved by retaining both complete owner
descriptions: runtime scheduled-job drain and E1 migration admission. Automatic
merges retain both execution-inventory registrations, publication entries and
contributor/package explanations. No runtime production/API byte or E1 control,
inert fixture, canonical v1/88-entry manifest or inventory pin is intentionally
changed. The instruction revision remains
`75d08b8207053fe9a5207e003b625133685ffdf4`.

This preparation is light-only: AST, inventory, policy/navigation and diff
checks, plus an exact staged-tree dependency/preservation packet for the master's
new read. There is no install, build, pack, lint, PostgreSQL, heavy waiter, full
verification, DCO, native preparation or push. Existing working-pack and test
results retain their exact earlier tree attribution; they are not proof for
this integrated tree. Manual conflict resolution receives no mechanical
integration exemption, counted PASS or native budget reset.

Pending-merge policy uses actual HEAD ancestor
`b040add7f9fbc5cdd461881f09421cb0a6700145`. Only after an authorized ordinary
signed integration commit may the new exact E1 predecessor be exported as
`OPENLUP_STACK_BASE`; that future nonancestor is not used to check this pending
merge. All prior policy diagnostics, input failures, evidence and remaining
full/native proof obligations are preserved. The active E1 proving worktree and
its exclusive full run remain untouched. Recovery retains d94753f and the prior
owned backup/stash; no rollback or shared-reference cleanup was performed.

Light checks passed: policy/navigation reported five obligations and zero
unanswered against b040add7; inventory admitted 6,509 tracked public paths;
ast-grep passed. Exact byte assertions confirmed all three runtime production
files and both API reports still match d94753f, all 25 nonoverlapping inherited
E1 paths match 3a8d4a7, and all five inert fixture bytes match both E1 and their
unchanged SHA-256 pins. The active manifest remains identical to E1: schema v1,
88 legacy units and inventory
`cfe3a8b4fa6216f61b1cdd5f004cb0f7a967bc01d9e18ddacb2efee74742d3b3`.
Canonical migrations and release caps also remain identical to E1. Evidence is
in `/private/tmp/m14-runtime-e1-integration-20261027/preservation.json`.

The runtime delta relative to E1 passes whitespace checking. The full inherited
integration diff relative to runtime reports one existing E1 fixture blank line
at EOF (`q2_20260810180001_self_host_actor_auth.sql:79`). Preserve its exact
reviewed bytes and pin rather than silently normalizing that inherited input.
This diagnostic is not reported as a passing whole-integration whitespace check.

Self-retro: checking the shared dependency delta before full verification found
the actual owner-paragraph conflict early. Keeping both existing explanations
and the exact inherited controls avoids repeating full proof after a known
manual integration, without adding a new runtime mechanism or weakening a gate.

## Cumulative E1 + runtime working proof, 2026-10-27

The master read the staged integration packet `40947552…` and source resolution,
then granted one finite cumulative working-proof phase for staged tree
`c5517013c8460ea839ed4adcc31df9eeb3ecb1da`, with d94753f + exact E1 3a8d4a7
still pending. Node 24.21.0/npm 11.19.0, this worktree's dependencies and a new
task-owned npm cache were used. Inputs stayed fixed during execution; phases
were sequential normal `--wait` admissions on numeric suffix
`wt521061927005047226`: build (4 CPU/4,096 MB), tooling (2 CPU/2,048 MB),
PostgreSQL (2 CPU/6,144 MB) and typecheck (4 CPU/6,144 MB). The previously
diagnosed Docker access used ordinary escalation, with no known-bad selector or
cache retry, nested broker, new timeout or cap change.

Fresh core/outbox/platform builds and all three API checks passed without any
snapshot rewrite. Actual cumulative packs passed artifact/content, all byte
and file budgets and every complete browser-entry cap with zero findings.
Platform measured code gzip 1,662,140 / 1,743,872 bytes, tarball
1,935,102 / 2,029,568, unpacked 9,006,345 / 9,447,424, docs gzip
65,643 / 73,728, code files 2,574 / 2,574 and total files 2,628 / 2,628.
Core/outbox tarballs measured 167,341 / 39,165 bytes, within their unchanged caps.
The three runtime suites passed 78/78 and the actual PostgreSQL witness passed
2/2 (1.88 seconds tests, 2.15 seconds total). Teardown succeeded and a bounded
owned-container query returned no remaining `node-host-drain-` container.

Canonical lint passed in 29.463 seconds (zero errors, 33 existing warnings).
All five published typecheck projects passed in 27.519 seconds with zero
unresolved edges and zero consumer-side errors. Full logs, exact command timing,
tarball identities and browser measurements are in
`/private/tmp/m14-runtime-cumulative-proof-20261027`. These are current cumulative
working-tree results; previous packets retain their earlier attribution.
The task-note update is the only post-execution tracked edit. Exact runtime
source/API and E1 control/pin/manifest preservation is rechecked in the final
packet, with light policy using the valid b040add7 ancestor while merging.
No DCO, commit, native session, full verification or push has occurred.

Self-retro: dispatching each existing resource profile directly and using the
known root test project completed this phase without input failures or repeated
commands. The combined artifacts fit approved reserves; no additional mechanism,
cap adjustment or verification shortcut was justified.
