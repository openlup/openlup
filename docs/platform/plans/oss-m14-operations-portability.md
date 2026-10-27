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

The active supervisor relayed the owner's current limit for this run: inspect
and repair source only, with no tests, verification, installs, builds, lint,
gates, independent reviewers, commits, pushes or external writes. Drafts stay
drafts. This temporary execution boundary supersedes the broader delivery grant
above for this run; it does not waive any proof or authorize later delivery.

E1 remains in `/private/tmp/openlup-m14-qualified-install-controls`, branch
`codex/oss-m14-qualified-install-controls`, checkpoint
`0b4517be8000352be4659e4be2320163b1db9650`, draft
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
commands on PATH but retain actual `node:net` loopback binds. `available()` maps
every socket error to false, so denied binds as well as occupied ports can reach
the same final "no free port block" error before image/start/replay stages.
The historical errno was not retained here. This does not establish an
environmental cause or exclude a regression; all 16 failures remain unresolved.
No generic port, fixture or refusal change was made. Earlier fragment-row and
PATH failures and the required regroup remain part of the handoff history.

No executable check was run in this continuation. Required next proof includes
a regression witness through actual queue admission for qualified additions with
unchanged pins and changed machinery, acceptance without that machinery delta,
source and merge-group coverage, optional fifth-binding/fixture integrity,
current pgTAP diagnosis, package hook/native-session proof, API/build/pack and
owner/budget checks, two fresh full native reviews and the canonical full gate.
No native session is initialized: cycles remain 0/3, with no PASS or expiry.
No candidate DCO, receipt, readiness, admission or merge claim follows from these
local edits; no budget was raised. All changes remain uncommitted.

Self-retro: the missing caller condition showed why a validator-only fixture
cannot prove trusted admission is wired. Reusing the existing guard was the
smallest adequate correction. The port failure's discarded errno limits static
diagnosis, so preserve that uncertainty until an authorized executable run.

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
