# Plan: autonomous reviewed delivery

Status: native-session implementation, updated by the owner-approved
[2026-10-19 simplification](native-review-simplification-proposal.md). Transport
option A (PR comments) is implemented in this change. Queue activation is dated
in [Development and release](../DEVELOPMENT_AND_RELEASE.md#reading-results-and-recovering).
Audience: contributors implementing and verifying the development workflow.

## Approved convergence implementation wave

Historical approval record. Its closure-lineage, inherited-expiry, repair-cycle
and rethink/owner-cycle protocol is superseded by the owner-approved
2026-10-19 simplification. The steps and acceptance below describe that earlier
wave; current rules and commands are in the lifecycle and session interface.

The maintainer authorized planning, implementation, dogfooding and delivery
through merge for this bounded correction. The outcome is a review process that
stops when sufficient evidence exists, while retaining independent review,
exact candidate attribution, required mechanical checks and delivery authority.
This wave changes native review policy, session validation and the installed
local equivalents. It does not authorize production, releases, secrets or
credentials, GitHub settings or ruleset changes, or migration of sibling tasks.

Implementation order:

1. Challenge the repair protocol before implementation. The later proportional
   calibration retains one reviewer for ordinary prose, adds one for bounded
   routine code, and keeps two for sensitive/material behaviour and controls.
   Define blocking findings by demonstrated effect on correctness or acceptance;
   optional advice cannot require another repair or prevent a terminal pass.
2. Extend the existing session state with bounded prior-round evidence. A
   committed repair within unchanged approved criteria, scope and base may use
   one fresh cold closure reviewer covering the actual repair and interactions,
   after complete initial coverage and prior rounds are validated. Supply neutral
   prior finding cards, never old verdicts or author history. Control, security,
   schema, executable instruction and unknown repairs retain two reviews;
   independently confirm semantic risk rather than trust filenames or an author
   label. Validate exact lineage and every material finding's disposition without
   copying approvals onto another SHA or renewing inherited evidence through a
   reduced review. Complete prior coverage permits focused repair review;
   unavailable, incomplete or expired coverage requires two fresh full-scope reviews.
3. Preserve complete review when prepare is repeated for an unchanged candidate.
   Bound automatic continuation cycles at two across repair and full-review
   escalation. Exhaustion remains blocked while the supervisor automatically
   regroups the execution approach within existing authority; no silent reset,
   bypass or automatic merge follows. Changed intent requires explicit regrouping.
   Ancestor-preserving base integration receives fresh full-scope coverage within
   the same budget; cross-base reuse is deferred rather than inferred from filenames.
   Once criteria, review and checks pass, stop optional edits.
4. Update existing contributor/agent guidance and intent together. Installed
   verification refuses workflow drift before expensive commands, and serializes
   heavy local verify runs sharing worktree outputs without stealing another
   task's lock. Exact-candidate
   receipts remain reusable by pre-push; no general test-result cache is added.
5. Run focused regression and refusal checks, then two dogfooding passes: first
   exercise the real installed CLI and hooks, batch material fixes, and then
   repeat the affected scenarios. Include unchanged prepare, advisory-only pass,
   successful repair closure, control-change escalation, stale/dirty evidence,
   missing coverage, erased findings, exhausted cycles and concurrent execution.
6. Commit the final candidate with DCO, obtain independent native evidence for
   this control change, run required full verify and release advice, publish the
   authorized PR, wait for all six actual hosted checks and squash merge with
   the maintainer's configured author email. Verify the merged tree and main CI.

Acceptance: no full review is repeated solely for unchanged prepare or optional
advice; a narrow repair needs one closure review while control repairs need two;
no stale, dirty, incomplete or unclosed candidate is admitted; reduced reviews
cannot renew inherited expiry and exhausted cycles remain blocked; workflow drift starts no
expensive checks or replacement of prior logs; concurrent verify
cannot corrupt or overlap its heavy checks. Report observed reviewer counts,
dogfooding findings and remaining limitations. Historical-red Draft publication,
general selective-test caching, merge queues and cross-base review reuse were
outside that convergence wave. The separately approved queue follow-up below
does not expand its repair protocol. Its W4 amendment adds only a bounded,
mechanically checked carry-over for merge groups, not a general cross-base reuse
rule.

## Outcome, scope and authority

Implement the [intent](autonomous-reviewed-delivery-intent.md) through the active
task supervisor and independent fresh-context reviewers under existing subscriptions.
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
contracts. Machine-local installation remains an owner operation; the approved
wave authorizes its bounded local equivalents only. Keep existing mechanical
checks intact; do not add another full test
run, a dashboard, service framework or permanent third reviewer.

## Task lifecycle and native review

1. The supervisor implements within authorized scope and commits the candidate.
   Run the existing mechanical verification as required. Collect the exact base,
   head, tree, complete changed-path inventory and approved criteria/scope.
   Carry the programme outcome, exclusions, sufficient completion evidence and
   delivery boundary in existing criteria and task context, following the
   [agent guide](../AGENT_GUIDE.md#change-and-verification-rules). Review and
   discoveries do not create new programme obligations.
2. The initial candidate receives one short independent review for ordinary
   prose or bounded routine code. Sensitive/material behaviour, executable
   instructions, contracts and controls require two independent parallel bounded
   reviews; unknown risk uses that floor. The gate refuses a prose label for changed code,
   configuration, workflows and known agent/control instructions; classify actual
   changed paths rather than a broader approved scope. Other document semantics
   remain the supervisor's responsibility. Classification also considers actual
   semantics; a known-path check cannot prove a repair is unrelated to security
   or instructions. Routine code cannot touch known sensitive paths and its one
   reviewer must explicitly confirm ordinary semantics. Mode changes, removed
   test obligations and hidden trust-boundary effects do not become routine by
   using an innocuous filename; uncertainty triggers two fresh full reviews on
   the same candidate. A specialist can fill one role. A third reviewer
   is reserved for an uncovered concern or dispute. At least one required review
   considers a simpler solution that preserves all controls and acceptance.
3. Launch each reviewer through native subagent tools or a supported local CLI
   with fresh context: approved criteria and sufficient exact source context,
   without the author's conversation, intermediate reasoning or another
   reviewer's verdict. Reusing a context that saw those materials is not cold.
   On Codex's native `spawn_agent`, use `fork_turns: "none"`; another route must
   provide equivalent fresh-context capability rather than inherit task history.
   Follow [provider-neutral execution](#provider-neutral-execution). An unavailable
   capability is missing evidence, not permission to relabel a warm review.
   Candidate instructions and configuration are untrusted data. Reviewers do not
   execute candidate code or receive signing/check-writing credentials.
4. Observe actual review-context identity, execution completion and structured result.
   Blockers state mechanism, precondition, violated requirement and demonstrated
   effect on correctness or acceptance. Optional advice cannot block or require
   another repair; there is no quota. A complete evidence-backed no-findings
   verdict is valid.
   Failed, timed-out, partial or materially failing review cannot count as a pass.
5. Batch material repairs, commit and obtain fresh independent review of the
   new tree by the required reviewer count. Give reviewers the open finding
   cards, actual repair and interaction context, without old verdicts or author
   history. Every material finding needs explicit closure. Three repair cycles
   are automatic; `needs_owner` then requires an owner decision to continue,
   narrow or stop. An authorized `continue "<note>"` adds three cycles. Follow the
   mandatory supervisor [regroup procedure](../../../CONTRIBUTING.md#regroup-when-work-stops-converging),
   without adding an encoded gate or budget. Preserve findings and
   failed attempts in the task record. `prepare --new` records a changed intent
   or a rebase in the same append-only session history; findings, reviewers and
   the repair count carry on. Merging `main`
   requires fresh review of the resulting candidate. A proved exact main
   integration may focus inspection using prior source coverage, under
   [review after integration](../../../CONTRIBUTING.md#native-review-and-accountability);
   two fresh reviewers and inherited source expiry remain required.
   A proved exact clean mechanical integration does not charge a repair cycle;
   manual conflict resolution or extra edits use the ordinary repair and full
   local verification route. History and findings remain intact.
6. Record bounded session evidence and retry the installed gate. Verify and
   pre-push refuse missing, stale, dirty, mismatched, incomplete or unresolved
   review. Unchanged prepare retains current evidence. Handle
   `needs_agent_review` in the active task. Once criteria, review and checks
   pass, stop optional edits and complete only authorized delivery.

## Provider-neutral execution

Coordination, supervision, implementation, verification and independent review
may use different providers or models within the actual task grant. Retain one
active delivery supervisor and list every implementation/supervisor context in
the existing task record. Before assigning a reviewer, exclude those contexts
and every previously used reviewer context in this session history. Do not reuse
a historical reviewer as an implementer or successor supervisor in that history;
use a fresh context for the new role. Check roles before writing session state.

A supported local CLI must create a genuinely new context after candidate
stabilization, without resume/fork of author history, automatic author memory or
execution of candidate hooks. Give it the neutral criteria/scope and exact
base/head/tree and intent. The supervisor observes its real context identity,
execution identity, successful completion and full result, and retains those
observations beside the existing task evidence. A timed-out/failed execution,
partial result or old output file cannot count. If this cannot be demonstrated,
that route is unavailable; the existing native route remains usable.

In V2, `reviewer` identifies the observed review context, not a role alias or an
individual turn/run in a reused context. Use one stable representation, qualified
by provider/parent context when needed, across the task's author/reviewer evidence;
retain observed legacy aliases without relabelling old reports. A new run ID or
model switch in the same context does not create another reviewer. V2 checks only
its recorded author IDs and declared bindings; the supervisor must check the full
actor list, freshness and complete base/head/tree/intent observations. This is the
existing process trust boundary, not a new machine-proven independence claim.

A supervisor change uses the existing `prepare --new` route and requires fresh
reports; preserve findings, histories, budgets and expiry rules. An identical tree
does not add a repair cycle. A simultaneous main integration is assessed
separately under the existing integration conditions; a changed supervisor does
not establish that exception. No new schema, migration or handoff command is
required. Existing tasks can adopt at a stable boundary under their actual grants.
The policy amendment itself receives review by the previously allowed route;
programme-specific allocation restrictions must also be reconciled before use.

## Evidence contract and limits

Local session evidence binds the approved intent, scope and criteria to the
candidate's base, committed head and tree, reviewer identities and reports.
History retains stable finding IDs; a material finding stays open until a
report on a current or later candidate lists it in `closes`. Advice never blocks.
Each candidate needs one reviewer for prose/routine work or two for sensitive
or unknown work, with the changed-path and mode floor able to raise the count.
Reviewers must be cold, non-author, distinct and not reused from earlier candidates.

Evidence expires 24 hours after the earliest counted PASS report for the current
candidate, limited by inherited source expiry for proved integration coverage.
There is no reduced-reviewer closure route. The gate
captures the candidate and checks the clean worktree and exact tree binding.
An unchanged installation baseline is not task approval. The hosted summary
receipt carries only PR, base, head, tree, risk, reviewers, verdict, expiry and
session digest; admission independently recomputes the tree and risk floor.

The supervisor's observed review executions provide process evidence. The session
receipt is not cryptographic remote attestation that an agent ran, and the same
task does not establish hard signer/author OS separation. Honest orchestration
must obtain actual independent platform results; a typed approval JSON is not
an alternative. Tests of receipt consistency do not prove malicious-author
isolation. Source objects are trusted through Git's own hashing, with
`transfer.fsckObjects=true` on hosted fetches. This limitation must remain visible
in activation and proof claims.

Hosted CI still requires actual success from the existing mechanical checks;
skipped or neutral checks are not successful execution. Generic GitHub observers
and source-bound check adapters can remain optional. They do not require model
execution on GitHub, a new backend or transfer of subscription credentials.

## Acceptance and installed activation

Prove valid one-role prose and routine paths, plus two-role sensitive/unknown paths,
then refusal of an elevated path with a routine label, uncertain routine semantics, absent
review, wrong candidate/base/tree, dirty or out-of-scope changes, expiry, duplicate
execution identities, missing criteria/scope coverage, partial/failed executions,
unresolved findings and bypass attempts. Exercise the actual installed verify
and pre-push paths and the supervisor recovery after `needs_agent_review`.
Review transports must report unsupported cold-context capabilities honestly;
do not quietly inherit author history or substitute an API call.

Also prove unchanged prepare preserves evidence, advice does not block, stable
material findings require closure, expiry applies to the current candidate,
and the fourth repair needs an owner continuation. Check new-session archival
after a rebase or changed intent, lock exclusion and atomic state writes.
Historical installed workflow-drift and heavy-check serialization proofs belong
to local verification; the simplified session does not run policy/inventory
checks or maintain a proof lease. No general test-result cache is introduced.

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
mechanical CI and optional admission transport; model review stays within subscription-backed
tools qualified by the active task's execution contract. Do not enable that unpublished API
workflow or move subscription authentication to a runner. Historical merged
libraries remain available as optional mechanisms, not activation prerequisites
for this native-session route.

## Native session interface

The supervisor writes ignored `.context/scratch/agent-review/intent.json`:

```json
{ "authorSessionId": "<supervisor session id>",
  "intent": { "risk": "<prose|routine|behavior|unknown>",
    "scope": ["<changed paths>"], "criteria": "<approved criteria>" } }
```

Codex may omit `authorSessionId` to use `CODEX_THREAD_ID`. Read
[Review lessons](../../../CONTRIBUTING.md#review-lessons) and put the simplicity
pre-check in the first review request as prose, outside this JSON.

```bash
node scripts/agent-review-session.mjs prepare .context/scratch/agent-review/intent.json
node scripts/agent-review-session.mjs record report.json
node scripts/agent-review-session.mjs verify
node scripts/agent-review-session.mjs status
```

`prepare [--new] <intent.json>` captures the candidate and reviewer floor and
writes version-2 state to `.context/scratch/agent-review/session.json`. Refresh
`origin/main` first. Prepare, verify-command and receipt reuse the queue's cheap
merge/carry-over preflight against that local ref; a conflict or ineligible base
move refuses before expensive work. An unlanded stack pin still permits local
preparation, while hosted admission waits for the prerequisite. The base
is the single `git merge-base --all HEAD origin/main`; no or multiple merge bases
refuse. `OPENLUP_STACK_BASE` may pin a predecessor between that fork point and
HEAD. Documentation and local review use the same pin; hosted admission requires
the pinned base to be an ancestor of actual main and the reviewed head. A
predecessor-only landing preserves the candidate and expiry. An unpinned review
remains valid while main moves ahead without changing the fork point.

Unchanged prepare preserves evidence. Preparing a new tree after an earlier
candidate increments `cycle`, except when `candidate.integration.mechanical`
proves the exact successful `git merge-tree` result of the prior reviewed head
and new main base. That exception preserves the existing counter and allowance;
it does not renew expiry or reuse reports. Three repairs are automatic. Beyond
the allowed cycles, `needs_owner` refuses until the owner authorizes continuation:

```bash
node scripts/agent-review-session.mjs continue "<owner decision and reason>"
```

This records a timestamped note and adds three cycles. The mandatory supervisor
[regroup procedure](../../../CONTRIBUTING.md#regroup-when-work-stops-converging)
uses existing task notes, not a state-file gate or this native cycle counter.
`prepare --new <intent.json>` records a changed intent or a rebase in the same
append-only session history; findings, reviewers and the repair count carry on.
Each prepare event records its intent, candidate and author; verdicts and receipts
use the latest intent. Reviewers must differ from every author in the history.
With no existing state, `--new` behaves like the first prepare. Unsupported
state versions refuse; `--new` does not discard them.

Each actual fresh reviewer supplies a report in this shape:

```json
{ "reviewer": "<observed review context id>", "cold": true, "verdict": "PASS",
  "tree": "<reviewed tree>", "findings": [], "closes": [] }
```

`verdict` is `PASS` or `FAIL`. Findings have stable `id`, `summary` and `material`
fields. A report on the current or a later candidate closes a finding through
`closes: ["<finding id>"]`. Every material finding must be closed; optional advice
(`material: false`) never blocks. Reviewers cannot be the author, duplicate each
other or reuse earlier candidates' reviewer IDs. Required reviewer count is one
for prose/routine work and two for sensitive/material behaviour or unknown risk;
paths and executable/mode/symlink changes establish a floor that intent can raise.
Reviewers assess semantics independently and escalate uncertainty to two reviews.

`verify` exits zero and prints `reviewed` only with a clean matching candidate,
enough PASS reports, closed material findings and unexpired evidence. Expiry is
24 hours after the earliest counted PASS report for the current candidate,
or the earlier inherited source expiry when `candidate.integration` is present.
Prepare supplies that context only for a valid prior PASS in the same session,
unchanged intent/author and an exact two-parent merge of prior head and new base.
It binds the prior base/head/tree and expiry. Two fresh current-tree reports
remain required; unavailable coverage uses full review. See the canonical
[inspection scope](../../../CONTRIBUTING.md#native-review-and-accountability).
`candidate.integration.mechanical: true` additionally proves that the clean
candidate tree equals the successful `git merge-tree` result for those exact
parents. Two-parent lineage alone permits additional edits and cannot establish
this mechanical exception. Manual resolution or extra edits retain ordinary
repair accounting and full local verification.
Failures use `needs_agent_review`, `needs_owner`, `stale`, `expired`, `dirty` or
`invalid` with an actionable reason; `status` prints JSON.

`receipt <PR>` requires passing verify and prints a PR comment body: the marker
`<!-- openlup-native-review-receipt v2 -->` followed by a fenced JSON summary
`{pr, base, head, tree, risk, reviewers, verdict, expires, sessionDigest}`.
The supervisor posts it within delivery authority:

```bash
node scripts/agent-review-session.mjs receipt "$PR" | gh pr comment "$PR" --body-file -
```

`verify-command [--resource PROFILE] -- CMD ARGS...` verifies before and after
the command, requiring an unchanged HEAD tree and clean worktree. With a resource
profile it invokes the existing `ai-resource-gate` broker; nested broker use
refuses. The merge preflight reuses the existing queue predicate; proof leases
and policy/inventory runs remain outside this wrapper. Exclusive locking and atomic rename protect state writes;
input/state bounds remain 1 MiB/8 MiB.
The wrapper does not attest that selected commands form complete verification.
The existing raw-command route may use the
[bounded local integration alternative](../../../CONTRIBUTING.md#native-review-and-accountability)
only under its full-anchor, mechanical-chain and check-selection conditions.
Unsupported installed verifiers keep full-run stamp requirements. No flag, history
event, copied stamp or cache is introduced; all required source and merge-group CI commands still run.

The report schema in `scripts/agent-review-session.mjs` is the implementation
contract. Receipts are process evidence, not cryptographic remote attestation
or hard signer isolation. Source objects are trusted through Git's own hashing.
No model service or separate signer is required.

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
and a hosted mechanical-check observer. Raw object-graph authentication was
removed by the 2026-10-19 simplification; Git's own hashing now supplies source
object integrity while review stays under the active subscription. Signed receipt,
App and protected-key provisioning are not default-route acceptance criteria.
Historical fixture results and reviews prove only the mechanisms they exercised;
they do not attest the current candidate or any new installation.

Keep reviewer execution parallel when their source context and observations are
isolated. Calibrate on representative prose and behavioural tasks before adding
another reviewer, orchestration layer or merge queue. Record lead time, confirmed
and false findings, subscription usage and escaped regressions. This large control
change alone cannot establish the economics of ordinary small tasks.

## Approved native queue follow-up wave

The maintainer authorized implementation and bounded delivery through merge for
this follow-up. Its outcome is queue admission tied to actual native source
review and the exact GitHub integration candidate. Public scope covers the
queue transport and refusal tests, the six-job workflow's merge-group event
support, its optional admission job, documentation attribution, contributor
guidance and the configured local verification mirror. This foundation can
merge while queue activation remains off. No production, release, new secret,
subscription-authentication transfer, paid model call or settings change is
authorized by foundation delivery.

The original follow-up used main-only artifact transport and separate integration
reviews. Those mechanisms are superseded by the 2026-10-19 simplification: PR
comment summaries and source-review carry-over are the only admission route.
Retain all six mechanical checks and their failure signals. The seventh `native-review` job provides the additional admission
condition only after separate activation.

### Source evidence and carry-over

The supervisor owns review of the committed source in the active task and posts
its summary as soon as the PR is open and ready. A new head needs new evidence.
After local proof, current review, required maintainer reads and the ready-main-PR
source receipt, actual merge authority permits enabling auto-merge once while
source checks are pending, following [Merge queue](../../../CONTRIBUTING.md#merge-queue).
Known failed checks, conflicts and unresolved mergeability retain their existing
stops. Pending `autoMergeRequest` confirms enabled auto-merge; `mergeQueueEntry`
alone confirms queue entry. Required source and group success still precedes merge.
For a merge group, admission uses the PR number from
`gh-readonly-queue/main/pr-<N>-<sha>` and actual event base/head identities.

Native admission establishes carry-over under the canonical
[source-review conditions](../../../CONTRIBUTING.md#required-and-raw-checks).
That procedure owns the exact tree/base checks, protected paths and narrow
exception for disjoint package `exports` additions; this plan does not maintain
a second list. Existing review evidence remains subject to those native rules.

Otherwise reject the group: merge `main` and re-review. There is no run-keyed or
integration-review receipt route. At most two authorized supervisor
queue-recovery retries remain separate from the source repair counter, under
the canonical [Merge queue](../../../CONTRIBUTING.md#merge-queue) procedure.
The trusted Queue Handoff command makes one enqueue attempt after eligibility
checks; it does not retry a refusal within that invocation or automatically
requeue an entry from the same arming intent. Review grants no settings,
publication, merge or release authority.

### Native transport and admission

Transport option A was chosen on 2026-10-19. The supervisor posts
`agent-review-session.mjs receipt <PR>` output with
`gh pr comment <PR> --body-file -`. The queue script exposes `wait` for
admission and `enqueue` for the trusted one-shot Queue Handoff, after its
eligibility checks; it does not retry a refusal within that invocation or
automatically requeue an entry from the same arming intent. The old dispatch
workflow, transport input/submit commands, compressed envelopes and artifact
upload/download path are removed.

The `native-review` job runs from trusted main after the six mechanical checks,
when `OPENLUP_NATIVE_QUEUE=enabled`. It reads all pages of PR comments and
considers marked receipts only from users whose repository permission is `admin`,
`maintain` or `write`.
It selects the newest valid receipt matching the live head, fetches the required
SHAs using `transfer.fsckObjects=true`, and recomputes the tree, paths and risk
floor. It checks PASS, reviewer count, expiry, fork point or pinned ancestry,
and merge-group carry-over. Polling is every 15 seconds for at most twenty
minutes. Missing, stale or mismatched evidence refuses with an actionable reason.

The W2/W3 artifact-provenance and W4 separate-integration amendments are historical
and superseded by the 2026-10-19 simplification. W4's bounded carry-over conditions
and W5's fork-point base remain. Live historical proof: #122's group carried
over from its source receipt on an unchanged tree, without a live session.

Freshness is checked at admission, not guaranteed at the eventual merge. A
successful GitHub context has no native receipt expiry timer, and Actions source
attribution does not isolate a malicious writer capable of spoofing that context.
These remain process-evidence limits.

### Verification and separate activation decision

Historical activation plan. The run/attempt integration receipts and artifact
provenance below are superseded by the 2026-10-19 simplification. Current
admission uses comment receipts and rejects groups that cannot carry over;
this record grants no new authority or current acceptance obligations.

Implement and test authenticated source/group identity, whole-tree equality,
changed-tree two-review requirements, stale/partial findings, expiry, input
bounds, head movement during observation, group rebuilds, unknown membership,
and exact run/attempt replay refusals. Preserve criteria and findings while
testing repair and queue retry exhaustion independently. Exercise main-only
transport and artifact provenance without moving model execution to GitHub.

The six CI commands remain. Merge-group DCO checks the complete event-base-to-head
range including the synthetic tip; an unsigned tip fails. Documentation impact
validates event base/head/ref/tree against the checkout and compares that full
range. Controlled local fixtures establish those mechanics only. When a hosted
sandbox or live queue test is unavailable, record `UNAVAILABLE` with its missing
precondition; fixture results cannot replace it or justify a waiver.

Prepare an exact settings proposal for separate maintainer approval: squash
queue, build concurrency one, minimum and maximum merge count one, `ALLGREEN`,
all six existing contexts plus `native-review`, the activation variable and a
check-response timeout covering mechanical CI plus the bounded receipt wait.
Do not enable settings while delivering the foundation. The inactive admission
job is skipped and is not enforcement proof.

The historical activation proof required a head changed after arming to stay
blocked without new source evidence, a changed or sensitive group to require
two integration reviews, and each new run/attempt to require a new receipt.
Since 2026-10-19, a group that cannot carry over is rejected: merge `main` and
re-review. A current source comment receipt covers reruns of the same reviewed
head; there is no integration-review receipt route. Prove exact live
membership and base/head/tree/ref attribution, stale receipt failure, bounded
wait expiry and rebuild recovery. Confirm the synthetic tip's DCO behavior and
that the actual squash author email is `dev@openlup.com`; either unproven behavior
blocks activation. No DCO exemption or unsupported email assumption is allowed.
Keep queue settings inactive until the exact proposal and these live results
support the owner's activation decision. A merge of foundation code is not that
decision and does not authorize production or a release.

### Merge-commit queue (proposed 2026-10-17)

Stacked pull requests do not stay tree-equal under squash landings. The upper
branch keeps its old merge base, so any insertion next to its predecessor's in
a shared list conflicts: catalogue rows, appended exports, single-instance
records. Simulated merge-commit landings of the same stacks were clean and
tree-equal. The owner's settings change, not this repository, enables it:
- the `main` ruleset drops `required_linear_history` and allows the merge
  method;
- the repository allows merge commits (`allow_merge_commit: true`) and the merge queue's
  `merge_method` becomes `MERGE`;
- the repository's merge-commit message is the pull request body
  (`merge_commit_message: PR_BODY`, with `merge_commit_title: PR_TITLE`);
- head-branch deletion and retargeting are verified; when automatic deletion is
  unavailable, explicitly retarget the upper PR after the predecessor lands.

The merge method itself changes no review floor, expiry, receipt or DCO rule.
The separately authorized stack-base implementation below binds local own-delta
reviews and requires their prerequisites on main. The DCO check already
certifies merge commits, so each description ends with the author's
`Signed-off-by:` line. Merge commits make a merged branch's own commits
ancestors of `main`, so the release gates accept only a target on `main`'s
first-parent line, and release prepare finds each reviewed forward's
introduction on that line.

Prove it live right after the switch, before relying on it:
1. The first pull request merges through the queue. The group tip and the merge
   commit on `main` pass DCO from the description's sign-off; record the merge
   commit's actual author and that it has two parents, the previous `main`
   first.
2. A second pull request, stacked on the first and reviewed before the first
   merged, is admitted with "unchanged tree" carry-over using its own source
   receipt, without an additional receipt.

If either step fails, the owner restores the squash settings and the guidance
change is reverted.

### Stack-base and local proof implementation (2026-10-17)

Historical record. The proof-lease, merge-preview and policy/inventory wrapper
parts below are superseded by the 2026-10-19 simplification. The stack pin and
bounded resource-broker command wrapper remain as described in the current
[session interface](#native-session-interface).

Outcome: update the same bounded PR with optional immutable predecessor bases,
early merged-tree policy/inventory proof and coordinated heavy local commands.
The direct owner instruction authorizes implementation and updating this PR;
settings, merge, release, adopter rollout and queue-capacity changes remain out
of scope. Acceptance preserves native identity, complete coverage, reviewers,
expiry, repair history, DCO and all required commands. Ordinary PRs remain a
first-class path with no stack configuration.

The smallest adequate implementation shares one explicit pin, uses existing
policy/inventory checks in a disposable predicted checkout, and wraps heavy
commands with a bounded output lease for their real worktree. An installed host
resource broker handles aggregate CPU/RAM capacity across independent projects,
using the explicitly selected existing profile for each command. This wrapper
does not define a new CPU/RAM, worker-count or execution-time budget;
there is no new daemon, dependency, shared result cache or test selector. Native
review and cheap checks precede waiting, and are revalidated before final proof.
The wrapper does not install itself in npm or CI pre-scripts and creates no
reusable verification stamp. Existing installed hooks retain their authority.

Regression simulations cover unchanged independent bases, pinned own-delta
review before/after predecessor landing, missing or rewritten prerequisites,
disjoint and sensitive base moves, textual conflict, clean-but-invalid generated
aggregates, independent worktree resource identities, owned contention refusal, nested
wrapper refusal, child-environment isolation and source mutation during proof.
The current source tests are the falsifiers; live GitHub queue activation remains
the separate two-step proof above.
