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
and selected-row/local-object evidence do not close the full M14 store outcome.

The five local handover sources (entry, cohort helper, dispatch actor,
application actor and provider) route to that same transfer architecture owner.
Runtime guidance explains exact process/backend retirement and the frozen
coordinator; data guidance preserves interrupted graph/media state. Contributor
guidance owns the opt-in command, four executable carriers and retained
handover proof. Exact publication and generated navigation add no execution,
adopter-host qualification or delivered-predecessor claim.

Operations source, owner-local witnesses, the unchanged control-plane SQL
projection and the three operations API reports route to the
[operations architecture](ARCHITECTURE_AND_EXTENSIONS.md#operations-and-diagnostics).
The package README is the short import entry point; the public M14 module record
retains programme scope and lane records retain candidate evidence. Navigation
adds no activation or hosted-provider claim.


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

The M10 control re-pin moves pending inert fixtures to `20261024`, adds native
X/Y, and folds preview replay into N2 under `scripts/fixtures/reviewed-m10/`.
The migration guide owns the exact 18-pin inventory (with historical 14/16-pin reads) and payment/stock/preview purpose; contributor checks own their
same-rail landing order and real PostgreSQL witnesses. Generated navigation
lists these control inputs without admitting them to an installation manifest
or establishing activation, package publication or managed parity.

The CI image mirror workflow, dependency-free script and offline witnesses are
public source outputs in the publication catalogue. Contributor checks own its
default-branch execution and one-time package visibility/access setup; canonical
contracts own the non-CLI pin inventory and mirror-first consumer selection.
The shared pull module, PostgreSQL helper and pgTAP pre-pull witnesses are public
source outputs. Contributor checks own their bounded retry/fallback and CLI
local-name reconciliation, including exact local reuse, the gate's shared pull path and remaining-budget
Retry-After fall-through before non-GHCR fallback; generated bindings establish no registry publication.

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

The P7 native catalog move keeps the package README as owner of the two
factory exports, sparse descriptor and structural contribution. The adapter
owner explains reference compatibility paths; the runtime owner explains the
explicit inert selection and unchanged default exposure. Contributor guidance
owns the three P7 proof files, five cases and reused packed-consumer scenario. The
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
previous owners' impact obligations. Package composition, runtime mounting and
direct/managed schema limitations remain explained by their respective owners;
generated navigation describes source locations rather than installation proof.


Identity routing includes the direct operator challenge source and tests,
canonical/projection SQL, runtime auth composition and browser auth seams. The
identity guide owns their behavior; package, architecture, migration and runtime
owners retain their API, installation and host explanations. Generated navigation
reflects these routes and never substitutes for those substantive owner updates.


<!-- openlup-doc-impact {"unit":"ownership","digest":"sha256-b3d56b4feaad78d44001bd18aeebe086853ba4c6f9cc79d1d49563c50591301d","reason":"The identity browser surface assigns customer pages, session hooks and browser adapters to their new canonical guide. Existing owner precedence and same-change documentation obligations remain unchanged; prior browser and data owners retain their impact review."} -->

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

Most domains use `src/domains/<domain>/README.md` as their semantic owner. A
server README adds server-specific security, money, authorization or operational
constraints when needed. The [server layer guide](../../server/domains/README.md)
explains that convention. Other source families have explicit owners for their
browser, provider, data, tooling, test, policy, asset or historical role.

A more specific route can narrow broad category guidance. Equally specific
conflicting owners, orphan paths, missing pages or anchors, and selectors that
match nothing are errors. When moving or deleting a source, inspect its previous
owner as well as its new owner; changing the route must not hide an obligation.

`anchor: ""` owns the complete page. A nonempty anchor owns that heading and
its subsections until the next heading of the same or higher level. Selectors
support exact paths, `*` within a path component and recursive `**` components.
New platform domains need an explicit route and registry entry; a broad category
cannot hide an unregistered domain. A shared domain README is the default owner;
narrow workflow routes should explain significant internal decisions.
Historical exemption applies to Markdown documents, not executable or configuration
inputs placed under a plan/history directory. Those inputs still owe impact review.

Generated file views identify the responsibility owner and the source of the
description. Authored guidance, source declarations and structural information
are different evidence. A filename or exported symbol can establish a location
or role, but cannot independently establish the module's behavior.

Inventory, index, ancestry and object reads share one checkout-bound Git runner.
It ignores ambient repository/index redirects, replacement objects and grafts,
disables lazy fetching and filesystem monitors, and excludes global/system Git
configuration. This preserves the actual object meaning of the reported SHA.

The outbox rail owns its package protocol and transaction guide. Documentation routing assigns its source, explicit disposable consumer proof and reference composition to that guide; core retains shared kernel and checker documentation. Regenerated navigation lists these actual source responsibilities.

## Impact

For a source change:

1. Resolve its documentation impact against the comparison base.
2. Read each affected canonical section and follow its source and test links.
3. Update the explanation where behavior or the public boundary changed.
4. If the section remains correct, record a scoped no-impact explanation as a
   commit trailer in the change itself, tied to the source delta and its owner.
5. Regenerate navigation, then run the structural and impact checks.

The policy check uses an explicit full base SHA or a local merge base with
`origin/main`. An optional local `OPENLUP_STACK_BASE` supplies the exact pinned
predecessor for a stacked branch and is shared with native review and final
verification. Conflicting `--docs-base` and environment pins refuse. A normal
branch needs no pin. This keeps own-change fingerprints stable before and after
the predecessor lands; native admission separately requires that base on main.
Hosted checks use validated event attribution and checkout
identity. Missing comparison history is a refusal, not a reason to assume that
documentation has no impact. Hosted attribution takes precedence over
`--docs-base`. A missing hosted base is fetched from the public repository by
validated SHA, without credential helpers, prompts or ref updates. An immutable
evaluation checkout lacking `origin/main` can pass its own full commit as the
explicit base; a contribution needs its actual branch comparison base.
The fallback refuses effective repository/worktree URL, HTTP or credential
configuration, including included files and an alias named as the public URL,
before starting transport. Its public HTTPS request disallows redirects and other
transport protocols, pruning, submodule recursion and automatic maintenance. Resolve unsafe
configuration before retrying; refusal diagnostics never print configured values
or potentially credential-bearing keys.

For `merge_group.checks_requested`, hosted attribution requires the public
repository, a nonzero event base on `main`, and the event head/ref matching the
actual queue checkout. The event's commit and tree identity must also match
Git objects. Impact compares that complete event-base-to-group range; unknown,
malformed or mismatched group identity refuses rather than borrowing a PR base.
These structural checks establish attribution, not independent integration
review or live queue activation.

Generated output, whitespace, a review date or an unrelated paragraph cannot
satisfy an affected section's obligation. A scoped no-impact explanation must
be refreshed when its source delta or ownership changes. Its fingerprint binds
the scope; it does not prove semantic correctness, reviewer identity or owner
approval. Review the reason as carefully as a changed paragraph.
The candidate includes staged, unstaged and nonignored untracked paths. If a pending
staged source differs from both committed `HEAD` and the materialized candidate,
reconcile the index before checking; hidden staged proposals must not disappear.
An ordinary unstaged edit after a branch commit is supported.

Run the existing structural and impact entrypoint from the repository root:

```sh
npm run oss:published-tree -- --policy
# For a deliberate local comparison, substitute the full ancestor commit SHA:
npm run oss:published-tree -- --policy --docs-base <full-base-sha>
# Regenerate the map and run the same check:
npm run oss:published-tree -- --policy --docs-update
```

An unanswered obligation reports its owner, changed paths and current digest.
If the existing explanation remains correct, put the reported trailer on its
own line in a commit message of the change. The policy output prints the exact
line to complete:

```text
OpenLup-Doc-Impact: {"unit":"<reported-unit>","digest":"<reported-digest>","reason":"…"}
```

For example, record the explanation in an empty signed commit:

```sh
git commit --allow-empty -s -m "docs: record no-impact for <unit>" -m 'OpenLup-Doc-Impact: {"unit":"<reported-unit>","digest":"<reported-digest>","reason":"Explain why this section stays correct."}'
```

**What a record's digest binds:** the unit, the owner document and anchor, and
the before and after content, mode and ownership of each changed path. It does
not bind the owner section's prose or the comparison base commit.

**When a record expires:** when the source delta or mapping changes, including
a base change to a path the record covers. An edit of the owner section on
`main` does not expire it, so independent pull requests never edit the same
line to answer the same unit. Reviewers still read the reason against the
current section.

Only the change's own non-merge commits between the comparison base and `HEAD`
count. The base's history and merge commits never answer, including the merge
queue's synthetic tip, whose message is the pull-request description.
This relies on the merge queue building merge commits; a squash or rebase queue
would need its own rule.
Records matching no current obligation are ignored; a malformed record in a
change with obligations fails the check. A shallow checkout reads no trailers
and checks a legacy comment only against the current section; fetch complete
history. Every accepted reason is printed by `--policy` for review.

For compatibility, an in-section `openlup-doc-impact` comment accepted by the
previous rule still answers: exactly one fresh record for the unit in its owner
section. The comment's digest is the previous rule's, which also binds the owner
section's text; that text may be the section at the candidate or at any of the
change's own non-merge commits, so an edit of the section on `main` does not
expire it either, while a source or mapping change still does. Only comments
already written in open pull requests qualify; the digest `--policy` reports
now is the trailer's and never satisfies this path. It remains until those pull
requests have merged; existing comments on `main` answer nothing new and are
removed with this compatibility path. Comments inside fenced or inline code
never answer an obligation.

The checker also keeps the previous owner's obligation when routing changes or
a source disappears. Cosmetic edits, records and generated/provenance blocks
are excluded from the substantive comparison. Adding irrelevant prose can still
mislead a structural check: meaningful review remains necessary.

See [contribution checks](../../CONTRIBUTING.md#development-preview-checks) for
the other gates and their execution scope. Documentation checks do not replace
behavioral tests or installation evidence.

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
Git reader as impact checks, so local object replacements or environment
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
source tree passed policy/impact checks. A consumer with both pins refuses
drafts and mismatched revisions/digests. Its loader may import
[validateDocumentationBundle](../../scripts/documentation-bundle-io.ts) directly;
it must use data as plain Markdown, validate before rendering, and sanitize its
chosen Markdown renderer. The platform does not execute content or ship MDX.
An initial website build can obtain the bundle from a pinned public checkout;
attaching archives to releases or adding a hosted endpoint is later publication
work. No second authoring copy or live feed service is required.
