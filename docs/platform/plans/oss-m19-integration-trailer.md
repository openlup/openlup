# Trailer-only commit after a reviewed integration

Status: development-preview control change in preparation (2026-11-01).

Outcome: retain focused integration review when exactly one empty, single-parent
commit follows the qualifying two-parent merge and carries only a subject,
`OpenLup-Doc-Impact` trailers and optional `Signed-off-by` lines. The merge must
still join the prior reviewed head and the new review base in that order.

Scope: the native session's Git-object lineage capture, its existing decision
boundary, committed regression fixtures, publication inventory and the integration
guidance in CONTRIBUTING, documentation maintenance and both agent guides.
Keep the actual tip as `candidate.head`, including the trailer commit; normalize
only the parent evidence passed to the existing integration decision. This keeps
verify, receipts and queue admission bound to the same actual head and tree.

Exclusions: no documentation-answer or digest changes, trailers on merges as
answers, new receipt format, relaxed review, expiry, intent, author, finding,
repair-cycle or mechanical-proof rules; no package API, release or adopter change.

Authority and delivery: the maintainer's delegated coordinator approved this
bounded review-control change; the assigned stream supervisor coordinates it.
This worker implements and performs focused local proof, then supplies a stable
read packet before DCO. Only after that read may it sign commits and obtain two
independent fresh-context reviews. Canonical verification waits for supervisor
selection. Submission and landing retain their actual delegated gates; this
record grants no publication, settings, credentials or production action.

Code base and fetched policy revision: `3887ee7425fd0eddeecd9a8e2ef3e1420bcf640d`.
Branch: `codex/oss-m19-integration-trailer`; worktree: the identically named
dedicated task worktree. No other worktree is in scope.

Acceptance and proof: real Git fixtures exercise the accepted empty trailer tip
and refuse a changed tree, two commits, other trailers, body text, wrong merge
parents, a non-merge parent and merge-on-top. Existing pure decision cases retain
changed-intent/author, missing/expired coverage and findings refusals. Verify,
receipt and hosted/queue witnesses must bind to the actual trailer tip. Exact
`merge-tree` equality alone determines mechanical status. Run focused regressions,
ast-grep, published-tree policy/navigation and typecheck, lint and real package
packs through the required focused resource admission. Measure package delta;
none is expected. Do not run canonical verification before selection.

Risk: a mistaken lineage exemption could narrow inspection without valid source
coverage. A single nonrecursive classifier at Git capture is the smallest
adequate change; leaving the actual tip identity intact avoids special cases in
verification and admission. Reviewers inspect trailer reasons against current
documentation as well as the integration delta.

Execution evidence (2026-11-01, Node 24.21.0 / npm 11.19.0):

- Locked install passed. Required focused resource admission passed; one later
  admission waited 64 seconds. No canonical verifier was run.
- `npm test -- scripts/agent-review-gate.test.ts`: 36 cases passed; 25.31 seconds
  elapsed, 25.11 seconds in tests. This includes both the mechanical trailer tip
  and a trailer after extra merge edits, which correctly remains nonmechanical.
- `npx --no -- vitest run scripts/agent-review-session.test.ts`: 98 cases passed
  in 154 ms, including inherited expiry, findings, author/intent and cycle limits.
- `npx --no -- vitest run scripts/agent-review-queue.test.ts`: 189 cases passed
  in 333 ms,
  retaining hosted identity, reviewer-floor, expiry and carry-over refusals.
- Published-tree policy with `--docs-update`: passed, one obligation and zero
  unanswered. Ast-grep passed. Published-tree typecheck passed with zero unresolved
  edges and zero consumer errors. Its first attempt lacked built package
  declarations; the normal test pre-script built them before the passing rerun.
- `npm run lint`: passed, zero errors and 33 warnings outside this change.
- Real `npm pack --json --pack-destination <scratch>` runs for each of Core,
  Outbox and Platform at the base snapshot and candidate produced identical
  SHA-256 bytes per package. Compressed sizes: 182,871 / 41,407 / 2,111,198 bytes;
  unpacked sizes: 765,428 / 143,183 / 9,838,399 bytes. Total delta: zero bytes
  compressed and unpacked. Baseline extraction and artifacts stay in task scratch.

Initial pre-read checkpoint: source and guidance were ready for the stabilized control
read; at that checkpoint no DCO commit, counted review, push, PR or landing had
occurred. Native repair cycles consumed were zero. The next steps were the read,
two fresh reviews and supervisor selection of canonical verification.

Review saving: none realized at this checkpoint. The two-reviewer floor is
unchanged; the saving to measure is repeat full-source inspection versus the
integration/base deltas and trailer reasons. Record actual review durations and
scope when those observations exist; fixture execution time is not reviewer
cost, and no estimate is presented as a measured saving.

Self-retro at this checkpoint: preserving the actual tip avoided changes to
decision state, verify, receipt and queue schemas. Build package declarations
before direct typecheck on a fresh install; the premature run cost one failed
typecheck without a source defect. No rethink condition was reached. If this
optimization exceeds one day or review stops converging, stop and report.

## First native review and raw-message repair

The coordinator accepted the initial staged tree
`58b94f7f051db86cb8aed6b2dd43e6b5c29176ec` for DCO. Signed commit
`a51f6cce706c17accb823378cd8e18f95a183771` preserves that tree. Committed policy
passed with zero unanswered obligations and needed no trailer because the tooling
owner section was updated. DCO passed for the one commit. The configured gitleaks
scan passed across all 1,089 commits reachable from the task branch; an initial
run without the repository config reported historical findings and was superseded
by the canonical configured scan. No task WIP ref was created.

The two fresh independent native reviewers completed the initial candidate:
one PASS and one FAIL. Material finding `M19-TRAILER-NUL-01` demonstrated that
Git's pretty-printed `%B` can truncate a raw commit message at NUL, hiding
prohibited body text from the classifier. A task-owned literal Git-object witness
confirmed the truncation, `git fsck` warning with exit zero, and incorrect focused
recognition with mechanical status. The new real-object regression failed on
the committed implementation, discriminating this missing refusal boundary.

Repair: retain Git's parent/tree metadata, but obtain the complete message with
`git cat-file commit`, reject NUL and check every raw message line. This preserves
the existing head identity, parent checks and all other controls. The additional
fixture hashes the malformed commit literally within its disposable repository;
it never modifies another worktree or shared ref. The production-control repair
must receive its stabilized read before DCO, then fresh required review; the
finding is not closed by the author's proof. Native cycle remains zero until the
repair is committed and prepared. Neither first-review report is copied to the
repair tree. Canonical verification and all external delivery remain unrun.

Repair proof: the raw-object regression failed on the initial committed code,
then the complete real-Git gate suite passed all 37 cases in 19.18 seconds
(18.97 seconds in tests) after the raw-message repair. Installed package inputs
are unchanged, so the existing byte-identical real pack comparison remains
applicable. Additional current working-tree checks are recorded in task scratch
with the stabilized repair read: ast-grep, lint (zero errors, 33 existing warnings),
published-tree typecheck (zero unresolved edges and consumer errors), and policy
with navigation regeneration (zero unanswered) passed. No final verification is
claimed. The current stop is the required read of the production-control repair
before its DCO commit and fresh reviews; the original material finding stays open.

Measured workload context from the existing forced-integration case: its complete
own diff contains 76 paths, 21,365 changed lines and 1,211,743 patch bytes. Its
integration delta contains 14 paths, 789 added lines and 58,759 patch bytes; the
base delta has those same path/line counts and 58,629 bytes. The integration
delta input is 96.31% smaller by changed-line count. This is not a measured total
review-time saving: reviewers still inspect both deltas, both own-diff versions
and interactions. The supplied evidence says fresh integration reviewers were
not run and provides no timing/token comparison. No time saving is invented.

Updated self-retro: raw commit bytes are the message-shape boundary; pretty
display is insufficient. The discriminating raw-object witness was more useful
than adding ordinary body-text variants. Keep the actual tip rather than add
identity exceptions, and use the repository gitleaks config from the first scan.
One completed review evaluation exposed the finding; no regroup condition or
review-budget exhaustion was reached.
