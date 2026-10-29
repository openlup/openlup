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
then the native signed-commit review and final verification. Local preliminary
review snapshots do not establish native admission/counter/expiry; preserve both
histories and actually applicable limits without inferring or resetting state.
Freeze tracked inputs and serialize verification phases sharing mutable output;
run the existing cheap contract/artifact/platform checks before the broad gate.
Complete required local verification and coverage before submission; the sole
bounded alternative is the proved mechanical integration case in
[Native review](CONTRIBUTING.md#native-review-and-accountability).
It requires actual prior full proof, green main evidence and fresh integration
review; missing proof keeps the full route. Early focused feedback helps keep
late failures rare.
For an authorized adopter continuation, use waits for independent, bounded
read-only reconnaissance of its current pins, drift and ownership. Record the
actual registry, adoption and staging endpoint when those outcomes are in scope.

Before DCO sign-off, complete the applicable working-tree checks and obtain any
required maintainer read of the stabilized API, npm-publishing, security-control
or release-control changes and proposed gate budgets. A later material delta
needs its applicable read again. Record computed identities as evidence, not as
a maintainer quote. Committed native review and final verification still follow.

Before each delegated external write, revalidate the actual scope, live PR head
and applicable review/receipt identity and expiry through the existing mechanism.
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
A new agent, session or renamed symptom does not reset limits or evidence expiry.
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

Commit repairs before review. Give fresh reviewers the open finding cards and
obtain passing review of the new tree by the required number of reviewers.
Every material finding must be closed; optional advice never blocks. Evidence
expires 24 hours after the earliest counted PASS report for the current candidate.

Handle `needs_agent_review` within the active task. Unchanged prepare preserves
evidence. Three repair cycles are automatic; after that `needs_owner` requires
the owner to decide whether to continue, narrow or stop. Record an authorized
continuation with `continue "<note>"`, which adds three cycles. Follow the mandatory
supervisor [regroup procedure](CONTRIBUTING.md#regroup-when-work-stops-converging)
before further repairs when its condition is met; it adds no native gate or budget.

The review base is the candidate's fork point (`git merge-base HEAD origin/main`).
A stacked task may export `OPENLUP_STACK_BASE` with the exact predecessor between
that fork point and HEAD. Documentation and local native review use this same
pin; admission requires it on actual main. A predecessor-only landing preserves
the candidate and its expiry. Do not rebase or merge `main` only to catch up.
For a conflict or failed carry-over, merge `main` and re-review.
When `prepare` proves valid prior coverage and exact merge lineage in the same
session, two fresh reviewers may focus on the full integration delta and its
interactions, following [review after integration](CONTRIBUTING.md#native-review-and-accountability).
Inherited source expiry and findings remain binding. A successful exact
`merge-tree` result additionally marks `candidate.integration.mechanical`: only
this proved case avoids a repair-cycle charge. Extra edits or manual resolution
keep ordinary accounting; no old cycle or exhausted budget is refunded.
Otherwise use full review. Refresh `origin/main` before prepare and final verification;
the existing prepare, verify-command and receipt preflight refuse known conflicts
or failed carry-over before expensive work. `prepare --new`
records a changed intent or a rebase in the same append-only session history; findings, reviewers and the repair count carry on. Only
`continue` adds cycles.

When criteria, required review and checks pass, stop optional edits and continue
only authorized delivery. Missing, stale, expired, dirty, partial or unclosed
evidence refuses verify and pre-push once installed enforcement passes its live
refusal tests. Where installed, pre-push also requires the exact clean tree's
passing `openlup-dev verify` stamp. Native session receipts are process evidence,
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
Admission checks the live PR head, tree, reviewer floor and expiry.

A source review carries over to a merge group when either:
- the group tree equals the reviewed tree; or
- the group is exactly the reviewed change on its queue base, which admission
  checks with `git merge-tree`, and the base's net change since the reviewed
  base touches neither the change's paths nor the admission, identity-binding,
  dependency and migration machinery (`.github/`, the review scripts, the
  identity fence, package manifests and lockfiles, migrations). Other check
  configuration is not on this list; the group's mechanical checks run with it.
  A moved `packages/<name>/package.json` does not block carry-over when main's
  and the change's edits to it only add new, disjoint subpath `exports` keys,
  preserve existing values with order-sensitive comparison, and leave every
  other key unchanged. The merged manifest must preserve those values and contain
  exactly both additions; root manifests and lockfiles still block.

The source receipt then admits the group without a new receipt or live session;
the six mechanical checks on the group tree cover behavioural interaction.
Otherwise the group is rejected: merge `main` and re-review. Queue rebuild
recovery remains bounded at two retries and does not reset repair cycles.
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
