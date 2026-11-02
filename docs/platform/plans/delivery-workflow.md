# Public delivery workflow

Status: approved programme intent; S1–S2 implementation in progress, with final
review, verification and draft submission pending. S3–S10 remain unimplemented.
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

## Current task: S1–S2

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

Comparison base and instruction revision:
`21c057038b25db6bdf490496a341df5b2f1fdbcc`.
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
