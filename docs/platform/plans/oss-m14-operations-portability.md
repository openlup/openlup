# Operations and existing-store portability

Status: development-preview implementation in progress. Draft contributions do
not establish supported hosting, provider certification, migration readiness or
stable-framework acceptance.

## Outcome and authority

The accountable maintainer authorized M14 implementation and independent review,
with Codex coordinating named workstreams and bounded subagents. The original
external endpoint of reviewed, appropriately verified, stacked **draft pull
requests** is historical; that initial grant covered scoped local work, signed
commits and draft submission.

The direct human amendment of 27 October 2026 (message
`01a17c90-a079-7f02-b102-a9e35d770649`) authorizes this same M14 C2 programme
through push, PR, ready conversion, required source checks and native admission,
merge queue, required group checks and confirmed merge. The finite implementation
and proof scope is unchanged. Package publication, provider activation, live
provisioning/cutover, deployment and account/settings/credential operations remain
excluded. Required API/security/control reads and native evidence still apply.
Technical review is delegated and does not assert personal human reading of
every diff.

### E1 source-only continuation, 27 October 2026

For this historical source-only continuation, the active supervisor relayed the
owner's then-current limit: prepare
all source fixes and regression source here, with no execution of tests,
verification, installs, builds, lint or gates, and no counted native reviews,
commits, pushes or external writes. The stronger machine only runs measurements,
tests and verification and returns results; source repair remains here. Drafts
stay drafts. This temporary execution boundary supersedes the broader delivery
grant above for this run; it does not waive any proof or authorize later delivery.

E1 remains in `/private/tmp/openlup-m14-qualified-install-controls`, branch
`codex/oss-m14-qualified-install-controls`, checkpoint
`0b4517be8000352be4659e4be2320163b1db9650`, with the first receiving source
corrections subsequently checkpointed by the supervisor at
`d3996e385003dce41e7cf00b53eb254ddc70810b`, draft
[PR #402](https://github.com/openlup/openlup/pull/402). Its
[historical handoff](https://github.com/openlup/openlup/pull/402#issuecomment-6449955741)
and [coordinator handoff](https://github.com/openlup/openlup/pull/402#issuecomment-6449957049)
retain prior authors, failures, exclusions and proof gaps. The supervisor
confirmed a fresh fetch in this receiving run with unchanged policy pin
`a03d920eec32bfb3d0de90b9a12535cc57f88d53` and read its current instructions.
This lane read the local instructions and handoff. The code review base is
separate from that policy pin.

Receiving author context `01a17e98-8264-7033-a2d1-0d3c8479ca3b`
(`/root/m14_e1`), receiving supervisor context
`01a17e97-d95d-7581-beb5-ab5ee9ad007c` (`/root`) and E2/F source contributor
context `01a17e98-931e-7fe3-99cb-841a3ac9ef0b` (`/root/m14_e2f`, author of
the optional fifth-pin/inert-fixture packet) are excluded from future independent
review of this candidate. No independent review occurred in this continuation.

Static inspection found an unwired control: trusted queue admission selected
`assertCoLocatedForwardApproval` only for a changed approval registry, although
qualified SQL normally arrives with unchanged prior pins. That skipped the
existing guard against simultaneous machinery changes. The local correction
selects the same guard for qualified paths in source and merge-group admission.
It adds no validator, bypass, fallback or extra query. The optional
`PlatformMigrationSource.assertSession` already runs once after exact-prefix
validation under the existing lock and before pending SQL/status/dry-run;
no hook change was justified by this inspection.

Later E2 source tracing found a reachable pre-hook resolution gap in the same
runner: unqualified lock/hash and ledger-existence calls execute before session
admission. The source correction adds three private catalog-bound SQL constants
selected only when `source.assertSession` is defined, passing one private boolean
through the existing session/prefix helpers. No extra query, session mutation,
public flag or new runner is introduced. Existing hook transcript assertions now
expect bound acquire/lookup/release, with prepared successful status/dry-run,
explicit-undefined legacy-transcript and prefix-mismatch-before-hook cases.
Default/undefined-hook query strings remain exact. These cases remain unexecuted;
the stronger machine must prove lock-key equivalence and hostile-name refusal.

The E/F coordinator supplied the optional fifth prior-control binding and inert
fixture for the existing retained-import SQL, SHA-256
`56144f8e61b649c9d9f48458a1734abcc8bbd8d36fdc3919d90ceb1bc35d3b48`.
Its publication row and owner descriptions are updated locally. This is a
proposed control candidate, not completed prior approval or installation proof.
The four existing pins and fixture bytes, active v1 manifest, its 88 legacy units
and inventory `cfe3a8b4fa6216f61b1cdd5f004cb0f7a967bc01d9e18ddacb2efee74742d3b3`
are unchanged by these edits. No active qualified SQL is introduced by E1.
E1 must actually land as trusted controls before E2 or F delivery.

The historical focused batch remains 739 PASS / 16 FAIL across five files.
Read-only tracing shows that synthetic pgTAP lifecycle fixtures replace external
commands on PATH but retain actual `node:net` loopback binds. The checkpoint's
`available()` mapped every socket error to false, so denied binds as well as occupied ports could reach
the same final "no free port block" error before image/start/replay stages.
The historical errno was not retained here. This does not establish an
environmental cause or exclude a regression; all 16 failures remain unresolved.
The new diagnostic correction retries only `EADDRINUSE` and reports other bind
errors with their errno and exact loopback port; it still refuses before stack
startup. The 50-attempt budget and seven probes per block are unchanged. Three
prepared lifecycle cases inject `EPERM`, `EACCES` and `EADDRINUSE` using the
existing subprocess fixture and assert immediate named refusal or bounded
occupancy exhaustion, with no stack commands. They have not run. Earlier
fragment-row and PATH failures and the required regroup remain in the history.

Four prepared cases extend the existing real-Git qualified-admission witness
through actual `waitNativeAdmission`: pull-request and merge-group events each
accept ordinary separately approved additions with unchanged pins and refuse a
simultaneous machinery edit. The real co-location guard is observed through a
call-through spy, including both source and group invocations on group success;
the fixture replaces API responses and omits only fetching already-local Git
objects. Synthetic receipt data is fixture input, never task review evidence.

No executable check was run in this continuation. Required next proof includes
execution of these prepared queue and socket cases, optional fifth-binding/fixture
integrity, current pgTAP diagnosis, package hook/native-session proof, API/build/pack and
owner/budget checks, two fresh full native reviews and the canonical full gate.
No native session is initialized: cycles remain 0/3, with no PASS or expiry.
No candidate DCO, receipt, readiness, admission or merge claim follows from these
local edits; no budget was raised. New edits since `d3996e38` remain uncommitted.

Self-retro: the missing caller condition showed why a validator-only fixture
cannot prove trusted admission is wired. Reusing the existing guard was the
smallest adequate correction. Extending the real Git witness reaches the actual
caller, and preserving socket errno removes a diagnostic ambiguity without a
new selector or retry policy. Admission cannot protect lookup functions that run
before it; binding those existing calls closes that source gap without changing
legacy transcripts. Historical causality still needs an authorized run.

### E1 authorized verification continuation, 27 October 2026

The owner subsequently authorized the required tests and full clean verification
on this machine, followed by DCO, push and updates to the five existing PRs,
ready conversion, native receipt/admission, required source/group checks and
merge queue through confirmed merge. This supersedes the temporary source-only
and corrected-draft execution endpoints above and below; it changes no programme
acceptance or proof requirement. Release/npm publication, deployment, live
provisioning/cutover, credentials, account and settings changes remain excluded.
The active root supervisor coordinates delivery and serializes heavy phases;
the author lanes `/root/m14_e1_controls` and its continuing integration lane
`/root/m14_e1_delivery` own this E1 worktree and are excluded from independent
review. Policy was refreshed from `a03d920eec32bfb3d0de90b9a12535cc57f88d53` to
`75d08b8207053fe9a5207e003b625133685ffdf4`, separate from the code review base;
the changed contributor guidance describes the owned PostgreSQL tmpfs fixtures.

This continuation started from the clean checkpoint
`f8c88bb4009b7841478e87ce08a1815144c410ac` with its prior source corrections
already committed. With Node 24.21.0/npm 11.19.0 and this worktree's own
`node_modules/.bin` on PATH, the following focused checks ran:

- `node scripts/run-vitest.mjs run scripts/qualified-migration-admission.test.ts scripts/platform-migration-manifest.test.ts packages/platform/test/migrations/postgresRunner.test.ts --project=node`:
  64 tests passed in three files. These include actual source/group admission
  success and machinery-change refusal with unchanged pins, manifest/history
  refusals and the optional session hook's exact ordering/legacy transcripts.
- `node scripts/run-vitest.mjs run scripts/oss-published-tree-check.test.ts --project=node -t 'owned pgTAP command lifecycle'`:
  sandboxed execution reproduced 16 failures and seven passes, with 74 unrelated
  cases excluded. The first failure explicitly reported loopback bind `EPERM`
  before stack startup. The exact same command outside the sandbox passed all
  23 selected cases in 36.30 seconds, including injected `EPERM`, `EACCES` and
  bounded `EADDRINUSE` refusal. No timeout, retry budget, socket refusal or test
  assertion changed. This identifies the current environment limitation; the
  historical 739 PASS/16 FAIL run still lacks its original errno and is not
  retrospectively reclassified.
- `npm run oss:published-tree -- --policy` and `--inventory` passed. Policy
  initially refused an inline-code link to the intentionally future E2 proof
  file. Its owner explanation now links the existing execution inventory
  instead; no placeholder file or checker exception was introduced. All four
  documentation obligations are answered. The stale committed release snapshot
  remains the checker-designated release-preparation item.
- `npx --no -- ast-grep scan --error=no-suppress-all --error=unused-suppression`
  passed after that documentation correction.

The active manifest remains v1 with 88 legacy units and inventory
`cfe3a8b4fa6216f61b1cdd5f004cb0f7a967bc01d9e18ddacb2efee74742d3b3`;
the five inert fixtures and exact prior pins are unchanged. Existing fragment,
PATH and regroup history is retained above. Native E1 has not been initialized:
no PASS, expiry or receipt is claimed.

The supervisor then assigned the serialized working-tree build/API/artifact
phase. The existing broker admitted `openlup:build:wt12291020735647487593`
after 149 seconds for the prerequisite build; all three packages built and their
actual current API checks passed. Platform's API delta remains only the optional
session callback described above, with its exact ordering and legacy behavior.
Actual npm tarballs were measured using the existing artifact-content,
class-size and browser-budget functions. Core measured 167,341 packed bytes and
Outbox 39,165, without findings. Platform measured 1,923,429 packed bytes,
8,963,693 unpacked bytes, 2,619 files, code gzip 1,651,418 bytes/2,565 files and
docs gzip 64,693 bytes/five files. Its tarball SHA-256 is
`69d455b314df4623490afea9834ff493ac4190229d11fa613913f2542662c49e`.
Artifact-content checks and all 17 browser budgets passed, but the code class
exceeded this branch's existing 1,650,631-byte cap by 787 bytes. The phase stopped
there before lint/typecheck; no cap, baseline or reserve was changed. These are
working-tree measurements, not clean committed package proof. Required final
proof and the supervisor-owned integration of the separately authorized budget
remain open. Public/UI neutrality and gitleaks 8.30.1 also passed in this run:
zero neutrality increases and no leaks across 951 commits.

The supervisor explicitly continued independent lint/typecheck despite the known
budget finding, without waiving final delivery proof. With those fresh package
declarations unchanged, `npm --ignore-scripts run lint` ran the complete lint
body without rebuilding the same inputs: file-wide-ignore checks, structural
scan, eight rule suites and ESLint passed with zero errors and 33 warnings.
`npm run oss:published-tree -- --typecheck` passed all five projects with zero
unresolved edges and zero consumer-side errors. Both used the existing numeric
worktree typecheck broker profile; no pack was repeated and no source repair
was needed. Normal lint prerequisites and the complete installed/cold/coverage,
real PostgreSQL, independent review and full clean verification remain owed in
the supervisor's serialized final proof.

Self-retro: errno-preserving diagnostics and one identical unsandboxed fixture
run resolved the current environment question without changing controls or
adding a port-selection mechanism. The owner-documentation repair describes the
already registered future entrypoint through its existing source of truth.

The supervisor assigned the exact lifecycle predecessor
`b040add7f9fbc5cdd461881f09421cb0a6700145` for E1 integration. That candidate
contains the already approved global Platform reserve: 1,743,872 code-class
bytes, 2,029,568 total packed bytes and 9,447,424 total unpacked bytes. This
necessary dependency supplies the lifecycle export and existing reserve against
which E1's complete artifact must be measured; E1 introduces no budget change.
Its actual landing must precede dependent E1 delivery. This is dependency
integration, not a main refresh for freshness. The three overlapping contributor,
publication-catalogue and documentation-owner sections were resolved manually,
retaining both lifecycle and E1 responsibilities, and the two pre-existing E1
documentation edits were preserved and restored. Both exact execution entries
remain registered, including the future E2 child proof; the classifier is
unchanged. The five inert pins and active v1/88-unit inventory remain unchanged.
No mechanical-integration exemption or inherited E1 full proof is claimed:
working-tree build/artifact checks, the full clean gate and fresh independent
review still apply to the resulting candidate. The light integration checks
passed structural rules, the 6,506-path publication inventory and all nine
documentation obligations; navigation was regenerated. These checks used the
existing fork point while the merge was pending, so they do not establish final
proof against the committed lifecycle predecessor.

The assigned integrated working-tree phase then passed all three fresh package
builds and API checks. Actual Core and Outbox tarballs remained 167,341 and
39,165 bytes. Platform measured 1,933,640 packed bytes, 9,001,011 unpacked bytes,
2,628 files, code gzip 1,661,068 bytes/2,574 files and docs gzip 65,180 bytes/five
files. Artifact-content checks and all 17 browser budgets passed against the
unchanged lifecycle predecessor's approved limits, leaving 82,804 code-class,
95,928 packed and 446,413 unpacked bytes of headroom. Platform's working tarball
SHA-256 is `bcf3d43e46701fbfc2042b3cabd228ba12bfb21f6c8fbc0a97086936886a7670`.
The four-file control/manifest/runner/publication selection passed all 161 cases,
including the materialized closed-entrypoint success and unregistered direct
execution refusal. The actual PostgreSQL session-admission witness passed its
one lock/interrupted-prefix case using the current disposable tmpfs helper.
Canonical `npm run lint`, including its fresh build prerequisites, passed with
zero errors and 33 warnings; published typecheck passed all five projects with
zero unresolved edges and consumer errors. The normal numeric build, tooling,
PostgreSQL and typecheck broker profiles admitted immediately and released after
their commands. Tracked inputs stayed unchanged during these working checks.
The full clean/cold/coverage gate and fresh independent native review remain owed;
these results do not substitute for that final proof or authorize a release.

The module preserves operational behavior while supplying public lifecycle
capabilities for an existing synthetic store: compatible install/upgrade,
managed-to-portable and portable-to-portable transfer, interrupted operation,
DB/object/external-effect recovery and controlled executor handover. Preserve
identity/ACL/history, active subscriptions, frozen terms, unsettled amounts,
pending duties and idempotency/outbox/provider ledgers. Domain commands and
truth remain with their existing owners. Executor isolation does not pause a
subscription or discard obligations. An undelivered replacement is never marked
delivered; actual late arrival extends a cycle later once.

The source and initial policy base is
`80d27906a6d4bc679c011871948e88d185bb1c63`. Later exact candidate/predecessor
pins, authors, paths, review findings and commands belong to each workstream's
task record and native session. No implementation review PASS is recorded here.

## Workstreams and first useful candidates

These initial boundaries separate current operations from new lifecycle work;
they do not make a subset equal to whole-module completion.

| Workstream | Owned source and proof | First useful result |
| --- | --- | --- |
| Operations | `packages/platform/src/operations/`, its package tests and reference composition | Existing settings/pipeline/alerts/control-plane behavior, typed injected authority, watchdog delivery/heartbeat/replay/refusal, useful installed consumer. |
| Existing-store transfer and recovery | `packages/platform/src/portability/`, its package tests and source/target adapters | Authenticated consistent object copy/resume, explicit compatible-data transport/mappings and effect-time ownership experiment; unsupported handover refuses honestly. |
| App upgrade | `packages/platform/src/lifecycle/`, its package tests and supported recipe consumers | Conservative app-owned-file plan/apply, pre-write conflict refusal and interrupted resume; caller schema-range input is separate from actual database compatibility. |
| Portable installation compatibility | Existing canonical migration/role/manifest owners; exact implementation paths pending the bounded control decision | Resolve restricted-admin, distinct runtime-login and domain import-trigger gaps without rewriting history, bypassing controls or duplicating the runner. Source-only decision first. |

Use isolated platform subpaths under the
[package-placement decision](../ARCHITECTURE_AND_EXTENSIONS.md#package-placement-decision-canonical).
Browser-safe contracts are isolated from Node/provider infrastructure. Existing
data, migration, scheduler, identity and domain-effect rails are reused; no
universal dispatcher, second domain engine, generic ETL framework, new proof
registry or always-on transfer coordinator is justified by this plan.

One integration owner serializes shared manifests/exports/module graph/API
snapshots, migration/source/publication descriptors, reference composition and
documentation navigation. The bottom operations candidate gets an exact bounded
shared-file handoff first. Other disjoint source work can proceed in parallel;
upper branches incorporate final predecessors before counted review. Exact PR
ordering and boundaries are recorded when the candidates stabilize, not inferred
from workstream names. Existing earlier work retains priority.

## Concrete fit limits and recovery questions

- The public migration runner applies an ordered exact catalogue with
  ledger-prefix/object-inventory checks and an advisory lock. It is not a
  filesystem upgrade planner, data transfer or restore command. Preserve its
  history and checks; target schema comes from canonical migrations, with
  compatible data transported separately and only necessary explicit mappings.
- The generic gateway has actor/service role lanes, while capability-local
  stores can use role-free transactions. Real selected operations and their
  intended login/grants must be inventoried; owner-only tests do not prove the
  deployed capability. Both installer-managed and operator-provisioned models
  require explicit preflight.
- The current acquisition foundation requires a superuser migration login and
  binds the sole runtime-role membership to that login. The actor-auth forward
  creates cluster-global roles unconditionally. Restricted administrators,
  distinct runtime logins and existing clusters therefore have unresolved
  compatibility requirements. Do not rewrite/skip immutable history, widen
  grants silently or label those installation models supported. A compatible
  canonical repair/catalogue decision remains an explicit module dependency.
- Ordinary sign-in reconciliation does not migrate identity between issuers.
  The exact issuer/subject derives the OIDC principal; an already linked email
  cannot be overwritten. Transfer must account for dependent customer/operator
  memberships, erasures/challenges and credential/session limitations.
- Normal blob interfaces supply URLs, upload/list/exists/delete but not a
  complete authenticated byte/version/access export. Existing exists semantics
  can collapse storage errors to false. A transfer-specific server capability
  must distinguish absence, denial and unavailability, traverse all pages and
  reconcile bytes plus ownership/access at a consistent DB/object point.
- Restoring a database clones claim tokens, generations, versions and leases.
  Locks in independent databases cannot exclude an old process. Pause a worker
  after admission immediately before provider dispatch, hand over, then resume
  it while the new instance reconciles an accepted-before-ACK effect and late
  observation. Actual old egress must refuse through independently enforced
  authority; a startup-only or cached static check is insufficient. Assess
  existing deployment/provider enforcement before a new persistent service.

These are named feasibility/proof gaps, not new defects accepted as harmless.
Bounded useful drafts may disclose still-owed whole-module work; safe refusal
does not make a permanently unusable transfer a completed outcome.

## Proof and verification

Extend existing package/installed-consumer and disposable PostgreSQL harnesses.
Use neutral synthetic data, ordinary granted roles and meaningful failing
counterexamples. New module evidence must execute actual consumer behavior,
not merely validate interfaces or count exported names.

| Changed boundary | Required useful evidence |
| --- | --- |
| Operations/API | Current behavior and exact typed requests/results, authorization/input/output refusals, replay/conflict/checkOnly/restart; cold installed consumer without optional SDK or workspace leakage. |
| Roles/schema | Actual allowed domain write, forbidden neighboring operation and absent-grant refusal under the selected login; fresh/existing-state compatibility and hostile caller where applicable. |
| Transfer | Connected existing-store data, exact numeric/time/ID values, source writes/catch-up, interrupted copy/resume and complete count/value/ownership/ACL/object reconciliation. |
| Object recovery | Nested/multipage/private objects, denied read, interruption and overwrite between DB snapshot and byte read; no unreadable object reported absent. |
| Effect recovery | External acceptance, crash before ACK, older snapshot, old/new actors and late observation; no duplicate/loss or explicit safe refusal, controlled ownership and measured recovery point/time. |
| App upgrade | A real outside-workspace two-version app with customized/unmanaged files, divergent managed-file refusal before writes, interruption after one write and resumed application; schema compatibility distinct from file planning. |
| Recipes | One factored PostgreSQL conformance kit and explicit Node/OIDC/S3/host configuration; hosted results only when actually observed under scope. No cloud cross-product or stable claim from local fixtures. |

Use cheap structural/lint/published-tree typecheck, API/boundary/artifact and
affected behavior checks before counted review and final verification. Complete
mandatory full native verification for the applicable frozen candidate; focused
green never replaces it. Draft/skipped hosted checks do not prove admission.
Two independent fresh full reviewers cover material/sensitive candidates, one
considering a simpler solution. Preserve native findings/cycles/expiry and
exact predecessor pins. Do not review known-changing bases or repeatedly run
full gates while outputs are still changing. Follow the existing resource
broker and native sibling-held lock rules; no new gate or runner is installed.

## Measurements and completion evidence

### Test ledger

Counts describe configured required cases collected by the existing Vitest
`list --json` command, including expanded parameterized cases. They are separate
from executed results and hosted elapsed time. The public baseline is
`80d27906a6d4bc679c011871948e88d185bb1c63`; A's first candidate is
`1caa0197053db4446edc374561205aec2314488c`.

| Candidate / evidence | Configured delta | Executed result |
| --- | --- | --- |
| A actual selected baseline/current collections | Boundary 2,383 → 2,467: +84 from 28 new source files × three existing guards. Package operations: 88 cases, comprising 78 copied characterization cases plus 10 new cases; the root characterization remains. Selected confirmed increase **at least +172**, not a whole-root net. Other dynamic inventories also grow; comparable whole-root configured delta remains pending. | Focused 15 files / 104 cases passed. The mandatory root run on `1caa0197` observed 21,386 PASS / 6 FAIL / 2 skipped in 563s; metadata/reference-inventory repairs and a new exact candidate are required. This is not a +104 configured delta or a passing full receipt. |
| B first source slice on stable `84344611` | Current selected collection: 2,590 cases (boundary 2,480; new runtime files 25; cold consumer 85). Confirmed selected addition **+39**: 13 boundary cases (four new files × three existing guards, plus one no-pg declaration case), 25 cases in files absent from the predecessor, and one added named cold-consumer case. No boundary cases removed; prior cold-case declarations remain. This is not a whole-root delta. | Early four files / 25 new selected-row, object/filesystem and loopback cases passed. Integration then passed five files / 110 cases: those 25 plus one new installed-copy falsifier and 84 existing cold-consumer cases. Package boundary passed 2,480 cases. Three affected replacement-inventory cases passed. Full installed native PostgreSQL/candidate verification remains pending. |

A's actual collection artifacts are identified by SHA-256:
baseline `bd4888539b759020b21c9a1c0304da0fd5df9154c40e2819af908accfaadb954`,
current `67aee3b05eacda966e1642013dcefed5a84fa7e1c129ab2e1c0c1ce36db072bb`,
delta `4c0bc2cdd24ef02984c1620e8404c9e72cd23f78384b38c9c4d2958f5ff7f0c2`.
B's historical pre-move collection on `84344611` is
`ef29cb498975078dcb84446e021559beb01cc903c497e4d7d6404a9da87d7e67`;
its historical source-attributed delta record is
`17d2aa7fceda89c7559e8534ed55ca5a867837ac1cd48d98902809f3852237bb`.
The historical boundary baseline is A’s actual 2,467-case collection above;
the `84344611` replacement changed no inputs of that selected collection. Compare Node boundary name
**multisets**, preserving repeated truncated display labels; the older collection
omits `projectName`, while B records `node`. Runtime-file absence and the one
added cold-case declaration are checked against the exact predecessor. A and B
therefore establish at least +211 selected cases over the public baseline;
additional dynamic root inventories keep the whole-root increase unmeasured here.
These are measured selected local evidence identities, not whole-root counts or
hosted receipts. The unchanged source/path move preserves B’s historical +39
attribution; exact `97c239ef` configured counts remain pending. Its preliminary
affected boundary/cold execution passed 2,593 cases in 33.16s. No telemetry-only
baseline install or extra run is required; current main integration and mandatory
proof still follow their actual owners. Comparable whole-root configured delta and hosted timing remain
**UNKNOWN**. PROC28.8's +100-case / +30-second target applies
after post-C6 cleanup; it is not a new pre-C6 acceptance gate or a waiver of
current checks, caps or test selection. Do not delete characterization early.

Current final package headroom and installation-specific recovery measurements
remain owed at the respective candidate. Measure existing artifact caps and
required test costs cumulatively at useful candidates. A measured crossing takes
its competent maintainer budget route; another package/agent does not create
additional budget.

Final module acceptance retains complete existing-store transfer/recovery,
upgrade and applicable recipes, including missing install/handover seams above.
Final exact-release hosting/distribution/independent-adopter acceptance retains
its owning later integration boundary; it cannot excuse an M14-owned missing
operation or default. No real-store or production action follows from local
evidence. Each delivered draft records actual checks, review findings, remaining
dependencies and a short terminal self-retro. This plan grants no additional
authority or automatic successor work.

## E2 source-only continuation, 27 October 2026

The receiving supervisor assigned the existing E2 worktree and draft #403 at
`13a3c877cba43f63b1fb2f7b2108029d3393e789`, stacked on E1
`0b4517be8000352be4659e4be2320163b1db9650`. The supervisor freshly fetched and
confirmed policy pin `a03d920eec32bfb3d0de90b9a12535cc57f88d53` in this receiving
run, separately from those source checkpoints. The latest human limit permits local source
corrections and handoff only: no tests, install/build/lint/verification gates,
independent reviews, commits, pushes or external writes. The draft remains
unfinished. Earlier findings, native history and budgets are unchanged.

Source-correction author context: `01a17e98-931e-7fe3-99cb-841a3ac9ef0b`
(`/root/m14_e2f`); coordinating author context:
`01a17e97-d95d-7581-beb5-ab5ee9ad007c`. Both are future reviewer exclusions
for this candidate, alongside the inherited author exclusions. No independent
review was performed in this continuation.

Static pre-flight recovered the four production SQL units, the unchanged E-only
manifest and all four source-derived inventory pins. The concrete omission was
the eight new E2 SQL/adapter/witness paths in the public-source catalogue. They
are now registered as `public-output`; the migration, contract and adapter owner
pages explain the actual source composition and distinguish it from readiness.
The smallest adequate repair registers existing source instead of introducing a
new runner, selector, expected digest or host provisioning layer. SQL bytes,
the 88-unit legacy selection, its inventory and the E-only 89-unit pins were
left unchanged. The known actor SQL EOF finding remains deliberately retained.

Still owed after the original author resumes authorized execution: E1 actually
on main; current API/source-contract/navigation metadata; fixed-pin checks of
the four references through production built imports; four fresh targets in the
other role mode with different actual principal names; apply/status/replay and
89 ledger rows, healthy inventory-mutation and separate unsafe-session refusal;
legacy, partial-prefix/race, installed/cold, coverage, measured cumulative
package budgets and full native proof. No aliases, custom expectation or
projector overrides may qualify these installations. No current PASS, review
receipt, native cycle, expiry or delivery completion was created here.

Self-retro: static source registration and owner explanation were sufficient for
this bounded correction; the missing production proof cannot be replaced by
another source-derived digest or by the earlier reference runs.


## Owner-authorized corrected draft checkpoint, 2026-10-27

After the source-only handoff preparation, the owner directly instructed this
receiving session to commit and push its corrections into the existing #403
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


Draft integration note: the corrected E1 checkpoint is now merged into the E2
draft branch. The manual resolution retained E1 control/author evidence, E2
source/publication notes and both boundaries in the contract owner. Conflicts
were documentation-only; no SQL, manifest or runtime behavior was rewritten.
This integration has no current tests, review, carry-over or qualification proof.

## F source-only continuation, 27 October 2026

The receiving supervisor assigned the existing F worktree and draft #404 at
`8fe11e5f7576d414860c0d759a5a3a801de9cb54`, stacked on E2
`13a3c877cba43f63b1fb2f7b2108029d3393e789`. The supervisor freshly fetched and
confirmed policy pin `a03d920eec32bfb3d0de90b9a12535cc57f88d53` in this receiving
run, separately from those source checkpoints. The latest human limit permits local source
corrections and handoff only: no tests, install/build/lint/verification gates,
independent reviews, commits, pushes or external writes. The draft remains
unfinished. Earlier failures, findings, native history and budgets are unchanged.

Source-correction author context: `01a17e98-931e-7fe3-99cb-841a3ac9ef0b`
(`/root/m14_e2f`), also the optional E1 fifth-pin/inert-fixture patch author;
coordinating author context: `01a17e97-d95d-7581-beb5-ab5ee9ad007c`.
Both are future reviewer exclusions for this candidate, alongside the inherited
author exclusions. No independent review was performed in this continuation.

Static pre-flight found that F's exact SQL is present but has no optional fifth
prior approval and no selected-manifest registration. The preserved source hash
remains `56144f8e61b649c9d9f48458a1734abcc8bbd8d36fdc3919d90ceb1bc35d3b48`.
An isolated control-only patch and inert exact fixture were applied locally by
the E1 owner for the separately landed prior-approval route; those uncommitted,
unverified changes do not constitute prior approval. No candidate-local pin was used
to authorize the existing draft SQL. The ten E2/F SQL/adapter/witness paths are
now registered in the public-source catalogue, and owner pages explain the
restricted import behavior and present refusal. SQL and existing manifest bytes
remain unchanged. This is source preparation, not a passing policy check.

F registration is deliberately deferred: after prior control approval and E2
landing, append only this exact SQL after the runtime tail and derive the two
real E+F 90-unit `withRestore` inventories. Remove E-only `runtimeOnly` selection
for that plan. Do not copy the existing 89-unit `withRestore` digests into F or
invent placeholder expectations. The current unmanifested-file refusal remains
binding. Keep E2's 88-unit legacy identities/inventory unchanged and its E-only
89-unit qualification separate.

The original author still owes actual production E2+F installation, allowed
normal-runtime operations and neighboring/refused import permissions, the
13-client-field/eight-cycle-field retained-value and replay/conflict witnesses,
origin refusal, trigger/history/frozen-term preservation, API/source-contract
and owner-impact/navigation metadata, installed/cold proof, measured cumulative
package budgets, coverage and full native proof. Historical 13 PostgreSQL cases
and nine startup refusals remain standalone evidence; no new execution or PASS,
native cycle, expiry, receipt or delivery completion was created here.

Self-retro: preserving the validator's refusal is the smallest correct behavior
while 90-unit expectations are unknown. Adding F's hash beside its SQL would
not repair the required prior-control lineage.


## Owner-authorized corrected draft checkpoint, 2026-10-27

After the source-only handoff preparation, the owner directly instructed this
receiving session to commit and push its corrections into the existing #404
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

Draft F integration note: the corrected E1/E2 checkpoints are now merged into
the F draft. The resolution retained F's public source row, the five inert
prior-control fixtures and all E1/E2/F author, authority and failure records.
Conflicts affected publication metadata and prose only. SQL, existing inventory
pins and manifest bytes remain unchanged; F's unregistered-unit refusal and the
two missing 90-unit withRestore expectations remain open. No current test,
review, carry-over, receipt or qualified-installation proof was created.

## F inventory derivation packet, 27 October 2026

The owner selected the strong machine for the two real 90-unit measurements.
All source work remains in this receiving session; the strong machine executes
the fixed command and returns evidence, with no source edits or autonomous
repair loop. This continuation starts from F checkpoint
`37c136d224479dad149e741f8cfaa2f14abd668a`; the source author remains
`01a17e98-931e-7fe3-99cb-841a3ac9ef0b`, with coordinating author
`01a17e97-d95d-7581-beb5-ab5ee9ad007c`. Preserve these and inherited reviewer
exclusions, findings and budgets. No local PostgreSQL, tests, builds, installs,
lint, verification gates, commits or pushes are authorized in this continuation.

The finite task-local derivation packet consists of ignored operative inputs
`.context/scratch/m14-f-reference/derive.ts` and `reference.json`. These are not
public executable entrypoints or archived predecessor source trees. They use
the existing disposable-container helper and an explicit 90-entry fixture.
It checks every source SQL hash, the unchanged E-only manifest bytes, all five
prior-control source pins and exact inert-fixture equality before creating a
database. It creates exactly two independent, sequential PostgreSQL 16 clusters
in installer-managed mode, with restore present: bootstrap/migrator aliased,
then a separate actual SUPERUSER migrator. Runtime and restore names differ
between references. Each reference uses one raw fixture transaction and exact
90-row ledger insertion; it provides no pending/replay/retry mechanism or
expected-inventory bypass. Static inspection found no standalone BEGIN/COMMIT/
ROLLBACK statements in the fixed SQL files. This reference construction is not
the package runner's target-installation path.

From the frozen F checkout on the strong machine, with its own locked
dependencies and Docker available, run once through the supervisor's existing
resource serialization:

```sh
node --import tsx .context/scratch/m14-f-reference/derive.ts /tmp/openlup-f90-reference-run-1
```

The supervisor fills the packet's fixed expected F head only after source
integration, then freezes the two source SHA-256 values in the handoff envelope.
The strong machine reconstructs those exact UTF-8 files without code edits.
The script refuses a different executing head or a dirty tracked tree; the
ignored operative packet is not a tracked-source change. The lockfile pins
`pg` and `tsx`; use the checkout's own locked dependencies, Node 24 and the
repository-pinned PostgreSQL 16 image through the existing container helper.
The output directory must not already exist and must be outside the checkout.
Return the process exit code, complete stdout/stderr, and the complete output
directory, including `inputs.json`, `report.json`, both raw `*.payload.json`
files and both 90-row `*.ledger.json` files. The report records executing Git
head/tree/dirty paths, input file hashes, the configured pinned image, actual
login/version/database-owner facts, raw production-projector payload hash and
size, exact ledger/hash, lock release and owned pool/container/volume cleanup.
There is no PASS or inventory expectation authored into this packet. On failure,
return the evidence to this session; do not edit code, repin SQL, retry a new
matrix or manufacture missing output on the strong machine.

The production `qualifiedPostgresCatalogPayload` is imported directly, including
its session/role/ACL checks. No alias, projector override or expected hash is
accepted. Source identities must match the supervisor's frozen packet; derived
values are usable only with complete ledger and successful cleanup evidence.
The current manifest stays unregistered for F until those real values return.
Even two successful reference derivations are not E2+F apply/status/replay,
normal-runtime, installed-consumer, refusal or full verification qualification.
The original two `withRestore` registration step and all target proof remain owed.

Self-retro: one finite raw schema fixture avoids adding a second migrator or
relaxing the production runner's required expected inventory. No measurement or
qualification result is claimed from static source preparation.


## E2 production-composition proof source, 27 October 2026

The owner's receiving-session instruction now requests all necessary source
corrections here, with measurements/tests/verification executed only on the
stronger proving machine. This work starts from E2
`1c52d71aaa76a59b751b526fa5b8c253df5d72a4`. No tests, builds, lint, installs,
gates, commits, push or external writes ran in this source-only preparation.
No native history, findings, cycles or prior expiry was changed. Additional
test-source author `01a17e98-726c-7263-871e-44c8cd68410a` (`/root/m14_cd`)
is excluded from later independent review alongside every existing author and
coordinator. This is authored proof source, not counted independent review.

The smallest complete witness is
`tests/postgres/m14QualifiedComposition.test.ts` and its one-installation child
`m14QualifiedComposition.proof.ts`. It defines exactly four installer-managed
production references and four fresh operator-provisioned targets, covering
migration/bootstrap aliased or separate and restore absent or present. Reference
names use `q2_reference_*`; target names use `q2_target_*`. The temporary setup
login renames actual bootstrap OID 10 and is dropped before admission. No name
alias, target-derived expected digest or extra four-install matrix is introduced.

Every child uses the actual production reference binding, default startup/pool
transport and public `@openlup/platform/migrations` built export. There is no
root, pool, source, projector or expectation override. A separate measured
payload observation uses the same production startup-options helper under the
actual migration login and held lock; its result must equal the unchanged prior
pin. Each profile checks pending status, apply, complete status, empty replay
and all 89 exact path/digest/position ledger rows. These are eight new production
checks; the four historical source-reference derivations remain historical.

Only the already-healthy separate-migrator/with-restore target adds the
discriminators: a column-comment mutation must reach the precise object-inventory
SHA refusal with unchanged ledger timestamps; after restoration healthy status
must recover. A separate SET-reachable parameter capability grant must reach
the unsafe-session refusal, retain the ledger and recover after revocation.
The canonical-search-path discriminator adds exact public `left(name,int4)` and
`hashtextextended(text,int4)` overloads: observations and pre-hook lock handling
must invoke neither, then reach the precise inventory refusal for the added
definitions. After cleanup, healthy status must recover. An application-first
role-default search_path with writing shadow functions must separately refuse
as `qualified_profile_requires_canonical_search_path` with zero shadow calls;
resetting the default and removing that schema must recover healthy status and
empty replay. These are prepared regressions for the supervisor's coordinated
facts/catalog/qualified-executor symbol binding, not evidence those changes pass.

The existing disposable PostgreSQL helper owns each container and removes it
in a finally block, including child failure/timeout. Every runner operation is
awaited. Explicit observer/setup pools close before child exit; child lifetime
then releases the production runner's hidden default pools without adding a
production close API. The two source paths are registered in the existing public
catalogue. The supervisor places the child's exact execution-entrypoint
registration in prior E1 controls, preserving the prohibition on co-changing
admission machinery with E2's new qualified SQL; E2 changes no classifier or
entrypoint machinery. Frozen SQL, fixture bytes, manifest and four pins remain
unchanged. The known frozen actor-SQL EOF issue is retained.

Proving-machine commands from the E2 checkout, after its normal pinned
Node/npm/dependency setup (not executed here):

```sh
npm test -- --project=node tests/postgres/m14QualifiedComposition.test.ts
npm test -- --project=node tests/postgres/m14QualifiedBaseline.test.ts tests/postgres/m14QualifiedSession.test.ts tests/postgres/m14MigrationSessionAdmission.test.ts server/adapters/postgres/qualifiedInstall.test.ts
```

The first command includes the existing prerequisite builds and eight sequential
owned installations; logs distinguish each reference/target, actual measured
inventory, exact ledger count and elapsed time. Missing Docker is a failure,
not a skip. The second is the existing focused regression selection. These do
not replace required policy/navigation, coverage, cold/installed/legacy/full
checks, measurements, committed native review and authorized delivery. If
execution exposes a source defect, return its exact failure to this authoring
session rather than changing SQL, pins or expectations on the proving machine.

Self-retro: a process-lifetime child exercises the real hidden-pool composition
without a test seam or new production API. Sharing the four prior pins between
two explicit modes yields the required eight checks, while applying destructive
discriminators to one restored healthy target avoids redundant installations.


### Receiving coordinator source-freeze addendum

Root completed the qualified session-facts bindings and the effective-path
refusal before deparser use. Author 01a17e98-8264-7033-a2d1-0d3c8479ca3b also
bound lookup symbols in the shared static selected-catalog query and its three
fragments; query identities, serializers, expected hashes and SQL assets remain
unchanged. This author remains excluded from subsequent independent E2 review.
The owner explanation links the prepared eight-case production witness.

The concrete reachable cause was path resolution of unqualified catalog names,
including exact public overloads despite an implicitly first pg_catalog. Merely
checking canonical path would not close that mechanism. Reusing the fixed query
with qualified symbols preserves the expected canonical payload without a new
projector variant, parser, session SET or replacement inventory. Canonical
legacy output and frozen E-only hashes still need actual proving-machine
execution. The effective-path check is for stable catalog rendering; it does
not claim isolation from PostgreSQL native deparser/type-output implementations.

All source edits remain here under the owner's latest instruction. The
stronger-machine session may only run the prepared measurement/test/verify
commands and return results; it must not implement further repairs. No local
execution, PASS, native cycle or budget change occurred in this source phase.


### Receiving coordinator source-freeze addendum

The receiving coordinator also registered the exact future E2 child entrypoint
in the existing closed execution inventory and documented it in CONTRIBUTING.
The entry registration is control-only here, before E2 source introduction; it
changes no classifier or exception. All further source repairs remain on this
Daybreak-capable machine. The stronger machine may only execute the supplied
measurements/tests/verify and return evidence; defects return here for repair.


Statement-pin accounting: the fixed SQL query text intentionally changed from
`8c9494f87d3147ec25bf0d6461ed214061e410b2594186cb4b90baea60dca54c` to
`e897c3028f5b097baea6e16f79e75ad33ffcf8174d751ed3a95486b803bc5e50` for catalog qualification. The existing prepared-statement
unit pin is updated to those exact constructed statement bytes. Static fragment
extraction first reproduced the old pin; this is source-data integrity, not
SQL execution. PROJECTION_PAYLOAD, PROJECTION_DIGEST, query names and every
legacy/E-only manifest inventory expectation remain unchanged. Actual canonical
PostgreSQL byte equivalence still requires the proving-machine run.

## Receiving E2 compile proof, 27 October 2026

The active receiving supervisor reports the later direct owner instruction
restoring required test/full verification and the existing ready, receipt,
admission, queue and confirmed-merge endpoint for these M14 drafts. Earlier
machine-specific source-only and draft-only limits remain historical; no
release, npm publication, deployment, live provisioning, account, settings,
credential or other-repository authority is added. Heavy execution remains
serialized by the supervisor. The current E2/F integration coordinator
`/root/m14_e2_f_integration` is a source author and excluded from independent
review alongside all inherited authors and coordinators. E2 has no native
session, counted PASS, expiry or used repair cycle. Actual E1 landing still
precedes E2 delivery; local proof does not replace that boundary.

This continuation uses the existing E2 worktree at
`813b6967b40eca48880a34eabfbf4b3b529b97bd` and real stack predecessor
`f8c88bb4009b7841478e87ce08a1815144c410ac`. Its current instruction pin is
`a03d920eec32bfb3d0de90b9a12535cc57f88d53`, separate from the code comparison.
The first fail-fast broker refusal occurred before execution. The supported
normal waiting route then admitted after 195 seconds, with existing defaults;
core, outbox and platform prerequisite builds passed. Canonical
`npm run oss:published-tree -- --typecheck` failed with three consumer errors
and zero unresolved imports. The actual canonical API project located the
predicted `qualifiedInstall.ts` errors at lines 147 and 232.

The authorized repair changes only the private throwing `fail` helper from an
inferred arrow constant to a function declaration. Its body, error strings,
unknown-value validation and runtime refusals remain identical. The full
canonical rerun passed all five projects with zero unresolved imports and zero
consumer errors. Both original failure logs and passing rerun are retained in
the existing task evidence. SQL, role permissions, queries, manifests and fixed
inventories were not changed. Source AST and diff checks passed.

The heavy slot was released before any production PostgreSQL installation,
following the supervisor's C+D full-verification priority. The eight 89-unit
production checks, required legacy/partial-prefix/race and adapter regressions,
installed/cold/API/artifact/coverage proof, lint and full/native verification
remain pending. No test deadline, retry or gate budget is raised. Documentation
impact is checked against the actual E1 predecessor; a helper-only digest cannot
settle the complete new adapter, qualified SQL and fixture-selection delta.

Self-retro: prerequisite builds removed stale declaration noise before the
canonical failure was diagnosed. One helper declaration restored compiler flow
analysis without casts or weaker validation. The 195-second broker wait was
scheduling evidence, not a test failure.

### Receiving E2 production PostgreSQL result

After the supervisor's next explicit allocation, the existing eight production
composition checks passed: four fixed-pin reference profiles and four fresh
renamed-principal targets in the other role mode. The 89-unit source, manifest
and built migration entry identities remained exact before and after execution;
no alias, projector or expected-inventory override was used. The tests assert
status/apply/replay and all exact ledger rows; the healthy final target also
passed the prepared inventory, unsafe-session and shadow-symbol discriminators
and recovery checks. Vitest reported 8/8 passing in 82.61 seconds.

The selected baseline/session/actual-lock admission, reference adapter and
package migration/legacy-prefix/projector regressions then passed 78/78 across
seven files in 4.09 seconds. The whole admitted phase took 88 seconds and exited
zero. Its first sandbox Docker-socket refusal happened before Vitest; that log
was preserved, and normal tool permission review admitted the same authorized
command. No source repair or expectation change followed that tool refusal.
The test-owned container inventory was empty afterwards, and the broker slot
was released before the supervisor's next C+D work. Full installed/cold/API,
artifact/coverage, lint, full/native review and actual predecessor landing still
remain separate obligations; this phase grants no delivery or hosting claim.

Self-retro: the already-built production entry was reused with its recorded
identity, avoiding a redundant pretest build. Tool-sandbox refusal, actual test
execution and source qualification remain separately attributed in the evidence.

### Receiving E2 dependency integration

The active root supervisor continues the same finite E2 outcome under the later
direct test, DCO, submission and merge grant. Its instruction revision is now
`75d08b8207053fe9a5207e003b625133685ffdf4`, separate from the code base. The
exact E1 dependency `3a8d4a7165f5ef3df13bdc8da9d6a3e3ca17a529` incorporates
the reviewed lifecycle predecessor and its already approved Platform reserve.
E2 changes no byte cap, file count, browser budget, baseline or lockfile. This
is dependency integration, with actual E1 landing still required before E2
delivery; it is not a freshness merge.

Before integration the supervisor preserved the five existing E2 edits, their
exact bytes and patch, and retained the explicitly named own stash. The ordinary
merge was conflict-free; restoring those edits required one contributor-doc
resolution retaining both the lifecycle and qualified-installation witnesses.
All migration SQL, the selected manifest, the approval registry and the private
throwing-helper repair remain byte-identical to their recorded pre-integration
identities. Historical failures and earlier production PostgreSQL results are
preserved; they are not claimed as full proof of this integrated tree.

The pending merge has no mechanical exemption or native PASS. Its precommit
checks use the actual current ancestor; the E1 stack pin applies only once a
normal signed checkpoint makes it an ancestor of HEAD. Fresh cumulative build,
API, artifact, owner, lint and type checks precede DCO; two fresh independent
full reviews and the canonical clean full gate still follow. Root and all
source authors remain excluded from independent review. The standing direct
human authorization covers two-way M14 session communication without another
permission question. Release and live operations remain outside this endpoint.

Self-retro: preserving the owned patch before dependency integration made the
single documentation overlap explicit while keeping the qualified SQL and
fixed inventories intact. No source abstraction or extra installation matrix
was needed for the integration.

### Receiving E2 pending-merge working checks

The author/coordinator `/root/m14_e2_delivery` recovered the same pending
ordinary merge, with HEAD `813b6967b40eca48880a34eabfbf4b3b529b97bd`, E1
parent `3a8d4a7165f5ef3df13bdc8da9d6a3e3ca17a529` and pre-evidence staged
tree `ba2e2d4eaf5faf8a04aa150900b01f0c0777df95`. This actor is a source
contributor and is excluded from independent review. Current instruction
revision `35ee4227babaa2fe16f88110af52e61d242b3296` is separate from that
code comparison. All 94 preserved SQL, manifest and approval-registry hashes
matched; the private throwing-helper repair and owned stash remained exact.
No patch was replayed, history replaced, cap raised or installation matrix added.

Under the supervisor's bounded allocation, explicit Node 24.21.0/npm 11.19.0
ran fresh Core, Outbox and Platform builds and API checks. Actual working-tree
tarballs passed the existing artifact-content, class/total size and all 17 browser
entry gates. Platform measured code-gzip 1,661,068 B, tarball 1,933,640 B and
unpacked 9,001,011 B; code/total counts were 2574/2628 against the unchanged
caps. This 11-second phase used the fixed build 4 CPU/4096 MB profile. These
exported-gate measurements are preliminary working-tree feedback; the canonical
clean cold/installed package route still follows the committed candidate.

Canonical `npm run lint` and `npm run oss:published-tree -- --typecheck`
passed sequentially in 61 seconds under typecheck 4 CPU/6144 MB. All five
projects had zero unresolved imports and zero consumer errors. The same seven
baseline/session/lock-admission/reference-adapter/package-runner regression files
passed 78/78 in 2.15 seconds under PostgreSQL 2 CPU/6144 MB. Each lease admitted
without waiting and was released. An initial broker argument-order refusal
happened before execution and is preserved alongside the corrected invocation;
it changed no test, deadline or review budget. Tracked inputs stayed frozen
during these phases. The earlier eight production installations remain attributed
to their original inputs; they were not repeated or claimed as integrated proof.

The current checkpoint still needs the supervisor's stabilized API/notes/control,
budget and recovery read before DCO. The exact final runtime predecessor must
then be integrated normally before the first counted E2 review and full route.
No E2 native session, counted PASS, expiry, repair cycle, signed checkpoint or
external write was created by these working checks. Existing source/control
acceptance, all mandatory clean/full checks and the root-owned delivery endpoint
remain unchanged.

Self-retro: selecting the recorded toolchain explicitly avoided shell-version
drift. Reusing the existing artifact gate functions supplied concrete precommit
measurements while preserving the canonical clean-tree gate for final proof.

### E2 runtime dependency integration

After the root supervisor read the stabilized packet and independently compared
all 94 preserved SQL/manifest/registry inputs and the private helper, its direct
GO authorized the ordinary DCO merge checkpoint
`377fcd9af50f70d93534942c5afdcc439ad08d31`, exact tree
`826b322cf05f60bf2ba55ba5a366cfc117682144`, with parents 813b6967 and
3a8d4a71. Policy/navigation against the now-valid exact E1 ancestor reported six
obligations and zero unanswered; all eight commits in that DCO range were signed
off, including four merges, and the checkpoint was clean.

The same bounded authorization then prepared a normal pending merge of exact
runtime predecessor `4687b6c8d11a1fbc0094b26057d0983111560d16`, tree
`ddc243119df5bb7578ec1a3c5ce9d9eae61cd25e`. Shared contributor and catalogue
edits merged automatically; there were no conflicts or manual resolutions.
Both owner descriptions, execution registrations and publication metadata remain.
All three runtime production files and both API reports match that predecessor
exactly; all 94 E2 immutable inputs and the helper repair remain unchanged.
This dependency order is C, E1, runtime, E2, then F. It changes no contract,
installation profile, SQL, expected inventory, package budget or proof obligation.

Instruction revision 35ee4227 remains separate from the review base. Light
pending-merge checks use actual E1 ancestor
`3a8d4a7165f5ef3df13bdc8da9d6a3e3ca17a529`; the runtime stack pin becomes
valid only after a separately authorized next DCO checkpoint. Earlier working
measurements and production-installation results retain their original source
attribution. This integrated tree still requires its cumulative working phase,
root technical read, first two fresh independent E2 full reviews and canonical
clean full verification. No mechanical exemption, native session, PASS, expiry
or repair cycle was created. Root owns further DCO and external-delivery GO;
release and live operations remain excluded. Existing author exclusions apply.

Self-retro: checking exact predecessor bytes before integration made preservation
directly observable. The normal merge retained the overlapping explanations
without a source repair or additional installation matrix.

### Cumulative E2 and runtime working proof

The root supervisor's next exclusive allocation covered pending tree
`896d4fc2c13ea58c083cc04f033bf94a8dac7559`, with signed E2 checkpoint
377fcd9 and runtime 4687b6c8 still pending as the two normal merge parents.
Explicit Node 24.21.0/npm 11.19.0 and this task's own dependencies ran the same
bounded sequence with frozen tracked inputs. Fixed numeric-worktree resource
profiles admitted without waiting: build 4 CPU/4096 MB, typecheck 4 CPU/6144 MB,
then PostgreSQL 2 CPU/6144 MB. Every lease was released; no nested broker,
new deadline, retry or source repair was introduced.

Fresh Core, Outbox and Platform builds and all three API checks passed. Actual
working tarballs passed the existing artifact-content, class/total budgets and
all 17 browser-entry gates with zero findings. Platform measured code-gzip
1,662,140 B, tarball 1,935,102 B, unpacked 9,006,345 B and docs-gzip 65,643 B;
code/total counts remained 2574/2628. Core/Outbox tarballs were 167,341/39,165 B.
All approved caps, baseline, manifest and lockfiles remained unchanged. This
build/API/artifact phase took 10 seconds and remains preliminary working-tree
feedback rather than canonical clean cold/installed proof.

Canonical lint passed with zero errors and 33 existing warnings. The five-project
published typecheck passed with zero unresolved imports and zero consumer errors;
the sequential typecheck phase took 53 seconds. The same seven existing
baseline/session/lock-admission/reference-adapter/package-runner files passed
78/78 in 2.47 seconds. No eight-installation matrix was repeated; its prior
production results keep their original attribution. Exact commands, elapsed
times, tarball identities and measurements are retained in
`/private/tmp/m14-e2-runtime-working-20261027`. The task-note update is the only
post-execution tracked edit.

The root's stabilized API/notes/control/budget/recovery read and explicit GO
still precede the next DCO. First E2 counted review and the canonical clean full
route remain unperformed; no native evidence or mechanical exemption is claimed.
All protected SQL/manifest/registry/helper and runtime source/API bytes retain
their checked identities. Existing authors, failures, exclusions, authority and
review budgets continue unchanged.

Self-retro: direct reuse of the same exported artifact gates and fixed resource
profiles completed the cumulative phase without new code, retries or a larger
installation matrix. Keeping the clean committed route separate preserves its
proof obligation while supplying concrete current measurements before sign-off.

## Receiving E2/F integration, 27 October 2026

The active receiving supervisor reports the later direct owner instruction
restoring required tests/full verification and the existing ready, receipt,
admission, queue and confirmed-merge endpoint for these M14 drafts. This
supersedes the preceding machine-specific source-only and draft-only limits;
it adds no release, npm publication, deployment, live provisioning, account,
settings, credential or other-repository authority. The supervisor still
serializes heavy execution and external delivery. This source continuation
changes only F in `/private/tmp/openlup-m14-retained-import`, starting at
`ece054faf317ebfaf679cb5778a0cff41fd70203`; E2 remains
`813b6967b40eca48880a34eabfbf4b3b529b97bd`. The current instruction pin remains
`a03d920eec32bfb3d0de90b9a12535cc57f88d53`, separate from those review inputs.
All earlier authors, findings, failed attempts and exclusions remain. The active
E2/F integration coordinator is a source author and cannot independently review
this candidate. E2/F still have no native session, counted PASS, expiry or used
repair cycle. E1 must actually land before E2 delivery, and E2 before F.

The fixed F measurement ran once from the exact frozen F head; its
[complete reference-only report](https://github.com/openlup/openlup/pull/404#issuecomment-6451079203)
records two exact 90-row ledgers and owned cleanup. F now appends only the
unchanged SQL `56144f8e61b649c9d9f48458a1734abcc8bbd8d36fdc3919d90ceb1bc35d3b48`
after runtime sealing. It selects `withRestore` only:
`f10dd81aadf543e9b14b5fca30e377c6d0d8689dde379837ad0c145795c09d8f`
for bootstrap/migrator aliasing and
`d68dd042c487c30b9082cd70103c63de81e2f6ee1754ff52e5961144f172d4b1`
for a separate migrator. The legacy 88 rows and `cfe3a8b4...` inventory, five
prior control pins and inert fixtures remain byte-identical. No selector,
projector, admission machinery, alias or expected-inventory override changes.

The existing registered composition child now prepares two 90-unit production
reference checks and two fresh operator-provisioned targets with changed actual
M/R/S names. It proves healthy status/apply/replay and exact ledger before
mutation/refusal discriminators. Actual R performs client writes and cycle
admission/receipt consumption; actual S exercises the retained 13/8 scalar
fields, microseconds and large integers, replay/conflict, history/frozen-term
preservation and origin/privilege refusals. E2 keeps its separate eight 89-unit
checks on its own branch. The frozen two-reference derivation is not repeated
or reclassified as target qualification.

The source manifest check, seven existing manifest-contract tests, structural
suppression scan and Node syntax check passed locally. The exact F predecessor
policy comparison has three obligations and zero unanswered owner impacts.
Focused TypeScript compilation could not establish a pass:
without prerequisite builds, the installed platform declarations lack the
inherited `assertSession` field, and existing `qualifiedInstall.ts` checks also
report type errors. No build, PostgreSQL execution, coverage, lint prebuild,
full verification, counted review, commit or external write ran in this source
continuation. Required production/domain, installed/cold/legacy proof, package
API/artifact/coverage and cumulative budgets, exact owner readings and final
native proof remain owed. No gate deadline, retry or artifact budget is raised;
existing 240-second child deadlines cover four installations rather than eight.

Self-retro: reusing the already registered child and existing manifest selector
closes the integration gap without a new runner or control exception. Owner
impact must update the exact mapped sections; prose in a neighboring section
alone did not satisfy the scoped policy check.

The preliminary F working proof on 27 October used its own locked install
(25.119 seconds) and three-package build (7.123 seconds). All four production
installations reached their exact 90-row ledger, status/apply/replay and frozen
inventory comparisons, then failed with `42501` when the proof used restricted
R to set the delivery-alignment mode. The setter is administrative: canonical
SQL revokes public execution, and the qualified runtime grants omit it. All
four owned containers and associated anonymous data volumes were destroyed.
Original inputs, failure logs and cleanup evidence remain under ignored
`working-pg-preflight`; no SQL, ACL, manifest or inventory expectation changed.

The bounded repair asserts that real R is denied once, then uses the existing
admin fixture pool for the four mode settings, as the standalone F witness
already does. R normal writes/admission/receipt consumption and S retained
imports/refusals continue through their actual restricted logins; every retained
field, history and frozen-state assertion remains. Repair author context
`01a17f3c-ccdd-7212-b5bb-985e4bdf3b3d` (`CODEX_THREAD_ID`) is excluded from later
independent review with all inherited authors. A separate ignored repair-input
freeze preserves the original failed candidate and permits exactly one rerun
of the existing four cases, without repeating install/build or the frozen
reference derivation. No new PASS, native session, expiry or cycle reset is
claimed here; the remaining PostgreSQL assertions and full F proof remain owed.

Self-retro: the preliminary run caught a fixture actor mismatch after exact
SQL/pin installation succeeded. Existing administrative setup is the smallest
repair and preserves the runtime capability boundary.

### F pending E2/runtime dependency integration

The root supervisor assigned the existing F author/integration coordinator
`/root/m14_f_delivery`, context `01a17f5d-3299-74f2-aa76-70cbf0b669cf`,
to the same finite #404 outcome. This actor is a source author and excluded from
independent review alongside all inherited authors, including the retained-proof
repair author `01a17f3c-ccdd-7212-b5bb-985e4bdf3b3d`. The standing direct human
authorization in root context `01a17909-94d4-7cc0-b40f-9a8782a0986f` permits
two-way M14 communication. The actual dependency order is C #401, E1 #402,
runtime #405, E2 #403, then F #404. E2 must actually land before F delivery.
Policy revision `35ee4227babaa2fe16f88110af52e61d242b3296` remains separate
from code inputs. Release, live operations, settings, accounts, credentials and
other repositories remain excluded; root retains external delivery coordination.

Before any buffering or integration, exact external backups, SHA-256 identities
and a binary patch preserved all seven owned WIP files. Only the explicitly
named own stash `bea76499a1a6b125bb1e530158efddda7239c522` was applied and
retained. A normal `--no-commit --no-ff` merge now joins F HEAD
`ece054faf317ebfaf679cb5778a0cff41fd70203` to exact signed E2 predecessor
`2da59893f439ff5ff23bdbd0adc8d4f091feb614`, tree
`5bd7f14a1dc23ded73182f2124072609987990ec`. The dependency merge was
conflict-free; restoring F's WIP required two documentation resolutions retaining
both E2/runtime evidence and F's compatibility/retained-import explanation.
All upstream E2/runtime source, API, registry, SQL, inert fixtures and publication
registrations remain, including the body-preserving private throwing-helper fix.
This is an ordinary manual integration with no mechanical exemption.

The exact F manifest and both composition proof/test files match the preserved
WIP: only the two restore-bound 90-unit inventories are selected, with the same
13-client/eight-cycle proof, restricted-R setter refusal and admin fixture setup.
The immutable F SQL hash remains
`56144f8e61b649c9d9f48458a1734abcc8bbd8d36fdc3919d90ceb1bc35d3b48`;
the issued legacy 88-unit plan, inventory and all five inert approval fixtures
remain unchanged. The frozen derivation at `/tmp/openlup-f90-reference-run-1`
is preserved and has not been repeated.

The earlier bounded repair rerun actually passed all four preliminary production
PostgreSQL cases in 54.467 seconds, retaining the exact ledger, replay, scalar
precision, history/frozen-state, privilege/origin and shadow checks. Its report
records aggregate input identity
`e7f9c9c82a64ab7863235727a9b8b5bec1dca575e6452dc2f2d3a15e15fab477`.
All four owned containers and four volumes were destroyed. Both the original
four `42501` failures and this later pass remain attributed to their own inputs;
neither is final qualification of the pending E2/runtime integration.

This allocation is light only. Explicit Node 24.21.0/npm 11.19.0 ran the AST
suppression scan and source inventory successfully. Navigation/policy against
actual current ancestor `813b6967b40eca48880a34eabfbf4b3b529b97bd` reports
11 obligations and one unanswered adapter-owner impact from the inherited private
helper change. That comparison already contains E2's adapter-owner source
introduction but still includes the later helper declaration repair. The
failure is retained; no owner obligation is changed to manufacture a pass.
The future E2 stack pin applies only after a separately authorized signed merge
checkpoint. Cumulative working checks, the stabilized root read, DCO, two fresh
independent full reviews and canonical clean full verification remain required.
No heavy command, install, build, test, native session, counted PASS, expiry,
repair-cycle reset, commit, push or external write ran in this light allocation.

Self-retro: exact backups exposed two documentation-only restore conflicts while
preserving the successful proof bytes. Checking policy against an actual ancestor
made the inherited trailer limitation visible without weakening ownership rules.

The root's bounded light follow-up verified
`f8c88bb4009b7841478e87ce08a1815144c410ac` as an actual ancestor of the
unchanged F HEAD. Policy/navigation against that full-source boundary passes
11 obligations with zero unanswered: it includes the complete E2 adapter
introduction together with the existing substantive `server/adapters/README.md`
owner update, while E1 controls and pins already exist at that base. The earlier
813b6967 comparison and its 11/1 diagnostic remain preserved; no no-impact
trailer, owner exemption, SQL or fixture change was invented. The proper exact
E2 stack pin still applies only after a separately authorized DCO checkpoint.

Root reports a bounded E2 proof gap in the three already-approved runtime lock
privilege exceptions, with no SQL defect, and is preparing minimal evidence in
the existing 89-profile child. Therefore 2da59893 is the integrated checkpoint,
not a claim that the predecessor is final. Its eventual signed E2 repair must
be integrated normally before first F counted review and full verification.
The F SQL, two 90-unit expectations and restricted-R/admin fixture repair remain
protected; this follow-up ran no heavy command, commit or native review.

Self-retro: comparing the whole inherited adapter introduction with its actual
owner update settled the light ownership check without a synthetic trailer or
an unrelated documentation edit.

### F cumulative current working proof

The root's exclusive bounded allocation executed pending tree
`96bd7b68b7ac85261234a447898db249703ae070`, with HEAD ece054fa and exact
E2 checkpoint 2da59893 still the two ordinary merge parents. Own locked
dependencies and explicit Node 24.21.0/npm 11.19.0 ran canonical lint, including
fresh Core/Outbox/Platform builds, then all five published typecheck projects.
That phase passed in 51.800 seconds: zero lint errors, 33 existing warnings,
zero unresolved imports and zero consumer errors. The 6,521 tracked inputs
stayed frozen at aggregate
`41671e7b5c0f1393a03906150350724d91f7406e13ba525f28713af15443b452`.

All three API checks and real cumulative tarball artifact/content, class/total
budgets and all 17 browser-entry gates passed in 5.538 seconds with zero
findings. Platform measured code-gzip 1,662,140 B, tarball 1,935,102 B,
unpacked 9,006,345 B and docs-gzip 65,643 B; code/total counts were 2574/2628.
Core/Outbox tarballs were 167,341/39,165 B. The Platform artifact SHA-256 is
`9662d1eb21bf47af47547a3cfb50023ce86a7f29a04bd82897521905fd9e2f08`.
Approved caps, package/lock manifests, APIs and runtime source remain unchanged.
These exported artifact-gate results are current working feedback, not the
canonical clean cold/installed route or a release authorization.

The existing four E2+F production composition checks then passed 4/4 in 39.72
seconds (40.937-second broker phase). Both real 90-unit restore-bound reference
profiles and the two renamed-principal operator-provisioned targets retain
exact inventory, ledger, status/apply/replay and actual R/S behavior. Existing
13/8-field, precision, history/frozen-state, conflict/origin/privilege, unsafe
session and shadow discriminators all remain. No extra installation matrix,
standalone substitute, alias/expectation override or frozen derivation repeated.
All four created owned containers were destroyed; none remained afterwards.
The inherited tmpfs helper prevents anonymous PostgreSQL data-volume allocation.
Raw commands, logs, artifacts, input freeze and Docker events remain at
`/private/tmp/m14-f-current-working-20261027`.

All three normal numeric-worktree leases admitted without waiting and were
released: typecheck 4 CPU/6144 MB, tooling 2 CPU/2048 MB, PostgreSQL 2 CPU/6144 MB.
Frozen-input validation passed after every phase. The F SQL remains 56144f8e;
manifest `b8073ba16df4b81a1514171ca00fc91c99edb45e6b6f341a253cc880d753e0ed`,
composition proof
`62cf857cd4e797ffa394a23ff2ebd2d7f8444aa64e79e592e5cf62fbe59d2eef`
and test `009938a8b81240cfc3831e4e3195460c46d4a93f01e77aaa5643e0497def70a6`
retain their protected bytes, two 90-unit expectations and R-refusal/admin-setup
repair. Registry, five inert fixtures, immutable SQL, legacy 88/cfe3 inventory,
upstream helper and runtime/API bytes remain exact to the preserved inputs.

The task-note update is the only post-execution source edit. Root's stabilized
API/notes/control/budget/recovery read and separate GO still precede DCO. The
forthcoming signed E2 runtime-lock proof repair must then be integrated by a
normal merge before first F counted review and full verification. This current
2da checkpoint is not claimed final. Existing historical failures, author
exclusions and authority boundaries remain; no native session, counted PASS,
expiry, repair-cycle reset, commit, push or external write was created here.

Self-retro: three existing bounded phases completed in 98.275 broker seconds
with zero queue waits or retries. Reusing the registered production child and
existing exported artifact gates preserved the required proof without adding a
new installation matrix or production mechanism.

### E2 restricted-runtime lock evidence repair

The root supervisor recorded the first native E2 candidate 2da59893/tree5bd7f14a
with one full PASS and one independent full FAIL. The sole material card
`E2R0-R-1` identifies the approved three lock-exception proof gap, not a
demonstrated unsafe grant. Native cycle 0/3 and the same history remain intact;
no new candidate has been prepared or budget reset. The root authorized this
bounded source repair after reading the concrete proposal and production ports.

The existing production child now unconditionally connects as each installation's
actual R login, checks current/session identity, no superuser/BYPASSRLS and no
direct or inherited table ownership. It uses the production notification port's
FOR SHARE admission, the diagnostic v2 ingest and replay FOR UPDATE branch, and
the privacy receipt/account-link SHARE ROW EXCLUSIVE and SHARE paths. Existing
rows discriminate permitted timestamp-only notification writes from denied
authority changes, denied diagnostic id updates, and receipt SELECT/INSERT from
denied populated-row updates; each refused write preserves the row. Autocommit
denials leave later transactions usable. Every new adapter/pool is closed by
the existing child cleanup, and the parent asserts the returned completed-proof
flag alongside its unchanged 89-unit and frozen inventory expectations.

This uses the same eight installations, no new runner or cross product. SQL,
ACLs, manifest/registry, expected inventories, helper, runtime source/API, caps
and deadlines remain unchanged. These are source changes pending execution;
earlier production results retain their original attribution. The authorized
working phase is canonical lint/typecheck, current API/actual artifact feedback,
the existing eight production cases once and the same 78 selected regressions.
An actual failure stops execution for diagnosis before any further repair/retry.
Root/source-author exclusions continue; DCO, native preparation, full verification
and external writes still require the supervisor's stabilized read and GO.

Self-retro: the missing acceptance class required real restricted-role operations,
not broader catalogue enumeration. Reusing existing ports inside the existing
child distinguishes lock usability and forbidden writes without a permission
framework, another installation matrix or a changed capability grant.

The mandatory supervisor regroup records two completed evaluations: the initial
candidate's material lock-proof gap `E2R0-R-1`, then the new witness's canonical
typecheck failure `TS2305` from importing `ErasureReceipt` through the wrong
barrel. Lint and its three package builds passed; PostgreSQL and later phases
did not run. The remaining approved gap is actual R lock usability and forbidden
write refusal. Its cause is test composition, not a requested capability change:
the type already belongs to public `@openlup/platform/identity/contracts` and its
API report. The simpler correction uses that existing entry, retaining the typed
receipt without a new export, cast or alternate proof framework. The next
discriminating step is zero consumer errors across all five canonical projects,
then the same eight actual targets. Root accepts this bounded continuation;
native history remains cycle 0/3 without a new prepare, budget or owner gate.
The failed log and before/after source hashes remain in the existing evidence.
Lesson: public contract type owner → correct existing entry, not a new export
or cast.

The authorized import-only continuation kept the receipt explicitly typed and
used that existing contract entry. Fresh canonical lint, including its three
package builds, passed with zero errors and 33 existing warnings. All five
published projects then passed with zero unresolved imports and zero consumer
errors; the typecheck phase took 54 seconds. All three API reports and actual
working tarball/content/byte/file checks passed, including all 17 browser budgets,
in six seconds without repeating the builds. Platform remained at code-gzip
1,662,140 B, tarball 1,935,102 B, unpacked 9,006,345 B and 2574/2628 code/total
files, against unchanged approved caps.

The same eight production installations passed in 59.22 seconds, including the
new unconditional actual-R identity/nonownership, successful production locks,
timestamp-only write, diagnostic replay, receipt INSERT/SELECT and populated-row
forbidden-update assertions. Each parent case required the child's completed
runtime-proof flag alongside its unchanged 89 ledger rows and fixed inventory.
The same seven-file selection then passed 78/78 in 2.10 seconds. Owned-container
inventory was empty after teardown, and all sequential fixed-profile leases
were released. Tracked inputs remained frozen throughout execution. Evidence,
including the unmodified first TS2305 failure and actual before/after hashes,
is retained under `/private/tmp/m14-e2-r1-runtime-lock-proof-20261027`; its
`import-repair-1` directory holds this authorized continuation's results.

All 94 protected SQL/manifest/registry inputs, the helper and runtime source/API
retain their earlier identities; no ACL, expected hash, installation matrix,
deadline or cap changed. This post-execution task summary is the only later
tracked edit. These are working results; `E2R0-R-1` still needs explicit closure
by fresh native reviewers of the eventual committed repair. Native history and
its cycle 0/3 remain unchanged until the supervisor prepares that candidate;
no DCO, prepare, full verification or external write occurred here.

### F runtime-lock proof dependency integration

After the root read the stabilized working packet and independently verified
its exact tree, F made ordinary DCO sign-off merge checkpoint
`7ed23e2ef730d7d2a452254e67700422fff11069`, tree
`6bb1444950d48c77e40457b206ae1ecb21a68591`, with parents ece054fa and
2da59893. The proper exact 2da stack pin then passed policy with three
obligations and zero unanswered; all eight commits in the sign-off range,
including five merges, passed DCO and the checkout was clean. An unnecessary
explicit GPG attempt failed before creating a commit because gpg was absent;
the actual ordinary sign-off route matches the predecessors. A short-SHA DCO
invocation refused before checking and the full-SHA invocation passed. Both
observations are retained; no source or review budget changed.

Root then authorized the normal pending merge of exact E2 repair
`9d26edb21b49ef04629d03a448c98135d92167e5`, tree
`54c4d964ef6341769138dfed6e5b05786be042ba`. Three actual overlaps in the
composition child, parent witness and shared task record were resolved by
retaining both complete helper bodies and both evidence histories. The F
retained helper is byte-identical to 7ed23e2; the runtime-lock helper is
byte-identical to 9d26edb. Both calls are awaited once, and both retainedRuntime
and runtimeLockPrivilegesProved flags are asserted by the parent. Port-close
cleanup is inherited. The contributor owner now describes F's current two
90-unit restore shapes and two renamed targets, retaining the E2 eight-case
89-unit predecessor attribution and new runtime privilege proof description.

All 6,511 other upstream paths remain exact. F's manifest, SQL, five inert pins,
legacy 88/cfe3 inventory, two frozen 90-unit restore expectations, four-case
matrix, R setter refusal/admin fixture setup and runtime/helper/API/budget bytes
remain protected. This is normal manual dependency integration, with no
mechanical exemption, patch replay, extra installation matrix or derivation.
The next root-exclusive allocation covers cumulative working checks of this
combined proof before the root's separate second-DCO read. No second commit,
native review, full verification or external write is authorized by these light
checks. Existing authors, findings, failures and expiry/cycle history remain.

Self-retro: combining the complete existing helpers and their actual parent
flags preserves both proof obligations without another runner or fixture matrix.

### F combined retained/runtime-lock working result

The root-exclusive final working allocation tested pending tree
`26dfd8273e6f6e13eca172ab38b9ffe27bc2e53a`, with ordinary parents F
7ed23e2 and exact E2 repair 9d26edb. All 6,521 tracked inputs remained frozen
at `454393e05e20d540a67ce69b99fc47229ae79184be19ecdbdfd4395b4a00a940`
after each phase. Explicit own Node 24.21.0/npm 11.19.0 and dependencies ran
canonical lint with three fresh package builds and the five-project published
typecheck: PASS in 49.896 seconds, zero errors/33 existing warnings and zero
unresolved imports/consumer errors. Three API checks and actual cumulative
artifact/content/class/total plus all 17 browser-entry gates passed in 4.985
seconds with zero findings. Package measurements and exact artifact hashes are
unchanged from the preceding working packet, including Platform code-gzip
1,662,140 B, tarball 1,935,102 B, unpacked 9,006,345 B and code/total counts
2574/2628; no cap, manifest, lockfile or API report changed.

The same four 90-unit production composition cases passed 4/4 in 43.41 seconds
(44.662-second broker phase), now awaiting both complete proof helpers before
returning both parent-asserted success flags. The actual R notification,
diagnostic replay and privacy lock/allowed-write/refusal boundaries execute
alongside F's actual R/S retained 13/8-field, precision, history/frozen-state,
replay/conflict/origin/refusal behavior and administrative mode setup. Both
fixed reference shapes and renamed-principal targets retain exact selected
inventories/ledger and status/apply/replay. No expectation, SQL, role, timeout,
profile, extra matrix or frozen derivation changed. All four created owned
containers were destroyed; zero remained and zero volume events occurred under
the unchanged tmpfs helper.

All normal numeric-worktree leases admitted immediately and were released:
typecheck 4 CPU/6144 MB, tooling 2 CPU/2048 MB, PostgreSQL 2 CPU/6144 MB. Root
was notified as soon as the last lease ended so E2 full verification could start.
Evidence is preserved at `/private/tmp/m14-f-final-working-20261027`.
The integrated proof SHA-256 remains
`cf4fea79e4de1451bdd4028776f65044807b90c69dfef0daa95da18659ca2fd9`;
the parent test is `8a0e949eef2d856b585c569c71239832bda25ce5863ecedf968d9f7041f24481`. The retained helper
remains exact to F 7ed23e2 and the runtime-lock helper exact to E2 9d26edb.
All other 6,511 upstream paths, F SQL/manifest/two hashes, five inert pins and
legacy 88/cfe3 inventory remain protected. The final task outcome is the only
post-execution tracked edit; no gate failure or retry occurred in these phases.

The root's stabilized final API/notes/control/budget/recovery read and separate
GO precede a second ordinary DCO checkpoint. First F independent full reviews,
native session and canonical clean full/cold/installed verification remain
required; E2 must actually land before F delivery. No second commit, native
PASS/expiry/cycle reset, full verification, push or external write is claimed.
Release/live/settings/account/credential/other-repository exclusions and all
existing authors, findings and failed-attempt history remain unchanged.

Self-retro: normal integration preserved both exact helper bodies, and one
existing four-case matrix exercised their interaction in 99.543 broker seconds
without queue waits, retries or a new production mechanism.

### E2 full-verification confinement repair

The signed 9d26edb2 candidate's first canonical full run stopped at the root
test phase: 22,111 tests passed, one failed and two existing optional tests
skipped. The single failure was the existing generic role-free transaction-lane
confinement test: the production PostgreSQL witness called that generic factory
outside its canonical reference binding. Prior install, lint, typecheck, builds
and package/cold/installed proof passed for that checkpoint; neutrality and
pgTAP were not reached. Preserve the complete failed run at
`.context/scratch/verify-local-EjvZNA`, with no partial/full PASS claim.

The necessary repair changes only witness composition. Diagnostic ingest/replay
uses the existing named customer-diagnostic lane, and privacy receipt operations
use the existing public privacy unit of work, matching their actual reference
bindings. Each still connects as the selected restricted R, is registered for
existing cleanup, and retains every identity/nonownership, successful lock,
allowed write, replay, denied-write and unchanged-row assertion. The confinement
test, production code, SQL, ACLs, manifest, inventories, API, budgets and deadlines
remain unchanged. The next discriminating checks include that actual confinement
selector together with the previous regressions, then the same eight production
targets. Native history remains cycle 1/3 until a committed repair is prepared;
F retains its own source/history and must integrate this actual dependency.

Self-retro: the earlier focused selection omitted an existing source-confinement
consumer and let a witness composition mistake reach the broad gate. Use the
actual owner bindings and include the existing confinement selector in focused
feedback; do not add a factory exemption or a second proof framework.

The bounded working checks passed: unchanged confinement selector 5/5 in
0.259 seconds, the same eight production installations 8/8 in 59.73 seconds,
and the prior seven-file selection 78/78 in 2.19 seconds. Canonical lint passed
with zero errors/33 existing warnings; all five type projects had zero unresolved
imports and consumer errors. Three API checks and current actual package/content/
size checks passed, including all 17 browser budgets. Platform remained exactly
1,662,140 code-gzip / 1,935,102 tarball / 9,006,345 unpacked bytes, with unchanged
2574/2628 file counts. No tracked input changed during execution and no owned
PostgreSQL remained after teardown. Exact commands, exits, source hashes and
logs are preserved in `/private/tmp/m14-e2-r2-confinement-20261027`. Only this
task outcome was appended afterwards. Root read the stabilized witness/notes
and unchanged API/control/budget/recovery scope and authorized ordinary DCO,
fresh full review in the same history, and a new complete canonical run; earlier
partial evidence is not promoted to current full proof.

### F E2 generic-lane confinement dependency repair

Root reported that E2 full verification of 9d26edb failed only the existing
`server/adapters/postgres/dataGateway.test.ts` confinement witness: the qualified
proof called the generic transaction factory directly. The bounded E2 source
repair composes the existing named diagnostic transaction lane and public privacy
unit of work with separate cleanup; no guard exception, SQL, ACL, manifest,
expected inventory, API or budget changed. Its signed-off dependency checkpoint
is `6f8349826a13190c76fcab894aed7432e483d8ce`, tree
`03d0818c1abcd2321de7754b0cbe3325731093a1`. The reported E2 working results
remain attributed to E2 inputs and are not a full PASS or F proof claim.

F preserved clean premerge checkpoint
`06cecedc8bb5f3c240fc991db3f37602b3775be4`, tree
`c4e5b5f88f216e80f1ad0b03d4af6a2072febf36`, then used an ordinary pending
merge of that exact E2 repair. The proof and contributor lesson merged without
conflict; only the shared task append conflicted, and both evidence histories
were retained. The complete F retained helper remains byte-identical to 06ceced;
the complete runtime-lock helper is byte-identical to 6f83498. Both calls remain
awaited once, both result flags remain parent-asserted and the parent test remains
byte-identical: exactly four 90-unit cases and only two measured restore maps.

All other 6,511 upstream paths, F SQL/registry/five inert pins, legacy 88/cfe3
inventory, manifest, runtime/private-helper/API and package budgets remain exact.
This is necessary dependency repair, not a freshness merge or mechanical
exemption. Premerge bytes, exact hashes and the one conflict are preserved at
`/private/tmp/m14-f-r1-confinement-integration-20261027`. Existing native
history, reports and cycle 0 are preserved without reading reviewer outcomes.
No native evidence is renewed or claimed by this source integration.

This allocation permits static working-source checks only. Root owns subsequent
heavy serialization: canonical lint with three builds and five-project types
under typecheck 4 CPU/6144 MB, three APIs and actual artifact/browser gates under
tooling 2 CPU/2048 MB, and the existing four combined production cases under
PostgreSQL 2 CPU/6144 MB still require root allocation. No install, build, lint,
test, PostgreSQL run, full verification, native prepare, commit or push ran here.
The new exact 6f83498 stack pin applies to the repaired candidate once it is an
actual ancestor of HEAD; no future-base exception is created. Existing failed
attempts, native history, author exclusions and all delivery boundaries persist.

Self-retro: normal dependency integration retained the full domain proof and
adopted existing owned lanes without changing the confinement guard or adding a
new mechanism. Static preservation alone does not establish runtime proof.

Static integration checks: AST and diff pass. Policy/navigation using requested
new stack base 6f83498 refuses with `explicit base is not an ancestor of HEAD`
while that commit remains only the pending merge parent; the refusal is retained.
The honest current-ancestor 9d26edb comparison passes three owner obligations
with zero unanswered. No future-base exception or no-impact trailer is added.
Eight existing ignored native-support files have unchanged metadata-only hash
identities; no review outcome was inspected and no native command or history
mutation ran. Final 6f83498 policy still follows its authorized signed checkpoint.

The root's bounded working phase on this integrated source passed canonical
lint (zero errors/33 existing warnings), all five published type projects
(zero unresolved imports/consumer errors), three API checks, actual package
content/byte/file gates and all 17 browser budgets. The unchanged confinement
selector passed 5/5; the existing four 90-unit composition profiles passed
4/4 in 46.69 seconds with both actual-R lock and retained-import proofs; the
prior seven-file regressions passed 78/78 in 2.59 seconds. Platform remained
at 1,662,140 code-gzip / 1,935,102 tarball / 9,006,345 unpacked bytes and
2574/2628 file counts under the same caps. No tracked input changed during
execution; no owned PostgreSQL remained. Root independently compared complete
TypeScript AST helper bodies: retained helper exact to 06cecedc, runtime-lock
helper exact to 6f834982, each awaited once. Raw commands, frozen inputs,
exits and logs remain at `/private/tmp/m14-f-r1-confinement-working-20261027`.

Only this task outcome was appended afterwards. The root read the stabilized
source/notes and unchanged SQL/hash/API/control/budget/recovery boundary and
authorized ordinary signed merge DCO, continuation of the same native history
with two fresh full reviewers, and complete canonical verification. The prior
06ce source reviews remain historical; none is relabelled to this tree. The
actual E2 predecessor must still land before F external admission. No full,
ready, receipt, admission or merge completion is claimed by these working results.

Self-retro: reuse of the actual owner bindings fixed the inherited confinement
failure without changing SQL or a guard. The four existing production profiles
cover both helpers after integration; no repeated frozen reference derivation,
extra installation matrix or proof framework was needed.

### F standalone legacy-prefix fixture repair

Root reported canonical full failure on F
`04cff4fe425c0b52246d46baa96acabd62684d51`, tree
`adca1a81826918ce006fbc2ff76e09c0b22e65a0`: the standalone retained-import
suite failed in beforeAll before its thirteen cases could execute. Its temporary
root copied the 88 legacy SQL files but copied the union manifest, which also
requires five qualified SQL files absent from that root. The runner correctly
rejected the incoherent catalogue. The full log at
`.context/scratch/verify-local-XeYAQQ/tests.log` and all earlier phase evidence
remain unchanged: root reported 22,108 passing cases, thirteen skipped by this
setup failure and two optional skips, with no ordinary assertion failure. The
first ten phases including package/cold proof passed; neutrality and pgTAP were
not reached. This is not a complete full PASS. Existing native cycle 1/3,
reports, failed attempts and repair history are preserved without reset.

The bounded fixture-only repair follows the existing fulfillment/invoicing
precedents: select the canonical `legacy` plan explicitly, copy exactly its
baseline and ordered forwards, create the temporary config directory, and write
that selected flat manifest. The canonical union manifest, runner validation,
SQL/roles/grants, byte checks and all thirteen domain/nine startup refusal
assertions remain unchanged. The four actual 90-unit production composition
cases and both complete retained/runtime-lock helpers remain untouched; no
qualified SQL is copied to relabel the standalone domain fixture as qualification.

This author allocation is static only. Root owns the working standalone,
regression/confinement proof, fresh full reviews and new complete canonical run.
No install, build, lint, test, PostgreSQL run, native prepare, commit or push ran
here. The exact stack base remains 6f834982. Before/after fixture identities,
patch and protected-input checks are preserved at
`/private/tmp/m14-f-r2-legacy-fixture-20261027`. Policy instructions were compared
with current origin/main `c1ca9994a8e833111e06fd7b280a6bd97c79e7ab`, separately
from the code base; relevant contribution additions retain existing requirements.
All authority, author exclusions and release/live/external-delivery limits remain.

Self-retro: a selected fixture must write the same catalogue it copies. Reusing
the canonical selector fixes the setup mismatch without weakening refusal logic,
adding five unrelated files or rerunning the separate production matrix.

The root ran the repaired standalone witness first: 13/13 passed in 2.44
seconds, completing the unchanged nine startup refusals in its beforeAll.
The existing eight-file regression/confinement selection then passed 83/83
in 2.18 seconds. Canonical lint, including fresh builds of all three packages,
passed with zero errors/33 existing warnings. All five published projects
compiled with zero unresolved imports and zero consumer errors. AST, policy
(three obligations, zero unanswered), inventory and diff checks passed. Tracked
inputs stayed frozen throughout; the owned disposable was removed. Exact
commands/exits/raw logs and source hashes remain under
`/private/tmp/m14-f-r2-legacy-fixture-20261027/working`.

Only this task outcome was appended after execution. The complete four-case
90-unit production child/parent, SQL, selected manifest, actual restore hashes,
API, package contents/budgets and all control inputs are byte-identical to
04cff4fe. Its actual working four-production-case result and prior full run's
passing package/cold/installed phase retain their original attribution; this
fixture repair does not relabel that failed full run or claim current full
proof. Root read the stabilized fixture/notes and unchanged API/control/budget/
recovery boundary, authorizing signed DCO, two fresh full reviews in the same
native history, and a new complete canonical run. The once-only reference
derivation is not repeated and no extra production installation matrix is added.

Self-retro: the affected standalone witness exposes this setup failure in
2.44 seconds, whereas deferring it to the broad gate cost 478.68 seconds of
root tests. Run the changed witness itself before the broad gate; a passing
composition sibling does not replace its fixture. Existing selector reuse
closes the cause without duplicating the whole qualified catalogue.

### Runtime completion, 28 October 2026

Outcome: introduce the exact separately approved runtime-completion SQL and
ordinary qualified 91 tail with two real reference inventories. This necessary
recovery remains within the approved M14 through C6 programme and ordinary
reviewed delivery through confirmed merge. Root appoints the sole contributor
and supervises technical read, DCO, submission and merge; all source authors
remain excluded from independent review. No new programme or budget is created.
Publication, activation, live provisioning/cutover, deployment, credentials and
settings remain excluded. No additional role mode or installation matrix is added.

Reader support landed as PR410, main commit 8da4af5a; the exact sixth pin landed as
PR411, main `1ef786beaa6c883c5f550923d33b319b0f642d0c`, with two fresh FULL
reviews and actual source/group 12/12 PASS. Their native and full-proof histories
remain attributed to their own trees, with the original session append-only.
Root prepares this changed third checkpoint in that same history; no reset.
Current code base is `1ef786beaa6c883c5f550923d33b319b0f642d0c`.
Separately verified policy is `1ef786beaa6c883c5f550923d33b319b0f642d0c`.
The former G1 stack pin remains unset; no freshness merge is needed.

The canonical 53-line SQL equals its approved inert fixture byte-for-byte:
q2_20261028100000_runtime_capability_completion.sql, SHA-256
`ec05d0e86a570724fad21916a6fd06976a5e32ae0d0323b1ff902f69c2ae189e`.
It grants context INSERT on four columns, UPDATE on three non-key columns and
DELETE, plus review-command receipt SELECT/INSERT. Existing installer ownership,
runtime binding and trusted preflight remain required; no receipt mutation,
TRUNCATE, ownership, role, RLS, trigger or production API change is introduced.
All six prior pins, five issued SQL units and fixtures retain their exact bytes.

The manifest preserves legacy 88/cfe3 and every F90 prefix identity/position,
then appends only this exact unit at position 90. Its two genuine withRestore
expectations came from independent sequential PostgreSQL16 references: actual
migration/bootstrap aliased and distinct, installer-managed with restore present.
The first actual measurement exited 0 in 5.670 seconds; root checked both raw
payloads, exact 91 ledgers, unchanged 90 prefix and successful owned cleanup.
The old F90 expectations and all raw measurement evidence remain historical;
these two measurements are not production target/runtime qualification.

The trusted-old-reader diagnostic accepted five rows and rejected six before
its no-SQL return. Delivery therefore required reader, pin, then active SQL in
that order on actual main. Guards, readers, admission, runner and projectors stay
unchanged. An alleged escape issue was refuted by actual byte inspection before
execution; no operative repair, runtime failure or native cycle resulted.

Working proof passed policy/navigation/inventory/manifest/AST, 71/71 controls,
lint/build prerequisites (33 existing warnings), five type projects, three APIs
and working packs. Four production cases passed in 46.49 seconds with normal-R
preparation, receipts/refusals and 91 inventories; retained legacy/prefix-race/
baseline/session/preparation passed 31/31. The first duplicate-fixture failure
was repaired in test only. Docker preflight skipped four before authorized
transport recovery; all owned PostgreSQL cleanup and broker release completed.

Platform pack is byte-identical to the prior artifact: 2574 code/2628 total
files, zero file headroom; all 17 browser checks passed. No npm asset or reserve
was added. Package APIs, metadata, caps and release machinery stay unchanged.
Remaining: root's stabilized final API/control/notes/budget/recovery read before
DCO, two fresh FULL reviews in the existing history, canonical full and actual
source/group admission/checks before reviewed merge.
Before installation, source recovery reverts this unissued tail and manifest
selection. After application, preserve the ledger and use a reviewed corrective
forward; never edit issued SQL or delete ledger rows. No adopter database changed.

Retro: isolate the named predecessor in a future-append fixture when SQL arrives;
existing assertions suffice. Inspect actual hex before proposing a repair from
presentation escaping; that concern added no runtime defect.
