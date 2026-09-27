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
   human's instruction, the sign-off is that human's, certified through the
   read that precedes authorising the pull request under rule 4 and, for
   commits added after the pull request is opened, through that human's review
   of them before it is merged.

3. **You must be able to explain every line.** If a reviewer asks why a line
   exists and the honest answer is "the model wrote it", the contribution is not
   ready. This is the whole test, and it is deliberately strict: it is what
   separates an assisted contribution from an unreviewed one.

4. **No autonomous, unattended pull requests.** An agent may write the code. A
   human reads the pull request and authorises opening it; an agent may then
   open it on that human's explicit instruction for that pull request, and the
   pull request says so. Bulk or automated submissions without a human in the
   loop are closed on sight, regardless of quality, and repeated submission is
   treated as abuse.

## Active admission and DCO

These are the active admission rules, including the human read in rules 2 and
4. DCO certifies provenance and the right to submit under the licence; it is not
a certification of code quality. Human reading is a separate admission control.

## Proposed delegation, pending enforcement

The [autonomous delivery intent](../docs/platform/plans/autonomous-reviewed-delivery-intent.md)
and [implementation plan](../docs/platform/plans/autonomous-reviewed-delivery.md)
propose delegating technical review while retaining an accountable human who
controls outcomes, important contracts and execution authority. They do not
yet replace rules 2 and 4 or authorize unattended submissions.

The replacement requires a protected controller that launches cold reviewers
and authenticates observed results for the exact candidate, plus required
hosted admission that refuses missing, stale, partial or unresolved material
evidence. Authors cannot issue their own accepted review. Existing mechanical
checks remain required; skipped checks are not successful execution. The
maintainer must explicitly activate the replacement after its refusal tests
pass. Until then, bootstrap contributions follow the active human-read rules.

The proposed workflow records each task's outcome, scope, authority, acceptance,
risk and execution/proof plan in one compact record. A separate specification
is needed for an ambiguous or durable contract, not for every small task.
Agents may refine execution notes without changing approved goals or guarantees.
Programme or batch authority must be explicit; a generated plan cannot grant it.

Ordinary prose receives one short cold review. Behaviour, executable instructions,
contracts and controls receive two independent bounded reviews; a specialist
can fill one role. Unknown classification uses that two-review floor. A third
reviewer is reserved for a distinct uncovered concern or dispute. Reviewers see
criteria and sufficient source context, not the author's conversation or each
other's verdicts. A blocker states the mechanism, precondition, violated
requirement and effect. Style preferences do not block; there is no findings
quota and an evidence-backed no-findings verdict is acceptable.

Planning and review ask whether a simpler solution delivers the outcome faster,
with less maintenance and stronger evidence. New abstractions, dependencies,
retries, caches, artifacts or gates need a concrete benefit over the nearest
simpler alternative. Obvious small tasks need no alternatives essay. Measure
accepted outcomes, regressions, confirmed and false findings, lead time and
total cost; code and pull-request volume are not quality targets. This
perspective never waives existing controls or acceptance evidence.

## Why the current bar is where it is

Review capacity is the scarce resource in a small project, and generated volume
consumes it faster than it produces value. The four rules above exist to keep the
cost of a contribution on the contributor rather than on the reviewer. A
contribution that a human has genuinely read and can defend costs a reviewer
roughly what a hand-written one costs. One that has not been read costs more than
it is worth.

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
