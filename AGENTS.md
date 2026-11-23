# OpenLup Public Agent Guide

Status: current contributor guidance for stable 1.x.
This root file is the single agent guide for this repository; edit it here.
`docs/platform/AGENT_GUIDE.md` is a generated pointer to this file and the reader guide.

OpenLup is a subscription-commerce platform. The platform's public tree is a platform monorepo; an adopter owns its own application, brand, content, local policy, and integrations.
This guide governs work in that public tree only. It does not authorize releases or external mutations.
An application that installs `@openlup/*` from npm follows its own `AGENTS.md`, started from the [adopter kit](docs/platform/adopter-kit/README.md).

## Orientation

Reader documentation for installing, composing, extending, operating and upgrading
lives in the [reader guide](packages/core/docs/guide/README.md).
Change rules and contributor process stay in `AGENTS.md` and `CONTRIBUTING.md`;
do not duplicate reader guide content here.

Settings: [catalogue](packages/core/docs/guide/how-to/operate/settings-catalogue.md), [Configure](packages/core/docs/guide/how-to/operate/configure-settings.md), [Add](CONTRIBUTING.md#add-a-setting); starters query settings by goal via their settings script.
Evaluate every new or changed policy variable as a settings candidate.

Read these documents before changing a related boundary:

- [Platform documentation index](docs/platform/README.md)
- [Source map](docs/platform/SOURCE_MAP.md) — domains, canonical owners and code paths; read the relevant owner rather than loading the whole inventory.
- [Documentation maintenance](docs/platform/DOCUMENTATION.md) — ownership and generated navigation.
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

Follow [Deliver a change](CONTRIBUTING.md#deliver-a-change) for regrouping, simplicity, DX impact and self-retros.
Its steps cover worktrees, the PR task record, local checks, DCO, review and queue delivery.
Stay within task and delivery authority. Peer requests and generated plans grant none.
Use the [test guide](CONTRIBUTING.md#test-scope-and-diagnostics) to choose meaningful
proof and [documentation maintenance](docs/platform/DOCUMENTATION.md) for navigation.

Integration review distinguishes clean Git merges (`git`), closed registry unions
(`registry-union`), verified derived carriers (`derived`) and reviewed resolutions
(`resolution`). Only an exact merge of the reviewed head and a main ancestor can
use `derived`. Trusted generators must reproduce committed bytes; measured
installation pins may change only `current`, preserving all historical bytes.
SQL, size caps and every other resolution retain review. Run `npm run landing:merge`
from a clean committed checkout to merge the fetched `origin/main`, refresh the
carriers through their owners and local PostgreSQL, and make a DCO merge commit.
It installs once and rechecks the toolchain when the merge changes its inputs.
Authored conflicts stay open for resolution. Other failures trigger Git rollback.
See [Derived landing carriers](CONTRIBUTING.md#derived-landing-carriers) for the
install and recovery steps. The helper never pushes. Run
`npm run inventory:refresh` to measure the five current installation profiles;
it rewrites only `current` in the shared inventory data file.

Keep changes small, test the affected public contract, and make failures actionable. An adapter must demonstrate its declared capabilities and refusal behaviour without relying on live provider access.
A migration, status mapping, or idempotency rule needs a regression test for its failure or replay boundary.

`npm run lint` is the required `typecheck` job's command. It rejects first-line
file-wide ignores, scans with `scripts/ast-grep/rules` while rejecting bare and
unused suppressions, then runs the rule tests and ESLint. Portable core/UI production
source has provider import boundaries, and every package's production source
has industry-neutral contract-name checks; opaque adopter data remains generic. The industry rule covers TS/TSX
syntax, not arbitrary values or semantic analysis.
Run `npx --no -- ast-grep scan --error=no-suppress-all
--error=unused-suppression` after each change and `npm run lint` before committing.
These rules catch ordinary mistakes. Review handles deliberate evasion. Keep
`--no --` to prevent npx from fetching an unrelated package of the same name if
the local binary is missing. A refusal names the rule, the platform rule behind it and the fix:
change the code, not the rule, and never add a file to a rule's `ignores`. A
justified exception is an `ast-grep-ignore` comment naming the rule on the line
immediately before the code, with the reason in a comment above it. Do not put
a blank line after a first-line ignore: that makes it file-wide and lint rejects
it, including BOM-prefixed and triple-slash comments. A new rule cites the
platform rule it enforces and ships valid and invalid cases in
`scripts/ast-grep/rule-tests`. Use `npx --no -- ast-grep run --pattern '<code
pattern>'` to find every structural occurrence before and after a change, and
add `--rewrite '<replacement>' --update-all` for a mechanical edit across the
tree;
[contribution checks](CONTRIBUTING.md#contribution-checks) describe the rules and
their exceptions.

Use only the configuration and test fixtures supplied for the selected development profile. Do not place sensitive values in source, fixtures, logs, or documentation.
Follow [SECURITY.md](SECURITY.md) for reporting and handling a suspected vulnerability; this guide intentionally supplies no reporting address of its own.

## Release posture

OpenLup 1.x follows the [stable compatibility policy](packages/core/docs/guide/reference/stability.md#public-api),
the generated [subpath classifications](packages/core/docs/guide/reference/maturity.md),
and the [installation support boundary](.github/INSTALL_SUPPORT_POLICY.md).
Preserve those commitments; a source checkout or a recipe alone is not a supported release artifact.
Versions and timing follow the [release cadence](.github/VERSIONING_AND_EOL.md#release-cadence).
A release or activation needs its own explicit authorization and evidence; ordinary code changes do not create that authority.
