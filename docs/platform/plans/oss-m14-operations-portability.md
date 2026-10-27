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

The active supervisor relayed the owner's current limit for this run: prepare
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


## Owner-authorized corrected draft checkpoint, 2026-10-27

After the source-only handoff preparation, the owner directly instructed this
receiving session to commit and push its corrections into the existing #402
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


### Receiving coordinator source-freeze addendum

The receiving coordinator also registered the exact future E2 child entrypoint
in the existing closed execution inventory and documented it in CONTRIBUTING.
The entry registration is control-only here, before E2 source introduction; it
changes no classifier or exception. All further source repairs remain on this
Daybreak-capable machine. The stronger machine may only execute the supplied
measurements/tests/verify and return evidence; defects return here for repair.
