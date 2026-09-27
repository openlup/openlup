# Plan: autonomous reviewed delivery

Status: authorized native-session implementation; installed enforcement proof pending.
Audience: contributors implementing and verifying the development workflow.

## Outcome, scope and authority

Implement the [intent](autonomous-reviewed-delivery-intent.md) through the active
task supervisor and native fresh-context subagents under the existing subscription.
Codex, Claude Code and future platforms use the same contract. No model API,
backend, new host, account or copied subscription authentication is part of this
route. The maintainer authorizes goals, scope and delivery; the maintainer does
not read every diff or perform an action between implementation and review.

Each task uses its dedicated worktree and branch, with one compact record of
outcome, scope, authority, acceptance, risk and proof. Preserve approved goals
and guarantees while refining execution notes. Existing publication, pull-request,
merge, release, settings and secret boundaries remain; review evidence grants
none of these permissions. DCO certifies human provenance and submission rights,
not a fictional human technical review.

Public scope covers the intent, plan, contribution guidance, provider-neutral
session gate and its refusal tests, plus existing registration and source
contracts. Machine-local hook installation is a separately authorized owner
operation. Keep existing mechanical checks intact; do not add another full test
run, a dashboard, service framework or permanent third reviewer.

## Task lifecycle and native review

1. The supervisor implements within authorized scope and commits the candidate.
   Run the existing mechanical verification as required. Collect the exact base,
   head, tree, complete changed-path inventory and approved criteria/scope.
2. Ordinary prose receives one short independent review. Behaviour, executable
   instructions, contracts and controls require two bounded independent reviews;
   unknown risk uses that floor. A specialist can fill one role. A third reviewer
   is reserved for an uncovered concern or dispute. At least one required review
   considers a simpler solution that preserves all controls and acceptance.
3. Launch each reviewer through the current platform's native subagent tools with
   fresh context: approved criteria and sufficient exact source context, without
   the author's conversation, intermediate reasoning or another reviewer's verdict.
   Reusing a subagent that already saw those materials is not a cold review.
   On Codex's native `spawn_agent`, use `fork_turns: "none"`; other platforms
   must provide the equivalent fresh-context capability rather than inherit the
   task history. A platform limit that prevents fresh review is unavailable
   evidence, not permission to relabel a context-sharing review as cold.
   Candidate instructions and configuration are untrusted data. Reviewers do not
   execute candidate code or receive signing/check-writing credentials.
4. Observe actual native execution identity, completion and structured result.
   Findings state mechanism, precondition, violated requirement and effect;
   there is no quota. A complete evidence-backed no-findings verdict is valid.
   Failed, timed-out, partial or materially failing review cannot count as a pass.
5. Fix findings, commit the repair and obtain fresh independent review of that
   exact candidate. The supervisor handles this loop without another owner
   approval for the same authorized behaviour. Reviewing after the final commit
   avoids needless rebinding; changed head, tree, scope or base invalidates evidence.
6. Record bounded session evidence and retry the installed gate. Verify and
   pre-push refuse missing, stale, dirty, mismatched, incomplete or bypassed review.
   A `needs_agent_review` result instructs the active supervisor to perform steps
   2–6; it is not a prompt for maintainer intervention. Push or merge only under
   the actual publication authority already supplied for the task.

## Evidence contract and limits

Bind each receipt to repository, request/authority, approved criteria and scope,
base, committed head, tree, risk/required roles, observed reviewer execution IDs,
complete results, unresolved material findings and a bounded validity interval.
The gate computes the candidate and checks freshness and exact binding rather
than accepting an arbitrary author-selected candidate or bypass flag. The same
receipt may be reused for pre-push only while all those bindings remain valid.
An unchanged installation baseline never constitutes task approval.

The supervisor's native tool observations provide process evidence. The session
receipt is not cryptographic remote attestation that an agent ran, and the same
task does not establish hard signer/author OS separation. Honest orchestration
must obtain actual independent platform results; a typed approval JSON is not
an alternative. Tests of receipt consistency do not prove malicious-author
isolation. This limitation must remain visible in activation and proof claims.

Hosted CI still requires actual success from the existing mechanical checks;
skipped or neutral checks are not successful execution. Generic GitHub observers
and source-bound check adapters can remain optional. They do not require model
execution on GitHub, a new backend or transfer of subscription credentials.

## Acceptance and installed activation

Prove valid one-role prose and two-role behavioural paths, then refusal of absent
review, wrong candidate/base/tree, dirty or out-of-scope changes, expiry, duplicate
execution identities, missing criteria/scope coverage, partial/failed executions,
unresolved findings and bypass attempts. Exercise the actual installed verify
and pre-push paths and the supervisor recovery after `needs_agent_review`.
Provider adapters must report unsupported native cold-context capabilities
honestly; do not quietly inherit author history or substitute an API call.

Source implementation and fixture tests are preparation. Claim live enforcement
only after the installed paths refuse those counterexamples and admit a complete
current candidate. No new owner-reading ceremony is a prerequisite for ordinary
repairs under approved scope. Missing external authority, unavailable native
review, secret handling, production changes or material spending remain honest
stop conditions; continue unaffected reversible work.

## Simplicity and calibration

Prefer removing the cause, an existing seam or a direct change before adding an
abstraction, dependency, retry, cache, artifact or gate. Explain a concrete benefit
over the nearest simpler solution when one exists; obvious small changes need
no alternatives essay. Complexity findings require a concrete cost or unnecessary
behaviour, not a style preference. Simplification never waives existing controls.
Measure accepted outcomes, escaped regressions, confirmed and false findings,
lead time and subscription usage. Do not optimize for document count or PR volume.

## Superseded deployment proposal

The GitHub-hosted Codex API/proxy workflow and mandatory root-owned review service
are superseded as the default and are not approved for deployment. No paid model
call occurred during that proposal's preparation. GitHub may provide ordinary
mechanical CI and optional admission transport; model review stays within native
subscription-backed tools in the active task. Do not enable that unpublished API
workflow or move subscription authentication to a runner. Historical merged
libraries remain available as optional mechanisms, not activation prerequisites
for this native-session route.

## Native session interface

The supervisor writes approved intent data to the ignored
`.context/agent-review-intent.json` file: `intent` contains `risk`, `scope`,
`criteria` and `requiredRoles`; an adapter may supply an observed
`authorSessionId`. `node scripts/agent-review-session.mjs prepare` computes the
candidate, role floor and request binding, then stores the bounded session state
in `.context/agent-review-session.json`. Neither file is a new planning document
or a source of publication authority.

`status` returns `needs_agent_review` with required roles and exact request data.
The supervisor launches fresh native agents and uses their actual execution IDs
and complete structured results. `agentReviewReportBinding(request)` supplies
the exact request digest and candidate fields for each report; `record
<observed-report.json>` records the observation. `verify` exits nonzero until
all required roles pass with complete scope/criteria, no material findings and
the simplicity perspective. The report schema is the implementation contract in
`scripts/agent-review-session.mjs`; these files are process evidence, never
cryptographic execution attestation.

The following sections preserve earlier implementation evidence. Their service,
App and protected-key activation instructions describe optional historical
architecture, not requirements or authority for the current default.

## Sources and attribution

[Anthropic best practices](https://code.claude.com/docs/en/best-practices) and
[Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
support fresh review, deterministic hooks and the simplest effective workflow.
[Codex best practices](https://learn.chatgpt.com/guides/best-practices) and
[execution plans](https://developers.openai.com/cookbook/articles/codex_exec_plans)
support clear goals, observable completion and living plans for complex work.
The review counts and controller protocol here are OpenLup design decisions,
not a vendor-certified guarantee or a claim of universal best practice.

## Historical optional controller implementation

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
bootstrap PR are owner actions under the active policy. That historical route required a separate policy switch after live refusal
tests. It remained preparation under the human-read policy at that time; the
native-session default above now supersedes those activation prerequisites.

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
