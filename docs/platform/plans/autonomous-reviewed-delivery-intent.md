# Intent: autonomous delivery with accountable review

Status: native-session implementation, updated by the owner-approved
[2026-10-19 simplification](native-review-simplification-proposal.md). Transport
option A (PR comments) is implemented in this change. Queue activation is dated
in [Development and release](../DEVELOPMENT_AND_RELEASE.md#reading-results-and-recovering).
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
semantics and simplicity. Uncertainty requires two fresh reviews of the same
committed candidate.
Neither a self-declared low-risk label nor a small diff is proof of low risk.
A merge group that cannot carry over is rejected: merge `main` and re-review.

Commit repairs and give fresh reviewers the open finding cards, actual repair
and interaction context, without old verdicts or author history. The new tree
needs passing review by the required reviewer count, with every material finding
closed. Evidence expires 24 hours after the earliest counted PASS report for the
current candidate. There is no closure-lineage or inherited-expiry route.

Unchanged prepare preserves evidence. Three repair cycles are automatic;
`needs_owner` then requires the owner to continue, narrow or stop. Record an
authorized continuation with `continue "<note>"`, which adds three cycles.
A rethink of criteria, tools and simpler alternatives remains recommended
practice, not an encoded gate. A rebase or changed intent starts a new session
with `prepare --new`, archiving and referencing the old session. Merging main
requires fresh review of the resulting candidate. Stop optional edits when
criteria, review and checks pass, then complete authorized delivery.

The supervisor in the active task conversation launches fresh-context reviewers
through the platform's native subagent tools, using the existing subscription.
The maintainer does not copy prompts, move reports, open another conversation
or read each diff. This is provider-neutral: Codex, Claude Code and future agents
must satisfy the same review contract. No model API, backend, new host, account
or transfer of subscription authentication is required.

The supervisor records observed native execution identities and complete results
for the exact committed base (the candidate's fork point), head, tree, scope and criteria. Local verify and
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
Source objects are trusted through Git's own hashing, with
`transfer.fsckObjects=true` on hosted fetches.

## Approved native queue follow-up

Extend that same native process to an optional GitHub merge queue without a
model API, reviewer host, new secret or transfer of subscription authentication.
The active supervisor posts the summary from
`node scripts/agent-review-session.mjs receipt <PR>` as a PR comment using
`gh pr comment <PR> --body-file -`, within delivery authority. Option A replaces
the historical dispatch/artifact transport under the 2026-10-19 simplification.
The old run-keyed integration receipt route is superseded too. All six mechanical
checks remain required. The bounded `native-review` job reads eligible comments,
recomputes source tree and reviewer floor, and checks live head, base and expiry.
A source-head change cannot inherit the old admission.

Carry-over remains available when the group tree equals the reviewed tree, or
when `git merge-tree` predicts exactly that group and the base's net change
avoids the reviewed paths and admission, identity-binding, dependency and
migration machinery. Otherwise reject the group: merge `main` and re-review.
The [plan](autonomous-reviewed-delivery.md#source-evidence-and-carry-over) lists
the exact protected paths. The optional `OPENLUP_STACK_BASE` pin must lie between
the fork point and HEAD and already be on actual main for hosted admission.
At most two automatic queue-rebuild retries remain separate from repair cycles.

Foundation delivery does not authorize settings activation. The original live
activation proof is historical; current guidance and dated activation evidence
are linked above. Freshness is checked at admission, not guaranteed at the later
merge, and Actions source attribution cannot isolate a malicious writer who can
spoof the same context. No production or release authority is granted.

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
finding or invalid expiry admits a stale or dirty candidate, green tests conceal
a violated approved goal, optional advice starts another repair, exhausted cycles
are silently restarted, simple tasks require a long ceremony, or ordinary
authorized repairs repeatedly ask
the maintainer to approve the same behaviour. The implementation plan must
name activation prerequisites honestly rather than substitute prose for a gate.

Implementation: [plan](autonomous-reviewed-delivery.md).
