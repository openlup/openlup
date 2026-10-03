# Intent: autonomous delivery with accountable review

Status: native-session implementation; queue admission is active (dated evidence in [Development and release](../DEVELOPMENT_AND_RELEASE.md#reading-results-and-recovering)); pull-request receipts amended on 2026-10-03.
Audience: maintainers and contributors designing the development workflow.

## Outcome

A sole maintainer controls goals, important contracts and execution authority
through intent, specifications where needed, and plans. Agents implement and
independently review authorized changes without relying on a claim that the
maintainer personally read every diff. Human accountability and DCO remain.
More pull requests must not require proportionally more maintainer reading.

Each task uses its own worktree and branch, for both Claude and Codex. The
coordination checkout remains clean. A task has one compact record of its
outcome, scope, authority, acceptance, risk and execution/proof plan. Separate
intent documents describe programmes; a separate specification is justified
only by a durable or ambiguous contract. Technical execution notes may evolve;
agents cannot silently change approved goals, guarantees or authority.

## Quality with less unnecessary work

Planning and review must ask whether the required result can be delivered
faster, with less maintenance and stronger evidence using a simpler solution.
Prefer removing the cause, reusing an existing seam, or a direct change before
adding a new abstraction. A wrapper, dependency, retry, cache, artifact or gate
must solve a concrete failure and explain its benefit over the nearest simpler
alternative. Obvious small tasks need no artificial alternatives essay.

This is a perspective within existing planning and review, not another
committee. Complexity findings need a concrete cost or unnecessary behaviour;
style preferences do not block. Simplification never waives an existing safety
control or required acceptance evidence. Measure accepted outcomes, escaped
regressions, confirmed and false findings, lead time and total cost, rather
than lines of code, document count or pull-request volume.

## Independent review and enforcement

The initial candidate gets one short cold review for ordinary prose or narrow
routine code, and two independent parallel bounded reviews for sensitive or
material behaviour, executable instructions, contracts, controls and unknown
risk. A specialist can fill one role; a third
reviewer is reserved for an uncovered concern or dispute. Reviewers receive
approved criteria, the exact candidate and sufficient source context, without
author history or other reviewers' verdicts. Blockers identify a mechanism,
precondition, violated requirement and demonstrated effect on correctness or
acceptance. There is no quota; optional advice cannot block, and evidence-backed
no-findings is acceptable.

The routine class applies only to a bounded internal change with understood
behavior and tests. Known control, trust-boundary and public-contract paths are
ineligible; semantic security, payment, durable-data, release, dependency,
executable-instruction and unknown risks remain on the two-review route even
when a filename looks ordinary. The one reviewer explicitly confirms ordinary
semantics and simplicity. If uncertain, a full refresh obtains two fresh reviews
of the same committed candidate within the existing continuation budget.
Neither a self-declared low-risk label nor a small diff is proof of low risk.
Changed-tree queue integration keeps two independent full reviews.

Complete prior coverage and exact validated lineage allow one fresh cold closure
review for a committed narrow repair within unchanged intent, scope and base.
Necessary neutral prior finding cards, actual repair and interaction context are
allowed; old verdicts and author history are not. Every prior material finding
needs a disposition. The reviewer independently confirms semantic risk: control,
security, schema, executable instruction and unknown repairs retain two focused
reviews, regardless of filenames. Reduced repair reviews cannot renew inherited
evidence expiry; unavailable or expired coverage requires two fresh full-scope
reviews with all prior findings and lineage retained.

Unchanged prepare preserves evidence. The two automatic repair/review cycles
persist across prepare and full-review escalation. On exhaustion the supervisor
automatically regroups the execution approach within existing authority while
keeping honest blocked evidence; there is no budget reset, bypass or automatic
merge. Changed intent requires explicit regrouping. An ancestor-preserving base
integration requires fresh full-scope review, preserving history and budget. Stop optional edits
when criteria, required review and checks pass, then complete authorized delivery.

The supervisor in the active task conversation launches fresh-context reviewers
through the platform's native subagent tools, using the existing subscription.
The maintainer does not copy prompts, move reports, open another conversation
or read each diff. This is provider-neutral: Codex, Claude Code and future agents
must satisfy the same review contract. No model API, backend, new host, account
or transfer of subscription authentication is required.

The supervisor records observed native execution identities and complete results
for the exact committed base, head, tree, scope and criteria. Local verify and
pre-push require fresh matching review evidence; missing, stale, incomplete,
bypassed or unresolved material evidence refuses. A `needs_agent_review` response
returns control to the active agent, which launches reviews and retries the gate
without asking the maintainer to repeat the authorized task. Mechanical checks
remain required; baseline installation is not task approval and skipped hosted
checks are not success.

This is process enforcement within the task, not cryptographic remote
attestation of an agent's execution or a claim that the supervisor and author
have separate OS authority. A report written by the author is not independent
review. The supervisor must obtain actual platform observations; receipt
validation checks their declared binding and completeness but cannot establish
independence against a dishonest actor with control of the entire session.

## Approved native queue follow-up

Extend that same native process to an optional GitHub merge queue without a
model API, reviewer host, new secret or transfer of subscription authentication.
The active supervisor retains source-review evidence and transports it through
a main-only dispatch artifact for the reviewed PR head, or for the exact
merge-group CI run/attempt.
All six mechanical jobs remain required. Activated queue admission adds a
seventh bounded job which rechecks current source, group, artifact and native
review identity before success. A source-head change after auto-merge was armed
cannot inherit the old admission.

For the one-source pilot, compare the actual entire group tree with the reviewed
source tree. Equal trees need no additional review; a different tree requires
two fresh independent full integration reviews with unchanged approved criteria.
Keep source and group identities separate and leave the source branch unchanged.
This does not alter the nonqueue base-integration protocol or reset its repair
budget. At most two automatic queue-rebuild retries are a separate bound;
exhaustion or unknown membership returns honest blocked evidence to the supervisor.

Foundation implementation and authorized delivery through merge do not activate
settings. Activation needs an exact separately approved proposal and live refusal
proof, including changed heads, rebuilt groups, same-SHA attempt replay (for
merge-group runs since the 2026-10-03 pull-request receipt amendment), and
synthetic-tip DCO. Fixture success or unavailable sandbox evidence does not
establish activation. Review freshness is checked at admission, not guaranteed
at the later GitHub merge; Actions source attribution cannot isolate a workflow
against a malicious writer who can spoof the same context. The queue retains
the existing process-evidence boundary and grants no production or release authority.

## Boundaries and falsifiers

The maintainer authorizes outcomes and delivery scope; there is no claim that
the maintainer personally read each diff. DCO provenance and accountability
remain separate from delegated technical review. Opening or merging a pull
request still needs the applicable explicit authority; a generated plan or
receipt cannot grant it. Claim installed enforcement only after actual verify
and pre-push refusal tests pass. Ordinary work does not authorize production,
secrets, material spending, ruleset changes or releases. No zero-regression claim.

The earlier protected root service and GitHub-hosted model/API proposal are
superseded as the default. Merged verifier and hosted-observer libraries may
remain optional components; they do not create a requirement for an external
model service or cryptographic separation in the same task.

The design fails if self-approval replaces actual independent review, an erased
finding or renewed expiry admits a stale or dirty candidate, green tests conceal
a violated approved goal, optional advice starts another repair, exhausted cycles
are silently restarted, simple tasks require a long ceremony, or ordinary
authorized repairs repeatedly ask
the maintainer to approve the same behaviour. The implementation plan must
name activation prerequisites honestly rather than substitute prose for a gate.

Implementation: [plan](autonomous-reviewed-delivery.md).
