# Public delivery workflow

Status: S1–S2 landed in [PR #507](https://github.com/openlup/openlup/pull/507).
The S3 qualification checkpoint below rejects the tested cache techniques;
useful stage recovery and S4–S10 remain undelivered. Public workflow v1 is partial.
Audience: contributors and supervisors improving the development-preview
delivery workflow. This record owns the outcome, sequence and current task;
[CONTRIBUTING](../../../CONTRIBUTING.md#deliver-a-change) owns the procedure.

## Intent and guarantees

Give a contributor one explanation of the applicable obligations, then execute
that same plan. Later targeted repeats should retain complete valid evidence
from independent stages, including successes in an otherwise failed run, and
rerun missing or invalidated work. Early local defect detection and proof of the
actual integration remain required. A partial result must never become a
complete PASS merely because its available stages are green.

Keep the workflow in this public repository, usable without a private helper,
private repository or provider credentials. Reuse the existing runner, package
discovery, test selection, native review and Queue Handoff. Add no framework,
package name, parallel registry or queue service for this programme.

Dogfooding may justify a routine correction, a simpler technique or dropping an
unhelpful experiment within the accepted outcome and authority. Record its
observed value, cost and KEEP / ADJUST / DROP decision in existing task evidence.
A dropped technique does not satisfy its undelivered outcome. A changed goal,
weaker gate, new risk or external authority boundary needs its owning decision.

## Schedule checks before review

Keep the approved working-tree checks and scoped tests for the changed
contract. If a committed candidate still needs a broad pre-review diagnostic,
refresh `origin/main` once at that boundary and run the early preflight before
requesting the resource slot. Set `OPENLUP_TRUSTED_CHECKOUT` to the absolute path
of a separate checkout of trusted main that contains the planner. Run the command
from the candidate worktree. Export the candidate's existing
`OPENLUP_STACK_BASE` for a stacked change.

First run `git fetch origin main` through the existing authorized fetch path.
After a successful refresh, run the following separately. The probe works
with read-only Git metadata because its temporary merge objects use a
disposable directory.

```sh
pre_review() (
  : "${OPENLUP_TRUSTED_CHECKOUT:?set to the checkout of trusted main}"
  original_objects=$(git rev-parse --path-format=absolute --git-path objects) || exit
  scratch_objects=$(mktemp -d) || exit
  trap 'rm -r -- "$scratch_objects"' EXIT
  mkdir "$scratch_objects/info" || exit
  printf '%s\n' "$original_objects" > "$scratch_objects/info/alternates" || exit
  GIT_OBJECT_DIRECTORY="$scratch_objects" node --input-type=module - "$OPENLUP_TRUSTED_CHECKOUT" <<'NODE'
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const planner = pathToFileURL(resolve(process.argv[2], 'scripts/verification-plan.mjs'));
try {
  const { preflightBeforeReview } = await import(planner);
  console.log(await preflightBeforeReview());
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
NODE
)
pre_review
```

Schedule the diagnostic only after the command succeeds. If a task script
schedules the diagnostic, use the preflight command as the first operand of
`&&` before the existing resource request. A failed prediction comes before
heavy work. The local pending-predecessor result permits local work and still
requires the exact predecessor to land before queue admission. The predictor
uses the existing native decision against the fetched ref. Later native
preflights remain the owner of current admission decisions.

A prepared candidate continues at its first outstanding obligation. Keep its
exact commit, stack pin, existing review history and valid local verification
or installed stamp. The planner does not require a review or write review or
verification records. Use it when there is still a broad diagnostic to schedule,
and use the existing delivery checks for a candidate ready to submit. Reserve
broad pre-review execution for a named interaction that the focused probes
cannot establish. Complete the full required gate after native review, once on
the actual candidate unless an existing recovery rule requires another run.

<!-- openlup-task-doc-impact {"unit":"tooling","doc":"CONTRIBUTING.md","anchor":"#development-preview-checks","digest":"sha256-48bbe21827488d20e42be875ef86f715a4f43e46dce096fcbd2b8a43021adf3a","reason":"The scheduling probe runs the existing native merge prediction before a resource request for an explicitly selected diagnostic. It is not part of the mandatory verification runner and does not change its phases, proof, receipt, stack-base or hosted admission rules. The development-preview checks section still describes those obligations. The scheduling procedure and its limits are explained in this delivery record."} -->

## S1–S2 delivery scope

S1 supplies one local obligation catalogue and read-only explanation. S2 makes
the runner consume that catalogue and moves both neutrality checks before
installation and heavy phases. The value is an accurate answer before costly
work and earlier refusal of known cheap defects.

Scope: `scripts/verification-plan.mjs` and its adjacent test;
`scripts/verify-local.mjs` and its existing test; the public publication
catalogue, contributor guidance, development guide, documentation index and
this record, with their required generated navigation/context updates.
Package and bounded tooling inventories retain their current owners.

The public interface is the existing runner with `--plan`, optionally `--json`
and `--pgtap`. Planning reads Git scope without running checks, installing
dependencies, validating review or creating run output. Unknown scope retains
all obligations and exits 2. It works on an unreviewed dirty task worktree;
that availability supplies no execution or delivery evidence.

Execution retains all thirteen mandatory phases, explicit raw pgTAP selection,
existing resource profiles and serialized shared-output phases. It still
requires a clean committed candidate and current native review, wraps executed
commands with native verification, checks the final candidate/review and stops
at the first failure. There is no stage reuse or path-based narrowing in S1–S2.
See [required and raw checks](../../../CONTRIBUTING.md#required-and-raw-checks)
for the commands and [development diagnostics](../DEVELOPMENT_AND_RELEASE.md#what-each-diagnostic-proves)
for their evidence boundaries.

Exclusions: proof caches/resume, changed review counts or expiry, source/group
CI selection, required contexts, queue admission, settings, release, npm
publication and production. Later checkpoints below add no current obligation
or implementation authority to this task.

## Authority and source

Bart Roszkowski is the accountable human. The approved S1–S2 task permits local
implementation and dogfooding, required review and verification, DCO commits,
branch push and a draft pull request. It grants no merge, queue activation,
settings, release, package publication, credential operations, external spending
or production action.
The supervisor owns integration and external delivery; workers retain their
assigned file ownership. Required stabilized reads and native review follow the
[AI contribution policy](../../../.github/AI_CONTRIBUTION_POLICY.md) and
[contribution rules](../../../CONTRIBUTING.md#deliver-a-change).

Initial implementation base and instruction revision:
`21c057038b25db6bdf490496a341df5b2f1fdbcc`.
At the repair boundary, main advanced to
`2d5547dcccb5d9e3c40bece5016382fbf9f6a670`; its relevant instructions were
unchanged. Native carry-over refused the moved package/catalogue inputs, so that
main was integrated into this task branch. Current review and final verification
bind the actual integrated candidate; this grants no PR merge or shortened proof.
Branch: `codex/delivery-workflow-s1-s2`, in its assigned task worktree.
Current instructions are read separately from candidate review evidence under
[instruction freshness](../../../CONTRIBUTING.md#instruction-freshness-and-handoffs).

## Acceptance and dogfooding

- Independent expectations preserve the existing commands, environment and
  resource profiles for both pgTAP variants. Only the two neutrality phases
  move earlier; no mandatory phase disappears. Unknown, duplicate, missing or
  wrongly ordered obligations refuse.
- Explain works without review, dependencies, scanner or broker, changes no
  checkout/index bytes and emits no execution PASS. Invalid Git comparison is
  visibly unknown with all obligations retained.
- Execution matches the explained plan for the same candidate. Missing,
  mismatched, dirty or expired native evidence and candidate drift still refuse;
  broker-present and broker-absent routes preserve their existing behavior.
- An isolated real-checker fixture demonstrates neutrality refusal before the
  first heavy phase. Source/group job contracts retain independent assertions
  about required coverage and event attribution; agreement with a copied table
  alone is insufficient.
- Use explain while preparing this change, inspect actual obligation output and
  compare it with execution. Run focused owner tests and cheap checks before
  counted review, then the complete required verification. Hosted observations
  remain distinct from local proof and draft submission.

The existing `verification-plan` and `verify-local` suites own command/CLI,
ordering, native refusal, failure and identity witnesses. The bounded
`ci-test-scope` selector and required package gate retain their own tests.
Documentation policy/navigation, structural checks, lint and public typecheck
remain required. No unexecuted proof is reported as passing.

## Later checkpoints

These are the accepted programme direction, pending separate implementation
scope and applicable control/delivery authority. Dependencies express outcomes,
not a requirement for one pull request per row.

| Checkpoint | Depends on | Observable value and completion boundary |
| --- | --- | --- |
| S3: useful stage recovery | S2 | Preserve a costly complete stage after an independent later failure. First investigate the whole package gate on the same candidate; retain its exact artifact identity and prove real recovery value before adding reuse. If no useful case exists, combine the minimal enabler with S4. |
| S4: repeat after a real repair | S3 | A new candidate reuses an unaffected stage only after its actual input/output closure is proved. Missing, corrupt, changed or uncertain evidence reruns the appropriate complete stage; a historical PASS cannot mask a known later failure. |
| S5: public workflow v1 | S1–S4 | A contributor without private tooling can explain, execute and perform one qualified repair/repeat or use the existing authorized-supervisor handoff. Same-candidate retry alone does not close the repair outcome. |
| S6: review with retained coverage | S2 | An independent reviewer can assess repairs and delta with preserved findings/history; new risk expands coverage. Mechanical restack and source-review lifetime changes require their own proved native-control decisions. |
| S7: remove a hot aggregate | S2 | Two disjoint additions integrate without a manual shared-list union, while complete inventory and refusal checks remain independently tested. Migrate one measured conflict source and retire the obsolete exception. |
| S8: dependent admission | S3, S6 and trusted admission proof | Admit a bounded ordered pair before its predecessor lands. Verify every member, receipt and predecessor; prove each landed prefix or an actual atomic bundle, with bounded ejection/recovery. |
| S9: proportionate source CI | S4, S8 and source-environment proof | Remove a redundant source execution only when equivalent early complete evidence exists; otherwise keep the early hosted check. Preserve proof of the actual merged tree and separately authorize settings activation. |
| S10: natural proof units | Measured repeat costs from S3, S4 or S9 | Recompute affected suites/consumers without losing discovery or shared-input coverage. Sub-test coverage reuse needs correct contribution subtraction/union and fresh global guards; otherwise coverage remains a whole stage. |

## Execution notes

2026-11-02: explain worked on the dirty task worktree. The three focused
plan/runner/scope suites passed 91 tests; the expanded plan/runner/publication/
neutrality batch passed 168 tests after adding an explain-versus-review refusal
witness. The real UI checker rejected the isolated fixture before installation
or any of the seven heavy phases. A direct comparison with the pre-extraction
runner at the base above confirmed identical commands, environment and resource
profiles for all 13/14 phases; only the two neutrality positions changed.
The read-only CLI fixture also compared Git index bytes and checkout entries.

The first committed full run stopped at tree-wide neutrality: the negative
fixture had copied its forbidden token into the test source itself. No install
or heavy phase started. Constructing the same synthetic input from fragments
preserves the intended real-checker refusal without a scanner exemption. This
reinforces the existing review lesson to check source/fixture policy before
counted review; the scanner and its budget remain unchanged.

KEEP: the shared catalogue explains and executes the same obligations, and the
earlier check prevents avoidable heavy work. Keep package discovery and tooling
selection with their owners; do not add a dynamic CI engine. These focused
observations are not canonical verification or hosted qualification. Native
review, full exact-candidate verification and draft submission follow; their
durable identities and results belong in the PR evidence.

Self-retro: the first explanation is also the runner's source of obligations;
keeping selection and package discovery with their existing owners avoids a
second catalogue. S1–S2 can provide value while the later reuse experiment
remains pending.

## Current task: S3 qualification

Intent: avoid repeating a costly complete stage after an independent later
failure, while keeping defect detection close to the code and proving the current
candidate. The approved fallback permits dropping an unhelpful pilot and joining
the minimal enabler to the first useful repair case. A rejected experiment does
not deliver recovery, and passing prototype tests cannot substitute for its value.

Bart Roszkowski initially authorized local implementation, parallel workers,
deliberate faults, dogfooding and draft submission, with no merge. On 2026-11-03
he authorized repairing #509, then building S3 on its actual base, and subsequently
explicitly instructed this supervisor to merge #509 and then S3 after the required
local and hosted evidence. That later grant permits the necessary ready, receipt,
admission and queue steps. It supersedes the earlier branch/draft/merge holds;
it resets no native budget and activates no unlanded review exception.

This task uses branch `codex/delivery-workflow-s3`. Its initial stack base was
#507 head `59560a429db85a271597baa0e5151fde997b88b6`; final submission uses
actual main containing both predecessors, pinned in native review and PR evidence.
The supervisor owns integration, commits and authorized delivery. Workers assessed
package recovery and built separate input-profile and runner prototypes; fresh
independent agents challenged package qualification and the integrated pilot's
value. Those challenges are qualification advice, not counted native approval.
Necessary #509 recovery retains its own task record, findings and consumed cycles.
At task start #507 was held as a draft with `do-not-merge`; it subsequently landed
outside this task as `31423ca5b3e44698eb9a1ce342addad3e58b5d71`.

Settings, release, publication, provider faults and external spending remain
outside this authority. Current native evidence and actual source/group checks
remain binding. Instruction policy was checked at main
`5054c53dc81b246b81fb77122aeb71f92cfbdd75`, separately from the code review base.
The landed review/history/report-scope rules and their owning contributor and
documentation sections were read. S3 retains fresh full prose review and the
complete local verification route; it inherits no model or stage proof.

Acceptance for the qualification checkpoint: inspect retained real runs before
choosing a donor; identify the later failure and actual assumptions it preserves;
measure the proposed stage and validation cost; exercise invalidation boundaries
with controlled local inputs; retain or drop the technique using that evidence.
Activation additionally requires a real useful recovery with observed complete
stage execution and a measured full repair loop. That activation acceptance has
not been met. The final deliverable records the decision and leaves the fresh
runner, mandatory phases, native guards and coverage unchanged.

### Package recovery observation

The retained local sample contains 40 result records: 26 overall PASS and 14 FAIL;
34 package executions, 32 package PASS, and four root failures after package PASS.
It contains no confirmed root broker-admission timeout. This convenience sample
is not a failure-rate estimate or a measurement of cache savings.

One M19 starter/upgrade pair repeats the same head, tree, base and recorded main:
head `4d72bfdf407bb23f93ea7b4c022eebd45418826d`, tree
`8815283dd690b55eac7674ab17137926bfaa5cb8`, base
`a7ce403cef3b790c28418d786f153e50ac595084`. The first root run timed out at
10,000 ms in the source-preview same-feature pin fixture; the retry passed.
The timeout's cause remains unknown. It was not a broker refusal.
Packages took 147.775 s then 148.566 s; root tests took 812.441 s then
793.391 s. Retry wall time was 1,133.094 s; the two-run loop was 2,342.843 s.
The retained set manifests were byte-identical, as were each of their three
package tarballs, and the hashes matched. Reusing the second package execution
would hypothetically remove
148.566 s before validation overhead, or 13.1% of the retry and 6.3% of the loop.
No such reuse was performed.

ADJUST: identical artifacts do not close package-proof inputs. The actual
consumers retain ambient environment and npm configuration; installed dependency
bytes, transitive resolution and mutable database-image inputs also matter.
The manifest precedes API and required consumer completion. It cannot certify
those obligations by itself. Keep packages fresh; do not implement a cache on
the strength of the historical timeout or an exit status alone.

### Whole-typecheck experiment and controlled faults

A bounded local prototype tested the next candidate: the complete public
typecheck, with all other phases fresh and current native guards still required.
It fingerprinted source, ignored typed inputs, actual dependencies and package
declarations, pinned the checker runtime and tools, and required an owner-emitted
file inventory from every configured compiler project. The only proposed
cross-candidate exception was content of this existing task record; path, mode,
base and all other inputs remained bound.

On the pinned Node 24.21.0/npm 11.19.0 toolchain, a supporting probe of the five
actual compiler projects observed 7,434 files, zero positioned or unpositioned
diagnostics, 27.160 s compiler time and 4.890 s closure validation. Two full
input snapshots over 67,325 files took 11.413 s then 2.857 s and produced the
same key. These are component observations, not canonical native verification,
an executed cache hit or a measured recovery-loop saving. Even two warm
snapshots would consume roughly 5.7 s per hit before native/history validation;
capturing a reusable donor also pays closure and snapshot costs.

The profile's 41 focused tests passed. Deliberate local falsifiers covered
changed ignored declarations and generated package declarations, escaping links,
an actual FIFO special file, outside compiler reads/configuration, dependency
type redirection, missing completion and unsupported runtime/environment inputs.
The runner's 33 focused tests passed, including synthetic missing helper output,
concurrency and candidate drift. Runner subprocess stubs test control flow;
they do not establish actual compiler reuse, later-failure independence or value.
No live provider or shared daemon was faulted.

DROP: no observed real repair fits the fixed-document exception. A synthetic
record edit cannot establish that acceptance. The two production helpers alone
added 438 lines before runner and compiler-owner changes, for a stage costing
about 27 s. Cold refusals on unrelated bytes, main movement or runtime changes
would narrow useful hits further. An independent value checkpoint reached the
same decision. The prototype was archived locally and removed from the submitted
tree; no resume option, cache, new receipt, lock or compiler change is shipped.

### S3/S4 qualification: checkout recovery token port (#521)

The [#521](https://github.com/openlup/openlup/pull/521) local run
`verify-local-gXmzv0` on `b35a6248a8608b23c528e696d59d01f2f1589b2c`
passed the complete package stage and failed the root test
`packages/platform/test/commerce/browserSafety.test.ts`. The server export
inventory expected 154 exports and the bundle had 155. The direct repair
`0729707ca2fea177f3a972b0df4b087bedbd3550` adds
`createPostgresCheckoutRecoveryTokenPort` to the test inventory. The fresh
`verify-local-w9WF9A` passed, including selected pgTAP. Both candidates were
clean on base and recorded main `2a59da4be321f6413ae384f49e66ae3145f881d4`
with Node 24.21.0, npm 11.19.0 and gitleaks 8.30.1. This was an assertion
failure requiring a source repair, with no broker refusal.

| Measure | Failed run | Repaired run |
| --- | ---: | ---: |
| Package stage elapsed | 112.582 s | 117.092 s |
| Package broker wait reported | 0 s | 0 s |
| Root tests elapsed | 662.188 s | 645.059 s |
| Run wall time | 932.723 s | 946.328 s |

The interval between runs was 453.914 s. Total repair-loop wall time was
2,332.965 s. The package timer includes its wrapper and consumer execution.
The logs do not split every internal wait from execution.

Recomputed SHA-256 hashes matched for the three retained package tarballs and
the eight retained subscription build files. Package manifests differed only
in the commit field, which the consumer validates against its candidate.
The manifests precede API and installed-consumer completion. The logs establish
those phases ran, while actual installed dependency bytes, inherited npm
configuration and environment, and the platform consumer's PostgreSQL 16 image
identity are not fully bound by these records. The changed test is itself
registered as source smoke evidence for `./commerce/server`. A rule based
only on a test-file diff or equal tarballs would miss these boundaries.

**DROP for reuse.** The entire package stage offers at most 117.092 s gross
before evidence collection, validation and restoration (12.4% of the repeat,
5.0% of the whole loop). Those costs were not measured for a complete proof,
and no stage was reused. Safe qualified saving is zero on this evidence.
The narrower subscription build repeated in 7.088 s. This case supports
focused reproduction of the failing assertion before a fresh full run,
and remains a reference for qualifying a future donor. S3 recovery, S4 repair
reuse and public workflow v1 remain partial.

### Coordination, retro and deferred observations

[PR #509](https://github.com/openlup/openlup/pull/509) landed as
`5054c53dc81b246b81fb77122aeb71f92cfbdd75`, from reviewed candidate
`655aa3dbde3fbb4d944b9da7561f8af0a40c338b`. It concerns S6: mechanical review
carry-over, ordinary repair review and evidence renewal (renewal and expiry were
removed on 2026-11-05). It does not add verify
stage reuse. Its rules are now part of the actual main base; use the applicable
landed rules without copying them or claiming verification-stage reuse here. The maintainer specified the landing order: **#507, then #509, then
S3**. The latest instruction authorizes that merge order. Build and review S3
on actual main after both predecessors land; create its draft after complete
local proof, then use the authorized ready/admission/queue route. The #509 repair,
findings and full review remain in its own existing task evidence. This S3
record does not supply that approval. Final S3 native review, complete local
verification and submission use the actual combined base after #509 recovery.
The draft records exact base/head/tree identities and local results. Prototype
observations or proof on the old #507 alone do not satisfy this requirement.
S3 adds only this qualification record; technical mergeability and passing local
proof do not deliver stage recovery or the remaining programme.

Self-retro — ADJUST/DROP: testing the actual closure exposed both the validation
cost and the absence of a useful repair class. The original package-first choice
was worth investigating, but its inputs were not qualified. Stop the prototype
instead of growing the mechanism to rescue it. Keep the S1–S2 early checks and
the existing fresh runner. S3 recovery, S4 repair reuse and public v1 remain
partial until a real case meets their approved acceptance.

Regroup: package qualification left shared proof inputs unknown; the subsequent
typecheck pilot left the real repair class unproved. The remaining acceptance
gap belongs to verification, not to review policy. The smaller adequate route is
fresh verification. A future discriminating check is an actual retained failure
and repair whose unchanged stage inputs can be demonstrated before adding code;
the expected result is either measured net recovery value or another cold case.
Lesson: theoretical stage savings without a real recovery class → qualify the
case first and keep the existing runner until then.

Deferred observations, not new tasks or acceptance obligations: compare actual
slow-fixture failures with resource admission delays; use measured repeat costs
to choose a natural proof unit before building its input mechanism; account for
donor creation, invalidation frequency and the whole repair loop, not just a
theoretical hit. Revisit these after the main programme work or within an
already-authorized nearby change only when doing so preserves its goal and scope.
