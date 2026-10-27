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
