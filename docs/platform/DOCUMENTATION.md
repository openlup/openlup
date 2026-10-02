# Documentation maintenance

Status: development-preview guidance.
Audience and purpose: contributors maintaining public navigation and behavior
guidance, and consumers importing that documentation into another presentation.

Documentation is authored with the code it explains. Generated maps help readers
find that code; a reviewer still checks whether the explanation is correct.
Start with the [platform index](README.md) and the affected module's README.

## Authoring

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

The [public CI record](plans/public-ci-known-red.md) distinguishes required
coverage from complete raw diagnostics. A failed or aborted suite names its
reason, triage owner and unexecuted obligation; it cannot establish a passing
installation or compatibility claim. Failure classification needs actual logs,
not a file's presence in the catalogue.

A test file is a falsifier to inspect, not a recorded passing result. Keep
development-preview limits visible and do not infer framework support from
source availability. Release-specific instructions belong with the selected
immutable release; see the [install support policy](../../.github/INSTALL_SUPPORT_POLICY.md).

## Ownership

The [domain registry](../../src/lib/coreDomains.ts) names platform domains. The
[publication catalogue](../../config/openlup-publication-catalog.json) supplies
the public path inventory. The [documentation routing map](../../config/doc-routing.json)
assigns those paths to canonical owner pages and sections; it is not a second
domain or publication census.

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

## Impact

For a source change:

1. Resolve its documentation impact against the comparison base.
2. Read each affected canonical section and follow its source and test links.
3. Update the explanation where behavior or the public boundary changed.
4. If the section remains correct, record a scoped no-impact explanation at
   that owner, tied to the source delta and unchanged owner text.
5. Regenerate navigation, then run the structural and impact checks.

The policy check uses an explicit full base SHA or a local merge base with
`origin/main`. Hosted checks use validated event attribution and checkout
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
be refreshed when its source delta or owner text changes. Its fingerprint binds
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
If the existing explanation remains correct, place a reasoned comment in that
owner section using the reported unit and digest:

```html
<!-- openlup-doc-impact {"unit":"<reported-unit>","digest":"<reported-digest>","reason":"Explain which behavior stayed the same and why the source delta does not change this section."} -->
```

Examples inside fenced blocks do not count as records. Existing records expire
when the comparison base, source delta, mapping or normalized owner changes.
The checker also keeps the previous owner's obligation when routing changes or
a source disappears. Cosmetic edits, records and generated/provenance blocks
are excluded from the substantive comparison. Adding irrelevant prose can still
mislead a structural check: meaningful review remains necessary.

See [contribution checks](../../CONTRIBUTING.md#development-preview-checks) for
the other gates and their execution scope. Documentation checks do not replace
behavioral tests or installation evidence.

## Exporting

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
