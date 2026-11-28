# Contributor delivery procedures

Status: current contributor guidance for stable 1.x.
Audience and purpose: contributors writing specifications, preparing reviews and delivering changes within their authority.

Start with the [contribution guide](../../../CONTRIBUTING.md) for scope and the local workflow.

## Agent coordination harness

The repository ships a zero-dependency coordination harness under `scripts/harness/`
for multi-lane contributor and agent workflows:

- `npm run safe:run -- probe|exec ...`: pre-flight host probe (`git`, Node >= 22,
  `gh` auth, optional worktree cleanliness) and fail-closed command execution
  with exact exit-code propagation and optional remote branch/PR `headRefOid`
  readback verification.
- `npm run pr:open -- create|ready ...`: draft-by-default PR creation and
  readiness promotion that verifies a clean worktree, commit and PR-body DCO
  `Signed-off-by` trailers, affected preflight before ready promotion, and
  remote `headRefOid` readback.
- `npm run pr:watch -- [--repo owner/name] [--ack <pr>:<sha>] ...`: single-shot
  GitHub GraphQL PR and stale-inbox monitor (exit `0` clean, `2` alerts, `1`
  error) with SHA-scoped acknowledgements and local-worker self-exclusion.
  Override default state paths via `OPENLUP_STALL_ACK_FILE` and
  `OPENLUP_INBOX_DIR` (defaults under `.context/scratch/harness/`).
- `npm run lane:inbox -- post|poll|ack|status ...`: file-locked JSONL lane
  inbox for cross-lane handoffs, decisions, and alerts with idempotent
  acknowledgements and stale-lock recovery.

## Write a change specification

Write for a contributor who has the checkout and has never read the author’s
conversation. The contributor should be able to find the owning entry point,
name the behavior to change and preserve, and tell what would disprove success.
For a trivial fix, state the change and expected check in a few lines and append
the observed result after running it. Omit headings and empty fields, and include
applicable simplicity and DX decisions. A small diff that changes a supported
contract needs proof at that contract's boundary.

Use one current specification per PR or independently verifiable delivery step.
The program plan owns the target and dependency order. The change specification
owns the approved behavior for this step. The PR task record carries the
acceptance criteria, actual authority and observed evidence. When the specification
lives separately, identify the criteria being delivered and link the exact
revision in a record accessible to the author and reviewer. In a public PR,
include the reviewable public contract and use shareable references. Keep private
source references in the authorized program record. Resolve amendments in the
affected behavior, refusal and acceptance sections before handoff. Update
the affected witness, including any fixture or expected result that the
decision changes. Keep superseded wording in the decision history with its
rationale. Author and reviewer should be able to use the same current criteria
without interpreting the amendment history.

For a handoff with unresolved prerequisites, put the step's current status,
approved specification revision and first safe action beside the conditions
for starting. Distinguish spec approval, readiness to start and authorization
to act. If a predecessor has to land, identify it by its repository change or
exact source revision and state what behavior or fixture the step consumes.
Use the landed reference to check the dependency once it is available. A
similar title or an earlier partial change cannot establish that it landed.
Keep an unresolved start condition visible until its evidence is recorded.

Apply this **Brief standard** in every non-trivial change specification before writing code:

- **Single decision owner.** Name the single module or function that owns each rule, schema check or threshold, and avoid shadow constants or duplicate validation across scripts or entry points.
- **Legacy-preservation matrix.** Tabulate existing callers, data formats, migrations and carrier paths with their required disposition (`preserve unchanged`, `extend additively`, `narrow/retire`), including dormant defaults and historical blobs.
- **Consumer census (`rg`).** Record an `rg` census of every caller, test, workflow and derived carrier reading the changed symbol or file, and list every site updated or proven unaffected.
- **Class-exhaustive repair.** When fixing a defect or review finding, enumerate and test the whole failure class across all entry points and code paths rather than patching a single trigger.

1. **Outcome and scope.** Name the actor, normal entry point, observable result,
   exclusions and what remains unavailable after this change. Name the owning
   contract and the source revision or installed version used to check assumptions.
   Compare the requested result to the current behavior. An existing supported
   operation may already satisfy the request. If the requested behavior conflicts
   with the baseline or another owner’s contract, record the conflict before
   designing the change. For each blocking decision, name who decides, the
   question, and the affected criterion or step. State which material choices the
   author may make. For each dependency that gates work, name the owner, the
   contract revision, and the evidence of the state needed to start, verify or
   activate. In a multi-step change, record readiness for each independently
   verifiable step. Name its start condition and leave unsettled dependent
   contracts in draft with an owner and an unblock condition. Prove each
   capability where it first becomes usable, including in explicit composition
   if the shipped default stays dormant. Prove that default's refusal or
   absence of effects with inputs that would work in the enabled composition.
2. **Behavior and invariants.** Give the relevant starting state, accepted inputs,
   public result and side effects. Cover affected existing callers and data.
   Specify inputs at the boundaries that matter, including units, limits or
   precedence when they affect the result. For refusals give the trigger,
   public outcome, actionable recovery and effects that must be absent. For
   compatibility or replay, identify the prior state and request identity,
   which outcome is retained, and which effects may occur again.
   Cite exact public names or wire values where consumers rely on them.
   If an existing entry lacks a fact this change needs, name its supplier,
   how it binds to the existing input, and the outcome when it is absent or
   ambiguous. If the author may choose the binding, state its constraints.
   When two paths must agree, name the decisions, fields or effects being
   compared, the shared input and state, and any checks reserved for one path.
   If one result mixes retained values with current eligibility, identify
   which values come from each and name the checks that can change eligibility.
3. **Acceptance and evidence.** For each material criterion, name the scenario,
   normal entry point, expected observation and the witness capable of checking it.
   Give multiple criteria stable IDs when later work or evidence refers to them.
   Name the fixture, entry variant, command or procedure and where the witness
   ends. For a refusal, give the inputs that reach the intended check. A quote
   response supports a quote claim. An order claim needs an order outcome.
   For a risky behavior, state a contrasting case or a plausible wrong
   implementation that the witness must reject. Choose fixtures that distinguish
   the expected behavior from that alternative. When the outcome includes a
   remedy, check that following it addresses the same cause. Keep planned
   checks distinct from observed results. Record command, candidate, relevant
   profile and result for completed checks. Identify skipped and unexecuted
   cases that affect an acceptance claim.
4. **Footprint and tradeoffs.** List affected owners, files, migrations and
   generated carriers. For each new mechanism, record the current requirement
   or reachable failure and the smallest adequate alternative considered. A new
   process control needs a concrete failure that required CI and the change's
   own review would miss. Prefer removing the cause or reusing an existing seam
   or default. Preserve correctness, required compatibility and proof. For public
   APIs, starters or examples, reader docs, errors, CLI, configuration and
   settings, or extension points, record the change in concepts, steps and files
   for the adopter or their agent. Minimize that burden and keep internals
   private. Name the cause and fix in errors, write adopter docs around tasks,
   and keep the local edit-and-test loop fast.

Match proof to the contract. A database change may need ordinary commit, replay,
retry under contention, a specific runtime role, historical data, upgrade or
restore. An installed contract may need a packed consumer, a supported starter
configuration, or the user or operator journey. Choose the cases the change can
affect and use their real boundaries. Source, installed artifacts, hosted checks
and live qualification each establish different facts.

### Changes that cross a contract boundary

- **Before writing.** At the source or installed-version pin for this step,
  compare the approved behavior with the actual entry points and their callers.
  When changing shared data or a shared decision, trace the affected writers
  and readers through SQL, adapters, starter composition and fixtures as
  applicable. Record what is preserved, what changes and any gap in the
  available inputs. Where behavior depends on order, name the owner of the
  transaction, snapshot,
  clock, locks and I/O. Record which refusal wins and which effects survive
  when relevant checks fail together. Refresh affected facts if a dependency
  moves before implementation.
- **Between owners.** For a new or changed handoff, agree the contract with
  the producer and consumer before either relies on the change. Trace the
  consumer route to the authoritative facts it can read, including the keys,
  role and point at which the producer commits them. State what the consumer
  may assume, what replay retains and
  how older or restored records without the facts behave. Name the producer
  witness and the first step that may consume the guarantee.
- **At the wire boundary.** For a change to response validation, cover affected
  entries and success variants using actual producer output or its owning
  serialization contract, independently of the consumer's validation list.
  Record shape rules such as presence and nullability. When success must be
  bound to the request, map fields and relevant structural conditions to the
  input or authoritative fact they must match, or state why comparison does
  not apply. Change one bound value or shape condition at a time with earlier
  checks satisfied and verify that the intended check decides the outcome.
- **For stored data.** For a changed persisted lifecycle, use the affected
  installed paths on the same fixture store. Check retained
  identities, the facts covered by the change and prohibited writes where they
  matter. For upgrade, use the supported predecessor and check the relevant
  migration order. Derive incidental metadata from the applied history.
  Identify how a supported current or historical path produces the prestate.
  Label deliberate corruption and the bypass used.
- **Installed behavior.** When claiming a shipped default works, exercise the
  mounted entry with its shipped configuration and supported inputs. For
  changed exports or declarations, identify the affected consumer and verify
  the installed artifact through its public entry. Record where each witness
  runs if hosted or nested execution can omit it.
- **SQL and larger steps.** Record the migration order, prerequisites, shared
  carriers and any restore registration. Mark this step's new ordinary slots
  as provisional or selected. Use the slot planner in the landing procedure
  to check their UTC validity and order.
  Follow the existing preflight and admission rules. For an approved stack,
  verify this step's SQL contract and order against its pinned predecessor
  before counted implementation review. Use
  [the existing landing procedure](#derived-landing-carriers) for live slot
  selection, rechecks and rename review. Where a size budget drives the split,
  show per-PR counts for production changes, full replacement bodies, tests
  and generated carriers without counting the same lines twice. State the split
  point and recount affected steps after a material change. Each split must leave a
  correct, independently verifiable state.

For example, to prove an installed status command respects a capability, keep
the migrated data and arguments the same in both cases. With the capability
disabled, expect the existing typed refusal and no writes. With it enabled,
expect the existing success result and no writes. This catches both an
unconditional success and an unconditional refusal.

For a required pre-implementation review, give the reviewer the specification,
the baseline and the owning contracts. Ask them to reconstruct the expected
behavior and identify a plausible implementation that must fail acceptance.
Resolve material gaps in the current specification before starting. If a
material gap returns in specification review, identify the cause and its owner.
Decide whether to amend the contract, reuse a proven seam, narrow or defer the
affected step. Record the decision and remaining evidence before requesting a
focused recheck. During implementation, pause the affected work if a choice,
discovery or dependency change materially conflicts with the specification.
Record what changed, resolve it with the accountable owner and update the text.
Recheck affected dependencies and rerun affected witnesses on the relevant
candidate. When reusing evidence, record why its inputs and boundary still
apply. Preserve criterion IDs for unchanged requirements. Changes to review
criteria or risk follow [native review intent](#native-review-and-accountability).
A clean advance of main follows the review carryover rule in
[Deliver a change](../../../CONTRIBUTING.md#deliver-a-change). An ordinary migration that must move to
remain eligible follows the [landing and review procedure](#derived-landing-carriers).

## Derived landing carriers

While authoring a new plain forward under `db/platform/migrations/` before
committing, use `npm run migration:sync -- --next-slot` to allocate the next
strictly-later 14-digit UTC slot above both `origin/main` and the local working
tree, and `npm run migration:sync` (with `--no-inventory` for fast local
iteration or `--check` for a read-only drift check) to synchronize checksums
across all three plans in `config/platform-migration-manifest.json`, declared
`nativeStoreForwardClass.slots` function digests in
`config/reviewed-platform-forwards.json`, the `packages/platform/sql/`
projection, `packages/core/docs/guide/reference/sql.md`, and measured
installation inventories.

Use `npm run migration:finalize -- plan --base <main-sha> --head <draft-sha>`
to preview the ordered mapping for committed, unlanded ordinary forwards.
The plan is read-only. Run local `apply` from a dedicated worktree and supply
`--pr <number> --repository-id <id> --pr-node-id <id>` with the same `--base`
and `--head` arguments. From that worktree, run
`git rev-parse --git-path openlup-migration-grant.json` to find the fixture
location. Copy the grant JSON there as an owned regular file, then remove it
when finished. Obtain the repository and PR node IDs independently of the
grant fixture. Apply returns the SHA-256 of the
exact inventory bytes it measured. Keep this value with the grant, base and
finalized head for independent verification. Hosted reservation remains inactive.
A renamed SQL identity retains its existing review obligations.

From a clean committed task checkout, refresh the remote reference, then run:

```sh
git fetch origin main
npm run landing:merge
```

If a newly added SQL migration uses a slot at or before the latest timestamp on
`origin/main`, the helper stops before builds and prints the next free UTC slot.
Run `npm run landing:merge -- --re-slot` to opt into moving that migration and
updating its registries and SQL mirror, or pass
`--target <YYYYMMDDHHMMSS>` with `--re-slot` to place the first unlanded plain
migration at a specific strictly-later UTC slot (advancing any remaining plain
migrations sequentially from there). An authored reference to the old filename
in code, tests, SQL, or documentation makes this operation refuse with file and
line locations. The changed SQL remains subject to integration review.

The helper merges the exact fetched `origin/main` with DCO sign-off; it never
rebases or pushes. Configure your Git `user.name` and `user.email` before running
it: the merge uses that identity and `-s` for your personal
[DCO certification](../../../CONTRIBUTING.md#developer-certificate-of-origin).
The helper checks the installed toolchain against HEAD before merging. If the
merge changes a toolchain input such as `package-lock.json` or `.npmrc`, it runs
`npm ci` once in the merged checkout and rechecks the toolchain once before
refreshing carriers. That install uses the shared `ai-resource-gate` helper
(`scripts/resource-gate.mjs`: `ai-resource-gate run --wait --queue-timeout 300 --execution-timeout 900 openlup:landing-build:wt<id> --`)
when `ai-resource-gate` is on `PATH` and not bypassed by `CI=true`,
`AI_RESOURCE_GATE_ACTIVE=1`, or `OPENLUP_DISABLE_RESOURCE_GATE=1`; otherwise it
falls back to an unwrapped `npm ci`. Matching inputs skip the install and the
second check.

After the merge commit is created, the CLI runs post-commit verification
(`scripts/build-packages-incremental.mjs` and `oss:published-tree -- --typecheck`)
by default and returns `verified: true` on success. Pass `npm run landing:merge -- --no-verify`
to skip post-commit verification. If post-commit verification fails, the helper
reports `OPENLUP_E_LANDING_VERIFY_FAILED` and preserves the merge commit without
rolling it back.

Authored conflicts leave the merge open for resolution. On other failures the
helper restores landing writes, aborts its merge and verifies the original HEAD,
an empty Git status and the absence of `MERGE_HEAD`. If rollback fails, inspect
`git status` and resolve the reported cleanup failure before retrying. Ignored
install and build outputs are outside Git rollback. If an install ran, you may
need `npm ci` at the restored HEAD before retrying.

The helper refreshes its carrier set with the merged tree's inventory refresh
and generators in new processes. Append-only migration entries are unioned in
slot order. Existing entries cannot be edited and new duplicate slots refuse. Issued
prefixes retain their original order. With a unique merge base, the closed
registry union admits additions and base-entry removals in the named arrays of
the publication catalogue, package boundary test and cold-consumer script. A
removal can come from either side or both. Edits to base entries, reorders and
moves between adapter classes need manual resolution and review.
The [shard weights](../../../config/vitest-shard-weights.json) are a closed union too:
the branch contributes only keys main lacks. Main's additions, recalibrations
and removals stand, and main's value wins for a key both sides added and for
`defaultDurationMs` and `schemaVersion`. A branch edit or removal of a
merge-base value, including those two fields, changes its test timeout. That remains an authored conflict
for manual resolution and review. Output keeps sorted keys, positive finite
weights and main's two-space JSON layout. GitHub can still remove a queued pull
request on a text conflict in this file; the union only removes the hand
resolution.

The [PostgreSQL suite closures](../../../config/ci-postgres-suite-closures.json) use a
parallel closed union: the branch may add new suites or append inputs to base
suites, while main's updates, narrowings and removals stand on suites the branch
left unchanged. A branch edit to `schemaVersion`, removal of a merge-base suite
or input, or divergent edits/additions on the same suite across branch and main
remains an authored conflict for manual resolution and review. Output keeps
sorted suite keys, sorted valid inputs/axes, no control-suite collisions, and
main's canonical two-space JSON layout. When introducing SQL under
`db/platform/migrations/` or `supabase/migrations/`,
[reviewed-platform-forward.ts](../../../scripts/reviewed-platform-forward.ts) also
enforces that [config/ci-postgres-suite-closures.json](../../../config/ci-postgres-suite-closures.json)
remains strictly valid and append-only.

If `landing:merge` refuses a new migration because its UTC slot is no longer
later than `origin/main`, rename the new, unlanded migration to a free UTC slot
after the migration slots on `origin/main`. Preserve the order of any other
new migrations on the branch. Update the migration registries, packaged SQL copy
and references to the old path or version. Refresh the derived files and
installation inventory, then submit the renamed migration and its resulting
changes for review. An existing review does not cover the rename.

Integration proof classifies an exact merge of the reviewed head and a commit
on `origin/main` as `derived` only for a closed carrier set: migration registry
unions, package SQL projections, publication catalogue, generated source map,
SQL reference, API snapshots, the maturity reference, settings catalogue outputs,
and current installation data. Trusted owner generators run on a temporary
prediction. API scripts and their helpers must match main byte-for-byte before
execution; so must `packages/core/scripts/documentation-contract.ts` and
`packages/ui/smoke/neutrality.ts` for the maturity reference. Candidate-only
tooling is never executed. Output must equal committed
bytes. Every SQL byte and mode must equal the mechanical merge; other changes
remain a `resolution` delta with its existing review floor. Size caps and release
fragments stay reviewed. Generator errors fail closed.

`npm run inventory:refresh` installs all five profiles in disposable local
PostgreSQL through the production migration runner and catalog projectors,
running up to three profiles concurrently by default (set
`OPENLUP_INVENTORY_CONCURRENCY` to `1`–`5` to override, and local non-CI runs
use host-local `ai-resource-gate` on the `docker-heavy` lane when present). It
measures complete hashes, counts, ledger tails and the connected handover count,
and rewrites only `current` in
[the inventory data](../../../tests/postgres/current-installation-inventory.json).
Historical pins remain frozen in the proofs or the `historical` section. Proof
requires the historical section and every byte outside `current` to equal both
parents and the fork point. CI's complete installation assertions independently
check the measured data; review proof does not substitute a guessed measurement.
The canonical manifest's current hashes must match that same data.

A landing containing only these verified carriers needs no resolution review;
a mixed landing reviews only its remaining delta. Existing `git` evidence keeps
its identity. Earlier `registry-union` evidence no longer replays as
`registry-union` if the reviewed base is anything other than the unique Git merge
base. The affected session needs a refreshed review of that carrier's
resolution. Protected-path vetoes and stack receipt rules are unchanged.

## Native review and accountability

The qualified route is fresh context, neutral input and read-only review, through
an observed local CLI session or native subagent. Count actual complete results
with distinct context IDs, independent of every author and other reviewer;
a PASS string alone is not execution evidence. The supervisor retains the
observations and checks the reports. No model API, new host or authentication
transfer is required. Receipts are process evidence, not cryptographic remote
attestation or hard signer isolation; Git hashing identifies source objects.

Write ignored `.context/scratch/agent-review/intent.json`:

```json
{ "authorSessionId": "<supervisor session id>",
  "intent": { "risk": "<prose|routine|behavior|unknown>",
    "criteria": "<approved criteria>" } }
```

Keep the intent for the life of the change (later candidates may touch more paths);
changing `risk` or `criteria` requires `prepare --new` and a full review.
A ruling that only reclassifies findings as advice or states an exclusion travels
in the brief; it does not change the intent.

Use this template for the approved criteria:

```text
This change covers <one sentence describing the scope>.
In-scope behaviours: <complete list>. In-scope paths: <complete list>.
Out of scope: <one sentence>.
Proofs: <complete list of behaviour proofs, each failing when its behaviour is
reverted>; required checks: <the repository checks that must pass>.
```

Codex may omit `authorSessionId` to use `CODEX_THREAD_ID`. Refresh the local main
reference before preparation so the cheap merge preflight catches known conflicts.

```sh
node scripts/agent-review-session.mjs --help
node scripts/agent-review-session.mjs prepare .context/scratch/agent-review/intent.json
node scripts/agent-review-session.mjs status --explain
node scripts/agent-review-session.mjs record report.json
node scripts/agent-review-session.mjs verify
```

`status` prints the raw recorded session JSON. `status --explain` compares the
recorded session with the local checkout (`clean`, `dirty` or `stale`), reports
the required reviewer floor (`0/1/2`), missing reports, open material findings,
repair or resolution delta scope and digest, and the next action without writing
Git objects, running generators or claiming `verify` completion.
`verify` confirms local review evidence. Before printing a receipt, `receipt`
runs the merge preflight against the locally fetched `origin/main`, subject to
the stack rules in [Deliver a change](../../../CONTRIBUTING.md#deliver-a-change).

Each fresh reviewer supplies a complete report:

```json
{ "reviewer": "<observed context id>", "cold": true, "verdict": "PASS",
  "tree": "<reviewed tree>", "documentation": "<claims and related guidance checked; result>",
  "findings": [], "closes": [] }
```

Findings have stable `id`, `summary` and `material` fields; a later report closes
one through `closes: ["<id>"]`. Advice uses `material: false`. The `documentation`
assessment checks stale claims and related examples, including for documentation
changes. Delta reports identify `candidate.coverage.delta` and include
`"ordinary": true`. That digest covers the diff with full object names, so it does
not depend on how many objects the local repository holds. An edge recorded with
abbreviated names before this rule still replays wherever those names reproduce.
Every later preparation keeps the history, so if admission refuses such an edge,
rebuild the session in a clone holding only main and the branch: keep the events
before the refused preparation, repeat each later `prepare` at its recorded head and
record the same reports, each delta report naming its new delta.
State stays in `.context/scratch/agent-review/session.json`;
unchanged preparation preserves evidence and history. `verify` refuses dirty,
mismatched, partial or missing evidence and unclosed blockers. On the CI-only
route no reviewer report is needed. Source admission checks the live head, tree
and floor using trusted main's tooling.

```sh
node scripts/agent-review-session.mjs receipt "$PR" | gh pr comment "$PR" --body-file -
node scripts/merge-queue-check-arm.mjs "$PR" "$REVIEWED_HEAD" &&
  gh pr merge "$PR" --auto --match-head-commit "$REVIEWED_HEAD" --author-email "$AUTHOR_EMAIL"
```

Set `PR` to the PR number, `REVIEWED_HEAD` to the reviewed head SHA and
`AUTHOR_EMAIL` to the maintainer's configured author address. Receipt generation
prints the comment body; posting it is an authorized GitHub write. A new head needs a new
receipt. Hosted admission accepts the newest valid receipt from a user with
write, maintain or admin permission and binds it to the PR head and tree.
Existing receipt formats retain their identities; recorded expiry is not enforced.
A v3 receipt is printed as gzip-compressed, base64-encoded text under a dedicated
marker, below a readable summary, so API clients that rewrite control-character
escapes cannot change it; admission decodes and verifies it like any receipt.
The command refuses a compressed body over 200,000 characters.
A v2 receipt, from a session prepared on a base without the v3 review rules, keeps the raw JSON form, which such clients can rewrite; prepare on current main to get a v3 session.
The summary table is a convenience; admission verifies only the machine block.

## Merge queue

Queue Handoff serializes its admission jobs from the occupancy check through
exact-head readback. GitHub's UI and CLI retain their existing entry behavior.

The queue builds and tests the integration tree. A source review carries over
when its base is on main and the group tree is the reviewed tree or the clean
`git merge-tree` result on the queue base. A clean registry-carrier union or verified derived landing also
preserves review; only the remaining resolution needs review. The required checks
on that tree cover interaction with main.

Before each external write, recheck actual authority, the live head and the
applicable receipt. A known failed required check needs diagnosis. Conflicting
mergeability stops enqueue attempts. If mergeability is `UNKNOWN` while checking
manually, take one fresh read, then diagnose. Leave `BEHIND` to the queue. Never
use `--admin` for this route.
A non-null `autoMergeRequest` means armed; only `mergeQueueEntry` confirms queue
entry. Observe an existing request instead of repeatedly arming it.

Run the read-only `merge-queue-check-arm.mjs` preflight before the manual
exact-head merge command. It checks GitHub's live PR title and description for
the DCO sign-off that will appear in the synthetic queue merge commit. Add a
`Signed-off-by: Your Name <your.email@example.com>` line to the PR description
and keep the sign-offs on the source commits. A migration PR waits while
another migration PR is active in the queue. The preflight reports `ready`
only with complete evidence. Keep the head match and recheck authority,
required checks and the receipt before the separate write.

Where activated, trusted `Queue Handoff` can insert a still-armed exact head once
after the required source successes and current native proof. At each of its two
mergeability checks, it re-reads `UNKNOWN` up to twelve times, 15 seconds apart.
Persistent `UNKNOWN` requires re-running the job. It does not arm an unarmed PR
or automatically requeue an evicted head. For PRs touching migration paths or
migration registries, it checks active entries in `main`'s merge queue first and
exits cleanly with `status: "deferred"` (leaving the merge intent unburned) when
another migration PR is already active; after the blocking PR clears and any
required `landing:merge` push runs, the deferred PR can be enqueued normally. Its App is scoped
to this repository with no bypass; its private key stays in the main-only
`openlup-merge-queue` environment, separate from release credentials. Queue
Handoff's built-in workflow token is read-only. Activation and settings remain
maintainer actions.

For read-only queue diagnostics, run
`node scripts/merge-queue-churn.mjs --github <since-UTC> <until-UTC> markdown`.
It reports elapsed job time and exits with status 2 for partial evidence.
Use `--offline [json|markdown] < evidence.json` for a saved sanitized
evidence object. Add `--stdin < envelope.json` to the live command to supply
an object with optional `priorSnapshot`, `subjects` and `attestations`.
Both modes read at most 8 MiB from standard input. The report labels
independently attested links and leaves unsupported historical links unknown.

On `pull_request`, when no receipt comment exists for the current head (and no
malformed receipt comment is present), `native-review` fails fast after the six
mechanical checks pass so the run completes immediately instead of idling.
`merge_group` runs and `pull_request` runs that already have a current-head or
malformed receipt comment retain the bounded three-minute wait. Where it is
activated, a new receipt comment from an owner, member or collaborator with
write, maintain or admin permission starts the trusted
[receipt rerun](../../../.github/workflows/native-review-receipt-rerun.yml). It reruns the
failed jobs once, with the built-in token's `actions: write`, only when the newest
run for the PR's current head, branch and repository is complete and `native-review`
is its only failed job. After an automatic rerun, confirm that the PR entered the
queue: whether Queue Handoff fires for an attempt requested with the built-in token
is unwitnessed until the first hosted rerun. In any other state, after a PR
`native-review` failure or receipt timeout, submit or check the receipt and rerun
the failed `native-review` job within rerun authority. A group timeout needs a
requeue under merge authority. After a same-head failed-check or timeout removal,
the preflight requires a passing rerun of the removed merge-group commit with
all required checks successful. A second removal of the same head stops routine
re-arming. A conflict removal without a merge-group commit is not counted;
the live mergeability check holds any conflict that remains on the head.
Diagnose any hold before considering further action. Missing or late
receipts require a receipt fix. A timely
valid receipt rejected without a conflict is a defect to diagnose.

The admission script comes from trusted main, but the job YAML comes from the
candidate. A successful same-name no-op could bypass admission. Review of changes
to that machinery is the in-repository control; a ruleset-required workflow
pinned outside candidate control requires a separate settings decision.
