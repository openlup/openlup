# M05 catalog, offers and pricing import

Status: development-preview plan; no stable-framework, release or activation claim.

## Outcome and authority

Contribute the neutral catalog, offer, price, promotion and bundle boundaries
while preserving current observable behavior and frozen subscription obligations.
Extraction witness identity: C1 `0e23c7ddb443e6c24d0a3fe2a0cf5c31fed00559`.
P1 local implementation and verification only: the supervisor owns commits,
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
| P2 | Unchanged price/quote/offer authority, scheduled acquisition selection and consent, policy math and money contracts; reuse the existing core pricing engine. Pending. |
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
