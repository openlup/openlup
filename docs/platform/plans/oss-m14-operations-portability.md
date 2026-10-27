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
