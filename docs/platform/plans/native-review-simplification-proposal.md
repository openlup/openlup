# Native review simplification: proposal for owner decision

Status: approved by the owner 2026-10-19; implemented in this change.
Transport option A (PR comment) was chosen. This is step 3 of the CI test-time
programme. Steps 1–2
(aggregate `test` job; run tooling tests only when their inputs change) belong
to a separate session and are not touched here.

The inventory, timings and staged-delivery alternatives below record the proposal
at approval. The binding approved interface uses version-2 sessions, expiry from
the earliest counted PASS report for the current candidate, three automatic
repair cycles with `continue "<note>"` adding three, and `prepare --new` after a
rebase or changed intent. The command wrapper remains a verify-before/after
wrapper with optional resource brokering; merge previews, proof leases and
policy/inventory runs are removed from it. The current
[session interface](autonomous-reviewed-delivery.md#native-session-interface)
owns executable instructions.

## Summary

Native review costs **97 s of the 573 s required-test budget in CI** (17 %;
session 74 s, queue 21.5 s, gate 1.2 s; run 39302608975). Locally the three
files take **143 s** (229 cases). The mechanism is 22 days old and has
**1,226 production LOC** plus **1,600 test LOC**. Its session test file grew
from 22 KB / 49 cases to 102 KB / 142 cases.

The cost is concentrated. **Five tests take 69 s of the 143 s locally.** In CI,
one test alone takes 34 s. They run the real policy checker and drive the
entire 0→7 repair-cycle lifecycle through Git and the CLI. The 30 pure
repair-convergence cases take 0.1 s in total. The decision logic is already
cheap; the I/O-heavy end-to-end tests are expensive.

Recommendation, in three parts:

1. **Do now, no rule change:** split decision logic from Git/CLI I/O, rewrite
   tests as tables, and keep six real-Git witnesses. Target: **≤ 10 s in CI**
   (from 97 s), with behaviour unchanged.
2. **Owner decision:** cut controls without an observed failure. Remove the
   raw Git object-graph authentication, the closure and inherited-expiry
   machinery, the encoded rethink and owner-cycle state machine, the
   integration-review receipt route, and the compressed full-session receipt.
   Keep five properties:
   - exact tree binding;
   - 24 h expiry;
   - two reviewers for sensitive paths;
   - fork-point base and carry-over to a merge group;
   - a bounded repair counter.
3. Target after both parts: **~450 production LOC and ~500 test LOC**.

## 1. Per-rule inventory

Sources: Codex reconnaissance of HEAD `5f0e2d8` and `git log --all`; local
`vitest --reporter=json` on this worktree; CI log of run 39302608975. LOC
figures overlap because rules share code. Test seconds are local per-case sums
(CI is about 0.65× local, except the policy-checker test, which is slower in CI).

"Observed" means a real operational failure appeared in a commit or plan
record. A counterexample found during review or dogfooding is marked
"review-found". No row records a malicious bypass in production.

| # | Rule | Prod LOC | Cases / local s | Failure it prevents | Observed? |
|---|---|---:|---:|---|---|
| R1 | Exact base/head/tree/index/request binding | ~120 | 10 / ~1 | Review applied to other bytes | Partly. Dogfood `e2190c8` showed a false rejection (a reviewer copied the tree id wrongly). No wrong-source admission was ever seen. Core requirement. **Keep.** |
| R2 | 24 h expiry, plus expiry inherited by closure rounds | ~80 | 9 / <1 | Stale evidence refreshed by a small re-review | Preventive. **Keep the 24 h limit; drop inheritance.** |
| R3 | One vs two reviewers (path regexes, mode/symlink, semantic escalation) | ~75 | 36 / <1 | A sensitive change admitted by one reviewer | Calibration (`1af873f`), with no incident. **Keep the path and mode floor.** Semantic escalation stays reviewer prose. |
| R4 | Repair cycles 1–3, rethink, 4–5, owner cycle 6, 7 refuses | ~155 | 7 / **~30** (one CLI lifecycle test: 27 s) | Endless repair loops | Friction observed (`7dca521`, `dfc7e3f`, `488a0b3`). The budget is justified. The encoded owner-continuation digests and rethink-identity checks answer no observed failure. **Collapse to a counter.** |
| R5 | Owner regroup; rebase → `needs_rescope` | ~110 | 25 / ~5 | Intent silently replaced; findings dropped | Preventive (`ddba890`); no bypass seen. **Collapse.** |
| R6 | Fork-point review base | ~30 | 6 / ~14 | Each main merge invalidated reviews | **Observed** (`79fa048`). **Keep.** |
| R7 | Stack pin `OPENLUP_STACK_BASE` | ~45 | 7 / ~3 | Squash landing left a stale merge base | **Observed** (`88f2709`, `f946e9d`). **Keep** (small). |
| R8 | Queue carry-over (equal tree, or `merge-tree` plus disjoint paths plus protected list) | ~50 | 20 / ~6 | Each main merge invalidated queued reviews | **Observed** (`6c79d11`). **Keep.** |
| R8b | Integration-review receipt (`input RUN ATTEMPT`, two fresh group reviewers) | ~60 | ~8 / ~5 | A group that cannot carry over | Designed with R8; no commit or plan records it used. **Cut.** When carry-over fails, the group leaves the queue and the author merges `main` and re-reviews. |
| R9 | Receipt transport: dispatch workflow, artifact, v3 gzip+base64, provenance | ~165 | 25 / ~8 | Receipt missing within 20 min; oversized input | Missing receipts **observed** (6 of 110 runs, `04e4a24`), which justifies source receipts reusable across runs. Compression exists only because the receipt carries the full session history. **Shrink the receipt to a summary; drop compression.** |
| R10 | Raw Git object-graph authentication (`agent-review-hook.mjs`) | ~170 | 8 / ~4 | Substituted loose-object bytes in the local repo | Review-found only. It caused an **availability failure**: a 128.5 MiB history was refused (`fa9e304`, 2026-10-19, still on M04 branches only). The threat is the local machine attacking itself. AGENTS.md already says receipts are "process evidence, not cryptographic remote attestation". **Cut**, and rely on Git's own hashing plus `transfer.fsckObjects`. |
| R11 | Pre-push / verify stamp | 0 here | 0 | Pushing an unverified tree | Observed (B:22), but implemented outside the public tree. **Out of scope.** |
| R12 | Closure reviewer, finding cards, prior-coverage lineage | ~115 | 31 / 0.1 | Lost findings; churn from optional advice | Process correction (`7dca521`). **Keep finding IDs and an "all closed" check.** Drop closure-versus-full lineage validation; which kind of review to run becomes reviewer policy. |
| R13 | Reviewer independence (`cold`, non-author, unique ids) | ~65 | 9 / <1 | The author counted as a reviewer | Preventive. **Keep the three cheap checks.** Context isolation stays orchestration prose. |
| R14 | Simplicity pre-check field; nonblocking advice | ~90 shared | 13 / <1 | Optional polish forcing repairs | Process. **Keep "advice never blocks"; move the pre-check to prose.** |
| R15 | Hardened state file (no-follow, symlink ancestors, hardlink, lock, 8 MiB) | ~80 | 6 / ~3 | Symlink/FIFO tricks; concurrent lost writes | Concurrency **observed** (`56761ff`); symlink cases review-found. **Keep lock and atomic write; drop the symlink and hardlink defences.** |
| R16 | `verify-command` frozen proof: merge preview, lease, resource broker, policy/inventory | 137 | 9 / **~25** (34 s in CI) | Expensive proof of superseded source; parallel load | Load timeouts **observed** (C:1330). This is local proof orchestration, not review. **Move out of native review**, to `openlup-dev` or a separate script with its own stubbed tests. |
| R17 | Hosted admission identity: exact PR/run/attempt, six successes, 20 min wait | ~185 | 11 / ~6 | Stale head; missing checks; endless wait | Partly observed. **Keep, simplified** around the summary receipt. |

Time check: R4 (30 s) + R16 (25 s) + R6 (14 s) + the R1/R5 snapshot cases make
up about 75 % of local time. Each of these is an I/O witness. Their decision
coverage does not need real Git.

## 2. Recommended minimal mechanism

### Industry norm

| Need | Usual tool | OpenLup today |
|---|---|---|
| Review bound to exact code | Branch protection dismisses approvals on a new push (bound to head SHA) | R1, tree plus request digests |
| Extra review on sensitive paths | CODEOWNERS with required reviewers | R3, path regexes, two reviewers |
| Review survives an unrelated main move | Merge queue; approvals carry over and CI re-runs on the group | R6 + R8, plus the R8b integration-review route |
| Review evidence | GitHub review or a bot status on the head SHA | R9 dispatch workflow, compressed artifact, polling job |
| Object integrity | Git's SHA hashing; `fsck` on transfer | R10, a second hand-written authenticator |
| Repair budget | None (human judgement) | R4, a six-stage encoded state machine |

Reviewers here are AI sub-agents with no GitHub identity, so a receipt is
still needed. Beyond that, the norm needs no object authenticator, no encoded
repair state machine and no second review route for merge groups.

### Proposed mechanism (about 450 LOC)

1. **Local session (`agent-review-session.mjs`, ~250 LOC).**
   - `prepare` records the base (fork point or stack pin), the head tree, the
     paths and the risk (path and mode floor).
   - `record` adds reviewer reports. Each report has a reviewer id (not the
     author, unique, `cold`), a verdict and findings with stable IDs.
   - `verify` passes when all of the following hold:
     - the HEAD tree equals the reviewed tree and the worktree is clean;
     - the latest report is less than 24 h old;
     - enough distinct reviewers passed (1 routine, 2 sensitive);
     - every material finding is closed;
     - the repair counter is ≤ 3, or the record holds an owner continuation
       (one boolean plus a note).
   - History is kept as an append-only list. There is no regroup state
     machine: a changed intent starts a new session that references the old one.
2. **Receipt = summary (~200 bytes).** It holds `{pr, base, head, tree,
   risk, reviewers:[ids], verdict, expires, sessionDigest}`. There is no
   compression and no history inside it.
3. **Hosted admission (`agent-review-queue.mjs`, ~200 LOC).** It recomputes
   the risk floor from the PR diff, so CI decides one versus two reviewers
   itself. It checks head/tree, expiry and the reviewer count, plus the six
   successes. For a merge group: carry over when the trees are equal, or when
   `merge-tree` succeeds and the base delta avoids the change's paths and the
   protected list. Otherwise it fails with "merge main and re-review".
4. **Transport.** Option A (recommended): the supervisor posts the summary as
   a PR comment from the owner account. `native-review` reads comments by
   write-permission authors, and the PR number of a merge group comes from
   `gh-readonly-queue/main/pr-N-…`. This deletes `native-review-admission.yml`,
   the artifact handling and the polling. Its trust is equivalent to today,
   where anyone with write access can dispatch. Option B: keep the dispatch
   workflow but carry the summary only.
5. **Deleted:** `agent-review-hook.mjs`; v3 compression; the R8b integration
   route; the closure-lineage, inherited-expiry, rethink-identity and
   owner-digest checks; symlink defences; and the `verify-command` wrapper
   (moved out).

### AGENTS.md rule text that would change (owner decision)

The "Change and verification rules" section in AGENTS.md and
`docs/platform/AGENT_GUIDE.md` changes together:

- **"Commit repairs before review. A narrow repair … one fresh cold closure
  reviewer … Closure must account for every prior material finding and cannot
  renew inherited evidence expiry …"** Replace with: a repair needs a passing
  review of the new tree by the required number of reviewers, given the open
  finding cards. Expiry counts from the latest report.
- **"Handle `needs_agent_review` … cycles 1–3 … rethink … 4 and 5 … Cycle 6
  needs a fresh explicit owner decision bound to the preserved fifth request
  … a seventh refuses."** Replace with: three automatic repair cycles, then
  the owner decides (continue / narrow / stop). The rethink remains
  recommended practice, not an encoded gate.
- **"A rebase discards that lineage, so `prepare` reports `needs_rescope` …"**
  Replace with: a rebase or a changed intent starts a new session, which
  references the previous one.
- **The whole "Then the pull request's source receipt admits … Otherwise the
  run-keyed receipt with two fresh independent full integration reviews
  applies" paragraph, and the `input RUN ATTEMPT … group-session.json`
  command.** Replace with: a group that cannot carry over is rejected; merge
  `main` and re-review.
- **"Native session receipts are process evidence, not cryptographic remote
  attestation …"** Keep, and add that source objects are trusted through Git's
  own hashing.
- The CONTRIBUTING.md sections "Native review and accountability", "Review
  lessons", "Merge queue", "Required and raw checks" and "Deliver a change",
  together with `autonomous-reviewed-delivery*.md`, follow the same edits. The
  plan's stale two-cycle wording (P:35–55, 205–209) is removed with them.

Unchanged: the required check name `native-review`, branch protection and
rulesets, merge authority, DCO, two reviewers for sensitive paths, and expiry.

## 3. Test strategy

Historical proposal and timing targets below, not current inventory or measured
budgets. Follow [testing](../../../CONTRIBUTING.md#test-scope-and-diagnostics) for
the current three-file native-review batch and scope rules; the pure session
tables remain unlisted and always run.

- **Logic module** (`scripts/agent-review-decide.mjs`, pure). Inputs are
  plain objects: candidate, session, reports, clock and group facts. Outputs
  are a verdict and a reason. Tests are tables of
  `[name, state, expected verdict/reason]`, one row per rule edge (about 70
  rows). They take **< 0.5 s**.
- **I/O adapters** (thin): Git capture, state file and GitHub reads. They
  contain no decisions.
- **Real-Git witnesses (6)**, each with at most about 30 spawned processes:
  1. capture → verify PASS on a real repo;
  2. a commit after review → refusal;
  3. a main move past the fork point → still PASS;
  4. a merge group with a disjoint base move → carry over;
  5. an overlapping base move → refusal;
  6. hosted `wait` against a fake GitHub API with one poll.
- **No test** runs the real policy checker, more than one repair cycle through
  the CLI, or real `zip`/`unzip`.

| | Before | After part 1 (no rule change) | After part 2 |
|---|---:|---:|---:|
| Production LOC (session + queue + hook) | 1,226 | ~1,250 (split only) | ~450 |
| Test LOC | 1,600 | ~900 | ~500 |
| Test cases | 229 | ~230 (same coverage, tables) | ~80 |
| CI test seconds (`test` job) | 97 | **≤ 15** | **≤ 8** |
| Local test seconds | 143 | ≤ 20 | ≤ 10 |
| CI `native-review` job | 15 s | 15 s | ~10 s (no artifact polling with option A) |

Part 1 alone removes about 85 % of the time cost without touching any rule,
because the slow cases are I/O witnesses of decisions that tables can cover.
With step 2 from the sibling session, these tests then run only when their
inputs change.

## 4. Staged delivery

Every PR changes `scripts/agent-review-*` or the workflows, which are control
paths. Each therefore gets **two fresh full native reviews under the rules in
force at its base**. A PR that removes a rule is still reviewed under that
rule. Hosted admission always runs from trusted main, so a PR is admitted by
the old code and the new code applies after it merges. Merge, settings and
ruleset actions stay with the owner, under the existing per-PR merge grant.

| PR | Content | Rule change? | Gate |
|---|---|---|---|
| **P1** | Extract `agent-review-decide.mjs` (no behaviour change). Convert decision tests to tables. Replace the 5 slowest tests with stubbed-command and single-cycle witnesses plus table rows that keep each assertion. | No | Characterization: the same verdicts for every existing case, listed in a mapping table in the PR. |
| **P2** | Remove R10 (`agent-review-hook.mjs`, GT) and set `transfer.fsckObjects` on the hosted fetch. Remove the R15 symlink defences and the R14 field. Edit AGENTS.md, AGENT_GUIDE.md and CONTRIBUTING.md. | Yes: owner | It also closes the availability failure that `fa9e304` patches. Coordinate so that `fa9e304` either lands first or is superseded. |
| **P3** | Collapse R4/R5/R12/R2 inheritance into a counter plus owner flag, finding IDs and an "all closed" check. Edit the rule text. | Yes: owner | Sessions open at merge time either finish under the old code or restart. P3 states which. |
| **P4** | Summary receipt with hosted risk recomputation; remove R8b and compression; transport option A or B. If A, delete `native-review-admission.yml` and add a comment reader. The job name stays `native-review`. | Yes: owner (transport choice) | No ruleset change, because the check name is unchanged. A dual-read window accepts both receipt formats for 24 h (one expiry) and is then removed in the same PR series. |
| **P5** | Move `verify-command` (R16) into maintainer-local tooling or a separate script with its own stubbed tests. Update CONTRIBUTING. | Yes: owner | It touches maintainer-local tooling outside this tree only through the documented seam. |

P1 can start immediately after approval and is independent of P2–P5. P2–P5
are ordered to limit conflicts in `agent-review-session.mjs`. Each is about a
day of Codex work plus a two-reviewer cycle.

## Decisions requested at proposal time (resolved 2026-10-19)

1. Approve **P1** (test restructuring, no rule change).
2. Approve the **rule cuts** in part 2: all of them, or pick from R10, R4/R5/R12
   collapse, R8b, R9 summary and R16 move-out.
3. Choose the transport: **A (PR comment, delete workflow)** or **B (keep the
   dispatch workflow, summary only)**.

## Evidence

- Local timing: `vitest run` of the three files on HEAD `5f0e2d8`, using the
  JSON reporter (229 passed, 143 s summed).
- CI timing: run 39302608975, jobs `test` (118231407992) and the full shards.
- Rule history: Codex read-only reconnaissance of `git log --all`. Key commits:
  `e2190c8`, `deb03a7`, `7dca521`, `1af873f`, `ddba890`, `79fa048`, `6c79d11`,
  `04e4a24`, `e863fe0`, `dfc7e3f`, `488a0b3`, `f946e9d`, `c88c70b`, `fa9e304`.

## Documentation implementation record

Outcome and scope: align the two agent guides, permitted native-review sections
of CONTRIBUTING and the named platform plans/recovery references with the
owner-approved interface. Authority: documentation edits and policy checks in
this assigned worktree only; no commit or external write. Code changes and
CONTRIBUTING local-verification commands/required-check lists belong to parallel
sessions. Acceptance: current commands and rules agree, historical procedures
are clearly superseded, and the policy-check result is reported. Proof: compare
the location-adjusted guides, inspect the scoped diff and run
`npm run oss:published-tree -- --policy`, refreshing Markdown navigation if asked.
Simplicity pre-check: update existing owners and summarize superseded mechanisms
instead of adding a new manual or review process.

Verification result: the guide bodies match after relative-link normalization;
all local Markdown link targets in the nine edited files exist. CONTRIBUTING's
local-verification sections, required command/check lists and delivery steps 2/4
remain byte-identical to the starting HEAD. The focused ast-grep scan and
Markdown whitespace check pass. `npm run oss:published-tree -- --policy` exits 1
before documentation checks: `config/openlup-publication-catalog.json:
publicPaths: paths must be unique and sorted`. The concurrent catalogue change
is outside this documentation-only scope; no navigation refresh was requested
before that refusal. No commit or stash was made.

Self-retro: a scope-check script initially used a paragraph marker that this edit
had replaced; comparing the old and new markers separately fixed the check.
Keeping historical approval/activation records with explicit supersession notes
preserved evidence without carrying retired procedures into current guidance.
