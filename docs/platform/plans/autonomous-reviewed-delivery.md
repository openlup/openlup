# Plan: autonomous reviewed delivery

Status: authorized local implementation; activation prerequisites outstanding.
Audience: contributors implementing and independently verifying the workflow.

## Frozen outcome and scope

Implement the [intent](autonomous-reviewed-delivery-intent.md) without weakening
existing admission or mechanical checks. The first slice delivers the compact
workflow, permanent simplicity criteria, a dependency-free authenticated review
verifier with negative tests, and review-hook integration ready for a protected
controller. The next slice activates that controller and hosted required checks;
it needs separate credential/service and repository-setting authority. Do not
claim autonomous admission is active before that slice actually passes.

Public scope: this intent and plan; the AI policy; both agent guides;
CONTRIBUTING; the PR template; a review verifier and its tests; publication
catalog and derived source contract; existing publication policy/entrypoint
registration and root test command to include the new falsifiers in the already
required test job. No application, schema or provider changes.
Machine-local scope: update only the local tool's rule source and its generated
Claude/Codex instruction sections for automatic task isolation. Recognize an
already assigned task worktree; from the clean coordinator use the designated
creation tool and its returned directory. Read-only reviewers share the task;
they do not create additional task worktrees. Record artifact digests. Do not
relink shared hooks, change shared identity/configuration, touch another task's
checkout or enable an unavailable controller for existing sessions.

## Execution and proof

1. For this governance-changing task, three independent agents challenge the plan, including the simplest feasible
   implementation, the trust boundary and actual execution ownership. Resolve
   material issues before code. Keep technical progress notes here without
   changing the approved outcome.
2. Put the lifecycle and anti-overengineering rule into the owning public
   documents. Retain current human-read admission until explicit activation;
   separate DCO provenance from the proposed review-quality mechanism.
3. Implement one Ed25519 receipt verifier using Node built-ins. Its trusted
   key, policy and expected candidate come from the protected caller, never
   the candidate's receipt. Authenticate exact payload bytes before parsing;
   bind repository, base, head, tree, authority, policy and request identity.
   The protected caller also supplies the required stage, risk/role floor,
   supported version, current time and maximum validity window. Unknown risk
   routes to two reviewers; unknown protocol/policy/stage refuses. Reject future
   or expired receipts, duplicate reviewer runs, partial scope, open material
   findings and insufficient reviewers or specialist coverage. A hosted receipt additionally
   requires actual completed SUCCESS for the existing six checks, authenticated
   by the controller with their expected source and candidate. The verifier
   does not itself launch agents or observe CI and must not claim it does.
4. Supply a dormant hook adapter, tested in an isolated harness, that refuses
   dirty or changed snapshots and invokes the verifier from a pinned protected
   installation. Keep the installed local verify/pre-push unchanged during this
   slice. At activation local verify runs its mechanical checks once, then review
   and final stability; pre-push authenticates cached exact-candidate evidence.
   Baseline installation is explicitly separate. Do not accept candidate-selected
   verifier, key, policy or bypass variables; author opt-in is not enforcement.
5. Negative tests cover wrong key/forgery, candidate/policy/authority/repository
   drift, expiry, duplicate runs, missing coverage, unresolved findings, unknown
   stage downgrade, future timestamps, baseline misuse and skipped/missing/wrong-source
   hosted checks. Include unknown-risk/two-review success and required-specialist refusal.
   Include
   valid prose and behaviour cases so refusal is not the only tested outcome.
6. Two fresh implementation reviews use the frozen acceptance criteria and raw
   diff. Resolve findings, register paths, regenerate the source contract, run
   focused tests and the existing full local verify. Report release-check reasons
   against the fresh baseline separately. No public push or PR in this slice.

## Activation prerequisites and stop conditions

The protected controller must compute inputs, launch cold reviewers itself,
close findings independently and sign observed results; it must not sign
author-supplied approval JSON. A key owned by the same unrestricted OS user
does not establish isolation. Use a separate protected service identity or
equivalent hosted controller. Candidate code and reviewers receive no signing
or check-writing credentials. Test prompt injection as untrusted input.

Before activating unattended admission: issue real receipts; prove the author
cannot issue them; bind local verify and pre-push to protected policy; run an
always-executing hosted aggregate from trusted code; require its genuine source
in repository protection; prove skipped checks and hook bypass still refuse;
and validate the actual integration/squash candidate under serial admission.
Use current strict up-to-date protection plus one merge slot initially; adopt
a merge queue only when availability and measurements justify it. Any new
candidate invalidates review until a safe reuse rule is separately proven.

Stop activation, while continuing safe preparation, if it needs actual secret
values, provisioning/material spending, repository settings, unavailable trust
isolation or publication not explicitly authorized. Missing evidence is never
success. Preserve existing policy through bootstrap and this policy's own PR.

## Simplicity and calibration

No general review framework, extra dependency, permanent third reviewer,
dashboard, universal three-document sequence or duplicate full verify. Each
new mechanism names a concrete failure, unique enforcement benefit, bounded
operational cost and condition for simplification/removal. Calibrate on known
regressions and correct patches; periodically sample outcomes and false findings.
Model/prompt/runner changes need the same calibration before trust is expanded.
Optimizing existing required tests is separate measured work.

## Sources and attribution

[Anthropic best practices](https://code.claude.com/docs/en/best-practices) and
[Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
support fresh review, deterministic hooks and the simplest effective workflow.
[Codex best practices](https://learn.chatgpt.com/guides/best-practices) and
[execution plans](https://developers.openai.com/cookbook/articles/codex_exec_plans)
support clear goals, observable completion and living plans for complex work.
The review counts and controller protocol here are OpenLup design decisions,
not a vendor-certified guarantee or a claim of universal best practice.

## Follow-on controller implementation

The next authorized implementation builds the actual supervisor and hosted
observer, using Node built-ins and the existing receipt protocol. Three
independent reconnaissance lanes confirmed that no protected signer/worker
identity or controller App is presently available. Preparation continues;
installed admission stays unchanged until those boundaries are demonstrated.

The controller accepts a checkout and a request ID, loads approved acceptance,
allowed scope and authority/policy commitments from protected records, and
observes the current remote base, head and tree itself. It refuses actual changed
paths outside the approved scope. It creates a neutral immutable
source-data bundle (base, candidate and complete change inventory), never another
authoring checkout. Commit, tree and blob contents are authenticated against
their identifiers, including ancestry and raw-reference closure. Review data
comes from that verified in-memory graph, preventing a later object-database
substitution between hashing and source extraction. Git transports, lazy fetch,
replacement objects, graft/shallow hints and commit-graph shortcuts are disabled.
It launches fresh read-only Codex processes itself with bounded time/output,
separate execution IDs and a fixed structured-report schema. It receives no
author-supplied verdict. Candidate instructions and configuration are data;
they are not startup instructions or executable hooks. The signing capability
never enters the reviewer process, environment, readable files or source bundle.
Only complete passing observations produce a signature. Any material finding
requires fresh independent review of the repaired exact candidate.

The hosted observer reads current PR/base/head and the latest attempt of the
approved workflow through authenticated GitHub APIs. It verifies each of the
six actual completed SUCCESS jobs and source identities. Initial admission
requires current-base ancestry and proves the actual integration tree equals
the reviewed head tree; it does not relabel a PR-head check as a merge-SHA check.
Integration and workflow/run/attempt/job provenance are included in the trusted
check identity. Final squash parent/tree read-back remains a separate obligation.

A candidate job can impersonate another job name under the GitHub Actions App.
Therefore the aggregate is a dedicated controller App check, required by that
App's identity, rather than an extra candidate-controlled workflow. Existing
six jobs remain untouched. The observer/publisher can be implemented and tested
with bounded fake APIs before any App credential or repository setting changes.

New public scope: one controller module, one hosted observer module and their
focused tests; existing verifier/hook helpers where reuse avoids duplication;
test-scope and publication registration; the owning contribution instructions.
No general service framework, queue, dashboard, model-routing framework or new
dependency. Production entrypoints refuse missing/unprotected installation.
Tests use in-memory fixture keys and controlled subprocesses; they establish
orchestration/refusal behaviour, never real OS isolation or active GitHub gating.

Activation still requires owner-provisioned signer and separately isolated
review worker/model authentication, a dedicated controller App installation,
protected code/policy records and publication of the bootstrap under the old
policy. Actual secrets, account provisioning, repository settings and public
PR actions remain the explicit stops above. Record concrete prerequisites once
the runnable implementation and negative evidence are ready.

### Activation checklist and installed boundaries

The executable interface is `protected controller <checkout> <request-id>`;
only the protected registry supplies criteria, scope, risk, reviewer roles,
authority/policy commitments and validity. Library callbacks are an integration
API, not author-supplied evidence. The fixed supervisor and its sibling verifier
and hook must be installed as immutable protected code. The reviewer launcher
and model-authentication profile need their own unprivileged identity. The
entire executable chain, including the actual Codex binary and runtime, must be
protected; pinning a wrapper around an author-writable binary is insufficient.
The supervisor drops worker UID/GID and supplementary groups; the root-owned
signing key remains unreadable to both the task author and reviewer. An
administrative author account prevents local production activation. A separate
managed execution host or a demonstrably
restricted author identity is needed; fixture keys are never an alternative.

Before switching policy, demonstrate on the chosen host that author and reviewer
cannot read the signer key, alter installed code/policy, substitute the launcher
or escalate into the supervisor. Exercise missing/forged/expired receipts,
dirty candidate, out-of-scope changes, changed main/head, failed/incomplete review
and unresolved findings against the actual installed request interface.

Then install the bounded authenticated GitHub transport, distinct controller
App and event handler. `observeHostedCandidate` and `publishHostedAdmission`
are the observer/publisher APIs; `routeAdmissionEvent` supplies routing hints,
never webhook authentication or permission. Authenticate webhook delivery and
serialize admission. Require `review-admission` from the installed App ID while
retaining all six existing checks and strict up-to-date protection. Demonstrate
that a same-name Actions check, skipped job, newer failed run/attempt, moved base
or expired review cannot admit a change, including invalidation after success.
Use the authenticated protected transport for `currentBase` at volume; the
standalone probe has no credential and refuses unavailable or rate-limited API
responses. It is not a throughput guarantee.

Finally connect the installed local verifier to `openlup-dev verify` and
pre-push. An unchanged bootstrap baseline may run mechanical checks but never
produce task approval. Nonbaseline task delivery must require authenticated
review of the exact clean committed snapshot. This hook/settings transition and
bootstrap PR are owner actions under the active policy. Switch the pending AI
policy only after those live refusal tests pass. Until then, this implementation
is preparation and ordinary delivery still follows the human-read rule.

### Dogfood execution

After the implementation passes its focused checks, perform two separate usage
sessions. The first exercises actual fresh Codex reviews of the committed task
snapshot, refusal paths and handoff usability. Repair confirmed findings before
the second session, then repeat the complete available path and check whether
the repairs improve evidence, recovery, runtime and ceremony. Use ephemeral
fixture signing keys; they confer no production authority. Actual protected
hook installation and hosted admission cannot be counted as dogfood success
before their infrastructure is provisioned. Record observations, limitations
and recommendations separately from synthetic test coverage.

Session 1 exercised the real Codex launcher against the committed implementation.
The first cold reviewer completed a passing structured review in 117.8 seconds,
but copied the tree identifier incorrectly. The controller refused signing;
the second reviewer was not launched. This is a useful refusal and a preventable
false rejection. Bind deterministic candidate values in the generated response
schema while retaining the independent exact-binding check.

The same run first dumped more than 1 MB of the full source index for 19 changed
paths. Observed usage was 694,091 input tokens, including 598,784 cached tokens,
across the review turns. Make changes the starting point, retain full source
context for bounded lookups, and compare the second session's observed cost.
Progress and actionable refusal reports also need to reach the protected caller;
buffering everything until process exit makes routine recovery unnecessarily
opaque. None of these improvements adds a review committee or waives a control.

Session 2 ran after those repairs against implementation commit
`abdab31e2ca4c26d6a03081c1b8b782221f3577e`. Two fresh actual Codex executions
covered all 19 changed paths, passed correctness/security review and preserved
the exact candidate. The controller produced a fixture-signed local receipt;
expired evidence, stale head, wrong authority and a verifier inside the author
checkout all refused. Total available-path time was 325.7 seconds. This was
same-identity lab orchestration, not protected-host or installed-hook proof;
there was no hosted App publication or repository-setting change.

The matched correctness review's observation file shrank from 1,383,638 to
313,223 bytes. Its uncached input stayed approximately flat: 95,307 versus
96,135 tokens. Duration increased from 117.8 to 212.2 seconds, and total input
including cached turns increased. These are two observations on evolving code,
not a controlled performance experiment or evidence of monetary savings.
The second security review took 107.6 seconds and used 86,844 uncached input
tokens. Streaming progress and actionable refusal evidence now work; the SHA
copy failure did not recur.

Implementation verification: 171 focused tests; final full mechanical verify
PASS in 141 seconds, including 574 test files and 4,724 tests. Independent
source reviews closed workflow-attempt races, stale clocks, raw-object/source
binding and startup/progress/reporting concerns. Native Git already rejects
some malformed loose-object cases; the added tests do not claim otherwise.

Recommended next changes, in order:

1. Provision the protected service/App and required-source enforcement, then
   repeat refusal tests on the real installed path before replacing policy.
   Use a controller-owned imported snapshot or equivalent bounded source
   isolation; do not give a privileged supervisor unrestricted access to an
   author's object stores, alternates or unrelated private repositories.
2. Calibrate on representative small prose and behavioural changes, measuring
   completed task latency, uncached/cached usage, false findings, recovery and
   escaped regressions. This large control change cannot establish ordinary
   task economics. Adjust review focus/model selection only from those results;
   retain the existing risk floors and exact-candidate checks.
3. Keep independent reviewer work parallel when protected per-run schemas and
   workspaces are isolated; never share intermediate verdicts. The current
   sequential implementation is the simple safe baseline, so measure its
   critical-path cost before adding concurrency. Keep hosted admission serial
   initially; add a merge queue only when measured contention justifies it.

No additional mandatory document, reviewer or dashboard is recommended from
these two sessions. The production activation prerequisites remain unproven.

## Earlier implementation evidence

- Fresh isolated baseline: mechanical verify PASS; release-check already reports
  NOT-RELEASABLE on the baseline. That pre-existing release limitation is outside
  this workflow change.
- Three independent plan reviews found stage/risk/time trust inputs and dormant
  activation ambiguous. Clarified above before code; all three support the
  bounded first slice once these findings are resolved.
- Documentation, dependency-free verifier and dormant adapter implemented. The
  new falsifiers are included in the existing required root test command.
- Two fresh implementation reviews exposed dirty-candidate concealment through
  Git metadata/filters and directory symlinks, plus blocking FIFO input. Repairs
  compare actual bytes/modes and index inventory without executing clean filters,
  reject symlink ancestors and use bounded nonblocking reads. Both reviewers
  closed their findings against the repaired source.
- Focused suite: 68 tests passed. Policy/catalogue, inventory and focused lint
  passed. Full mechanical verification is the next check on the committed tree.
- Protected controller provisioning, installed hook activation and hosted
  required-check activation remain outstanding; no real controller receipt or
  active autonomous admission is claimed. The maintainer explicitly approved
  the permanent automatic-worktree session-start amendment; its local Claude
  and Codex instruction projections were updated without changing other rules.
