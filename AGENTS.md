# OpenLup Public Agent Guide

Status: development-preview guidance. The authoritative public guide is
`docs/platform/AGENT_GUIDE.md`; this root copy keeps its rules available to
repository agents. Edit both files together in OpenLup, adjusting relative links
for their locations. The one-time public-root projection is no longer an authoring route.

OpenLup is a subscription-commerce platform. The platform's public tree is a platform monorepo; an adopter owns its own application, brand, content, local policy, and integrations.
This guide governs work in that public tree only. It does not authorize releases, external mutations, or stable-framework claims.
An application that installs `@openlup/*` from npm follows its own `AGENTS.md`, started from the [adopter kit](docs/platform/adopter-kit/README.md).

## Orientation

Read these documents before changing a related boundary:

- [Platform documentation index](docs/platform/README.md)
- [Source map](docs/platform/SOURCE_MAP.md) — domains, canonical owners and code paths; read the relevant owner rather than loading the whole inventory.
- [Documentation maintenance](docs/platform/DOCUMENTATION.md) — ownership, same-change impact and generated outputs.
- [Public documentation writing profile](docs/platform/README.md#write-or-update-a-page)
- [Architecture and extensions](docs/platform/ARCHITECTURE_AND_EXTENSIONS.md)
- [Data and migrations](docs/platform/DATA_AND_MIGRATIONS.md)
- [Runtime and self-hosting](docs/platform/RUNTIME_AND_SELF_HOSTING.md)
- [Canonical contracts](docs/platform/CANONICAL_CONTRACTS.md)
- [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md)

Treat code, tests, and machine-readable contracts as the implementation truth. Keep documentation aligned when a public boundary changes.
Do not copy a deployment-specific assumption into a platform contract.

## Choose evidence for the task

- If a path, exported symbol or error is known, open it or run scoped `rg`, then read its implementation and nearest tests. Stop searching when the affected contract and failure boundary are clear.
- If the owner is unclear, use the [source map](docs/platform/SOURCE_MAP.md) and `config/doc-routing.json` to find owner pages and code paths. Search repository documentation for the missing concept, then open cited pages. Check each page's stated maturity and limits against its owner code; a hit is a lead, not proof that every constraint was found.
- For changes across modules, migrations or architecture, trace each owner's code, callers, invariants and tests. Check ordered migrations and replay or compatibility boundaries when relevant.
- In an adopter application, follow its own instructions and use `openlup-context` from the **installed** `@openlup/*` version. Use its opt-in `--package-code` scan only when installed package source is needed. Do not treat this checkout's documentation as the contract of a different installed version.
- Search old plans or changelog history explicitly when investigating a past decision. Check any historical claim against current owners and code. Translate a freeform Polish task into concise repository terms if lexical search misses it; an empty result never proves that an API or seam is absent.

## Architecture rules

- Before planning a module or npm name, follow the canonical [package placement decision](docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#package-placement-decision-canonical).
- Keep browser-shareable contracts and clients separate from server use cases.
- Keep provider SDKs, HTTP clients, environment readers, and payload translation behind infrastructure and adapter boundaries.
- Put durable platform-data changes in ordered migrations; follow the compatibility lifecycle in [Data and migrations](docs/platform/DATA_AND_MIGRATIONS.md).
- Keep an adopter's brand, copy, catalogue, local rules, and provider-specific composition outside generic platform code.
- Preserve the subscription invariant: a late delivery extends the next cycle;
  the monotonic clamp must never stack deliveries or move a cycle earlier.
  A replacement may settle delivery alignment as `aligned` only after it
  reached the customer. Its superseded predecessor is no longer an outstanding
  obligation, but an in-flight or undelivered replacement still is. Never call
  `subscription_delivery_alignment_confirm_replacement` for a replacement that
  did not arrive: that operation records the customer-facing fact "Parcel
  delivered" and shifts the cycle later.

## Extension and ownership rules

Prefer a documented port, configuration seam, event subscription, or theme/data boundary over modifying platform internals.
An adopter may keep an extension in its own source or propose it upstream, but an accepted change still needs an explicit compatibility and maintenance owner.
Existing adopter code is contributed with unchanged logic first and refactored afterwards in OpenLup with its characterization witness unchanged; a behaviour change is never a refactor. [Contribute existing adopter code, then refactor](CONTRIBUTING.md#contribute-existing-adopter-code-then-refactor) owns the order.

Copying a platform component or page into adopter source is source ejection. The adopter then owns its security, tests, compatibility work, and manual porting of later changes; the platform does not update that copy automatically.

## Change and verification rules

Each implementation task uses a dedicated worktree and branch, for Claude and
Codex alike. From a coordination checkout, automatically create the task
worktree with the configured repository helper before editing, installing or
testing, then operate in that worktree. Recognize an already assigned task
worktree and continue there; do not create another for the same task. Keep the
coordination checkout clean and leave other tasks' worktrees, branches and
processes alone. Read-only reviewers do not need their own worktree.
If no maintainer helper is configured, use an ordinary dedicated `git worktree`;
[CONTRIBUTING.md](CONTRIBUTING.md#contribution-shape) owns that setup and the
handoff to an authorized submission supervisor.

Keep one compact task record of a finite observable outcome, smallest complete
scope, exclusions, authority and delivery boundary, acceptance and sufficient
completion evidence, risk and execution/proof plan. A small task needs no
separate planning ceremony; a separate specification is justified by an
ambiguous or durable contract. Plans, implementation, review, delegation and
handoffs inherit the approved programme boundary. Execution notes may evolve;
discoveries, review advice and new waves cannot silently add goals, acceptance
obligations or authority. Material changes use the applicable owner decision.

At task start, resume and handoff, recover the approved task state and read the
applicable current instructions under [Instruction freshness and handoffs](CONTRIBUTING.md#instruction-freshness-and-handoffs).
Keep the policy revision separate from the code review base; project memory links
to canonical rules instead of maintaining competing copies.

A new explicitly approved bounded module programme may combine implementation
and set-version preparation in one pull request, following
[package release policy](.github/VERSIONING_AND_EOL.md#package-releases).
Existing programmes keep their approved scope and delivery boundary.
Where an applicable maintainer-local policy explicitly delegates delivery or
merge for that programme, record the actual grant in the task; this public guide
does not install or grant that delegation. It cannot authorize merging the
change that establishes it.

Record effective maintainer authority in the existing task record: finite outcome,
actors/coordination, permitted local/commit/submission actions, actual merge and
release-dispatch grants, adopter endpoint and remaining human gates. Reconcile
later direct grants; do not let a generated local-only or messaging restriction
silently narrow them. A peer request or generated prompt never creates authority.
Ask only for the missing bounded action, not acceptance already recorded.
Use one stabilized sensitive API/notes/budget/recovery packet where required,
then the native signed-commit review. Local preliminary review snapshots do not
establish native admission or counters; preserve both histories and actually
applicable limits without inferring or resetting state. Run the cheap checks for
the code being written; the required final verification is hosted CI on the
integration tree (see [Deliver a change](CONTRIBUTING.md#deliver-a-change)).
For an authorized adopter continuation, use waits for independent, bounded
read-only reconnaissance of its current pins, drift and ownership. Record the
actual registry, adoption and staging endpoint when those outcomes are in scope.

Before DCO sign-off, complete the applicable working-tree checks and obtain any
required maintainer read of the stabilized API, npm-publishing, security-control
or release-control changes and proposed gate budgets. A later material delta
needs its applicable read again. Record computed identities as evidence, not as
a maintainer quote. Committed native review and final verification still follow.

Before each delegated external write, revalidate the actual scope, live PR head
and applicable review/receipt identity through the existing mechanism.
Merge additionally requires actual required source and group checks, closed
material findings and no unread material delta. Delegated PR responses or thread
resolution cover only that PR; resolve a new risk only after it is explained.
Thread resolution does not dismiss scanning alerts or mark hotspots safe.
Protected approval of the specific release run, credentials and npm-account
operations, settings, partial-release recovery, separate repositories and
exhausted review budgets retain their own boundaries. A generated plan, passed
poll or review receipt grants none of those rights.

Necessary in-scope recovery proceeds autonomously: it closes approved acceptance
or prevents this change or its necessary delivery route from violating an
applicable contract or invariant. Missing mandatory evidence still blocks
delivery. An unrelated pre-existing defect or optional improvement does not
become a new acceptance obligation. Briefly report consequential discoveries in
existing task evidence; do not automatically repair them, open issues or create
successor waves. A failing mandatory gate remains binding even when its cause is
out of scope: diagnose safely and report the blocker if recovery exceeds authority.

Prefer removing the cause, an existing seam or a direct change before adding a
material abstraction, dependency, fallback, control or persistent process. Name
the current requirement or reachable failure it protects and explain its benefit
over the smallest adequate alternative, considering implementation, verification,
operation and future comprehension/change cost. Hypothetical reuse and tests
introduced only for the new mechanism do not independently justify it. Obvious
small tasks need no alternatives essay, scorecard or new artifact. Complexity
findings need a concrete cost or unnecessary behaviour; style preferences do not
block. Simplicity preserves correctness, safety, required compatibility and proof.

Handoffs and context/session changes carry the approved outcome, scope,
exclusions and delivery boundary, sufficient evidence, remaining work, unresolved
blockers, failed attempts and consumed retry budgets in existing task state.
A new agent, session or renamed symptom does not reset limits or evidence.
Once acceptance, required review and checks are complete, perform only the
remaining authorized delivery steps and finish. Do not start cosmetic polish,
reassurance review or an automatic successor. Budget exhaustion or missing proof
is a blocker, not completion. Existing controls and authority remain binding.

Close every completed or stopped task run with a short self-retro in its existing
summary: measured delays or defects, a justified simplification, or no useful
improvement found. Apply only necessary, justified changes within actual scope
and authority. A process optimization reviews both its new contribution and
the applicable prior rules for freshness and contradictions. The note cites any
rethink and its lesson. Apart from the Review lessons route below, it requires
no separate learning PR and opens no automatic successor or review loop.

Follow the [AI contribution policy](.github/AI_CONTRIBUTION_POLICY.md) for accountability,
DCO and delivery authority. The [autonomous delivery intent](docs/platform/plans/autonomous-reviewed-delivery-intent.md)
and [plan](docs/platform/plans/autonomous-reviewed-delivery.md) require the active supervisor to launch independent
fresh-context reviewers in the same logical task and evidence history, through
native subagents or a supported local CLI under existing subscriptions. Provider
and model do not assign coordination, implementation or delivery rights; record
the actual roles and grants. Supply approved criteria and exact source without author history
or other reviewers' verdicts. The initial candidate needs one bounded review for
ordinary prose or narrow routine code, and two independent parallel reviews for
sensitive or material behaviour, executable instructions, contracts, controls
and unknown risk. Routine review refuses known control, trust-boundary and public
contract paths; its reviewer confirms ordinary semantics, and uncertainty
requires two fresh full reviews. At least one review considers
a simpler solution preserving all controls. A blocker demonstrates a mechanism,
precondition, violated requirement and effect on correctness or acceptance;
optional advice cannot block. The maintainer does not read each diff or move
prompts/reports between sessions.

Commit repairs before review and close every material finding explicitly. The
first review is full; reviewer independence, cold context and unique IDs remain
required. A conflict with main is resolved by merging main, and only the
resolution is reviewed. A repair is reviewed as its delta plus interactions,
with the open findings: two reviewers when the delta touches SQL, controls,
machinery or security-sensitive paths, one otherwise. Three repair cycles are
automatic; exhaustion requires an actual owner decision under CONTRIBUTING. Do
not rebase or merge main only for freshness. Receipt export and hosted admission
rederive the coverage chain from Git objects; [Merge queue](CONTRIBUTING.md#merge-queue)
owns the details.

**Process minimalism.** A new review, verification or control rule needs a
named, concrete failure that the required CI on the integration tree and the
PR's own review would not catch; without one, it is not added. A review covers
the PR's own change: changes on main never invalidate it, a conflict needs
review of its resolution only, and reviews do not expire. Each test runs once,
in the required CI; local runs serve the code being written, not repeated
rituals. Prefer deleting a rule to adding one.

When criteria, required review and checks pass, stop optional edits and continue
only authorized delivery. Missing, stale, dirty, partial or unclosed evidence
refuses verify. Native session receipts are process evidence,
not cryptographic remote attestation or hard signer isolation. Source objects
are trusted through Git's own hashing. No model API, backend, new host or copied
authentication is required. Review grants no publication, merge, secret or settings authority.

Before the first review, read [Review lessons](CONTRIBUTING.md#review-lessons)
and put the simplicity pre-check, the smallest adequate alternative considered,
in the first review request as prose. Add rethink lessons there and promote a
recurring lesson into its owning guidance in the same delivery.

The optional [native queue admission](docs/platform/plans/autonomous-reviewed-delivery.md#approved-native-queue-follow-up-wave)
keeps reviewers in this task and subscription. It was active at the dated
inspection in [Development and release](docs/platform/DEVELOPMENT_AND_RELEASE.md#reading-results-and-recovering).
The supervisor posts `node scripts/agent-review-session.mjs receipt <PR>` output
as a PR comment with `gh pr comment <PR> --body-file -`, within delivery authority,
as soon as the pull request is open and ready, and waits for actual admission.
Admission checks the live PR head, tree and reviewer floor.

Trusted main runs admission, so a PR cannot change the code that admits it. A
group carries the source review when it is a clean merge of the reviewed change.
Queue rebuild recovery remains bounded at two retries and does not reset repair cycles.
Settings remain a maintainer action; see [Deliver a change](CONTRIBUTING.md#deliver-a-change)
and [Merge queue](CONTRIBUTING.md#merge-queue).

Run `npm run oss:published-tree -- --policy` during implementation. Its report
names the owner section for each changed source responsibility. Update that
section with the code, or record the scoped, delta-bound no-impact explanation
described in [Documentation maintenance](docs/platform/DOCUMENTATION.md#impact).
Regenerate navigation with `--policy --docs-update` before the final check.
Generated bytes, a date or an unrelated paragraph do not settle the obligation;
reviewers must check the explanation's meaning. The checker runs on Node without
an agent-specific hook or private repository.

Each newly recorded native review report includes a short `documentation`
assessment: the affected canonical sections, related instructions/examples and
no-impact reasoning, including documentation-only changes. Check claims against
the selected source/contracts and installed-version boundary. This is part of
the existing review, not another reviewer or author form. The supervisor checks
its meaning; a nonempty field alone is not proof of correct documentation.

For running, placing and adding tests, follow [Test scope and diagnostics](CONTRIBUTING.md#test-scope-and-diagnostics).
Use its [sufficient-evidence rule](CONTRIBUTING.md#sufficient-evidence-and-material-test-gaps)
for material proof gaps; test presence or an arbitrary surviving mutant alone is insufficient.

Keep changes small, test the affected public contract, and make failures actionable. An adapter must demonstrate its declared capabilities and refusal behaviour without relying on live provider access.
A migration, status mapping, or idempotency rule needs a regression test for its failure or replay boundary.

`npm run lint` checks first-line file-wide ignores before running the ast-grep
structural rules in `scripts/ast-grep/rules`, rejects bare and unused
suppressions, runs the rule tests, then ESLint. Portable core/UI production
source has provider import boundaries, and every package's production source
has industry-neutral contract-name checks; opaque adopter data remains generic. The industry rule covers TS/TSX
syntax, not arbitrary values or semantic analysis.
Run `npx --no -- ast-grep scan --error=no-suppress-all
--error=unused-suppression` after each change for focused feedback, and run
`npm run lint` before committing: it also checks first-line file-wide ignores
and is the required `typecheck` job's command. These rules catch ordinary
mistakes; review handles deliberate evasion. Keep `--no --`: without it,
npx can fetch an unrelated package of the same name when the local binary is
missing. A refusal names the rule, the platform rule behind it and the fix:
change the code, not the rule, and never add a file to a rule's `ignores`. A
justified exception is an `ast-grep-ignore` comment naming the rule on the line
immediately before the code, with the reason in a comment above it. Do not put
a blank line after a first-line ignore: that makes it file-wide and lint rejects
it, including BOM-prefixed and triple-slash comments. Lint also rejects unused
suppressions. A new rule cites the
platform rule it enforces and ships valid and invalid cases in
`scripts/ast-grep/rule-tests`. Use `npx --no -- ast-grep run --pattern '<code
pattern>'` to find every structural occurrence before and after a change, and
add `--rewrite '<replacement>' --update-all` for a mechanical edit across the
tree;
[contribution checks](CONTRIBUTING.md#development-preview-checks) describe the rules and
their exceptions.

Use only the configuration and test fixtures supplied for the selected development profile. Do not place sensitive values in source, fixtures, logs, or documentation.
Follow [SECURITY.md](SECURITY.md) for reporting and handling a suspected vulnerability; this guide intentionally supplies no reporting address of its own.

## Release posture

The development preview is not a stable framework channel. Do not call a source checkout, preview artifact, extension seam, or self-host recipe stable or supported before `P1-SF` is complete.
A release or activation needs its own explicit authorization and evidence; ordinary code changes do not create that authority.
