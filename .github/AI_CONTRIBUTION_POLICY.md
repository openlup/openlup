# AI contribution policy

**AI-assisted contributions are welcome. They are not banned, and they will not
be banned.**

That sentence comes first because the opposite is this category's reflex, and
here it would be self-contradictory: OpenLup is itself developed with AI agents,
and the platform is built so that adopters can extend it with AI agents. A
project that forbade what it practises would be lying about one of the two.

The policy is therefore **disclosure and accountability**, not permission.

## The four rules

Moved to [AI-assisted contributions](../packages/core/docs/guide/reference/ai-contributions.md#contribution-responsibilities).

Sign-off under the Developer Certificate of Origin is the accountable human's;
the DCO requirement in `CONTRIBUTING.md` applies unchanged to AI-assisted work.
A tool cannot sign off, and the maintainer's own agents are no exception: when
an agent writes the sign-off line on a human's instruction, the sign-off is that
human's, certified by that human's authority over provenance, submission rights
and task delivery scope. Delegated technical review does not assert personal
reading of every diff.

Record the actual task or batch authority without claiming that the maintainer
personally read the diff.

## Admission, native review and DCO

DCO certifies human provenance and the right to submit under the licence, not
personal reading of every diff or code quality. One active supervisor coordinates
the task's evidence and authorized delivery. Provider and model choice assign no
rights: record the actual actors, permitted actions, submission and merge grants,
and remaining human gates. Local work or review delegation does not transfer
coordinator-only external-write authority.

[Deliver a change](../CONTRIBUTING.md#deliver-a-change) is the canonical sequence
for worktrees, task records, checks, independent review, receipts and queue delivery.
An author without upstream write authority can use the
[local contribution handoff](../CONTRIBUTING.md#local-contribution-handoff).
Review receipts and generated plans grant no publication, merge, credential,
settings or release authority. Protected release approval and separate-repository
work retain their own explicit authorization boundaries.

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

These dated decisions are history. Current delivery and review follow
[Deliver a change](../CONTRIBUTING.md#deliver-a-change).

**Review binds to the change, decided 2026-11-05.** The rules read that review
evidence expires after 24 hours, that a base move touching the change's paths or
the review machinery stops carry-over, and that a merge of `main` needs two
fresh integration reviewers and full local verification. A review now covers
the candidate's own change: a clean merge carries it, a conflict needs review of
its resolution only, a repair is reviewed as its delta, reviews do not expire,
and hosted CI on the integration tree is the required verification.
- The reason: each move of `main` re-triggered review and local verification of
  unchanged work, which took most of a landing's time without catching defects
  that the required CI and the change's own review would miss.
- Unchanged: trusted-main admission, required CI, the receipt binding reviews to
  the head, finding closure, reviewer independence and no force-push.
- Wrong if: a clean merge or a reviewed resolution admits a defect that the
  required CI on the group tree could not catch and a re-review would have.

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

**Superseded for current work.** The **Native-session delegation, decided
2026-09-27** decision below replaces the personal-read condition in this
historical revision for maintainer-authorized agent tasks. Current
accountability, DCO, submission-authority and review requirements are the four
rules and admission contract above.


**Native-session delegation, decided 2026-09-27.** The maintainer authorized
review through isolated fresh-context native subagents in the same conversation,
under existing subscriptions. This replaces personal diff-reading claims for
maintainer-authorized agent tasks while retaining human accountability, DCO and
actual publication/merge authority. The earlier mandatory protected-root and
GitHub model API routes are superseded. Installed enforcement must still pass
its real refusal tests; process receipts are not cryptographic remote attestation.

**Provider-neutral allocation, decided 2026-10-24.** The owner authorized the
minimal public/private policy amendment and delivery through merge. Native
subagents and qualified fresh local CLI contexts may provide independent review
under the same logical task and evidence history. This extends the execution
route above without changing V2 state/receipts, reviewer floors, budgets, expiry,
required checks or reserved owner acts. The amendment itself uses the previously
allowed native review route; CLI use requires actual execution proof and any
applicable programme allocation amendment. Existing tasks may adopt at a stable
boundary without a new programme admission or evidence reset.

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
a group that cannot carry over is rejected; merge `main` and re-review. Superseded
again by "Review binds to the change" above: a clean merge carries the review.

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
