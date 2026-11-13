# Documentation navigation and maintenance

Status: historical record, 2026-11-06.

Status of documentation-impact obligations: historical and superseded by
[Deliver a change](../../../CONTRIBUTING.md#deliver-a-change). A pull request
updates the documentation it makes stale; the reviewer checks it; tooling checks
only generated navigation, links and owner structure, not substantive updates or
fingerprinted no-impact answers. The impact-control design below records the
former plan and creates no current obligation.

Original status: implementation plan; local execution requested by the maintainer on
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
At this plan's 2026-09-27 source snapshot, there were 26 registered domains,
25 shared domain READMEs and a dormant routing file with 65 absent targets among
its 71 rows. These were navigation gaps, not evidence of a gate failure at that
planning stage. For current ownership, use
[Documentation maintenance](../DOCUMENTATION.md).

## 2. Scope and authority

- `merge`: public ownership routing, generated navigation, canonical authoring
  rules, the then-planned structural/impact check through existing `--policy`, source
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

### Change impact (historical; superseded)

The former `--policy` design resolved a local or hosted comparison base and
compared source inventories and ownership maps. It required an affected canonical
section to change substantively or carry a fresh scoped no-impact explanation
fingerprinted against the source delta and unchanged owner text. Cosmetic edits,
generated blocks and unrelated documents did not satisfy that former gate.
Fingerprints established scope rather than semantic correctness.

That impact checker and its fingerprinted answers have been removed. Current
documentation updates and reviewer responsibility follow
[Deliver a change](../../../CONTRIBUTING.md#deliver-a-change); `--policy` checks
navigation, links and owner structure. It still resolves the comparison base,
fetching a missing public hosted base, for the append-only migration history and
package Migration-block checks.

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
   navigation baseline before edits. Historical design: new source helpers were
   import-only and new tests used one published-tree falsifier entrypoint. That
   test arrangement is superseded by independently discovered files; follow
   [testing](../../../CONTRIBUTING.md#test-scope-and-diagnostics).
2. **Guard — historical assignment.** The worker owned routing/impact helpers
   and their focused regression cases; the lead owned checker integration and
   config. Missing history, cosmetic docs and stale no-impact answers were
   refusal cases for the former impact checker, now removed. Current structural
   checks cover owner paths, anchors and generated navigation.
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
   Historical delivery used a two-review floor for changed code and controls:
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
- Historical impact-gate acceptance required real-Git source edits to fail
  without a section update or scoped no-impact answer, and tested cosmetic edits,
  stale fingerprints and missing bases. Those impact obligations are superseded
  and are not current acceptance checks; base resolution keeps its witnesses
  because the migration-history checks still use it.
- Current documentation acceptance follows
  [Deliver a change](../../../CONTRIBUTING.md#deliver-a-change): the pull request
  updates stale documentation, and its reviewer checks the explanation.
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
workflow routes and inspect unfamiliar-reader answers. The former semantic text
comparison could accept irrelevant prose; reviewers and behavioral examples remained necessary.
The policy resolves a public CI base for its migration-history and Migration-block
checks and refuses when it cannot resolve one; the removed impact checker no
longer uses that base.

Do not broaden this work to fix unrelated release refusals. New schema changes,
protected release identities, additional services/dependencies, control weakening,
material recurring cost or website frozen-layer changes require a separate decision.
Preserve all unrelated task state. Recovery is a normal reviewable revert of this
local contribution, never a destructive reset or change to immutable evidence.

## 7. Simpler path considered

At planning time, link checks and writing reminders were considered insufficient
for the requested same-change enforcement and copy-free publishing. The later
simplification moved substantive documentation assessment to PR review. A docs
SaaS, new agent framework, mandatory model loop or a second registry was rejected
as extra maintenance without proof of meaning. The plan selected one owner map,
existing checks and plain public data.

## 8. Delivery evidence

The pull request records the exact committed candidate, comparison base and tree,
actual native reviewer execution IDs, complete role coverage, required check
results and remaining activation boundaries. Keep execution observations separate
from this historical plan so fresh reviewers receive the contract and source
without previous verdicts. Session-local navigation measurements do not establish
general performance, human acceptance or framework maturity.
