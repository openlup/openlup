# Documentation navigation and maintenance

Status: implementation plan; local execution requested by the maintainer on
2026-09-27. The maintainer subsequently authorized bounded task delivery through
merge under the native review rules introduced in pull request #52. Release and
website activation remain separate.

## 1. Decision and intended effect

Make the public repository navigable from README to domains, meaningful internal
workflows, contracts and their verification. Agents resolve documentation impact
while implementing a change. Derive inventories and website-ready formats from
the same public sources; reviewers remain accountable for behavioral meaning.

Reuse the platform index, domain READMEs, package API/documentation checks,
publication catalogue and existing `oss:published-tree` execution owner.
The current source snapshot has 26 registered domains, 25 shared domain READMEs
and a dormant routing file with 65 absent targets among its 71 rows. These are
navigation gaps, not evidence of a presently failing documentation gate.

## 2. Scope and authority

- `merge`: public ownership routing, generated navigation, canonical authoring
  rules, a mandatory structural/impact check through existing `--policy`, source
  and package links, meaningful subscription workflow guidance, and a reproducible
  documentation bundle with integrity validation.
- `experimental`: an explicitly labelled local bundle from an uncommitted tree
  and session-local contributor navigation measurements. Neither is public release
  or independent-adopter evidence.
- `activation`: consuming the bundle in the separately owned website, its search
  and documentation UX, hosting, version selection and live publication.
- `out`: business/runtime changes, database/schema changes, adopter upgrades,
  private tooling, new dependencies, workflow/job edits, autonomous PR bots,
  secrets, settings, releases and stable-framework claims.

Initial delivery was local. The maintainer extended authority on 2026-09-27 to
commit, publish this task branch, open its PR and squash merge after the required
native reviews and hosted checks. This grants no release, deployment, website,
secret or settings authority. Public contributor instructions and controls
require public inputs only. The root agent guide and its canonical
platform copy change together. New paths are registered and the source contract
is regenerated without changing protected identity/schema fields.

## 3. Implementation contract

### Ownership and navigation

Replace dormant `config/doc-routing.json` data with a versioned public ownership
map. Each surface declares stable ID, navigation purpose, path selectors and its
canonical Markdown owner/anchor. Reuse the existing domain list and publication
inventory rather than introducing a second census. Explicitly classify repository,
policy, browser, server, provider, data, tooling, test, asset and historical paths.

More specific selectors can inherit broad category guidance; equally specific
conflicting owners fail. Every registered domain has an explicit route. Unknown
paths, missing owner pages/anchors, dead selectors and malformed routing fail.
Generate a concise platform source map; a full per-file inventory is an on-demand
view with path, class, responsibility owner and source-derived symbol information.
Do not invent per-file semantics from a filename.

### Change impact

The CLI's `--policy` checks impact by default. A local checkout resolves an
explicit full `--docs-base` SHA or its merge base with `origin/main`. Hosted CI
uses the exact base SHA in its validated PR/push event metadata, taking precedence
over any local override. Validate public repository/event and checkout identities
(the PR merge checkout or push head), not just SHA syntax. If the shallow
checkout lacks that object, fetch only that validated public commit, without
credential helpers, askpass or ref/FETCH_HEAD writes. Missing/malformed attribution or fetch failure
refuses. This extends the existing execution owner without modifying workflow bytes.

Compare base and candidate inventories and both ownership maps, including moves,
deletions, mapping changes, modes and staged/unstaged/new candidate paths.
The initial dormant v1-to-v2 transition uses the new public map; later map changes
cannot erase the base owner's obligation. Pure docs, generated navigation and
historical records remain correctly classified rather than demanding self-review.

An affected canonical section must change substantively, or contain a fresh
scoped no-impact explanation tied to that source delta and unchanged owner text.
Keep such explanations at their owner; do not create an independent review ledger.
Exclude no-impact comments, provenance and generated blocks from the substantive
comparison. An invalid receipt must not pass as a section update. Whitespace,
review dates, generated navigation and unrelated documents cannot
satisfy an obligation. Fingerprints establish scope, never semantic correctness,
reviewer identity or owner approval. PR review must challenge the explanation.

### Bundle and consumer boundary

Use public Markdown and a small generated manifest: format version, exact source
commit for a clean tree, profile/maturity, stable page/source IDs, navigation,
content digests, search data and source links. Include raw Markdown and llms
indexes from those same bytes. Validate completeness, paths and digests before
acceptance; reject mixed trees and unsafe output destinations.

A clean export is suitable for a website build consuming a deliberately pinned
public revision. A local candidate export is explicitly non-publishable and binds
the base revision plus current content digest. It must not pretend its changed
bytes belong to committed HEAD. Do not run Markdown code blocks or MDX.

## 4. Checkpoints, ownership and dependencies

1. **Plan and first falsifiers — lead plus independent review.** Validate the
   implementation route against current public constraints. Record a cold-context
   navigation baseline before edits. New source helpers are import-only; new tests
   are executed through the existing published-tree falsifier entrypoint.
2. **Guard — guard worker.** Own cohesive routing/impact helpers and their focused
   regression cases. The lead owns shared checker integration and config. Prove
   refusal for missing history, orphan paths/anchors, unchanged/cosmetic docs,
   stale no-impact explanations, deletion/remap and hidden untracked additions.
3. **Owner documentation — documentation worker.** Own platform documentation
   pages, the accounting README, subscription/browser/server owner explanations
   and the domain-map authoring inputs. Link real source and real test commands;
   distinguish available services from mounted reference/runtime capabilities.
4. **Generated map and bundle — lead.** Own public routing integration, generated
   projections, bundle helpers/falsifiers, README/CONTRIBUTING, paired agent guide,
   PR guidance and catalogue/contract updates. Verify deterministic output, clean
   versus draft provenance, tamper/mixed-version refusal and a consumer readback.
5. **Integrated review and gates — independent reviewers plus lead.** Review code,
   ownership, guard adversarial cases, documentation truth and release boundaries.
   Repair material findings as one batch; rerun affected checks and final verify.
   Final delivery follows the current two-review floor for changed code and controls:
   commit the candidate, then launch fresh native correctness and security
   reviewers with no author history or other verdicts; at least one checks
   simplification. Record exact candidate observations and run required gates.
   A fresh public-only agent repeats orientation tasks; report accuracy, tools and
   time without claiming measured human acceptance or unavailable token counts.

The lead integrates shared files sequentially. Estimates are approximately
1,000–2,000 source/test lines and several hundred authored/generated documentation
lines, with readable helpers normally under 300 lines. These are estimates, not
permission to compress code or weaken tests. No executable public plan validator
is present; existing public plan location and actual required checks govern.

## 5. Acceptance evidence

- Every candidate tracked path resolves to an intentional owner; the 26 domains
  and all active documentation owners are reachable from the public entrypoints.
- Root, package, domain and meaningful workflow guidance lead to the actual
  source/contract and verification route. Accounting has a usable owner page.
- A real-Git source edit without relevant documentation fails. Correct section
  update or scoped no-impact review passes. Cosmetic/unrelated edits, stale
  fingerprints, missing bases and route removal/remapping fail as appropriate.
- The same guard path runs in the existing local and public self-check command;
  simulated hosted event/shallow-base cases prove strict attribution behavior.
  Run the actual CLI in a bare fixture without node_modules: self-check installs
  no dependencies, so every import in that closure must use Node or public code.
- Generated navigation matches its inputs. Bundle production is deterministic,
  validates content integrity, preserves all selected pages and refuses tampering,
  version mixing and publication of a dirty draft as clean committed content.
- Focused falsifiers pass through the existing explicit public test entrypoint,
  then `npm run oss:published-tree -- --policy`, `--inventory`, `--typecheck`,
  `npm run lint`, the relevant tests and full required maintainer verify pass.
- Readable local delivery includes exact commands, outcomes, review findings,
  deviations and remaining activation/human-acceptance boundaries.

## 6. Risks, recovery and reconsideration

Broad routing can hide useful internal boundaries; require explicit domain and
workflow routes and inspect unfamiliar-reader answers. Semantic text comparisons
can still accept irrelevant prose; reviewers and behavioral examples are necessary.
Fetching a public CI base introduces a small read-only network prerequisite; a
failure is an actionable refusal, not permission to guess a base or skip impact.

Do not broaden this work to fix unrelated release refusals. New schema changes,
protected release identities, additional services/dependencies, control weakening,
material recurring cost or website frozen-layer changes require a separate decision.
Preserve all unrelated task state. Recovery is a normal reviewable revert of this
local contribution, never a destructive reset or change to immutable evidence.

## 7. Simpler path considered

Only fixing links and adding another writing reminder leaves the requested
same-change enforcement and copy-free publishing unsolved. Conversely a docs SaaS,
new agent framework, mandatory model loop or a second registry adds maintenance
without proving meaning. Use one owner map, existing checks and plain public data.

## 8. Review and observed implementation

Independent plan review completed before implementation. Three attribution and
falsifier clarifications were incorporated: receipt exclusion from substantive
diffs, hosted identity/override precedence with credential-free fetch, and the
bare-runtime CLI case. Actual execution evidence is recorded as the work lands.
Integrated independent review found and falsified executable content hidden by
a historical-directory exemption; the exemption now applies only to Markdown.
Lead falsifiers additionally covered UTF-16 section offsets after emoji comments
and normal branch iteration versus a concealed staged revert. All three were
repaired together, with regression cases at the existing public test entrypoint.

The guard worker authored routing/Git/impact helpers and their cases; the content
worker authored owner pages and source explanations; the lead integrated CLI,
navigation, bundle, authoring guidance and publication metadata. A nonauthor
reviewer inspected the integrated contribution. Agents used the session's native
defaults; effective model identities and token counts were not separately exposed.

One public-only cold-context reader before changes took 131 seconds and 28 shell
inspections; a fresh reader after changes answered the same six tasks correctly
in 97 seconds and 17 shell inspections, with no wrong/dead target. This is a
session-local orientation measurement, not a general benchmark or human acceptance.
The initial local checkpoint was integrated with public main at
`e2190c851c309ba0a08d9e44bd7b1824a36b9c03`. A bounded independent integration
recheck found no remaining issues and confirmed that existing contribution
admission, registrations and protected contract fields were preserved.

Initial local maintainer verification exited 0 in 133 seconds: policy, inventory,
typecheck, install/build proofs, root tests (4,724), subscription-profile tests
(72), core package CI, published-tree falsifiers (67) and gitleaks passed.
DCO and commit-range leak checks skipped the then-empty commit range. Lint exited 0 with 32 existing warnings outside the changed paths.
The advisory release check exited 1 for a schema-bearing change already present
on main; this task changes no schema-bearing path and does not establish release
readiness. Clean export of this uncommitted contribution refused with exit 1 as
required. The local draft and its consumer readback are delivery artifacts.
The follow-on delivery integrates main at
`deb03a7f109775eeced947482bf584d0868e63d7` and replaces stale human-read admission
wording with the native review contract. Current candidate review and required
verification outcomes belong to the exact committed PR evidence; earlier local
results do not attest that later candidate. No published release, website
deployment or human onboarding acceptance is implied by this task.
