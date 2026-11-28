# Package, policy and release verification

Status: current contributor guidance for stable 1.x.
Audience and purpose: contributors checking package contracts, publication policy or release preparation.

Start with the [contribution guide](../../../CONTRIBUTING.md) for scope and the local workflow.

## Package, policy and release checks

See the [release cadence](../../../.github/VERSIONING_AND_EOL.md#release-cadence).
`npm run packages:check -- --manifest-only` checks every `packages/*/package.json` against
[`config/openlup-packages.json`](../../../config/openlup-packages.json), which lists each
package as released or as unreleased. A released package `packages/<name>` is
named `@openlup/<name>` and has its own `MAJOR.MINOR.PATCH` version, exact pins
to the current versions of other released `@openlup/*` packages, registry semver
ranges for every other dependency, and curated `exports`: no wildcard or
directory entries, and every target under `./dist/` except a `core-source`
target, which stays under `./src/`, and the `exports["./package.json"]` entry, which
exports the manifest itself for tooling and is not a code entry point. It is either `private: true` or carries
exactly the public, provenance-backed publication settings and a `repository`
entry. Its `publishConfig.tag` stays `preview`, so only the release workflow's
explicit `--tag latest` moves `latest`. An unreleased package is always
`private: true`. A new package stays unreleased through its module's pull
requests and becomes publishable only in the module's final one, where the
reference application composes it, so a set never republishes a half-built
package.

`npm run packages:check` (also `--pack`, retained for existing callers) builds and packs each released package
into a temporary directory, from a package directory with no uncommitted
changes. Every packed file must be either a tracked file of that package, byte
for byte (the manifest included), or built output of a tracked non-test source.
Artifact checks enforce the per-package byte/file caps, content allowlist and
browser-entry budgets. Only `--release-set <version>` checks growth against the
last released baseline and requires explanations in the new set's changelog
section and release body, as described in
[Package artifact limits](../../../.github/VERSIONING_AND_EOL.md#package-artifact-limits).
The privileged release job explicitly selects `--manifest-only`; its separate
unprivileged cold producer still checks every artifact before publication.
Every concrete `exports` target, including JavaScript, declarations and
`core-source`, must be present in the tarball. The core documentation check also
requires relative Markdown links in shipped files to target packed files, not
just files present in the source checkout.
Destination checks are conservative: unsupported boundaries, raw ampersands or
angle characters, Unicode whitespace and malformed percent encoding refuse with
an actionable error. Use literal punctuation or percent-encoded filenames and
ASCII whitespace before optional titles. This keeps ambiguous Markdown from
silently checking a different file.
Declaration maps may resolve only to their shipped, tracked source and adjacent
declaration. It refuses JavaScript source maps, other source-map references,
build-machine home paths, and
the operational coordinates the public detector knows. It prints each tarball's
integrity. `-- --out <dir>` implies `--pack`. It keeps each publishable
package's tarball in an empty directory, with a `packages-manifest.json` of
their versions and digests. `-- --release-tag openlup-<package>-v<version>`
packs only that publishable package and requires its manifest version to be
`<version>`. The command publishes nothing. Set-release dispatch separately runs the
[adjacent starter upgrade proof](../../../docs/platform/DISTRIBUTION_EVIDENCE.md#interrupted-adjacent-set-starter-upgrade)
against those retained digest-verified local packs before release planning;
post-publication provenance and qualification checks still run separately.
[Package releases](../../../.github/VERSIONING_AND_EOL.md#package-releases) describes how
the protected release approval leads to direct OIDC publication.

For managed pgTAP execution and its prerequisites, follow
[Test scope and diagnostics](testing.md#separate-db-package-and-coverage-proof).

The self-check job runs the existing UI neutrality gate and a tree-wide ratchet
that reuses both that gate's patterns and the core source scanner. The initial
[`neutrality baseline`](../../../config/openlup-neutrality-baseline.json) records the
counts on main at its full `sourceCommit`. Counts are pinned per exact path
(SHA-256 key) and category: a decrease elsewhere cannot pay for an increase.
Text files are scanned regardless of extension; binary files are inventoried.
The job also rejects baseline increases relative to the PR base/main push's
previous commit. For a first baseline, or to regenerate from main without
increasing debt, use `node scripts/public-ci-neutrality.mjs --write-baseline`.
After removing debt, lower the affected counts; never raise them.
Two store-vocabulary categories, `store-0` and `store-1`, are counted in Markdown
by the ratchet script itself rather than the pinned scanners, so reader pages
start at zero. A store category that no accepted baseline row carries yet may be
seeded once, up to the counts measured on the base tree and never from the
candidate; after that it ratchets like every other category.

The root `ROADMAP.md` provider matrix has a scoped exception in the existing
opt-in adapter vocabulary allowances: at most two matches each for categories
`ui-12`, `ui-13`, `ui-14` and `ui-15` at that exact path. A third match, those
terms at other paths outside their existing adapter allowances, and every other
counted term or category remain checked. The baseline and scanner pins stay
unchanged. The neutrality CLI witnesses cover the current matrix and these
refusals.

Pinned SQL vocabulary exceptions and their compatibility limits are owned by
[Data and migrations](../../../docs/platform/DATA_AND_MIGRATIONS.md#exact-reviewed-function-forwards).

One module/provider table defines the opt-in allowances for both payment
examples and the tax adapter for the first payment provider. Every entry admits
whole provider words in its own `packages/platform/src/<module>/<provider>/` and
`packages/platform/test/<module>/<provider>/` trees and its declaration snapshot
under `packages/platform/api/<module>-<provider>.api.md`.

The same table derives the case-sensitive tokens and registration positions
for every entry. The platform manifest admits the exact
`./<module>/<provider>` export key and its build targets. The release gates admit
that key, its entrypoint and snapshot, and smoke-evidence paths under the
adapter's test tree, including reuse by other gate entries. The publication
catalogue admits only matching paths in its `publicPaths` rows. Registration
paths use canonical relative segments under their approved roots. Traversal,
dot-segment re-entry, backslashes and absolute paths stay counted.

The platform agent guide, package README, package boundary test, cold-consumer
script and test, architecture and contract docs, and platform change fragments
admit complete subpath tokens. The platform and Core changelogs and versioned
Core upgrade pages also admit the report filename token. Bare vendor prose in
shared carriers, subpath lookalikes, casing changes in carrier tokens and
unrelated categories remain checked.

The opt-in fulfillment example lane subtracts only ui-15 at its exact source,
test, API-report and [A3 ledger](../../../docs/platform/plans/oss-a3-fulfillment-adapter.md)
paths. Fixed registration carriers and platform change fragments admit only the
complete case-sensitive subpath token; the report filename is admitted only in
release gates and the publication catalogue. Outside paths, bare vendor prose,
lookalikes, casing changes and other categories still fail. The script's tests
exercise these plants and negative subtraction without changing the baseline.
Its installed-consumer proof imports the opt-in fulfillment entry
with optional peers and SDK absent, blocks ambient network I/O, checks the exact
runtime inventory and unselected/unready defaults, then exercises only injected
HTTP with explicit host readiness. Missing or malformed evidence refuses before credential
resolution; successful dispatch exposes closed evidence rather than command PII
or response bags. The focused glue tests do not replace the actual fulfillment conformance
runner or the supervisor's committed review and full gates.

The named first-party adoption example has a narrow prose allowance: only the
approved complete lines in the root README, the documentation owner's page and
the exact screenshot catalogue reference are counted once. It subtracts only
that adopter's name/domain categories. Changed or repeated lines, another path,
other brands and every other category still fail normally. Production code has
no exemption, and the baseline and pinned scanner chain remain unchanged.
The existing neutrality CLI tests cover both the admitted illustration and
refusals; changes to the approved wording need the same policy review.

Within one ratchet invocation, the pinned counts-mode scanners reuse the measured
base result only when the complete base and working inventories have identical
paths and bytes, including baseline, scanner and binary files. Both inventories
and pin checks still run; any difference executes both scanner chains. This
relies on the current deterministic counting interfaces, so scanner changes must
revisit that assumption. Separate CLI invocations never share scan results.

For SQL history, forward admission, expression classification and approval pins,
follow [Data and migrations](../../../docs/platform/DATA_AND_MIGRATIONS.md). The required
self-check and release checks use those same contracts.

Before pushing a SQL, migration or registry change, run `npm run sql:admit` after
`git fetch origin`. It dry-runs the hosted admission locally: the self-check's
forward admission and append-only history on `origin/main` and a temporary pull-request
merge, and the queue's co-located approval guard on the fork point and on that merge.
It checks committed revisions only: `--head <rev>` defaults to `HEAD`, against
`--base <rev>` (default `origin/main`). Commit first; a local commit can be amended.
Without an explicit `--head`, any uncommitted change exits 2 with a "not checked"
message and no PASS. With explicit `--head`, only that commit is checked.
The command prints PASS or REFUSED per added forward and check with a capability
hint. Object content, refs, index and worktree stay unchanged, but Git may refresh
existing objects' timestamps. Every Git call uses a closed environment.
Hosted CI judges with the merge commit's admission code and the queue
with main's, so when the code this checkout loads differs from the base, the command
automatically extracts the admission rule closure from the trusted base commit into a
throwaway directory and runs it against the candidate range. It exits 2 only if the base
lacks runnable admission rules, if delegated execution fails or produces no verdicts, or
if already running in delegated mode; merge `origin/main` first, or pass
`--allow-stale-rules` to run the local checkout's rules with a warning. A PASS does
not cover `npm run oss:published-tree -- --policy` and `-- --inventory`, the neutrality
ratchet, the root test suite (including the real-PostgreSQL native catalogue test) or
pgTAP. Hosted CI and the merge queue remain authoritative.

Against the same base, `--policy` refuses a change that removes or changes a
line of a publishable package's API snapshot (`release-gates.json`
`packageSurface`) unless that package's single `## [Unreleased]` changelog
section or a validated package fragment in the exact head Git tree carries a
`Migration:` block, or a real coherent set bump above the base
has moved it into the unique candidate-version section while leaving a unique
empty Unreleased section. The candidate section must match the package manifest
and set; stale notes at an unchanged version, another version, duplicate
sections or a mixed set refuse. The base decides which packages and
snapshots are checked, and removing or renaming a subpath counts as a removal.
A pure addition, such as a name added to an export list, has no "before", so it
needs none; a comment that opens a line is ignored, the code on its lines is
not, and the head must keep each publishable package's gates file and snapshots
readable.

This is a textual, base-bound signal, not semantic migration certification. A
marker in a code fence or a reused block can satisfy it; declaration text that
reappears in order can look additive. Behaviour or schema changes and withdrawal
followed by re-admission of a package still need semantic review. Reviewers must
check the actual compatibility change and useful before/after migration steps;
the API snapshots, tests and release classification remain separate obligations.
Keep useful migration notes in a package fragment until release preparation;
legacy Unreleased notes remain valid and drain at the next set bump. A newly
approved bounded programme may combine the implementation and set bump in one
PR: the bump moves those notes into the candidate-version section and opens a
fresh empty Unreleased section. Do not duplicate notes into that empty section
to satisfy the gate. Separate implementation and release-preparation PRs remain
available within their actual authority.

The [diagnostic debt record](../../../docs/platform/plans/public-ci-known-red.md#current-checkpoint) separates the last recorded checkpoint from earlier failures.
It records closure of the twelve SQL files and keeps earlier failures archived;
full-root and managed SQL diagnostics are expected green. Matching named debt is not
permission to ignore a red run. When triaging a change, compare fresh
Vitest failure identities and per-file assertion counts, and pgTAP file summaries,
with the exact PR base, normalizing log timestamps and ANSI formatting first.
The required `test` aggregate exposes root and `pgtap` failures. They do not suppress tests or normalize exits. Installation, database
start/replay/cleanup and unexplained new failures block delivery; naming those
failures does not waive broken CI. Use the hosted pull-request run's raw logs
for this comparison, or the corresponding local commands. The six existing required contexts retain
their coverage, with blocking lint and neutrality. Promoting diagnostic jobs to
required checks is the maintainer's ruleset decision; this contribution changes
no repository settings. Release workflows still check those six contexts, so a
red root suite or `pgtap` run now refuses release through `test`.

For independently discovered documentation falsifiers and their proof limits,
follow [Test scope and diagnostics](testing.md#test-scope-and-diagnostics). Documentation
regeneration remains owned by [Documentation maintenance](../../../docs/platform/DOCUMENTATION.md).

A change can be released as the next source preview when the required checks of
Published Tree CI pass and its tree describes itself: the publication catalogue
lists every tracked path, and `config/openlup-source-release-contract.json`
matches the tree's bytes. Adding, removing or renaming a file, or changing a mode
or a dependency, is releasable on those terms. Before it tags, the release
workflow checks the target against the previous preview with
`assertDescendantSourceRelease` (`scripts/oss-source-release-contract.ts`). That
check admits additive forwards and the separate exact reviewed function class under
[Data and migrations](../../../packages/core/docs/guide/upgrade/database-migrations.md#follow-the-additive-forward-path).
Reviewed function forwards use the same checker in required self-check and release
prepare. Their whole-file bytes, signatures, old/new definitions and runtime
privileges are pinned in `config/reviewed-platform-forwards.json`. The runtime
list admits the five-function capability forward and an optional service-only
identity capabilities forward. The optional portable replacement list binds
code-fixed functions for the dunning invariant repair, payment-terminal
decoupling and stock-evidence replay reopening. The stock control embeds the
candidate SQL in the existing synthetic gate tests without adding a migration.
The same focused test file covers exact bytes, portable-chain priors, registry
cardinality, header preservation, extra-statement
refusal and introduction-time binding in both gates; managed counts remain
unchanged. SQL and its pins may share a feature PR under the canonical
[co-located SQL/pin rule](../../../docs/platform/DATA_AND_MIGRATIONS.md#co-located-sql-and-approval-pins).
Only bindings for that PR's new SQL may change; other entries and shared fields
stay fixed. Trusted-main native admission refuses co-changing the machinery.
Release preserves each binding from its actual mainline introduction; later
repins cannot authorize earlier SQL. A change to the validator or other admission
machinery still lands first as its own change. Batched pins land per rail as a prefix in version
order: all earlier same-rail pins must be present with their pinned whole-file
digests. The PG gate refuses landed holes and replays committed interleaved
files through the last pin along with the absent fixture suffix. These forwards
are not expand-only. See
[the exact class](../../../docs/platform/DATA_AND_MIGRATIONS.md#exact-reviewed-function-forwards)
and its refusal tests in `scripts/source-preview-release.test.ts`.
It refuses edits or deletions of migration history, unapproved non-expand-only SQL, a
non-prefix portable manifest, bootstrap SQL changes, database schema types
(`src/integrations/supabase/types.ts`) and policy registry changes
(`config/openlup-policy-registry.json`). Nonmigration schema or policy changes
may still merge after their ordinary checks, but must be called out in the pull
request because the release-time check refuses them. [Versioning and EOL](../../../.github/VERSIONING_AND_EOL.md#publish-refuse-and-recover)
states the complete rule. A preview carries no release asset; GitHub's release
attestation of the immutable release covers its annotated tag.
The protected release job creates the draft with the saved note bytes, checks
that same release ID and publishes by ID, changing only its draft flag. It never
discovers a draft through a paginated release list.

The workflow's prepare step also refuses, before it tags, a preview while a
tracked code file carries a removal marker
(`// openlup-remove-before: openlup-source-preview/<m>`) naming that preview or
an earlier one, or a comment line starting `// openlup-remove-before:` that does
not parse. Temporary compatibility files use such a marker so that a preview
cannot ship them past their announced removal.

Platform modules are contributed package-first: a reusable module becomes an
`@openlup/*` package with documented extension seams, and the reference
application consumes that package. Source-only changes are for the reference
application and documentation. The
packages are released as one coherent set, independently of source previews: one set
version `MAJOR.MINOR.PATCH` from one commit, with each package tagged
`openlup-<package>-v<version>` at that commit and republished in every set. A
reviewed pull request, either release preparation alone or an explicitly approved
bounded implementation-and-set-bump contribution, runs
`npm run release:bump -- --set <version>`,
which updates every publishable package's version carriers and every exact
internal pin on one, and assembles each changelog's version section below a fresh
Unreleased heading: legacy Unreleased body first, then fragments in byte order
of path. It also moves each package's growth baseline (`pack.baseline` in
`release-gates.json`) to the version being replaced, with the packed bytes of
that version's published registry tarball, so release preparation needs registry
access; see [Package artifact limits](../../../.github/VERSIONING_AND_EOL.md#package-artifact-limits).
All packages are validated and planned before writes, and only
consumed fragments are deleted after successful writes. The set bump also plans
an `upgrade/v<major>-<minor>-<patch>.md` guide page from those fragments and
the API diff before any writes, refusing an existing page. For each API report,
the page gives the count of added declarations with the report path and lists
removed and changed declarations individually. Guide-contract violations
print warnings for correction in the same PR. It also refreshes the guide's
repository-link pins and generated regions, and re-pins released repository links
in each publishable package's `AGENTS.md` and `README.md`.
These documentation writes and consumed deletions are staged so source preparation
sees the updated Git inventory; no other changes are staged. Follow the
[release preparation sequence](../../../docs/platform/DEVELOPMENT_AND_RELEASE.md#releasing-a-package)
for the read-only documentation listing and guide edits. Historical sections
remain byte-identical. Merging it authorizes no release.

Release preparation follows four authoring rules:

- Keep release notes minimal, and back every behavioural claim with a named test
  or `file:line` reference in the PR.
- Commit changelog fragments before running `release:bump`, rather than
  hand-editing assembled release sections after the bump.
- Prefer an explicit allowlist over a blacklist for text and audit exceptions;
  `--policy` and `--self-check` audit tracked fragments and the simulated upgrade
  page against the packed core release-note rules and size cap before release
  preparation.
- When changing an error message or operator remedy, include an executed recovery
  transcript showing the exact command and observed output in the PR.

A release is then dispatched with `publish-package.yml` and package `all` for the
reviewed commit, and one maintainer approval of the protected `release`
environment authorizes every package of the set. Dispatching the set again
resumes one that stopped part way; preflight requires completed releases to keep
the exact reviewed release-note bytes in both skip and resume states. The package
workflow independently verifies the App-published immutable
release, tag and attestation, then publishes the checked tarball through npm
OIDC with `--tag latest`, without another approval.
[Package releases](../../../.github/VERSIONING_AND_EOL.md#package-releases) lists every
check and the maintainer setup.

A new or renamed path needs its authored row in
`config/openlup-publication-catalog.json`, except three patterns: the fragment
pattern `packages/{core,outbox,platform}/changes/*.md`, the reader guide
`packages/core/docs/guide/**/*.md`, and manifest-pinned platform SQL migrations
`db/platform/migrations/*.sql` together with their projected package mirrors
`packages/platform/sql/*.sql` (excluding the hand-authored
`packages/platform/sql/20260809150001_job_run_ledger_v3.sql`,
`packages/platform/sql/manifest.json`, and `supabase/migrations/*.sql`, which
retain explicit rows). All three are admitted as `public-output` only after
content and regular, non-executable mode validation (and exact SHA-256 pinning
against `config/platform-migration-manifest.json` for platform SQL). Fragment
nesting, guide directories that are not lowercase, unmanifested SQL, other
extensions and per-file rows for any of the three patterns refuse. The catalogue
remains an explicit classification and execution inventory, not a generated list. A guide page keeps a review floor of
one, like a rule file, because it ships to npm and the website unchanged.

For a notable package change, add a uniquely named
`packages/<core|outbox|platform>/changes/<change>.md` fragment instead
of editing CHANGELOG. Use ordinary bullets, optional `###` subsections, useful
`Migration:` blocks and the existing size-growth bullet where needed. Empty
files, `#`/`##` headings and conflict markers refuse. No new universal fragment
gate is imposed; reviewers still check whether notes describe the change.
The existing Migration gate reads the exact head Git tree's fragments alongside
legacy Unreleased, validates fragments even for additive changes, and retains
the coherent prepared-version alternative. Source fragments never ship in npm.

Ordinary module and dependency PRs keep the committed source-release contract
snapshot unchanged. Both `--policy` and `--inventory` run its generator and
validate structure and authored identity, runtime, database seam and signed
compatibility. They report stale aggregate bindings without failing; missing
catalogue rows, broken derivation and other policy failures still refuse.

Refresh digests **at release preparation only**, after the set bump (when
applicable) and the authored catalogue updates, in the reviewed preparation PR:

```sh
node --experimental-strip-types scripts/source-release-preparation.ts --write
node --experimental-strip-types scripts/source-release-preparation.ts --check
```

The command validates live catalogue/inventory and migration inputs, plans the
snapshot before writing, then atomically replaces that file. It preserves
authored identity and compatibility, is byte-stable on repeat, and writes nothing
on validation failure. It never authors catalogue decisions. Commit the fresh
snapshot with the preparation change. Source-preview prepare, package/set
preflight, protected prepare/plan, and tag publication including resume require
canonical byte equality against the exact target Git objects. A later change to
a bound input requires another reviewed refresh. Remaining source bytes and
modes are bound by the target Git commit; the JSON is not a per-source content
hash list. Merging preparation still grants no release authority.

The [install support policy](../../../.github/INSTALL_SUPPORT_POLICY.md) and
[publication completeness policy](../../../.github/PUBLICATION_COMPLETENESS.md) describe
the supported installation and the limits of source-publication evidence.
A checkout that builds does not by itself become a supported artifact.
