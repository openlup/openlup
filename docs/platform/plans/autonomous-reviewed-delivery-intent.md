# Intent: autonomous delivery with accountable review

Status: native-session implementation; live activation requires per-installation proof.
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

The design fails if self-approval replaces actual independent review, a stale or dirty
candidate is admitted, green tests conceal a violated approved goal, simple
tasks require a long ceremony, or ordinary authorized repairs repeatedly ask
the maintainer to approve the same behaviour. The implementation plan must
name activation prerequisites honestly rather than substitute prose for a gate.

Implementation: [plan](autonomous-reviewed-delivery.md).
