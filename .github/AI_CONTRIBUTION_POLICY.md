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
   unchanged to AI-assisted work. A tool cannot sign off.

3. **You must be able to explain every line.** If a reviewer asks why a line
   exists and the honest answer is "the model wrote it", the contribution is not
   ready. This is the whole test, and it is deliberately strict: it is what
   separates an assisted contribution from an unreviewed one.

4. **No autonomous, unattended pull requests.** An agent may write the code. A
   human opens the pull request, having read it. Bulk or automated submissions
   opened without a human in the loop are closed on sight, regardless of
   quality, and repeated submission is treated as abuse.

## Why the bar is where it is

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
