# AI contribution policy

**AI-assisted contributions are welcome. They are not banned, and they will not
be banned.**

That sentence comes first because the opposite is this category's reflex, and
here it would be self-contradictory: OpenLup is itself developed with AI agents,
and the platform is built so that adopters can extend it with AI agents. A
project that forbade what it practises would be lying about one of the two.

The policy is therefore **disclosure and accountability**, not permission.

## The four rules

1. **Disclose.** If an AI tool wrote, drafted, or materially shaped a
   contribution, say so in the pull request or issue. A checkbox is enough. You
   are not judged for it.

2. **A human is accountable.** Every contribution has exactly one human author
   who is answerable for it. Sign-off under the Developer Certificate of Origin
   is that human's, and the DCO requirement in `CONTRIBUTING.md` applies
   unchanged to AI-assisted work. A tool cannot sign off, and the maintainer's
   own agents are no exception: when an agent writes the sign-off line on a
   human's instruction, the sign-off is that human's, certified by that
   human's authority over provenance, submission rights and task delivery scope.
   Delegated technical review does not assert personal reading of every diff.

3. **You must be able to explain every line.** If a reviewer asks why a line
   exists and the honest answer is "the model wrote it", the contribution is not
   ready. This is the whole test, and it is deliberately strict: it is what
   separates an assisted contribution from an unreviewed one.

4. **No unauthorized submissions.** An agent may implement and independently
   review an authorized task. Opening or merging a pull request still needs the
   applicable explicit maintainer authority; a generated plan or review receipt
   cannot grant it. Record the actual task or batch authority without claiming
   that the maintainer personally read the diff. Unsolicited bulk submissions
   without an accountable human and authorized scope are closed regardless of
   quality; repeated submission is treated as abuse.

## Admission, native review and DCO

DCO certifies human provenance and the right to submit under the licence; it is
not a certification of code quality or personal reading of every diff. The
maintainer controls outcomes, important contracts and delivery authority.
Technical review of maintainer-authorized agent tasks is delegated to independent
fresh-context reviewers in the same task conversation.

An author without native-subagent capability or upstream write authority can
prepare signed local commits and public check evidence, then use the
[local contribution handoff](../CONTRIBUTING.md#local-contribution-handoff).
The authorized maintainer or supervisor owns independent native review, source
receipt comment submission and queue admission. A dependency guide or local
check result grants none of those rights.

The [autonomous delivery intent](../docs/platform/plans/autonomous-reviewed-delivery-intent.md)
and [implementation plan](../docs/platform/plans/autonomous-reviewed-delivery.md)
define the native subscription-backed default. The active supervisor launches
reviewers using the platform's own subagent tools, without author conversation
or another reviewer's verdict. Codex, Claude Code and future providers share
this contract. No model API, backend, new host or authentication transfer is
required; the maintainer performs no action between implementation and review.

Installed verify and pre-push must refuse missing, stale, partial, mismatched or
unresolved material evidence for the exact committed candidate. Their
`needs_agent_review` response is handled by the supervisor, not by asking the
maintainer to repeat an approved task. Each installation must demonstrate its actual refusal paths before claiming
live enforcement; fixture results are not activation proof.
Existing mechanical checks and publication authority remain unchanged.

Native execution observations and receipts enforce the process; they do not
cryptographically attest remote agent execution or establish hard OS separation
between author and supervisor. An author-written approval is not independent
review. The supervisor must obtain actual complete native platform observations.

The workflow records each task's outcome, scope, authority, acceptance,
risk and execution/proof plan in one compact record. A separate specification
is needed for an ambiguous or durable contract, not for every small task.
Agents may refine execution notes without changing approved goals or guarantees.
The [agent guide](../docs/platform/AGENT_GUIDE.md#change-and-verification-rules)
owns finite outcome, inherited exclusions, necessary recovery and completion.
Review checks that approved boundary; a discovery or optional recommendation
cannot add acceptance obligations. Handoff retains blockers and consumed attempts.
Programme or batch authority must be explicit; a generated plan cannot grant it.

The initial candidate receives one short cold review for ordinary prose or
narrow routine code, and two independent parallel bounded reviews for sensitive
or material behaviour, executable instructions, contracts, controls and unknown
risk; a specialist can fill one role. A third
reviewer is reserved for a distinct uncovered concern or dispute. Reviewers see
criteria and sufficient source context, not the author's conversation or each
other's verdicts. A blocker states the mechanism, precondition, violated
requirement and demonstrated effect on correctness or acceptance. Optional advice
and style preferences do not block; there is no findings quota and an
evidence-backed no-findings verdict is acceptable.

Routine means a narrow internal change whose behavior, tests and rollback are
understood. It excludes authorization, security, payment, personal or durable
data, migrations, public contracts, dependency or package publication, release
and CI controls, executable agent instructions, and unknown interactions. A
small diff or the author's risk label alone does not qualify. The native gate
refuses known sensitive paths; the single correctness reviewer must also confirm
ordinary semantics and the simplicity perspective. Uncertainty or a discovered
higher-risk interaction blocks the single-review route. Two fresh full reviews
of the same committed candidate can resolve that uncertainty without a
gratuitous code edit; prior evidence and the review-cycle budget remain visible.

Commit repairs before review. Give fresh reviewers the open finding cards and
obtain passing review of the new tree by the required number of reviewers.
Every material finding must be closed; optional advice never blocks. Evidence
expires 24 hours after the earliest counted PASS report for the current candidate.

Unchanged prepare preserves evidence. Three repair cycles are automatic; after
that `needs_owner` requires the owner to decide whether to continue, narrow or
stop. Record an authorized continuation with `continue "<note>"`, which adds
three cycles. A rethink remains recommended practice: question the criteria
and tool, group findings by root cause, consider simpler alternatives and record
`pattern → simpler path`. The [agent guide](../AGENTS.md#change-and-verification-rules)
owns this process; exhaustion cannot bypass review or authorize a merge.
The review base is the candidate's
fork point, the single `git merge-base HEAD origin/main`, so `main` moving ahead does not
by itself make a review stale. An optional `OPENLUP_STACK_BASE` can instead pin
an exact predecessor between that fork point and HEAD. The candidate binds this
pin, its own delta and the complete tree. Local checks use it consistently;
hosted source and group admission require the reviewed base on current main,
including for equal trees. Landing that predecessor
alone preserves the exact review without refreshing its expiry or resetting
history. No pin is needed for an independent PR, whose existing rules remain.
An exact two-parent integration of the prior reviewed head and the new main
base may use focused integration inspection when `prepare` proves valid prior
coverage in the same session with unchanged intent and author. Two fresh
reviewers approve the current tree after examining the complete integration and
base deltas, conflict resolution and interactions, including changed control
machinery. Source coverage keeps its earliest expiry. Missing or expired
coverage and uncertain interactions require full inspection; findings and the
same repair budget remain binding. See
[review after integration](../CONTRIBUTING.md#native-review-and-accountability). `prepare --new` records a changed intent or a rebase
in the same append-only session history; findings, reviewers and the repair
count carry on. Only an authorized `continue` adds cycles.
This focused inspection does not copy reports across trees or create another
receipt route; the merge-group carry-over rule below is unchanged. Once criteria, required review and
checks pass, stop optional edits and continue only authorized delivery steps.

Planning and review ask whether a simpler solution delivers the outcome faster,
with less maintenance and stronger evidence. New abstractions, dependencies,
retries, caches, artifacts or gates need a concrete benefit over the nearest
simpler alternative. Obvious small tasks need no alternatives essay. Measure
accepted outcomes, regressions, confirmed and false findings, lead time and
total cost; code and pull-request volume are not quality targets. This
perspective never waives existing controls or acceptance evidence.

The approved [native queue follow-up](../docs/platform/plans/autonomous-reviewed-delivery.md#approved-native-queue-follow-up-wave)
adds an optional GitHub admission transport, not another reviewer host. The
active supervisor retains actual native source-review observations and posts
`node scripts/agent-review-session.mjs receipt <PR>` output as a PR comment with
`gh pr comment <PR> --body-file -`, within delivery authority, as soon as the
pull request is open and ready, then waits for actual admission. Admission
checks the live PR head, tree, reviewer floor and expiry.

The source review carries over to a merge group when either:
- the group tree is the reviewed tree; or
- the group is exactly the reviewed change on its queue base, and the base's net
  change since the reviewed base touches neither the change's paths nor the
  admission, identity-binding, dependency and migration machinery (`.github/`,
  review scripts, the identity fence, package manifests and lockfiles,
  migrations).

Admission checks these conditions itself; the author declares nothing. The
mechanical checks on the group tree are then relied on for behavioural
interaction. Otherwise the group is rejected: merge `main` and re-review, then
post the new source receipt. Base integration still requires fresh current-tree
review, using the proved focused scope described above when eligible.

Activation requires separate explicit maintainer approval of the exact settings
and live refusal proof. A disabled or skipped admission job is not that proof.
The six mechanical checks remain required; active queue admission adds a seventh
required `native-review` context. Its success establishes freshness at admission,
not a guarantee that evidence remains unexpired at the eventual merge. GitHub
Actions source attribution does not isolate a workflow against a malicious
writer able to spoof the same context. Native receipts remain process evidence;
neither transport nor queue admission grants merge, release or settings authority.

## Why the current bar is where it is

Review capacity is the scarce resource in a small project, and generated volume
consumes it faster than it produces value. The four rules above keep provenance, authority and review work with the
contributor. Independent bounded review of an exact candidate reduces the
maintainer's reading burden; generated volume alone does not establish quality.
Neither a human-read claim nor a model verdict substitutes for required evidence.

The same reasoning, applied to security reports, is in
`.github/SECURITY_RESPONSE_POSTURE.md`.

## What makes agent work verifiable here

The enabling condition for this policy is machine readiness, not prose. The
project's answer to "did the agent actually get it right" is executable:
conformance suites that start red and must be made green, contract snapshots,
required evidence on public exports, and fail-closed gates that refuse an
unclassified path. Those are what make an agent's work falsifiable, and they
apply identically to human work.

## What this project does not claim

OpenLup is **not** marketed as an "agent-native platform". That label is
someone else's position, and a documentation layer for agents is by now an
ordinary feature rather than a differentiator. What is claimed is narrower and
checkable: *you can extend this safely, including by delegating to an agent,
because the readiness condition is machine-checked.*

## Changes to this policy

**Rules 2 and 4, decided 2026-09-23.** Rule 4 read: "A human opens the pull
request, having read it." It now lets an agent open a pull request on an
explicit instruction for that pull request from the human who read it, with the
pull request saying so, and rule 2 says that a sign-off such an agent writes is
that human's, certified by that read and, for commits added after opening, by
that human's review before merge. The reason: the rule exists so that no pull
request arrives without a human who has read it and answers for it, and that
depends on the read and the instruction, not on whose hand opens the pull
request. The decision is wrong if an agent-opened pull request turns out to have
contained a commit that no human read before it was opened, or was opened
without an instruction for that pull request; either would return rules 2 and 4
to their earlier text.


**Native-session delegation, decided 2026-09-27.** The maintainer authorized
review through isolated fresh-context native subagents in the same conversation,
under existing subscriptions. This replaces personal diff-reading claims for
maintainer-authorized agent tasks while retaining human accountability, DCO and
actual publication/merge authority. The earlier mandatory protected-root and
GitHub model API routes are superseded. Installed enforcement must still pass
its real refusal tests; process receipts are not cryptographic remote attestation.

**Source-keyed pull-request receipts, decided 2026-10-03.** The rule read that
the supervisor submits review observations "for the exact hosted run and
attempt".
Superseded by the [2026-10-19 simplification](../docs/platform/plans/native-review-simplification-proposal.md):
receipts are now PR comments, with no run-keyed receipt route.
- Pull-request runs now also accept one receipt bound to the pull request number
  and the exact reviewed head and tree, which admits every run and attempt of
  that head. Merge-group runs were unchanged by this decision; see "Review
  carry-over in the merge queue" below.
- The reason: six required reds in the native-review window were receipt
  timeouts. A run-keyed receipt can only be submitted after the run exists, and
  again for every rerun, although it carries the same evidence.
- Admission still re-verifies the live pull request, the run identity and the
  review's freshness each time.
- The decision is wrong if a source receipt ever admits a head, tree or pull
  request other than the one its reviewers covered.

**Review carry-over in the merge queue, decided 2026-10-03 (#121).** The rule read: "Unknown or sensitive interactions cannot be excused by filenames, path separation or an author-written approval". It also required two integration reviewers for every merge group whose tree differed from the reviewed source.

Superseded by the [2026-10-19 simplification](../docs/platform/plans/native-review-simplification-proposal.md):
a group that cannot carry over is rejected; merge `main` and re-review.

- **What changed.** A source review now carries over, and the pull request's source receipt admits the group, in two cases:
  - the group tree is the reviewed tree;
  - admission proves the group is exactly the reviewed change on its queue base, and the base's net change since the reviewed base touches neither the change's paths nor the admission, identity-binding, dependency and migration machinery.
- **The reason.** Each merge into `main` invalidated the reviews of every waiting pull request. With several pull requests in flight, that grew quadratically in reviews and needed a live session within a 20-minute window per group. Gated open-source projects rely on mechanical checks of the exact merged tree in the same way.
- **Unchanged.** Overlapping changes, and changes to that machinery, keep two integration reviewers.
- **Wrong if:** a carried-over merge admits an interaction that the mechanical checks on the group tree could not have caught, and that a reviewer would have.

**Review cycles with a rethink pause, decided 2026-10-15.** The rule read: "at most two automatic repair/review continuation cycles are allowed". Cycles 3 to 6 each needed a fresh owner decision, and three historic exceptions added exact paths or SQL at cycles 4 to 6.

Superseded by the [2026-10-19 simplification](../docs/platform/plans/native-review-simplification-proposal.md):
three automatic repair cycles, then an owner continuation adds three more.

- **What changed.** Cycles 1–3 are automatic, and cycle 3 is a full review. A cycle 3 that did not pass pauses for a rethink: a record, written with one fresh cold simplicity reviewer, that groups every finding card by class, names the root cause, weighs simpler alternatives and decides to keep, change or narrow the approach, or to take an intent change to the owner. Cycles 4 and 5 are then automatic; cycle 6 still needs the owner. Each rethink ends with a lesson that feeds [Review lessons](../CONTRIBUTING.md#review-lessons), which the author reads before cycle 1. The spent exceptions are removed.
- **The reason.** A second failed cycle rarely needed a human; it needed a different approach. One module-boundary lint rule spent three cycles chasing new escapes in a growing denylist of import specifiers before the owner could authorize cycle 3. The pause targets that loop where the owner gate did not.
- **Unchanged.** Receipts, freshness, the fork point, reviewer independence, finding cards, the six-cycle ceiling and the owner's decision for cycle 6 and for intent changes.
- **Wrong if:** rethinks become rubber stamps, so tasks reach cycle 6 as often as they reached the owner gate before, or lessons accumulate without changing how later tasks start.

