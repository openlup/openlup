# Plan: autonomous reviewed delivery

Status: native-session implementation; live activation requires per-installation proof.
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
   unknown risk uses that floor. The gate refuses a prose label for changed code,
   configuration, workflows and known agent/control instructions; classify actual
   changed paths rather than a broader approved scope. Other document semantics
   remain the supervisor's responsibility. A specialist can fill one role. A third reviewer
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
`.context/scratch/agent-review/intent.json` file: `intent` contains `risk`, `scope`,
`criteria` and `requiredRoles`; an adapter may supply an observed
`authorSessionId`. `node scripts/agent-review-session.mjs prepare` computes the
candidate, role floor and request binding, then stores the bounded session state
in `.context/scratch/agent-review/session.json`. Neither file is a new planning document
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

Earlier signed-receipt and hosted-observer libraries remain optional historical
mechanisms. Their existence does not activate installed native review or grant
permission to provision a model service.

## Sources and attribution

[Anthropic best practices](https://code.claude.com/docs/en/best-practices) and
[Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
support fresh review, deterministic hooks and the simplest effective workflow.
[Codex best practices](https://learn.chatgpt.com/guides/best-practices) and
[execution plans](https://developers.openai.com/cookbook/articles/codex_exec_plans)
support clear goals, observable completion and living plans for complex work.
The review counts and controller protocol here are OpenLup design decisions,
not a vendor-certified guarantee or a claim of universal best practice.

## Historical implementation boundary

Earlier work introduced authenticated source graphs, signed-receipt validation
and a hosted mechanical-check observer. The native session gate reuses source
validation while keeping execution under the active subscription. Signed receipt,
App and protected-key provisioning are not default-route acceptance criteria.
Historical fixture results and reviews prove only the mechanisms they exercised;
they do not attest the current candidate or any new installation.

Keep reviewer execution parallel when their source context and observations are
isolated. Calibrate on representative prose and behavioural tasks before adding
another reviewer, orchestration layer or merge queue. Record lead time, confirmed
and false findings, subscription usage and escaped regressions. This large control
change alone cannot establish the economics of ordinary small tasks.
