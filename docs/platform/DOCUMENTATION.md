# Documentation maintenance

Status: current contributor guidance for stable 1.x.
Audience and purpose: contributors maintaining public navigation and behavior
guidance.

Documentation is authored with the code it explains. Generated maps help readers
find that code; a reviewer still checks whether the explanation is correct.
Start with the [platform index](README.md) and the affected module's README.

## Authoring

The root README uses an actual English-language Velipet storefront capture at
`docs/platform/assets/velipet-storefront-en.png`, with a caption distinguishing
application-specific presentation from the generic reference profile. It shows
public storefront content only; no customer account, order or operator data is
included. The image illustrates first-party experience, not a passing install
or independent-adopter result.

Keep one canonical explanation for each boundary. A domain README describes its
responsibility, public contracts, important internal steps, refusal behavior and
verification route. A platform page explains a contract spanning domains. Link
between them instead of copying the same instructions into several manuals.
The [development and release overview](DEVELOPMENT_AND_RELEASE.md) owns the
end-to-end execution map: keep its triggers, result interpretation and links
aligned with contributor commands and release policy, without copying their
full procedures or maintainer-local installation instructions.

Write for a concrete task: identify the reader's question, the owning module,
the code to inspect, and the failure that would disprove the description. For
example, the [subscription workflows](SUBSCRIPTION_WORKFLOWS.md) lead from
renewal admission to the durable payment attempt and its replay boundary.

Use repository-relative Markdown links to actual source, contracts and tests.
Check both the target and its section anchor. Link important internal units;
every utility, fixture or asset does not need its own README. Add an owner page
when a boundary needs an explanation readers cannot obtain from its parent.

Distinguish these claims:

| Claim | Required reference |
| --- | --- |
| Source exists | Tracked file at the selected revision |
| Interface is composed | Dispatcher, registry or composition code |
| Profile permits an interface | Selected profile's capability contract and composition |
| Check passed | Command, revision and observed result |
| Runtime works in an installation | Evidence from that installation |

The [public CI record](plans/public-ci-known-red.md) separates current diagnostic
results from archived measurements and required coverage from complete raw
diagnostics. Refresh a current claim with its exact revision, command, observed
exit and hosted run/attempt; keep historical observations attributed to their
original source. A failed or aborted suite names its
reason, triage owner and unexecuted obligation; it cannot establish a passing
installation or compatibility claim. Failure classification needs actual logs,
not a file's presence in the catalogue.

Templates that an application copies, such as the
[adopter kit](adopter-kit/README.md), live under `docs/platform/` with names no
agent tool loads automatically (`*.template.*`). An agent-instruction file
(`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursor/rules`) sits only at the
repository root or a package root. `npm run oss:published-tree -- --policy`
refuses any other placement, so contributor and adopter guidance never mix.

A test file is a falsifier to inspect, not a recorded passing result. Keep
release and profile limits visible and do not infer installation support from
source availability. Release-specific instructions belong with the selected
immutable release; see the [install support policy](../../.github/INSTALL_SUPPORT_POLICY.md).

## Ownership

The [domain registry](../../src/lib/coreDomains.ts) names platform domains. The
[publication catalogue](../../config/openlup-publication-catalog.json) supplies
the public path inventory. A moved test keeps its `public-output` class
and takes its new source owner; the subscription action-guard test now lives
beside the reference handler and is owned by the runtime guide. The
[documentation routing map](../../config/doc-routing.json) assigns those paths
to canonical owner pages and sections; it is not a second domain or publication
census. Open the generated [source map](SOURCE_MAP.md) first to look up any
file's canonical owner page and section rather than scanning per-surface notes.
Task records belong in the PR description under
[Deliver a change](../../CONTRIBUTING.md#deliver-a-change).

Most domains use `src/domains/<domain>/README.md` as their semantic owner. A
server README adds server-specific security, money, authorization or operational
constraints when needed. The [server layer guide](../../server/domains/README.md)
explains that convention. Other source families have explicit owners for their
browser, provider, data, tooling, test, policy, asset or historical role.

A more specific route can narrow broad category guidance. Equally specific
conflicting owners, orphan paths, missing pages or anchors, and selectors that
match nothing are errors. The pending package changelog-fragment selector may
match nothing after release preparation consumes every fragment; its owner route
still applies when a new fragment appears. When moving or deleting a source,
inspect its previous owner as well as its new owner; changing the route must
not hide the previous contract owner.

`anchor: ""` owns the complete page. A nonempty anchor owns that heading and
its subsections until the next heading of the same or higher level. Selectors
support exact paths, `*` within a path component and recursive `**` components.
New platform domains need an explicit route and registry entry; a broad category
cannot hide an unregistered domain. A short single-contract domain README may own the complete page. A page covering
several module contracts should use specific heading owners, so an unrelated
section edit cannot answer their source changes. Production module selectors
should not silently fall back to a package-wide README; narrow workflow routes
should explain significant internal decisions.
Historical exemption applies to Markdown documents, not executable or configuration
inputs placed under a plan/history directory. Those inputs retain their actual implementation owners.

Generated file views identify the responsibility owner and the source of the
description. Authored guidance, source declarations and structural information
are different evidence. A filename or exported symbol can establish a location
or role, but cannot independently establish the module's behavior. Generated
navigation, publication-catalogue rows and source-contract bindings never
establish runtime activation, schema installation, managed parity,
issuer/provider qualification, whole-store transfer or adopter absorption.

Inventory, index, ancestry and object reads share one checkout-bound Git runner.
It ignores ambient repository/index redirects, replacement objects and grafts,
disables lazy fetching and filesystem monitors, and excludes global/system Git
configuration. This preserves the actual object meaning of the reported SHA.

### Surface-specific responsibility splits and boundary limits

Exact path-to-owner mappings live in [`config/doc-routing.json`](../../config/doc-routing.json)
and [SOURCE_MAP.md](SOURCE_MAP.md). The entries below record only the unique
responsibility splits and boundary limits across shared surfaces:

- **Source-release contract and catalogue updates:** derives stable posture for
  the canonical activation identity and retains development-preview, unstable
  posture for local fixtures. Historical `openlup-source-preview/N` tag names remain
  unchanged identifiers. The contract snapshot binds the selected tree through
  the preparation generator, descendant releases preserve repository and
  evidence-class identity, and the validator admits the transition from historic
  preview to stable posture. Author exact publication-catalogue rows for moved
  tests and new package sources. Validated, regular, non-executable package
  changelog fragments and reader guide Markdown follow
  [the two pattern admissions](../../CONTRIBUTING.md#package-policy-and-release-checks).
  Policy and inventory checks derive live source-release bindings, validate
  authored fields and structure, and report a stale committed snapshot without
  failure. Refresh that snapshot only in a reviewed release-preparation change
  with the source-release preparation CLI. Release paths require strict
  equality against target Git objects.
- **Distribution evidence ([distribution evidence](DISTRIBUTION_EVIDENCE.md)):**
  its projection section owns class grouping, exact input fingerprints and the
  refusal to treat partial outcomes as complete. The publication catalogue
  includes the generated outcome projection. The BOM section owns committed
  package inventory and verified artifact identity. README evaluation paths
  and installation policy retain profile and sandbox-payment limits.
- **Hosted S3 task and storage witness:** the runner owner in runtime guidance defines its explicit storage-only declaration, private lifecycle continuity and pending/observed/cleanup receipt boundary; the adapter owner defines prefix selection and opt-in single-current-version admission, with default history refusal unchanged.
- **Store transfer, G17 shipment binding, portability and handover ([transfer architecture owner](ARCHITECTURE_AND_EXTENSIONS.md#existing-store-transfer-and-recovery)):** the [data owner](../../packages/core/docs/guide/upgrade/database-migrations.md#check-application-compatibility) defines restricted-login recovery proof for G17, retains canonical import-trigger/identity limitations for portability, and preserves interrupted graph/media state during handover. Runtime guidance owns effect-time fencing, host capability, exact process/backend retirement and the frozen coordinator. Contributor guidance owns the opt-in handover command, four executable carriers and retained handover proof. Optional catch-up mode adds the finite preliminary/final-generation journey and structured local report under the transfer owner without extending managed-history or hosted qualification, whole-store transfer, host exclusion, new-dispatch runtime capability or delivered-predecessor claims.
- **Node host and scheduler shutdown ([scheduled jobs boundary](../../packages/platform/README.md#scheduled-jobs)):** runtime guidance owns host dependency disposal and retains the separate external executor fencing and effect reconciliation duties; the real-session drain witness establishes no current test result or complete store-transfer claim.
- **Migrations, M10 fixtures and legacy upgrade ([migration owner](../../packages/core/docs/guide/upgrade/database-migrations.md#select-the-complete-catalogue) and [data owner](../../packages/core/docs/guide/upgrade/database-migrations.md#check-application-compatibility)):** the migration owner retains the session hook, union/history controls, seven issued qualified approval inputs, five inert restricted-bootstrap fixtures (not admitted to the canonical installation catalogue), and the exact 18-pin `scripts/fixtures/reviewed-m10/` inventory (with historical 14/16-pin reads) and payment/stock/preview purpose. The data owner owns same-rail landing order, real PostgreSQL witnesses, and the released legacy upgrade witness's published predecessor pin, real backfill and code-rollback limit (adding no qualified-v2 upgrade lineage or migration SQL); contributor guidance owns the process-kill test invocation and child execution-path registration.
- **Application file upgrades and legacy role observation ([application-file ownership boundary](ARCHITECTURE_AND_EXTENSIONS.md#application-file-upgrades) and [finite legacy role-observation owner](DATA_AND_MIGRATIONS.md#legacy-fresh-bootstrap-role-observation)):** the package README remains the short import entry, the package reference owns the disposable recipe and legacy role-helper invocation, and database/runtime owners retain schema compatibility, qualified-role acceptance and grant admission. The installed versioned-application witness observes the canonical database before fixture grants and exercises real operations through an application login; its owned child Node process is named in the closed public execution inventory without adding a job. The legacy role helper's report is role-prerequisite evidence, never install readiness; shared lifecycle API documentation retains both boundaries.
- **Operations, risk, invoicing, fulfillment and subscriptions ([operations architecture](ARCHITECTURE_AND_EXTENSIONS.md#operations-and-diagnostics), [risk contract](ARCHITECTURE_AND_EXTENSIONS.md#risk-contracts), [invoicing architecture owner](ARCHITECTURE_AND_EXTENSIONS.md#invoicing-contracts) and [subscription architecture owner](ARCHITECTURE_AND_EXTENSIONS.md#subscription-contracts)):** the platform package README remains its API entry point with brief module summaries (including risk's three experimental entry summaries and subscription's exact export/refusal surface links) and preserved top-level anchors; longer identity, communications and invoicing host-seam recipes live verbatim in the [platform package reference](PLATFORM_PACKAGE_REFERENCE.md) in the public source tree outside the npm tarball. For operations, the historical module record retains scope, task records retain candidate evidence, and the portable reference binding/witness admit source and local proof without adding a package entry, installed-default claim or hosted observability certification (runtime guidance describes host-supplied ports and captured delivery separately). For risk, migration guidance owns full-catalogue installation and unchanged SQL identities. For invoicing, canonical contracts distinguish unknown, exact absence and unsupported duties, and offline conformance witnesses make no store or activation claim. For subscriptions, canonical contracts own continuity and payment-evidence meaning without implying installed stores or a runner. Fulfillment routing covers the complete `fulfillment*.api.md` report family (including the opt-in example report) under the architecture owner without adding an export or claiming conformance.
- **Vitest worker-policy and review coverage helpers:** review coverage helpers use the tooling owner in `CONTRIBUTING.md`. The plain Vitest worker-policy witness's embedded child CLI is a declared execution entrypoint in the publication catalogue; register new tracked test paths there before final policy/inventory checks because those checks compare Git's tracked paths.
- **Marketing, analytics and partner acquisition ([server composition recipe](../../packages/core/docs/guide/how-to/build/marketing.md#choose-the-import-boundary) and [Partners](../../src/domains/partners/README.md)):** the platform runtime-boundary owner covers marketing analytics source, the server-only analytics context handler and neutral witnesses; reference analytics/purchase bindings retain host policy (with the frozen reference purchase transcript in the publication inventory), runtime guidance explains local admission, consent ordering, reference checkout-kind restriction, refusal ordering, verified-subject enrollment and the local meaning of `active`, and package/architecture guidance explain required host ports and absence of default persistence, a reference route or portable context SQL. The package README and server composition recipe own the separate marketing handler and optional-peer PostgreSQL adapter entries, while contributor guidance owns their boundary, cold-consumer and PostgreSQL proof checks. Partner acquisition keeps its existing Partners semantic owner when neutral schemas, type-only port and PostgreSQL store are contributed under marketing (marketing retains shared entry/distribution responsibilities, the Partners page links its package, public-producer and installed PostgreSQL witnesses, and data/architecture pages retain privacy/catalogue and host-composition duties).
- **CI image mirror, pull loop and pgTAP runner:** contributor checks own default-branch mirror execution, one-time package visibility/access setup, the active CLI bump task, and bounded digest-only retry/fallback (exact local reuse, shared pull path and remaining-budget `Retry-After` fall-through); canonical contracts own the single owned digest inventory, checksum-pinned PostgreSQL test packages and mirror-first PostgreSQL consumer selection with public upstream fallback, except the mirror-only required `install-packages` PostgreSQL startup step (which selects only the GHCR mirror, has no upstream fallback and requires access to that organization package).
- **Changelog histories and frozen starter records:** release preparation inventories core, outbox and platform changelog histories outside npm artifacts while each packed changelog retains the current and two previous releases (the release guide owns the rolling rule and package READMEs retain API ownership). Frozen starter proof/limit records and former platform README release notes live under `history/` outside npm artifacts with rebased Markdown links and byte-preserved proof text attachments; current verification remains in the [starter recipe](../../examples/neutral-store/docs/proof.md) and limits/public composition contracts remain in the installed reader guide.
- **Payment adapter extraction and opt-in examples ([payment contract](CANONICAL_CONTRACTS.md#opt-in-payment-example), [A2 ledger](plans/oss-a2-payment-adapters.md#o-p3b-2-reference-support-and-root-rebinding-2026-10-22), [unused-root case ledger](plans/oss-a2-payment-adapters.md#o-p3b-1-unused-root-retirement-2026-10-22) and [coordinator budget ledger](plans/oss-a2-payment-adapters.md#case-ledger-coordinator-budget-ruling-a)):** O-P3b-2 removes the 27 duplicate root payment implementation/test paths from the publication catalogue; the package README owns the eleven experimental reference-support exports, payment contracts own nominal error trust and host-return translation, architecture owns package/host placement, runtime owns inert composition, root adapter/payment owners describe retained host policy and unchanged domain contracts, package donor witnesses stay in place, and the A2 ledger records root retirement separately from C5 adopter retirement. O-P3b-1 removes only the ten deleted unused-root paths while generic HTTP helpers, package adapter sources and witnesses keep their owners. The opt-in payment example's private capability descriptor stays with its adapter sources (public re-export unchanged), with the payment contract owning single-currency notification binding, ambiguous-currency refusal and readback behavior, and the A2 case ledger owning parameterized case accounting for the readback parity witness (which runs the contributed provider interpretation with the package-local donor host money check).
- **Catalog and channels ([package catalogue section](../../packages/platform/README.md#catalog), [package channel contract](../../packages/platform/README.md#channels) and [catalog domain](../../src/domains/catalog/README.md)):** the platform package README owns the catalogue attribute validator, reference port, pure projection preparation, two factory exports, sparse descriptor, structural contribution, new package entries and moved witnesses; the catalog domain README owns reference shims and retained browser schemas; the adapter owner explains reference compatibility paths, the runtime owner explains explicit inert selection and unchanged default exposure, and the package guide owns the proof files and reused packed-consumer scenario (schema-object presence establishes no activation or successful installed consumer). For normalized channel package sources, type/API reports and preservation tests, the data guide owns paired SQL, selected inventories and trusted-owner differences, while architecture owns explicit owner composition and provider readiness boundaries.
- **Identity, OIDC, privacy and browser auth ([Identity](IDENTITY.md) and [browser identity reference](IDENTITY_BROWSER_REFERENCE.md)):** the identity guide owns OIDC explicit host composition, pinned disposable compose and real-issuer conformance modules (without certifying external issuers), reference admission, finite bundle schema inventories, direct reconcile, operator command composition, disposable mailbox, profile-local policy, opt-in acceptance, direct operator challenges, canonical/projection SQL, runtime auth composition, browser auth seams, and privacy export/erasure contracts, canonical receipt SQL/projection, reference privacy routes, subscription veto, operator Settings panel and conformance modules. The browser identity owner covers customer and operator page/provider composition, selected entry, account/admin mounts, closed import inventory, selected-profile inventory, callback and persistence guidance. Package/API, architecture, migration, runtime and contributor owners retain their exported-contract, readiness/actor scope, shell admission/public-policy, direct/managed schema limitation, installation, packed-consumer and command-inventory obligations.
- **Outbox rail ([Outbox](../../packages/outbox/README.md)):** owns its package protocol, transaction guide, explicit disposable consumer proof and reference composition; core retains shared kernel and checker documentation.

The root README's [Velipet storefront screenshot](assets/velipet-storefront-en.png)
is a public, English-language first-party application illustration. Its branding
and content belong to that application; it is not a generic reference UI,
installed-package acceptance result or independent-adopter certification. The
publication catalogue includes the image so README links resolve in the public
tree. This illustration changes no runtime, package or release contract.

Its approved name/domain references have an exact-line, exact-carrier allowance
in the tree-wide neutrality wrapper, as described in
[contribution checks](../../CONTRIBUTING.md#package-policy-and-release-checks).
The allowance admits only this case-study prose and screenshot references; code
and unapproved references remain subject to the existing scanner and baseline.

## Reader guide contract

The reader guide lives in
[`packages/core/docs/guide/`](../../packages/core/docs/guide/README.md); its index
holds the writing rules. It ships in the `@openlup/core` npm tarball under
`docs/guide/`. The installed `openlup-context` command and its MCP tools index
these Markdown pages alongside package `AGENTS.md`, `README.md`, declarations
and exports, with `CHANGELOG.md` included for upgrade questions. Nested headings
produce disjoint spans. The optional `--package-code` scan provides bounded
installed `src/` leads; results never prove application composition or database
state. The unchanged [lookup smoke matrix](../../scripts/agent-context/evaluate.mjs)
checks static query targets in installed core, outbox and platform artifacts.
Both pack checkers enforce a separate `guide` sub-budget from core's
`release-gates.json` (`pack.guide`), measured like the code and docs classes;
the total tarball limits also apply.
The `docs:check` script of each publishable package runs the
[documentation contract](../../packages/core/scripts/documentation-contract.ts).
Guide Markdown pages link relatively to one another; non-Markdown assets use
repository URLs pinned to the Core release, with target existence still checked.
Core runs it inside its `ci:required`; the root test suite runs it for outbox and
platform, so a required check covers all three. This root-suite enforcement of
outbox and platform `docs:check` depends on
`scripts/packages/platform-agent-guide.test.ts` staying out of `TOOLING_INPUTS`
in `scripts/ci-test-scope.mjs`: unlisted tests always run. The contract refuses:

- a guide Markdown page with zero or multiple level-one ATX headings (`# ` at
  line start); every page has exactly one title, ignoring backtick and tilde
  fenced code blocks;
- a TypeScript fence (`ts`, `typescript`, `tsx`, `mts` or `cts`, case-insensitive,
  with optional trailing attributes) in the guide or a package `README.md` or `AGENTS.md` that does not
  type-check against the built packages; a fence identical to the package's
  type-checked smoke example is already compiled, and a fence that must not
  compile puts `nocheck` first after the language and opens with a `//` reason
  line; JSX is checked with `jsx: preserve`;
- a stale or unknown `<!-- generated:<name> -->` region. The generators are
  `maturity:<core|outbox|platform>` from that package's `release-gates.json`,
  `compatibility-policies` from the validator's static `compatibilityByMaturity`
  object in `packages/core/scripts/public-api-config.ts`,
  `exports:<core|outbox|platform>` from its `package.json` and release gates,
  `sql:<outbox|platform>` from the `.sql` files the package ships under `sql/`, `cli:openlup` and
  `cli:openlup-context` from their static help constants, `versioning` from release
  gates, `configuration-keys` from `config/environment-variables.json`, and
  `refusal-codes` and `refusal-codes-open` from exported API report aliases and
  the lifecycle command's CLI codes;
- in the guide, a relative link that leaves the guide, any GitHub link that
  is not `https://github.com/openlup/openlup/blob/openlup-core-v<version>/<path>`
  at the core version or whose path is missing, and repository-internal
  language: task and milestone IDs, plan names, paths into tests, plans or agent
  scratch, delivery-process vocabulary and absolute filesystem paths. Exact
  terms such as product and algorithm names are admitted by exact,
  case-sensitive matching in
  [`config/documentation-guide-allowlist.json`](../../config/documentation-guide-allowlist.json);
- an `AGENTS.md` at a package root or the repository root above 200 lines or
  10240 bytes.

Each package's `docs:check -- --write` regenerates regions in its `README.md`
and `AGENTS.md`; core also regenerates guide regions and rewrites release tags
only in canonical repository URLs in the guide. HTML anchor `href` targets
participate in local-link and release-tag checks. Link rules read destinations with character references
decoded, and a destination carrying any `&` other than `&amp;` is refused. Each destination is also parsed as a
browser parses it; one that reaches the repository must already be written in the
parser's canonical spelling, so encoded hosts, embedded whitespace, backslashes,
Markdown escapes, user info or ports cannot reach an unchecked repository URL. Export and maturity regions
omit provider-specific subpath names using the neutrality scanner and, when any
are omitted, give the count and link to the complete manifest and package
`AGENTS.md` maturity section at the release tag. Guide pages
need no publication catalogue row; see
[the catalogue rule](../../CONTRIBUTING.md#package-policy-and-release-checks). Store vocabulary
stays out of the guide through the tree-wide neutrality ratchet, which counts
the adopter store terms in Markdown as categories `store-0` and `store-1`. Separately,
`npm run oss:published-tree -- --policy` refuses a home-directory path
(`/Users/…`, `/home/…`, their `file://` forms, `C:\Users\…` and `C:/Users/…`)
in any tracked Markdown.

The evaluation-path table and payment-support paragraph in
[`reference/limits.md`](../../packages/core/docs/guide/reference/limits.md)
remain authored: no machine-readable owner describes those complete boundaries.
[`public-reference-capability-manifest.json`](../../config/public-reference-capability-manifest.json)
owns the default reference's methods, routes and refusals only;
[`shared/limits.ts`](../../examples/neutral-store/shared/limits.ts) owns starter
action codes and localized explanations. Neither describes all five evaluation
paths, the subscription reference's database and egress prerequisites, or a
portable-versus-managed real-money support matrix. Those wider limits are
explained by the [install support policy](../../.github/INSTALL_SUPPORT_POLICY.md)
and [subscription reference](SUBSCRIPTION_REFERENCE.md), with application
composition still required. A provider capability or source file alone cannot
generate that support claim; no documentation-only fact registry is introduced.

There is no blanket refusal of hand-written reference tables. Auditing every
reference page finds legitimate evaluation and action/refusal explanations in
`limits.md` and a localized route inventory in `starter-routes.md` outside
generated regions. Such a rule would reject existing guidance and need either
their separate owner-driven generators or an allow-list. Existing generated
region freshness and unknown-region refusals remain in force.

The [tutorial](../../packages/core/docs/guide/start/tutorial.md) marks runnable
steps with `sh tutorial` fences and ordered stdout expectations with
`text tutorial-expect` fences.
[`guide-tutorial.ts`](../../scripts/packages/guide-tutorial.ts) executes those
commands in one Bash session: `--packages` substitutes the candidate version
and packed install artifacts, while `--registry` runs the page verbatim against
the public registry.
The `install-packages` job runs it after the package proofs and before PostgreSQL
cleanup as a blocking step: the condition of two green merge-group runs on main
has been met. It runs without `--advisory`, so a failed tutorial fails the step.
The workflow admits no `continue-on-error`.
Push-to-main runs reuse merge-group evidence and skip the tutorial step when
reuse succeeds.
The separate registry tutorial is blocking after two green release runs: a
failed tutorial fails that workflow run, which reports to the maintainer. It
runs after publication and cannot affect that publication. A propagation
timeout still warns and defers the tutorial.
A step the product cannot pass is stated as a current limit, not worked around.

## Impact

Documentation updates and their review follow
[Deliver a change](../../CONTRIBUTING.md#deliver-a-change).

## Navigation and source map

Delivery, review and same-PR documentation updates follow
[Deliver a change](../../CONTRIBUTING.md#deliver-a-change).
The policy self-check validates owner paths and anchors, ordinary local Markdown
links and generated navigation/source-map freshness. Local Markdown links may
also target content-validated, pattern-admitted package changelog fragments in
the effective publication catalogue. It checks structure; the
reviewer checks whether the explanation remains true against source and contracts.

The root [`AGENTS.md`](../../AGENTS.md) is the single agent guide for this
repository. The [public agent guide page](AGENT_GUIDE.md) is a stable pointer to
that file and the reader guide shipped in `@openlup/core`.
`--docs-update` regenerates this fixed pointer page. The check refuses a page
that differs from its generated form. Edit repository rules in the root file;
restore the pointer with `--docs-update` rather than editing it by hand.
The legacy `#architecture-rules` anchor remains on the pointer page so historical
links still resolve.

The migration-history and package Migration-block checks use an explicit full
base SHA or a local merge base with `origin/main`. Hosted checks use validated
event attribution and checkout identity, taking precedence over `--docs-base`.
Missing comparison history is a refusal. A missing hosted base is fetched from
the public repository by validated SHA, without credentials or ref updates.

For `pull_request`, the checkout must have exactly two parents and its second
parent must be the event head. The first parent must equal the event base or
descend from it, allowing main to advance after the PR's fork point. The
migration-history and package Migration-block checks compare that first parent
with the checkout, covering only the PR's change. Missing objects or shallow
history that cannot prove this ancestry refuse with a complete-history
diagnostic; restore the required history before retrying.

From the repository root, check or regenerate navigation:

```sh
npm run oss:published-tree -- --policy
npm run oss:published-tree -- --policy --docs-update
```

The routing map selects canonical owners; it is navigation rather than a second
capability census. Regenerate after adding or moving sources or changing headings.
Generated output does not establish runtime behavior, hosted qualification or
compatibility with a different installed package version.

Catalogue offline testing, the shared command branch and installed recipe/skeleton
proofs route to the platform catalog owner and the installed catalogue extension
guide. The refusal-code generator derives recipe links from the typed Node rule
record; navigation adds no installation, publication or activation claim.
