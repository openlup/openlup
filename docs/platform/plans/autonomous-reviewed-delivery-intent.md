# Intent: autonomous delivery with accountable review

Status: accepted direction; enforcement activation pending.
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

Ordinary prose gets one short cold review. Changes to behaviour, executable
instructions, contracts or controls get two independent bounded reviews. A
specialist can fill one of those roles. A third reviewer is reserved for an
uncovered concern or dispute. Unknown classification uses the behavioural
floor. Reviewers receive approved criteria, the exact candidate and sufficient
source context, without the author's conversation or other reviewers' verdicts.
Findings identify a mechanism, precondition, violated requirement and effect;
there is no quota and an evidence-backed no-findings verdict is acceptable.

Local verification and hosted admission must eventually require authentic,
complete review of the current candidate. Author-written receipts cannot prove
independence. A protected controller must launch reviewers, capture results
and authenticate the receipt; its authority must be unavailable to the author
and candidate code. Missing, stale, incomplete or unresolved material evidence
refuses admission. Successful installation of an unchanged baseline is not
task approval. Existing mechanical checks remain required and skipped hosted
checks do not count as success.

## Boundaries and falsifiers

Do not replace the existing human-read admission rule until the protected
controller and required hosted enforcement have passed refusal tests and the
maintainer explicitly activates the replacement. This policy-changing task is
admitted under the existing policy. Ordinary work does not authorize production,
secrets, material spending, ruleset changes or releases. No zero-regression claim.

The design fails if the author can mint accepted review, a stale or dirty
candidate is admitted, green tests conceal a violated approved goal, simple
tasks require a long ceremony, or ordinary authorized repairs repeatedly ask
the maintainer to approve the same behaviour. The implementation plan must
name activation prerequisites honestly rather than substitute prose for a gate.

Implementation: [plan](autonomous-reviewed-delivery.md).
