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
gratuitous code edit; prior evidence and the two-cycle budget remain visible.
The changed-tree merge-queue integration route still requires two full reviews.

A committed narrow repair within unchanged approved intent, scope and base may
use one fresh cold closure reviewer after the complete initial floor and prior
rounds are retained and exact lineage is validated. The closure prompt includes
neutral prior finding cards, actual repair and interaction context, never prior
verdicts or author history. Every prior material finding needs an explicit
disposition. The reviewer independently confirms semantic risk; control,
security, schema, executable instruction and unknown repairs retain two focused
reviews, even in otherwise ordinary source files. Reduced repair reviews cannot
renew inherited evidence expiry. Unavailable, incomplete or expired coverage
requires two fresh full-scope reviews, preserving prior findings and lineage.

Unchanged prepare preserves complete evidence. The task has at most two automatic
repair/review continuation cycles across prepare and full-review escalation. Exhaustion
stays blocked while the supervisor regroups the execution approach within actual
authority; it cannot restart the counter, bypass review or merge automatically.
Changed intent requires explicit regrouping. An ancestor-preserving base
integration requires fresh full-scope review within the same budget; this route admits no
cross-base reuse. Once criteria, required review and checks pass, stop optional
edits and continue only authorized delivery steps.

Planning and review ask whether a simpler solution delivers the outcome faster,
with less maintenance and stronger evidence. New abstractions, dependencies,
retries, caches, artifacts or gates need a concrete benefit over the nearest
simpler alternative. Obvious small tasks need no alternatives essay. Measure
accepted outcomes, regressions, confirmed and false findings, lead time and
total cost; code and pull-request volume are not quality targets. This
perspective never waives existing controls or acceptance evidence.

The approved [native queue follow-up](../docs/platform/plans/autonomous-reviewed-delivery.md#approved-native-queue-follow-up-wave)
adds an optional GitHub admission transport, not another reviewer host. The
active supervisor retains actual native source-review observations and submits
them for the exact hosted run and attempt. A queue group with the same complete
tree as the reviewed source needs no new review; a different tree requires two
fresh independent integration reviewers with unchanged approved criteria and
separate group identity. Unknown or sensitive interactions cannot be excused by
filenames, path separation or an author-written approval. Nonqueue base
integration still requires fresh full-scope review under the existing protocol.

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
