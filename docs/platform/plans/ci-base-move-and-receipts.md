# Plan: checks that survive a moving `main`, and pull-request receipts without a race

Status: executed on 2026-10-03 (W0 #112, W2 #113, W1 #114, W3 #115, W4 #121; local steps 0b and 4 applied); W5 (fork-point review base) approved the same day.
Audience: the agents executing it, their reviewers and the maintainer.

## 1. Why: recorded failures only

**Window.** The window is the 110 non-skipped pull-request and merge-group runs of
Published Tree CI from the first native-review run (2026-09-27) to 2026-10-02.
Counts below are completed runs. In that window, required contexts went red in
14 completed runs (15 attempts). None was caused by a check that local
verification failed to run.

**Cancelled runs** are not counted. Two cancelled runs had already shown the
fence red, and one a `native-review` red.

| Runs | Context | Cause | Fixed by |
|---|---|---|---|
| 6 pull request | `native-review` | No receipt within the 20-minute wait. The receipt is keyed to the run and attempt, so it can only be submitted after the run exists, by a live session, and again for every rerun. | W2 |
| 3 merge group | `self-check` | The no-impact doc marker digest includes the base SHA, and the group base differs from the pull-request base. | W1 (S1) |
| 4 pull request (5 attempts) | `self-check` | The identity fence compares the checkout with the `synchronize` payload's `merge_commit_sha`, which lagged. The parents matched the event's base and head. One followed an ordinary push. Three followed the authors' "merge main" pushes after the merge-group reds. | W1 (S2) |
| 1 pull request | `self-check` | Neutrality ratchet increase from the candidate's own new file. Local verification runs this exact check, but nothing ties a push to a passing verification of the pushed tree. | Local mirror patch (step 4) |

Everything else is out of scope. Section 6 lists it, with the evidence that
would reopen each item.

## 2. Rules for every step

- **One step, one pull request.** Each step means one task worktree, one branch
  and one pull request, opened ready for review, in the fixed order W0, W2, W1.
  - Each step branches from `main` after the previous step has merged.
  - A desktop session that runs in its own isolated worktree uses that worktree:
    it cannot edit another worktree, and it cannot move.
  - That worktree is bootstrapped as `openlup-dev new` would bootstrap it:
    worktree identity, its own install, and registration for native review.
- **Review.** Two independent native reviewers for every step, because each
  touches sensitive paths, including `CONTRIBUTING.md`. A fresh full review
  follows any change to the candidate.
- **Falsifiers first.** Write the listed failing tests first and run them on the
  unchanged code. If one passes, stop and report.
- **Scope.** Only the files listed for the step. Any other file needed means stop
  and report; no scope growth. Test files that pin old behaviour are part of the
  step's scope.
- **Receipts.**
  - **Merge-group runs:** when the source review carries over (S4), the pull
    request's source receipt admits the group. Otherwise submit the run-keyed
    (v1) receipt with integration evidence as soon as the run exists.
  - **Pull-request runs:** one source-keyed (v2) receipt per reviewed head
    (S3), submitted as soon as the pull request is open and ready. Before W2
    merged, this was a run-keyed receipt per run.
  - To submit: `agent-review-queue.mjs input` (or `input-source`), then a
    dispatch of `native-review-admission.yml`.
- **Owner read** (W2 only).
  - The maintainer reads the final reviewed candidate before auto-merge is armed,
    and confirms the read, with the candidate SHA, to the executing session.
  - The agent records that confirmation in the pull-request body.
  - Any later change to the candidate voids the read.
  - The read must fall within the review's 24-hour validity, or the review is
    repeated.
- **Queue.**
  - Once the required checks, the native review and any owner read are done,
    arm auto-merge with
    `gh pr merge --auto --squash` and the maintainer's configured author email.
  - Never rebase only because the branch is behind. If `main` moved, S4 decides
    whether the source review carries over or two integration reviews apply.
  - Rebase only on a textual conflict, followed by a fresh full review.
- **Stop and report**, with no repair attempted, on any of:
  - two repair cycles exhausted;
  - a required red that the step did not cause and that is not an objective
    flake. A flake means the same job passed on the same tree, or a `gh run
    rerun` (a new attempt) passed without a code change. One requeue for a
    flake uses the existing retry budget, and a second removal of the same head
    stops for diagnosis;
  - a need to change anything outside the listed scope.

  Stopping hands control back to the maintainer. "Stop and report" is the only
  stop this plan uses.

## 3. Authority requested (one approval)

The maintainer approves, once:
- W0, W2 and W1 as bounded delivery through merge. That covers:
  - creating task worktrees and opening the three pull requests;
  - dispatching `native-review-admission.yml` for them;
  - rerunning their Published Tree CI runs;
  - arming squash auto-merge with the maintainer's configured author email.
- That W2 reverses one approved property, for pull-request events only.
  Currently "an old same-SHA success cannot admit a new run/attempt with no new
  receipt". Under W2, a receipt bound to the reviewed head and tree admits any
  run of that exact head. Several receipts for one head are allowed, where v1
  refused several for one run and attempt, because each receipt is re-verified
  at admission. Merge groups stay unchanged until W4.
- W4 (approved on 2026-10-03, after W0–W3): a source review carries over to a
  merge group as S4 defines. Merge groups that do not qualify keep the run-keyed
  route.
- W5 (approved on 2026-10-03, after W4): the local review base is the
  candidate's fork point, as S5 defines. The maintainer reads it before
  sign-off and alone reinstalls the maintainer-local copy.
- The sign-off classes:
  - W2 changes an admission control, so the owner reads it. That read of the
    final candidate before merge certifies the sign-offs the agent wrote on its
    commits, and the squash commit carries the sign-off;
  - W0 and W1 pass on native review and the required checks;
  - W1's documentation checks are neither release, npm, security nor public
    API controls.
- The local mirror patch (step 4), which only the maintainer applies.

No release, repository setting, ruleset, secret or npm action is included.

## 4. Runbook

### Step 0: approval

- **Entry:** this plan as a reviewed draft.
- **Exit:** the maintainer's written approval of section 3. Until then, no step
  starts. Approved on 2026-10-03.

### Step 0b: local temporary directory (maintainer)

- **Why.** Dogfooding step 1 found a local-only red on clean `main` b2e8800.
  - The configured local verification mirror points `TMPDIR` inside the task
    worktree, which lies under the root `package.json` with `"type": "module"`.
  - The release workflow authenticity test runs a CommonJS fixture from a
    temporary directory. Locally Node loads it as an ES module and it fails;
    hosted runners use a temporary directory outside the repository, so it
    passes there.
  - With `TMPDIR` outside the worktree, the same test passes locally.
- **What.** The maintainer points the mirror's `TMPDIR` outside every checkout,
  matching hosted runners.
- **Exit:** verification of clean `main` exits 0. No step pushes before this.

### Step 1, W0: publish this plan and the queue rules

- **Scope:**
  - this file and its row in `config/openlup-publication-catalog.json`;
  - the regenerated `config/openlup-source-release-contract.json`;
  - a merge-queue paragraph in the "Pull requests" section of
    `CONTRIBUTING.md`. It states the queue rules of section 2 (no rebase for
    freshness, the objective flake rule, the receipt timing) as standing
    contributor rules.
- **Exit:**
  - required checks are green;
  - native review of the exact candidate passes;
  - the pull request is merged;
  - verification has exit 0 before the push.

### Step 2, W2: pull-request receipts keyed to the reviewed candidate (spec S3)

- **Scope:**
  - `scripts/agent-review-queue.mjs` and `scripts/agent-review-queue.test.ts`;
  - in `CONTRIBUTING.md`, the native-review text and W0's receipt-timing rule;
  - the identical lines 140 and 148 of `AGENTS.md` and
    `docs/platform/AGENT_GUIDE.md` (exact run/attempt, and the `input` command);
  - one amendment paragraph in the native-transport section of
    `docs/platform/plans/autonomous-reviewed-delivery.md`, and line 106 of
    `autonomous-reviewed-delivery-intent.md`;
  - in `.github/AI_CONTRIBUTION_POLICY.md`, the "exact hosted run and attempt"
    sentence, plus a dated entry under "Changes to this policy".
  - No workflow file changes.
- **Falsifiers first:** R1 and R2 fail on `main`. They fail because the new
  exports do not exist yet, which is acceptable.
- **Exit:**
  - R1–R10 pass;
  - native review passes;
  - the owner read is recorded;
  - the pull request is merged.

### Step 3, W1: documentation checks that survive base moves (specs S1, S2)

- **Scope:**
  - `scripts/documentation-impact.ts` and `scripts/documentation-git.ts`;
  - `scripts/documentation-impact.test.ts`;
  - the marker description in `docs/platform/DOCUMENTATION.md`;
  - the merge-group paragraph in `CONTRIBUTING.md`.
- **Falsifiers first:** P1 and F1 fail on `main`.
- **Exit:**
  - P1–P6 and F1–F5 pass;
  - native review passes;
  - the pull request is merged;
  - the pull request body lists open pull requests carrying a no-impact marker
    that must be re-answered once.
- **Live proof of W2,** recorded in the W1 pull request:
  - its pull-request run was admitted by a v2 receipt, with no v1 artifact for
    that run and attempt;
  - one `gh run rerun` (a new attempt) was admitted without resubmission.

### Step 4: local mirror patch (maintainer)

- **Entry:** W1 merged.
- **What happens:** an agent drafts the patch outside the public tree, and the
  maintainer reviews and applies it to the configured local verification mirror.
  The patch makes verification:
  - record a stamp of the exact clean tree it passed. The pre-push gate stays
    offline and refuses a tree without a stamp. This answers table row 4.
  - run the two raw diagnostics only on opt-in, or when the diff reaches the
    database inputs. This saves local time: the diagnostics are permanently
    red, give no local signal, and hosted CI shows them on every run.
- **Exit:** the mirror's self-test and doctor pass with the new cases.

### Done, and the regroup rule

**Done:**
- W0, W2, W1 and the W3 follow-up merged with green required contexts;
- the W2 live proof recorded;
- the step 4 self-test green.

A report of required reds by class over the next 30 merges follows, but does not
gate completion.

### Step 5, W3: follow-up hardening

From the review advice and dogfooding of W0–W1:
- **Admission.** On a pull-request run, an unreadable or untrusted run-keyed
  artifact no longer blocks the source receipt; merge groups still refuse it. A pull
  request and its run must carry an integer head repository ID. Source
  submission observes the pull request before fetching objects.
- **Tests.** A live PR head that moved while the event head did not. P1 also
  moves an untouched path of the same unit. P6 expects exactly one failure.
- **Documentation.** Record binding covers content and mode; freshness compares
  with the base only. This plan's status, window and receipt rules.
- **Local mirror (maintainer-local).** The verify temporary directory takes an
  override, so the mirror's self-test leaves nothing in the home directory.
  Doctor accepts every workflow blob that verify mirrors.

Sign-off: the maintainer reads the candidate before sign-off, because it
changes an admission control.

### Step 6, W4: review carry-over in the merge queue

**Why.** On 2026-10-03, #118 entered the queue right after another pull request
merged. Its group tree therefore differed from the reviewed tree, and admission
needed two integration reviews from a live session within the 20-minute wait.
With several pull requests in flight, every merge into `main` repeats that cost
for each waiting pull request.

**What.** Specification S4: a source review carries over to a merge group that
is exactly the reviewed change on a base whose net change avoids its paths and
the admission, identity-binding, dependency and migration machinery. The pull
request's source receipt then admits the group. A refused carry-over is logged,
and the group keeps waiting for the run-keyed receipt.

**Scope:**
- `scripts/agent-review-queue.mjs` and its tests;
- the AI contribution policy, plus a dated change entry;
- the delivery plan and its intent;
- `AGENTS.md` and the agent guide;
- `CONTRIBUTING.md` and the development and release guide;
- this plan.

**Sign-off:** the maintainer reads the candidate before sign-off, because this
changes an approved admission rule.

**Live proof:** two independent pull requests armed together, both admitted in
the queue by their source receipts alone.

**Stop and report instead of repairing** if any of these happens:
- a receipt timeout on a pull request whose v2 receipt was submitted in time;
- a base-SHA or fence red after W1;
- a step that needs a file outside its scope.

### Step 7, W5: a local review survives a moving `main` (spec S5)

**Status:** approved 2026-10-03.

**Why.** The local review session bound a review to `origin/main` itself. When
another pull request merged before the author pushed, verify and pre-push
refused the exact reviewed commit, and the author had to rebase and obtain a
fresh full review. That contradicts the no-rebase-for-freshness rule of
section 2, and is the local twin of the queue cost W4 removed.

**What.** Specification S5: the review base is the candidate's fork point.

**Scope:**
- `scripts/agent-review-session.mjs` and its tests;
- the review-base sentences in `AGENTS.md` and the agent guide,
  `CONTRIBUTING.md` and the delivery plan;
- this plan.

**Sign-off:** the maintainer reads the candidate before sign-off, because this
changes the review gate that verify and pre-push run.

**Installed copy.** Verify and pre-push run the maintainer-local installed copy
of the session script, and add no base check of their own. S5 takes effect
locally only after the maintainer reinstalls that copy from `main`; until then,
including for this step's own push, the base must still equal `origin/main`.

## 5. Specifications

Line numbers refer to `main` at b2e8800. Tests are named by their `it(...)`
title where one exists.

### S1. Documentation obligation digest v2

**Contract.** In `checkDocumentationImpact` (`scripts/documentation-impact.ts`),
the obligation digest hashes:

```ts
{ version: 2, unit, doc, anchor,
  source: changedPaths.map((path) => ({ path, before: binding(before.get(path)), after: binding(after.get(path)), ownership: owners.get(path) })),
  section: documentationDigest(normalized) }
```

That is, v1 without `base`, with `version` 2 and the key order as written.

**Unchanged:**
- the marker syntax and its three keys;
- one applicable marker per unit;
- the freshness rule (a marker identical to one in the base section is not
  fresh);
- the substantive-update path and the failure message;
- `DocumentationImpactResult.base`.

There is no v1 acceptance. Markers already on `main` are never rewritten.

**Known limit.** A prose edit in the base to the section that owns a unit still
invalidates that unit's marker. The large development section of
`CONTRIBUTING.md` owns several units, so this can still happen. That is
intended: the answered section changed.

**Falsifiers.**
- **P1.** A marker answered against `B1` stays valid after an unrelated base
  commit, giving `B2`, when the candidate is `B2` plus the same change. It fails
  today. The test "binds source modes, the exact base, and unchanged section
  content" asserts the opposite after an empty next-base commit. Invert that
  assertion, and rename the test so it no longer claims to bind the exact
  base.
- **P2.** A base commit that edits a changed path fails. Use a multi-line
  `SOURCE` so the merge is clean (guard).
- **P3.** A base edit to the owner section's prose fails (guard).
- **P4.** A marker identical to one in the base section is not fresh (guard).
- **P5.** Two markers for the unit fail (guard).
- **P6.** A base routing change for a changed path fails (guard).

### S2. Pull-request identity fence

**Contract.** In `hostedBase` (`scripts/documentation-git.ts`), remove the
`merge_commit_sha` clause. The pull-request branch then admits the checkout when
all of these hold:
- `HEAD === GITHUB_SHA`, which is already checked first;
- `base.sha` and `head.sha` are full SHAs;
- the parents of `HEAD` are exactly `[base.sha, head.sha]`.

The `push` and `merge_group` branches are unchanged.

**Falsifiers** (beside the test "validates the actual PR merge parents"):
- **F1.** Correct parents with a stale `merge_commit_sha` are accepted. This
  fails today.
- **F2.** Swapped parents, built with `git commit-tree`, are refused.
- **F3.** One parent is refused.
- **F4.** A first parent other than `base.sha` is refused.
- **F5.** `HEAD` other than `GITHUB_SHA` is refused.

F2–F5 are guards.

### S3. Source-keyed pull-request receipts

**Input v2.**
`node scripts/agent-review-queue.mjs input-source PR source-session.json`
produces:

```json
{ "version": 2, "target": { "event": "pull_request", "prNumber": "<positive integer>", "sourceHead": "<40 hex>" }, "source": "<session state>", "integration": null }
```

`parseNativeAdmission` accepts v1 unchanged, and v2 with exactly these keys,
under the same 56,000-byte bound.

**`submit` for v2,** run on trusted `main` with `native-review-admission.yml`
unchanged:
- A new exported `observeSourceAdmission(api, input)` requires:
  - the PR is open, not a draft and not merged;
  - its base is `main` in this repository;
  - `pr.head.sha`, `target.sourceHead` and `source.request.candidate.head` are
    all equal;
  - the commit's tree equals `source.request.candidate.tree`.
- No workflow run is required.
- Source verification and freshness work as in v1. Only the source base and head
  are fetched.
- The artifact name, output as today, is `native-review-pr-<prNumber>-<sourceHead>`.

**Admission**, refactored for tests:
- Add an exported
  `waitNativeAdmission({ event, env, api, cwd, now, sleep, deadlineMs, fetchObjects })`,
  which `main()` calls with the real `fetchObjects`. Tests inject a no-network
  fetch over a local fixture repository. It reads the target run as
  `api.get(/repos/openlup/openlup/actions/runs/${env.GITHUB_RUN_ID})`.
  Behaviour is unchanged for v1 and for merge groups.
- For a `pull_request` event:
  - First try the v1 artifact for this run and attempt.
  - Otherwise use a new exported `readSourceAdmissionArtifact(api, prNumber,
    sourceHead)`.
  - Among non-expired artifacts with the v2 name, it takes the newest one whose
    dispatch run passes the existing provenance checks, and whose
    `receipt.input.target.prNumber` and `sourceHead` equal the requested ones.
  - A resubmission carries the same evidence, so several are allowed.
  - Artifacts that fail provenance are skipped rather than fatal, because the
    name is predictable and any run can upload one.
  - An incomplete listing refuses, as in v1: more than 100 artifacts with one
    name.
- It then repeats `observeSourceAdmission` and source verification at that
  moment, and requires all of these:
  - the v1 run identity, which is
    `run.id`/`run_attempt` from the environment, `run.repository.id ===
    REPOSITORY_ID`, `run.path === WORKFLOW` and an integer `workflow_id`;
  - `run.event === 'pull_request'`;
  - `run.head_sha === sourceHead`;
  - `run.head_branch === pr.head.ref`;
  - `run.head_repository.id === pr.head.repo.id`;
  - `event.number === prNumber`.
- Freshness is sampled at admission.
- Merge groups ignore v2 artifacts.

**Falsifiers** (`scripts/agent-review-queue.test.ts`, with injected `api`,
`now` and `sleep`):
- **R1.** A v2 receipt submitted before any run admits a later run of that head.
  This fails today.
- **R2.** The same receipt admits a new attempt and a later run of the same head
  without resubmission. This fails today.
- **R3.** A different head of the same PR is refused.
- **R4.** The same head under another PR number is refused.
- **R5.** An expired review at admission is refused.
- **R6.** A draft PR at submit is refused.
- **R7.** A v1 receipt still admits its exact run and attempt (guard).
- **R8.** A merge group ignores a v2 artifact (guard).
- **R9.** A run whose head repository differs from the PR's head repository is
  refused, and so is a run from another workflow file.
- **R10.** An artifact with the v2 name that fails provenance is skipped. A
  valid older one still admits.

### S4. Review carry-over in the merge queue

**Contract.** For a `merge_group` run with no usable run-keyed receipt,
`waitNativeAdmission` first finds the queue entry whose head is `GITHUB_SHA`. It
reads that entry's PR number and reviewed head as a hint, then reads the source
receipt for that PR and head (S3).

`verifyGroupSourceAdmission` then admits the group in four steps:
1. Observe the group exactly as the run-keyed route does: run identity, queue
   membership (first position), entry, ref, base and tree. This is reused from
   `observeNativeAdmission`.
2. Verify the source review and its freshness.
3. Require `carryOverSourceReview`, which passes when either condition holds:
   - **Unchanged tree:** the group tree equals the reviewed tree.
   - **Disjoint base move:** all three of these hold:
     - the source base is an ancestor of the group base;
     - `git merge-tree --write-tree --merge-base=<source base> <group base> <source head>`
       equals the group tree, so the group is exactly the reviewed change;
     - no path changed between the source base and the group base is a
       reviewed path, or matches this machinery: `.github/`,
       `scripts/agent-review-*`, `scripts/documentation-git.ts`, root or
       package `package.json` and `package-lock.json`, `supabase/migrations/`,
       `config/platform-migration-manifest.json`.
4. Repeat the observation and compare it with the first.

The hosted event's base, head and ref must match the binding. When the
carry-over refuses, the refusal is logged and the wait continues, so every other
group still reaches the unchanged run-keyed route with two integration reviews.
The merge-tree prediction runs with a clean git configuration and rename
detection off.

**Falsifiers** (`scripts/agent-review-queue.test.ts`, merge groups admitted by
their source receipt):
- **G1.** A behind group whose base moved only on unrelated paths is admitted.
- **G2–G4, G7, G8.** The carry-over is refused with a logged reason, and the wait
  continues, in each of these cases:
  - **G2:** a reviewed path moved;
  - **G3:** each listed machinery path changed;
  - **G4:** the group has an unreviewed extra change;
  - **G7:** the review has expired;
  - **G8:** the change conflicts with the base.
- **G5.** A group with the unchanged tree is admitted.
- **G6.** An entry that names another head waits.
- **Run-keyed route still reachable.** A run-keyed receipt with two integration
  reviews, uploaded during the wait, still admits a group that does not carry
  over.

G1 and G5 fail on the implementation before W4.

### S5. Fork-point review base

**Contract.** In `scripts/agent-review-session.mjs`:
- the fork point is the single merge base of `HEAD` and the observed
  `origin/main` (`git merge-base --all`, commit graph off). None, or several,
  refuses;
- `captureSessionCandidate` defaults its base to the fork point and requires a
  given base to equal it, in place of equality with `origin/main`. Prepare,
  record, verify, status and the pristine baseline all bind through it;
- `prepare` defaults `base` to the fork point instead of `origin/main`.

So:
- `main` moving ahead leaves the fork point, and the evidence, current;
- a repair commit on the un-rebased branch keeps its base and lineage;
- merging `main` into the branch moves the fork point, and the existing
  ancestor-preserving base integration with fresh full review applies;
- a rebase rewrites the reviewed head: as before, prepare reports
  `needs_rescope`, and a fresh session starts at the new fork point;
- a rewritten `main` on which the reviewed base is no longer the fork point
  refuses.

**Unchanged:** exact head, tree, working and index digests; the authenticated
object graph; 24-hour freshness; lineage, delta and the two-cycle budget; hosted
admission, which already verifies a review against its own base; S4.

**Known limit.** Locally, the review covers the change against its fork point,
not the current `main`. The merge queue checks the integration: S4 carries the
review over only on an unrelated base move, and otherwise two integration
reviews apply.

**Falsifiers** (`scripts/agent-review-session.test.ts`, "fork-point review base
(S5)"):
- **(a)** Reviewed at base B, `origin/main` advances on an unrelated path, and
  the unchanged candidate still verifies as reviewed.
- **(b)** `main` rewritten so that B is not an ancestor: verify refuses (guard).
- **(c)** Prepare after `main` advanced, on the unchanged candidate, preserves
  the evidence byte for byte.
- **(d)** A repair commit on the un-rebased branch gets a closure continuation
  at base B.
- **(e)** Merging `main` moves the base to M with a full continuation. A rebase
  reports `needs_rescope`, and a fresh session takes base M (guard).
- A pristine checkout stays pristine when `main` moves ahead of it.

(a), (c), (d) and the pristine case fail before W5; (b) and (e) differ only in
the refusal wording.

## 6. Deferred, with the evidence that would reopen each

- **Diagnostics off the pull-request and merge-group events:** runner-slot
  saturation, or a missed signal blamed on permanent diagnostic red.
- **Contract digests only when touched:** a recorded merge-group removal caused
  by a contract conflict.
- **Changelog fragments:** a recorded conflict removal on a changelog.
- **Merge-preview local checks:** a required red that a check on the merged tree
  would have caught.
- **More than one queue build:** measured queue wait.
- **Conflict replay:** a merge-group removal caused by a textual conflict.
- **Parallel local checks:** a local verification time that blocks delivery.
