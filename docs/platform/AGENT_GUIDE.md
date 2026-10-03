# OpenLup Public Agent Guide

Status: development-preview guidance. This is the authoritative public guide;
the root `AGENTS.md` keeps its rules available to repository agents. Edit both
files together in OpenLup, adjusting relative links for their locations. The
one-time public-root projection is no longer an authoring route.

OpenLup is a subscription-commerce platform. The platform's public tree is a platform monorepo; an adopter owns its own application, brand, content, local policy, and integrations.
This guide governs work in that public tree only. It does not authorize releases, external mutations, or stable-framework claims.
An application that installs `@openlup/*` from npm follows its own `AGENTS.md`, started from the [adopter kit](adopter-kit/README.md).

## Orientation

Read these documents before changing a related boundary:

- [Platform documentation index](README.md)
- [Source map](SOURCE_MAP.md) — domains, canonical owners and code paths; read the relevant owner rather than loading the whole inventory.
- [Documentation maintenance](DOCUMENTATION.md) — ownership, same-change impact and generated outputs.
- [Public documentation writing profile](README.md#write-or-update-a-page)
- [Architecture and extensions](ARCHITECTURE_AND_EXTENSIONS.md)
- [Data and migrations](DATA_AND_MIGRATIONS.md)
- [Runtime and self-hosting](RUNTIME_AND_SELF_HOSTING.md)
- [Canonical contracts](CANONICAL_CONTRACTS.md)
- [CONTRIBUTING.md](../../CONTRIBUTING.md) and [SECURITY.md](../../SECURITY.md)

Treat code, tests, and machine-readable contracts as the implementation truth. Keep documentation aligned when a public boundary changes.
Do not copy a deployment-specific assumption into a platform contract.

## Architecture rules

- Keep browser-shareable contracts and clients separate from server use cases.
- Keep provider SDKs, HTTP clients, environment readers, and payload translation behind infrastructure and adapter boundaries.
- Put durable platform-data changes in ordered migrations; follow the compatibility lifecycle in [Data and migrations](DATA_AND_MIGRATIONS.md).
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

Copying a platform component or page into adopter source is source ejection. The adopter then owns its security, tests, compatibility work, and manual porting of later changes; the platform does not update that copy automatically.

## Change and verification rules

Each implementation task uses a dedicated worktree and branch, for Claude and
Codex alike. From a coordination checkout, automatically create the task
worktree with the configured repository helper before editing, installing or
testing, then operate in that worktree. Recognize an already assigned task
worktree and continue there; do not create another for the same task. Keep the
coordination checkout clean and leave other tasks' worktrees, branches and
processes alone. Read-only reviewers do not need their own worktree.

Keep one compact task record of a finite observable outcome, smallest complete
scope, exclusions, authority and delivery boundary, acceptance and sufficient
completion evidence, risk and execution/proof plan. A small task needs no
separate planning ceremony; a separate specification is justified by an
ambiguous or durable contract. Plans, implementation, review, delegation and
handoffs inherit the approved programme boundary. Execution notes may evolve;
discoveries, review advice and new waves cannot silently add goals, acceptance
obligations or authority. Material changes use the applicable owner decision.

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

Follow the [AI contribution policy](../../.github/AI_CONTRIBUTION_POLICY.md) for accountability,
DCO and delivery authority. The [autonomous delivery intent](plans/autonomous-reviewed-delivery-intent.md)
and [plan](plans/autonomous-reviewed-delivery.md) require the active supervisor to launch independent
fresh-context native subagents in the same conversation under the existing
subscription. Supply approved criteria and exact source without author history
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

Commit repairs before review. A narrow repair within unchanged approved intent,
scope and base may use one fresh cold closure reviewer only after complete prior
coverage is retained and exact candidate lineage is validated. Supply neutral
prior finding cards, the actual repair and interaction context; never supply old
verdicts or author history. The reviewer independently confirms semantic risk:
control, security, schema, executable instruction and unknown repairs require
two reviews, regardless of filenames. Closure must account for every prior
material finding and cannot renew inherited evidence expiry. Complete prior
coverage permits focused repair reviews; unavailable or expired coverage requires
two fresh reviews of the full approved scope.

Handle `needs_agent_review` within the active task. Unchanged prepare preserves
evidence; at most two automatic repair/review continuation cycles are allowed,
including full-review escalation. Exhaustion remains blocked while the supervisor regroups
the execution approach within existing authority; no reset, bypass or automatic
merge follows. Changed intent requires explicit regrouping. The review base is the
candidate's fork point (`git merge-base HEAD origin/main`), so verify and pre-push keep
accepting a reviewed candidate while `main` moves ahead. An ancestor-preserving base
integration requires fresh full-scope review, preserving history and budget. Do not rebase
or merge `main` only to catch up: the merge queue integrates, and a rebase is for a textual
conflict. When criteria,
required review and checks pass, stop optional edits and continue only authorized
delivery steps. Missing, stale, dirty, partial or unclosed evidence refuses verify
and pre-push once installed enforcement passes its live refusal tests. Where the
maintainer-local layer is installed, pre-push also refuses a task-worktree push
whose exact clean tree has no stamp from a passing `openlup-dev verify`. Native
session receipts are process evidence, not cryptographic remote attestation or
hard signer isolation. No model API, backend, new host or copied authentication
is required. Review grants no publication, merge, secret or settings authority.

The optional [native queue admission](plans/autonomous-reviewed-delivery.md#approved-native-queue-follow-up-wave)
keeps reviewers in this same task and subscription. It was active at the dated
inspection in [Development and release](DEVELOPMENT_AND_RELEASE.md#reading-results-and-recovering).
The supervisor supplies current source evidence for the reviewed PR head, or
for the exact merge-group run/attempt, then observes the queue's actual base,
head, tree and source identity.

A source review carries over to a merge group when either:
- the group tree equals the reviewed tree; or
- the group is exactly the reviewed change on its queue base, which admission
  checks with `git merge-tree`, and the base's net change since the reviewed
  base touches neither the change's paths nor the admission, identity-binding,
  dependency and migration machinery (`.github/`, the review scripts, the
  identity fence, package manifests and lockfiles, migrations). Other check
  configuration is not on this list; the group's mechanical checks run with it.

Then the pull request's source receipt admits the group, with no new receipt
and no live session. The six mechanical checks on the group tree are relied on
for behavioural interaction. Otherwise the run-keyed receipt with two fresh
independent full integration reviews applies, under the same approved
criteria.

An author statement cannot establish that the change does not interact with the
base. Keep the source branch unchanged and record group evidence
separately. The existing nonqueue base-integration and repair-budget rules remain.
The supervisor creates the bounded transport input with
`node scripts/agent-review-queue.mjs input-source PR source-session.json` for the
pull request, or
`node scripts/agent-review-queue.mjs input RUN ATTEMPT PR source-session.json [group-session.json]`
for a merge-group run whose source review does not carry over,
submits it through the main-only workflow within authorized delivery, and waits
for actual admission in this conversation. The script does not dispatch or
authorize delivery. Missing evidence remains blocked; no maintainer handoff is
needed for routine review. Queue rebuild recovery is bounded at two retries and
does not reset repair cycles. Changing queue settings remains a maintainer action.
Submit the source receipt as soon as the pull request is open and ready, and,
when the source review does not carry over, the run-keyed receipt as soon as the
merge-group run exists. The complete order, with
both commands, is in [Deliver a change](../../CONTRIBUTING.md#deliver-a-change). The arming, receipt-timeout and flake rules are in
[Merge queue](../../CONTRIBUTING.md#merge-queue).

Run `npm run oss:published-tree -- --policy` during implementation. Its report
names the owner section for each changed source responsibility. Update that
section with the code, or record the scoped, delta-bound no-impact explanation
described in [Documentation maintenance](DOCUMENTATION.md#impact).
Regenerate navigation with `--policy --docs-update` before the final check.
Generated bytes, a date or an unrelated paragraph do not settle the obligation;
reviewers must check the explanation's meaning. The checker runs on Node without
an agent-specific hook or private repository.

Keep changes small, test the affected public contract, and make failures actionable. An adapter must demonstrate its declared capabilities and refusal behaviour without relying on live provider access.
A migration, status mapping, or idempotency rule needs a regression test for its failure or replay boundary.

`npm run lint` checks first-line file-wide ignores before running the ast-grep
structural rules in `scripts/ast-grep/rules`, rejects bare and unused
suppressions, runs the rule tests, then ESLint. Portable core/UI production
source has provider import boundaries and industry-neutral contract-name
checks; opaque adopter data remains generic. The industry rule covers TS/TSX
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
[contribution checks](../../CONTRIBUTING.md#development-preview-checks) describe the rules and
their exceptions.

Use only the configuration and test fixtures supplied for the selected development profile. Do not place sensitive values in source, fixtures, logs, or documentation.
Follow [SECURITY.md](../../SECURITY.md) for reporting and handling a suspected vulnerability; this guide intentionally supplies no reporting address of its own.

## Release posture

The development preview is not a stable framework channel. Do not call a source checkout, preview artifact, extension seam, or self-host recipe stable or supported before `P1-SF` is complete.
A release or activation needs its own explicit authorization and evidence; ordinary code changes do not create that authority.
