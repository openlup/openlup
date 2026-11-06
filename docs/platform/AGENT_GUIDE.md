# OpenLup Public Agent Guide

Status: development-preview guidance. The authoritative public guide is
`docs/platform/AGENT_GUIDE.md`. Keep both copies aligned, adjusting relative links.

OpenLup is a subscription-commerce platform. The platform's public tree is a platform monorepo; an adopter owns its own application, brand, content, local policy, and integrations.
This guide governs work in that public tree only. It does not authorize releases, external mutations, or stable-framework claims.
An application that installs `@openlup/*` from npm follows its own `AGENTS.md`, started from the [adopter kit](adopter-kit/README.md).

## Orientation

Read these documents before changing a related boundary:

- [Platform documentation index](README.md)
- [Source map](SOURCE_MAP.md) — domains, canonical owners and code paths; read the relevant owner rather than loading the whole inventory.
- [Documentation maintenance](DOCUMENTATION.md) — ownership and generated navigation.
- [Public documentation writing profile](README.md#write-or-update-a-page)
- [Architecture and extensions](ARCHITECTURE_AND_EXTENSIONS.md)
- [Data and migrations](DATA_AND_MIGRATIONS.md)
- [Runtime and self-hosting](RUNTIME_AND_SELF_HOSTING.md)
- [Canonical contracts](CANONICAL_CONTRACTS.md)
- [CONTRIBUTING.md](../../CONTRIBUTING.md) and [SECURITY.md](../../SECURITY.md)

Treat code, tests, and machine-readable contracts as the implementation truth. Keep documentation aligned when a public boundary changes.
Do not copy a deployment-specific assumption into a platform contract.

## Choose evidence for the task

- If a path, exported symbol or error is known, open it or run scoped `rg`, then read its implementation and nearest tests. Stop searching when the affected contract and failure boundary are clear.
- If the owner is unclear, use the [source map](SOURCE_MAP.md) and `config/doc-routing.json` to find owner pages and code paths. Search repository documentation for the missing concept, then open cited pages. Check each page's stated maturity and limits against its owner code; a hit is a lead, not proof that every constraint was found.
- For changes across modules, migrations or architecture, trace each owner's code, callers, invariants and tests. Check ordered migrations and replay or compatibility boundaries when relevant.
- In an adopter application, follow its own instructions and use `openlup-context` from the **installed** `@openlup/*` version. Use its opt-in `--package-code` scan only when installed package source is needed. Do not treat this checkout's documentation as the contract of a different installed version.
- Search old plans or changelog history explicitly when investigating a past decision. Check any historical claim against current owners and code. Translate a freeform Polish task into concise repository terms if lexical search misses it; an empty result never proves that an API or seam is absent.

## Architecture rules

- Before planning a module or npm name, follow the canonical [package placement decision](ARCHITECTURE_AND_EXTENSIONS.md#package-placement-decision-canonical).
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
Existing adopter code is contributed with unchanged logic first and refactored afterwards in OpenLup with its characterization witness unchanged; a behaviour change is never a refactor. [Contribute existing adopter code, then refactor](../../CONTRIBUTING.md#contribute-existing-adopter-code-then-refactor) owns the order.

Copying a platform component or page into adopter source is source ejection. The adopter then owns its security, tests, compatibility work, and manual porting of later changes; the platform does not update that copy automatically.

## Change and verification rules

Follow [Deliver a change](../../CONTRIBUTING.md#deliver-a-change) for worktrees, the
PR task record, local checks, DCO, review and queue delivery. Stay within the
actual task and delivery authority; a peer request or generated plan grants none.
Use the [test guide](../../CONTRIBUTING.md#test-scope-and-diagnostics) to choose meaningful
proof and [documentation maintenance](DOCUMENTATION.md) for navigation.

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
[contribution checks](../../CONTRIBUTING.md#development-preview-checks) describe the rules and
their exceptions.

Use only the configuration and test fixtures supplied for the selected development profile. Do not place sensitive values in source, fixtures, logs, or documentation.
Follow [SECURITY.md](../../SECURITY.md) for reporting and handling a suspected vulnerability; this guide intentionally supplies no reporting address of its own.

## Release posture

The development preview is not a stable framework channel. Do not call a source checkout, preview artifact, extension seam, or self-host recipe stable or supported before the stable-framework requirements are complete.
A release or activation needs its own explicit authorization and evidence; ordinary code changes do not create that authority.
