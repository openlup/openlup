# Documentation maintenance

Status: development-preview guidance.
Audience and purpose: contributors maintaining public navigation and behavior
guidance, and consumers importing that documentation into another presentation.

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
development-preview limits visible and do not infer framework support from
source availability. Release-specific instructions belong with the selected
immutable release; see the [install support policy](../../.github/INSTALL_SUPPORT_POLICY.md).

## Ownership

Review coverage helpers use the existing tooling owner in CONTRIBUTING.
Task records belong in the PR description under
[Deliver a change](../../CONTRIBUTING.md#deliver-a-change).

The source-only outcome and package-set BOM generators route to
[distribution evidence](DISTRIBUTION_EVIDENCE.md). Its projection section owns
class grouping, exact input fingerprints and refusal of partial outcome claims;
its BOM section owns committed inventory and verified artifact identity. The
publication catalogue includes their helpers, wrappers, witnesses and the one
generated outcome file. README evaluation paths and installation policy retain
preview and sandbox-payment limits. Generated navigation grants no execution,
installation, publication or support qualification.

The hosted S3 task and storage witness are public source outputs. The runner
owner in runtime guidance defines its explicit storage-only declaration, private
lifecycle continuity and pending/observed/cleanup receipt boundary. The adapter
owner defines prefix selection and opt-in single-current-version admission;
default history refusal remains unchanged. Generated navigation grants no
hosted qualification.

The small installed `AGENT_CONTEXT.md` corpora in core, outbox and platform are
generated from selected canonical owner sections by
[`scripts/agent-context/generate.mjs`](../../scripts/agent-context/generate.mjs).
Run `node scripts/agent-context/generate.mjs` after changing a selected owner
or a package version;
`node scripts/agent-context/generate.mjs --check` refuses stale or missing
snapshots without writing; `npm run oss:published-tree -- --policy` runs this
freshness check before the publication and documentation policy. Packaging consumes the checked-in Markdown and never
generates context during prepack. The generator's focused witness runs with
`node --test scripts/agent-context/generate.test.mjs`.
Each excerpt retains its original Markdown bytes, source path, one-based
inclusive line span and SHA-256. Shipped package-local owner paths are relative
to the installed package; all other owners link to the source repository at
`openlup-<package>-v<version>`, read from the package manifest. Relative links and
repository-internal paths or aliases inside verbatim excerpts describe that
checkout, not required application files. The corpus cap is 14,000 bytes
(previously 12,000) to retain the existing routes plus explicit release citations. These small task routes support offline reading; they do
not certify an installed runtime, hosted qualification or compatibility with
another revision. Canonical owners remain authoritative and the source map
continues to own broad source navigation.
The cycle task routes retain the core engine's late-payment clamp and the
canonical late-delivery/replacement alignment boundary as separate owner
excerpts; retrieval must not conflate payment timing with delivery confirmation.
The delivery excerpt stops before the native translation paragraph; its cited
line span and hash describe only the retained verbatim guidance.
Additional small routes cover adopter data ownership, the first ordered-forward
rules, cross-domain idempotency, provider-adapter capabilities and subscription
layer/delivery navigation. The idempotency owner is reachable from the platform
and outbox corpora; retrieval returns one canonical-source result for the same
section.
An excerpt from an installed README or engine page is not returned alongside
that page's matching section. The CLI separates nested headings into disjoint
spans and offers `--package-code` only when an agent explicitly needs installed
`src/` evidence; these are bounded source leads, not proof of application
composition or installed database state.

The exact-shipment native G17 host binding and its local unit/native witnesses
route to the [transfer architecture owner](ARCHITECTURE_AND_EXTENSIONS.md#existing-store-transfer-and-recovery).
The [data owner](DATA_AND_MIGRATIONS.md#compatibility-lifecycle) defines its
actual restricted-login recovery proof. This source routing does not establish
whole-store transfer, host exclusion, provider qualification or new-dispatch
runtime capability.

The Node host and scheduler shutdown source, API reports and disposable
PostgreSQL drain witness belong to the platform package's
[scheduled jobs boundary](../../packages/platform/README.md#scheduled-jobs).
Runtime guidance owns host dependency disposal and retains the separate
external executor fencing and effect reconciliation duties. The publication
catalogue includes the real-session witness; generated navigation establishes
no current test result or complete store-transfer claim.

The migration session hook, union/history controls, seven issued qualified
approval inputs and five additional inert restricted-bootstrap fixtures retain the
[migration owner](DATA_AND_MIGRATIONS.md#module-catalogues-and-installed-histories).
The package entry and contributor witness descriptions link to that boundary;
publication inventory includes the control witnesses and inert fixtures without
admitting the five separately approved replacements to the canonical installation catalogue.
The released legacy upgrade witness and its child process route to the same
[data owner](DATA_AND_MIGRATIONS.md#compatibility-lifecycle). Its published
predecessor pin, real backfill and code-rollback limit belong there; contributor
guidance owns the process-kill test invocation and the child's execution-path
registration. This adds no qualified-v2 upgrade lineage or migration SQL.

Application lifecycle source, owner-local witnesses and its API report route
to the [application-file ownership boundary](ARCHITECTURE_AND_EXTENSIONS.md#application-file-upgrades).
The package README remains the short import entry, the package reference owns
the disposable recipe, and database/runtime owners retain their separate
compatibility and admission duties. Generated navigation adds no upgrade,
installation or provider claim.
The installed versioned-application witness routes to that same file-upgrade
owner. Its existing native cold scenario observes the canonical database before
fixture grants and exercises real operations through an application login;
the database owner retains schema compatibility and qualified-role acceptance.

The lifecycle legacy PostgreSQL role helper, its package witness and actual
PostgreSQL witness route to the
[finite legacy role-observation owner](DATA_AND_MIGRATIONS.md#legacy-fresh-bootstrap-role-observation).
Its report is role-prerequisite evidence, never install readiness. The package
reference owns the invocation; runtime guidance keeps installation and grant
admission separate. Shared lifecycle API documentation retains both boundaries.

The app-file witness's owned child Node process is named in the existing closed
public execution inventory; this records its CLI carrier without adding a job.

Portability source, package witnesses, the compatible-row PostgreSQL witness and
its API report route to the
[transfer architecture owner](ARCHITECTURE_AND_EXTENSIONS.md#existing-store-transfer-and-recovery).
Data guidance retains canonical import-trigger/identity limitations; runtime
guidance retains effect-time fencing and host capability ownership. Navigation
and selected-row/local-object evidence do not close the full store-transfer outcome.

The local handover sources (entry, cohort and catch-up helpers, dispatch actor,
application actor and provider) route to that same transfer architecture owner.
Runtime guidance explains exact process/backend retirement and the frozen
coordinator; data guidance preserves interrupted graph/media state. Contributor
guidance owns the opt-in command, four executable carriers and retained
handover proof. The optional catch-up mode adds the finite preliminary/final-generation
journey and its structured local report under the same transfer owner; it does
not extend managed-history or hosted qualification. Exact publication and
generated navigation add no execution,
adopter-host qualification or delivered-predecessor claim.

Operations source, owner-local witnesses, the unchanged control-plane SQL
projection and the three operations API reports route to the
[operations architecture](ARCHITECTURE_AND_EXTENSIONS.md#operations-and-diagnostics).
The package README is the short import entry point; the historical module record
retains scope and task records retain candidate evidence. Navigation
adds no activation or hosted-provider claim.

Risk package sources, API reports, sparse SQL projection and neutral witnesses
route to the [risk contract](ARCHITECTURE_AND_EXTENSIONS.md#risk-contracts).
The package README owns its three experimental entry summaries; migration
guidance owns full-catalogue installation and unchanged SQL identities. The
publication catalogue inventories these files; generated navigation establishes
no activation, managed parity, privacy reconciliation or installation claim.

The plain Vitest worker-policy witness is a public tooling source in the
publication catalogue; its embedded child CLI is also a declared execution
entrypoint, like the existing process witnesses. Register new tracked test paths there before final
policy/inventory checks; those checks compare Git's tracked paths, so an
untracked test alone cannot establish complete publication evidence.

Marketing analytics source and its neutral witnesses belong to the platform
runtime-boundary owner. Reference analytics and purchase bindings retain their
host policy; runtime guidance explains local admission, consent ordering and the
reference checkout-kind restriction. Publication inventory includes the package
facts and the frozen reference purchase transcript; generated navigation carries
no delivery or activation claim.

The server-only analytics context handler and its package witness share that
runtime-boundary owner. Package and architecture guidance explain its required
host ports and absence of default persistence or a reference route; runtime
guidance owns refusal ordering, verified-subject enrollment and the local meaning
of `active`. Publication inventory includes these sources without claiming
portable context SQL, activation or delivery.

The historical renewal-control re-pin moved inert fixtures under
`scripts/fixtures/reviewed-m10/`.
The migration guide owns the exact 18-pin inventory (with historical 14/16-pin reads) and payment/stock/preview purpose; the data guide owns
same-rail landing order and real PostgreSQL witnesses. Generated navigation
lists these control inputs without admitting them to an installation manifest
or establishing activation, package publication or managed parity.

The CI image mirror workflow, dependency-free script and offline witnesses are
public source outputs in the publication catalogue. Contributor checks own its
default-branch execution and one-time package visibility/access setup; canonical
contracts own the single owned digest inventory, the checksum-pinned PostgreSQL
test packages and mirror-first PostgreSQL consumer selection with public upstream
fallback, except the mirror-only required `install-packages` startup step.
The shared pull module, PostgreSQL helper and stock pgTAP runner are public
source outputs. Contributor checks own their bounded, digest-only retry/fallback,
including exact local reuse, the gate's shared pull path and remaining-budget
Retry-After fall-through within the selected sources. The mirror reads only that
inventory. PostgreSQL consumers, including the pgTAP runner's install-proof pin,
retain upstream sources in CI and locally, except the required `install-packages`
PostgreSQL startup step: it selects only the GHCR mirror, has no upstream fallback
and requires access to that organization package.
The active CLI bump task is included as an authored catalogue output. Generated
bindings establish no registry publication.

Invoicing source, contract witnesses and both API reports route to the
[invoicing architecture owner](ARCHITECTURE_AND_EXTENSIONS.md#invoicing-contracts).
The package README keeps a short export summary; the package reference owns the
longer host-seam recipe outside the npm tarball. Canonical contracts distinguish
unknown, exact absence and unsupported duties. The design plan and offline conformance
witnesses describe their limited proof without making a store or activation claim;
navigation adds no runtime authority.

The platform package README remains its API entry point, with brief module
summaries and preserved top-level anchors. Longer identity and communications
recipes live verbatim in the [platform package reference](PLATFORM_PACKAGE_REFERENCE.md),
which the publication catalogue includes in the public source tree rather than
the npm artifact. Detailed recipe links point there directly; existing identity,
runtime and package ownership routes remain unchanged.

Marketing's PostgreSQL export barrel and generated server API reports are public
source outputs in the publication catalogue. The package README and
[server composition recipe](PLATFORM_PACKAGE_REFERENCE.md#marketing-server-composition)
own the separate handler and optional-peer adapter entries; the contributor
guide owns their existing boundary, cold-consumer and PostgreSQL proof checks.

Subscription source, contract witnesses and generated subscription API reports
route to the [subscription architecture owner](ARCHITECTURE_AND_EXTENSIONS.md#subscription-contracts).
The package README links the exact export and refusal surface in that owner;
canonical contracts own continuity and payment-evidence meaning. Navigation describes this
contract step without implying that later stores or a runner are installed.

Release preparation inventories core, outbox and platform changelog histories as
public source documentation. These verbatim archives remain outside the npm
artifacts; each packed changelog retains the current and two previous releases.
The release guide owns the rolling rule and package READMEs retain API ownership.

Fulfillment routing covers the complete `fulfillment*.api.md` report family,
including the opt-in example report, under the existing architecture owner.
The generated source map lists that family alongside its source and witnesses;
this changes navigation coverage without adding an export or claiming conformance.

O-P3b-2 removes the 27 duplicate root payment implementation/test paths from the
publication catalogue. The package README owns the eleven experimental
reference-support exports; payment contracts own nominal error trust and
host-return translation, architecture owns package/host placement, and runtime
owns inert composition. Root adapter and payment owners describe retained host
policy and unchanged domain contracts. Package donor witnesses stay in place;
the [A2 ledger](plans/oss-a2-payment-adapters.md#o-p3b-2-reference-support-and-root-rebinding-2026-10-22)
records root retirement separately from C5 adopter retirement.

The bounded unused-root payment retirement removes only the ten deleted paths
from the authored publication catalogue. Generic HTTP helpers, package adapter
sources and their witnesses keep their existing inventory and owners. Generated
source bindings and navigation describe that smaller tree; they establish no
new export, activation or release. The [case ledger](plans/oss-a2-payment-adapters.md#o-p3b-1-unused-root-retirement-2026-10-22)
distinguishes root retirement from the remaining adopter obligation.

The opt-in payment example's private capability descriptor is catalogued with
its adapter sources; the existing public re-export is unchanged. The
[payment contract](CANONICAL_CONTRACTS.md#opt-in-payment-example) owns the
single-currency notification binding and ambiguous-currency refusal.

The opt-in payment readback parity witness is catalogued as a public test output.
It runs the contributed provider interpretation with the package-local donor host
money check; the [A2 ledger](plans/oss-a2-payment-adapters.md#case-ledger-coordinator-budget-ruling-a) owns its
parameterized case accounting, and the [payment contract](CANONICAL_CONTRACTS.md#opt-in-payment-example)
owns readback behavior. The catalogue row makes that witness available in the
public tree without adding a package export or claiming provider activation.

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

The native catalog move keeps the package README as owner of the two
factory exports, sparse descriptor and structural contribution. The adapter
owner explains reference compatibility paths; the runtime owner explains the
explicit inert selection and unchanged default exposure. The package guide
owns the proof files and reused packed-consumer scenario. The
publication catalogue and derived source contract inventory these additions;
neither generated navigation nor schema-object presence establishes activation
or a successful installed consumer.

The catalog extraction keeps the platform README as owner of its new package
entries and moved witnesses, and the catalog domain README as owner of reference
shims and retained browser schemas. Author the exact publication catalogue rows for moved tests
and new package sources; there is no catalogue discovery generator. Validated
regular non-executable `packages/{core,outbox,platform}/changes/*.md` fragments
are the sole pattern admission without rows. Policy and inventory checks derive
live source-release bindings, validate authored fields and structure, and report
a stale committed snapshot without failure. Refresh that snapshot only in a
reviewed release-preparation change with the source-release preparation CLI;
release paths require strict equality against the target Git objects. These projections describe the
unchanged source move; they establish no new installation or publication claim.

OIDC selectors assign the explicit host composition, pinned disposable compose
and real-issuer conformance modules to the identity guide. Package/API owners
retain exported-contract explanations, architecture retains readiness and actor
scope, and contributor tooling retains packed-consumer execution obligations.
These routes describe source ownership, not successful issuer certification.

Identity selectors also cover reference admission, the finite bundle schema
inventories, direct reconcile and operator command composition. Their owner is
the identity guide; runtime, package and publication owners retain their
installation, consumer and execution-contract obligations.

Identity ownership includes the disposable mailbox, profile-local policy and
opt-in acceptance sources. The browser identity owner additionally describes
the selected entry, account/admin mounts and closed import inventory. Runtime
and architecture owners retain the shell's admission and public-policy boundary;
contributor owners retain verification and command-inventory obligations.

Privacy routing additionally names the identity-owned export/erasure contracts,
canonical receipt SQL and projection, reference privacy routes and subscription
veto, operator Settings panel and conformance modules. These selectors retain
previous canonical owners. Package composition, runtime mounting and
direct/managed schema limitations remain explained by their respective owners;
generated navigation describes source locations rather than installation proof.

Identity routing includes the direct operator challenge source and tests,
canonical/projection SQL, runtime auth composition and browser auth seams. The
browser identity owner covers both customer and operator page/provider composition,
selected-profile inventory, callback and persistence guidance. The identity guide
owns their behavior; package, architecture, migration and runtime owners retain
their API, installation and host explanations. Generated navigation reflects
these routes and never substitutes for those substantive owner updates.

The [domain registry](../../src/lib/coreDomains.ts) names platform domains. The
[publication catalogue](../../config/openlup-publication-catalog.json) supplies
the public path inventory. A moved test keeps its `public-output` class
and takes its new source owner; the subscription action-guard test now lives
beside the reference handler and is owned by the runtime guide. The [documentation routing map](../../config/doc-routing.json)
assigns those paths to canonical owner pages and sections; it is not a second
domain or publication census.

The portable operations reference binding and its composed witness route to the
operations architecture owner. Their catalogue rows admit source and local
proof, without adding a package entry, installed-default claim or hosted
observability certification. Runtime guidance describes the host-supplied ports
and captured delivery boundary separately.

Partner acquisition keeps its existing Partners semantic owner when the neutral
schemas, type-only port and PostgreSQL store are contributed under marketing.
Exact source selectors extend the existing Partners route; marketing retains
shared entry/distribution responsibilities. The Partners page links its package,
public-producer and installed PostgreSQL witnesses, while data and architecture
pages retain privacy/catalogue and host-composition duties. This routing creates
no new domain, capability or installation claim.

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
or role, but cannot independently establish the module's behavior.

Inventory, index, ancestry and object reads share one checkout-bound Git runner.
It ignores ambient repository/index redirects, replacement objects and grafts,
disables lazy fetching and filesystem monitors, and excludes global/system Git
configuration. This preserves the actual object meaning of the reported SHA.

The outbox rail owns its package protocol and transaction guide. Documentation routing assigns its source, explicit disposable consumer proof and reference composition to that guide; core retains shared kernel and checker documentation. Regenerated navigation lists these actual source responsibilities.

The normalized channel package sources, type/API reports and preservation tests
route to the [package channel contract](../../packages/platform/README.md#channels).
The data guide owns paired SQL, selected inventories and trusted-owner differences;
architecture owns explicit owner composition and provider readiness boundaries.

## Reader guide contract

The reader guide lives in
[`packages/core/docs/guide/`](../../packages/core/docs/guide/README.md); its index
holds the writing rules. The `docs:check` script of each publishable package runs the
[documentation contract](../../packages/core/scripts/documentation-contract.ts).
Core runs it inside its `ci:required`; the root test suite runs it for outbox and
platform, so a required check covers all three. The contract refuses:

- a `ts` fence in the guide or a package `README.md` or `AGENTS.md` that does not
  type-check against the built packages; a fence identical to the package's
  type-checked smoke example is already compiled, and a fence that must not
  compile is marked `ts nocheck` and opens with a `//` reason line;
- a stale or unknown `<!-- generated:<name> -->` region. The generators are
  `maturity:<core|outbox|platform>` from that package's `release-gates.json`
  and `configuration-keys` from `config/environment-variables.json`;
- in the guide, a relative link that leaves the guide, a repository link that
  is not `https://github.com/openlup/openlup/blob/openlup-core-v<version>/<path>`
  at the core version or whose path is missing, and repository-internal
  language: task and milestone IDs, plan names, paths into tests, plans or agent
  scratch, delivery-process vocabulary and absolute filesystem paths. Exact
  terms such as product and algorithm names are admitted by
  [`config/documentation-guide-allowlist.json`](../../config/documentation-guide-allowlist.json);
- an `AGENTS.md` at a package root or the repository root above 200 lines or
  10240 bytes.

`npm --workspace @openlup/core run docs:check -- --write` regenerates the regions and
rewrites the release tag of every repository link in the guide. Guide pages
need no publication catalogue row; see
[the catalogue rule](../../CONTRIBUTING.md#package-policy-and-release-checks). Store vocabulary
stays out of the guide through the tree-wide neutrality ratchet, which counts
the adopter store terms in Markdown as categories `store-0` and `store-1`. Separately,
`npm run oss:published-tree -- --policy` refuses a home-directory path
(`/Users/…`, `/home/…`, `C:\Users\…`) in any tracked Markdown.

The [tutorial](../../packages/core/docs/guide/start/tutorial.md) marks runnable
steps with `sh tutorial` fences and ordered stdout expectations with
`text tutorial-expect` fences.
[`guide-tutorial.ts`](../../scripts/packages/guide-tutorial.ts) executes those
commands in one Bash session: `--packages` substitutes the candidate version
and packed install artifacts, while `--registry` runs the page verbatim against
the public registry.
The `install-packages` job runs it after the package proofs and before PostgreSQL
cleanup; it is non-blocking until two green merge-group runs on main, after which
`continue-on-error` is removed.
Push-to-main runs reuse merge-group evidence and skip the tutorial step when
reuse succeeds.
A step the product cannot pass is stated as a current limit, not worked around.

## Impact

Documentation updates and their review follow
[Deliver a change](../../CONTRIBUTING.md#deliver-a-change).

## Navigation and source map

Delivery, review and same-PR documentation updates follow
[Deliver a change](../../CONTRIBUTING.md#deliver-a-change).
The policy self-check validates owner paths and anchors, ordinary local Markdown
links and generated navigation/source-map freshness. It checks structure; the
reviewer checks whether the explanation remains true against source and contracts.

The root [`AGENTS.md`](../../AGENTS.md) is the single source of the
[public agent guide](AGENT_GUIDE.md). `--docs-update` copies it to
`docs/platform/AGENT_GUIDE.md`, relocating each relative Markdown link outside
code for that directory and replacing only the status paragraph that names the
source. The check refuses a guide that differs from this generated form, so
edit the root file and regenerate; never edit the guide by hand.

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
capability census. Regenerate after adding or moving sources, changing headings
or editing the root `AGENTS.md`.
Generated output does not establish runtime behavior, hosted qualification or
compatibility with a different installed package version.

## Exporting

Bundle source records use actual file-byte hashes and authored catalogue classes.
The sole implicit class is `public-output` for validated package changelog
fragments under the exact `packages/{core,outbox,platform}/changes/*.md` pattern.
A stale committed source-release digest snapshot does not invalidate navigation:
policy still runs derivation and validates its authored fields before export.
Bundles hash the snapshot's actual bytes rather than trusting its digest fields.

The documentation bundle carries the selected Markdown bytes, navigation,
search information, source links and `llms` indexes from the same inputs. Its
manifest records the format version, profile and maturity, stable page/source
identities, content digests and provenance.

A clean export names the exact public source commit. A local candidate export
binds its base revision and current content digest and is explicitly
non-publishable; changed bytes must not be attributed to committed `HEAD`.
HEAD, committed inventory, index and raw blob comparisons use the same isolated
Git reader as navigation checks, so local object replacements or environment
redirects cannot substitute the revision being exported. The exporter compares
raw bytes and modes without `git status` or worktree conversions, which could
execute configured Git clean/process filters. A changed index or an untracked
source also refuses a committed export.
Keep output in a new ignored `dist-docs/<name>` directory. The exporter refuses
existing outputs, escaping paths and symbolic-link parents.
Re-export the complete bundle after changing an input instead of copying an
individual stale page over a previous version.

Export does not run Markdown code blocks or MDX. A website may render the plain
Markdown and build search from the bundle; selecting a website revision and
publishing it are separate actions.

From the root of a clean committed checkout containing this mechanism:

```sh
npm run oss:published-tree -- --policy --docs-export dist-docs/committed
```

For review of an uncommitted candidate:

```sh
npm run oss:published-tree -- --policy --docs-export dist-docs/local --docs-local
```

The bundle includes `manifest.json`, raw pages under `markdown/`, `sources.json`,
`search.json`, `llms.txt` and `llms-full.txt`. Page/source IDs use their normalized
repository path; preserve or explicitly migrate links when renaming a page.
The manifest resolves Markdown links to bundled pages or public source at the
same SHA. Draft source links are null, so changed code is never attributed to
its base. Syntactic export names are hints, not a complete TypeScript API index;
the core package's existing API/documentation checks remain authoritative.
`llms` indexes are convenience formats, not a promise that every agent reads them.

## Consumer integrity

Before accepting a bundle, validate its format, required pages and source IDs,
safe paths, content digests and consistent provenance. Refuse missing content,
tampering or a mixture of revisions. Preserve the profile and development-preview
status in the consumer's presentation.
Inspect the plain file tree, including `manifest.json`, before reading any bundle
content. Symbolic links and special files are refused before their bytes are opened.
Source IDs must equal `source:<normalized repository path>` and remain unique.
Each source's owner ID, page, anchor and purpose must agree with its navigation
surface. Page headings are checked against the raw Markdown so an invented
heading cannot make a dangling owner link appear valid.

Pin the public revision and bundle digest from a trusted public build deliberately.
Self-consistent hashes alone do not authenticate a downloaded manifest. A commit
or digest identifies the source
bytes; it is not evidence of a stable framework, a passing test or a hosted
installation. Keep links back to canonical owners so a reader can inspect the
contract and implementation behind an extracted page.

Changes to meaning are authored upstream at those owners and exported again.
The consumer owns rendering, search and navigation presentation; it should not
silently maintain a divergent copy of the platform's contracts.

Validate a local bundle, then validate a public consumer's two trusted pins:

```sh
npm run oss:published-tree -- --policy --docs-check-bundle dist-docs/local
npm run oss:published-tree -- --policy --docs-check-bundle dist-docs/committed \
  --docs-source <full-public-sha> --docs-digest <sha256-digest>
```

Bundle validation is a separate operation: it does not report that the current
source tree passed policy checks. A consumer with both pins refuses
drafts and mismatched revisions/digests. Its loader may import
[validateDocumentationBundle](../../scripts/documentation-bundle-io.ts) directly;
it must use data as plain Markdown, validate before rendering, and sanitize its
chosen Markdown renderer. The platform does not execute content or ship MDX.
An initial website build can obtain the bundle from a pinned public checkout;
attaching archives to releases or adding a hosted endpoint is later publication
work. No second authoring copy or live feed service is required.
