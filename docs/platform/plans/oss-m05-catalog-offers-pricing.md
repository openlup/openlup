# M05 catalog, offers and pricing import

Status: development-preview plan; no stable-framework, release or activation claim.

## Outcome and authority

Contribute the neutral catalog, offer, price, promotion and bundle boundaries
while preserving current observable behavior and frozen subscription obligations.
Extraction witness identity: C1 `0e23c7ddb443e6c24d0a3fe2a0cf5c31fed00559`.
P1/P2a local implementation and verification only: the supervisor owns commits,
clean-candidate package proof, independent native review and any separately
authorized submission. No release, adopter update, deployment or activation grant.

O1 C + D: M05 supplies lifecycle-ready contracts and ports without behavior change.
R3-lite is a separate round immediately after M05 C6, parallel with M06, requiring
its own admission, bounded plan and evidence. It covers admin create/edit/activate/
withdraw variants, validation, publication to product pages and readback; MCP,
bulk import and auto-updating consumers are excluded. It ships off in [the private
adopter] until an owner enablement decision. That private production prerequisite
does not gate the generic round and authorizes no live assortment change.

## PR graph and scope

Whole M04 stack, including C-compose and S1, precedes M05 implementation.
P1 → P2 → P3 → P4 → P5 → P6 → P7 → S1. The supervisor owns prerequisite
integration; the assigned P1 tree is not evidence of a completed release.

| PR | Bounded scope and status |
| --- | --- |
| P1 | Neutral catalog/read/draft move, media contribution and lifecycle-ready types. Phase A committed at `1aafd77`; phase B local implementation, supervisor commit/review/artifact gates pending. |
| P2a | Unchanged existing OpenLup price authority, subscription policy, assignment tokens, safe errors and bounded DTOs. Local implementation; supervisor commit/review/artifact proof pending. |
| P2b / P2c | Proposed remaining split: quote computation/schemas/tax/provenance, then handlers/offer/acquisition selection and consent. Pending coordinator extension; no added authority is inferred. |
| P3 | Unchanged promotion application, code/claim contracts and selected native semantics; reuse core promotion engine. Pending. |
| P4 | Unchanged fixed bundle composition, allocation, availability and admin boundary; selected native stores/descriptor where needed. Pending. |
| P5 | Useful neutral browse/product/cart/builder/admin UI consuming explicit data/locale/media ports and lifecycle-ready DTOs; preserve existing fences. Pending. |
| P6 | Bounded refactoring only after unchanged imports and preserved witnesses; no new functional scope. Pending. |
| P7 | Reference/default composition, selected native stores/schema/readiness and real consumer/readback proof; no new capability or activation. Pending. |
| S1 | Separate existing-set version preparation and final packed-artifact/cold-consumer proof; no inferred version. Pending. |

## P1 boundary

`@openlup/platform/catalog` owns the existing neutral public foundation, product
types, draft contracts/ports, active selection, sellable/read ports, draft
handler/validation, resolved projection and reference read handler. Named reference
shims preserve function/error identities and the observed responder binding.
`./catalog/contracts` holds dependency-free DTOs and pure helpers; server schemas
stay outside it and reference browser schemas remain local.

Phase B contributes unchanged media contracts/resolution and source-pack logic,
with import-only relocation and three fresh synthetic W8 equivalents. No private
assets or reference shims are added for these previously absent subjects. The
injected blob type uses the existing exact core entry; no module graph edge or
new dependency is needed. Lifecycle/publication additions are types and ports only.
Read/draft use cases remain available through host bindings; `publicationRead`,
`publish` and `lifecycleWrite` are unsupported in the neutral reference binding.
No constructor creates a verified publisher. Missing authority is unsupported;
configured outage is dependency_unavailable. Known absence is distinct from either.

P1 exclusions: admin document contracts/handler and current-document adapter stay
reference-owned and unchanged; no fresh neutral readback guard implementation,
no offer-membership port without a consumer, no SQL projection/descriptor, store,
migration or manifest position. W5/W7 subjects are not moved. Rich catalog
interpretation, browser schemas, provider protocol decoders, private composition,
upload routes, publication executor, activation/withdrawal/rollback, private assets,
new graph edges and new dependencies are excluded. Native catalog stores and their
descriptor belong to later P7/P4 work. No reference preview/proposal response,
canonicalizer portability or SKU-pack refusal behavior changes in P1.

## P2a boundary and task record

Finite outcome: move only the existing public OpenLup price authority,
subscription price policy, pricing-policy token, neutral policy-error/safe-reason
block and bounded offer-policy contracts to `@openlup/platform/pricing` and its
DTO-only `./pricing/contracts` entry. Implementation authority permits local
file edits and verification only; the supervisor owns all Git writes, native
review and separately authorized submission. No release/merge/dispatch, adopter,
registry or staging action is part of this handoff. The stack base is P1 head
`2ecf1da8f0bdf3e9f9a9d393743c333db2bd9da0` on the assigned P2 worktree.

The smallest adequate cut separates DTOs from schemas and uses named reference
exports. Package-local jitless Zod setup is the only additional implementation
closure file; it preserves the existing validation runtime without importing a
reference path or another module's private helper. The subscription browser inventory also admits exactly the three emitted pricing
contracts runtime files reached by the retained browser schema binding. No new abstraction, peer,
module edge or dependency is needed. Error classes remain single package-owned
constructors; browser policy schemas remain local.

Exclusions: quote computation/helpers/handlers, offer projection/handler/cache,
readiness, settings, catalog provenance, tax guard, snapshot verifier,
acquisition terms, shipping policy, read preparation, price setup, promotions,
UI and adopter-only files. Core pricing types/allocation remain core re-exports.
No SQL, store, descriptor or migration-manifest change is needed for injected
read ports. The proposed P2a/P2b/P2c sequence requires the coordinator's extension
for subsequent parts and a cumulative measured cap decision before they grow
past current limits. Splitting PRs alone does not solve cumulative artifact size.

Acceptance: preserve incumbent algorithms and assertions, keep contracts free of
Zod/Node/global runtime dependencies, retain reference composition and class
identity, register actual exports/graph/smoke evidence, regenerate API and source
catalogues, and run the specified local lint/type/build/test/neutrality/size
checks. The uncommitted tree cannot supply the supervisor's package gates.
The execution evidence and remaining gates are recorded in the implementation
handoff; no frozen-renewal or full W1/acquisition completion claim follows.

## Witness ledger

Private C1 witnesses remain unchanged. A public package equivalent protects the
selected neutral subject; exporting types alone does not close a private witness.

| Witness | C1 cases / protected property | P1 disposition |
| --- | --- | --- |
| W1 | 7; strict price authority, quote/offer and acquisition promise/refusal boundaries | Deferred to P2; private witness unchanged. |
| W2 | 5; frozen subscription money, retry bytes, acquisition consent and explicit edits | Deferred to P2/private adoption; private witness unchanged. |
| W3 | 4; promotion adjustment/acceptance, floors and advisory versus durable claim | Deferred to P3; private witness unchanged. |
| W4 | 4; captured bundle composition/readback, allocation, stock and human activation | Deferred to P4; private witness unchanged. |
| W5 | 5; exact document/head/membership join, stale/mixed heads and legacy versus outage | Subjects not moved in P1; no synthetic readback claim; private witness unchanged. |
| W6 | 4; quote-to-draft transfer/reload/navigation and fresh-consent refusal | Deferred to P5; private witness unchanged. |
| W7 | 2; authority/request/proposal/evidence transcript and advanced-head refusal | Subjects not moved in P1; proposal remains distinct from publication; private witness unchanged. |
| W8 | 3; distinct bytes/exact immutable URLs, locale/variant/order/fallback, absence and pre-upload refusal | Three synthetic package cases, including immutable-key deduplication; no private assets or wholesale media-suite copy. |

## Observable-difference inventory

| Item | Disposition |
| --- | --- |
| PROC-26/P1-01: canonical JSON portability | O behavior preserved: existing lookbehind canonicalizer moves unchanged; older-browser compatibility expansion deferred. |
| PROC-26/P1-02: optional publication preview | O behavior preserved: reference handler unchanged; early preview execution path deferred. |
| PROC-26/P1-03: proposal response publication metadata | O behavior preserved: no v2 candidate/head/post-state response addition; deferred. |
| PROC-26/P1-04: SKU-pack refusal details | O behavior preserved: no new authorization/read-unavailable details; handler unchanged. |
| PROC-26/P1-05: new neutral public API | Additive media functions and lifecycle/publication types/ports only; no mounted mutation. Membership and readback implementation deferred by the P1 cut. |
| PROC-26/P2a-01: authority scheduling | O base-before-history reads preserved; no adopter concurrency optimization. A bad base prevents history work and its refusal retains precedence. |
| PROC-26/P2a-02: history identity | O uses validated `base.priceListId`, including malformed-adapter observations; selected-list identity is not substituted. |
| PROC-26/P2a-03: policy errors and tokens | O neutral error block, safe reasons, token binding/expiry and rollback behavior preserved; no acquisition additions, readiness or secret composition moved. |
| PROC-26/P5-01: SSG media/details | O behavior preserved in P1; optional SSG contract/example-data additions deferred to P5. |

Draft-handler boolean narrowing is type-only; O canonical output is preserved.
Admin digest relocation and component-fact type exports remain reference-owned or
deferred; no server crypto enters browser contracts. Existing SKU statuses remain
`draft`/`active`/`archived`, and draft receipts remain `open`/`abandoned`.
Lifecycle `withdrawn` maps from `archived` only with an establishing authority.
No abandoned draft implies withdrawal and no active row invents publication lineage.

## Test and cap ledger

C1 consumed 34 of the programme's 100 new cases; 66 remained at P1 admission.
Phase A moves eight existing suites unchanged (87 cases) and adds one reference
responder-binding case. Phase B adds three media cases and one lifecycle type
case: **4 phase-B / 5 whole-P1 authored new required cases**, leaving **61** for
later work. Generated source-boundary iterations are tracked separately; no
copied 21-case resolver or 24-case source-pack suites and no duplicate invocation.
Existing browser closure/budget and cold-consumer classification machinery is reused.
The lifecycle case checks closed refusal/success states, publish change states and
opaque authorization; it adds no runtime capability.

Whole-P1 changed production-source ceiling: 35; actual cut: 34 (29 phase A plus
five new phase-B files). New contracts browser entry: measured 3,281 B minified+
gzip, budget 4,096 B (phase A 1,289 / 1,536 B). No existing entry or aggregate cap
increases. Whole-package caps remain 800 files, 522,240 packed B and 2,088,960
unpacked B; code gzip 440,320 B / 800 files and root docs gzip 40,960 B / 10 files.

The old programme size forecast is not approval. Measurement after the complete
M04 S1 integration remains owed, as do final committed-tree package gates and
hosted added-time evidence. Local phase-B pack/check receipts belong to the task
handoff; they cannot establish release, registry, adoption or staging readiness.

## Verification and handoff

The local task checks lint/structural rules, public typecheck, both reference builds,
scoped and full tests, policy/inventory/neutrality and pack size. Package gates need
a committed tree and are reserved for the supervisor, together with native review.
No Git writes or external mutations are part of this implementation handoff.

Self-retro: retaining browser schemas and reusing the existing core blob port keeps
the contracts boundary closed without a new edge, dependency or mapping layer.

P2a case ledger: three complete incumbent suites plus the pure error-mapping
case move with import-only assertion changes. Three new required cases protect
base-before-history sequencing, observed-base history identity/raw errors, and
the nontrivial reference error/browser-schema binding. No standalone offer-policy
suite exists in the incumbent tree; existing quote/offer schema suites remain
reference-owned and run through root discovery. Programme new-case balance is
58 after P1's five and P2a's three; generated boundary iterations remain separate.

P2a self-retro: keeping the browser schema binding local avoids importing server
crypto into browser consumers; one shared binding case covers that seam and
error identity. The initial install omitted the task cache setting and was rerun
with the required cache before implementation; the first scoped run also exposed 12 tooling pack failures from the default
cache. Subsequent test commands explicitly inherit the task-owned cache. Core resolver compatibility exports remain only at their existing reference
path; the pricing entry exports only the moved authority and policy subjects.
No process or out-of-scope repair was added.

P2a browser budget: complete contracts runtime closure measured 249 B minified+gzip;
new entry cap 320 B. All pre-existing entry and package caps remain unchanged.

## P2a local verification handoff (2026-10-20)

The uncommitted P1-stacked candidate changes 18 domain production files, or 20
including the lint graph and cold-consumer tooling (ceiling 35). It moves 25
incumbent cases and adds three required cases; no duplicate selector is added.
The authority, token, policy digest/math and neutral error block retain their
original implementation bytes after import/type separation. No existing API
snapshot changes or declaration-order reorders occurred.

Local results: ast-grep and lint pass (zero errors, 33 warnings); the public
five-project typecheck has zero unresolved edges and consumer errors. Both
reference builds prerender two pages, and API checks pass all 17 entries.
The final brokered unfiltered run used four workers, waited 11 seconds for six
CPU tokens/8192 MiB, and completed in 222.06 seconds: 14,501 passed, two skipped,
one real-pack failure because the 12 new pricing sources are untracked (36
source/derived-file refusals). This guard cannot pass before the supervisor's
Git step. The preceding scoped run excluded no files and reported that same
refusal plus five 10-second timeouts under contention; the full run cleared all
five. An earlier scoped attempt had 12 default-cache pack failures. No test,
timeout, selection, artifact or admission control was relaxed.

Dry-run pack: 789 files / 479,671 packed B / 2,033,334 unpacked B; sorted code
class 405,144 gzip B / 771 files; root docs 31,987 gzip B / five files. All caps
remain unchanged. The contracts closure measures 249 B against its new 320 B
cap. Eleven total package-file slots remain; later P2 parts still need the
coordinator's split extension and cumulative budget decision.

Policy/inventory CLI checks stop at the deleted original test path in the
uncommitted tracked inventory. The separate materialized-candidate check passes
all 5,162 catalogue paths and exact generated source-release bytes; documentation
impact has six answered obligations. These local checks do not replace signed
candidate package gates, native review, independent installed-artifact proof or
hosted added-time evidence. The supervisor owns those remaining gates and any
authorized delivery. No Git writes, release, registry/adopter/staging operation
or external mutation was performed by this implementation task.

Rethink lesson: default parallelism plus host contention can turn unrelated
imports into deadline failures; broker admission and the existing per-run worker
setting cleared them without changing deadlines. Keep build/typecheck phases
serialized, and pass the task cache to child npm processes as well as installation.
