# M05 catalog, offers and pricing import

Status: development-preview plan; no stable-framework, release or activation claim.

## Outcome and authority

Contribute the neutral catalog, offer, price, promotion and bundle boundaries
while preserving existing OpenLup behaviour and frozen subscription obligations.
Extraction witness identity: C1 `0e23c7ddb443e6c24d0a3fe2a0cf5c31fed00559`.
The maintainer's delegate approved the P2 split below. Release, adoption,
deployment and activation require separate authorization.

## PR graph and scope

The complete M04 stack, including C-compose and S1, precedes M05 implementation.
P1 → P2a → P2b → P2c → P3 → P4 → P5 → P6 → P7 → S1.
P2 is split into three parts; checkout, claims and finalize stay with the checkout module.

| PR | Bounded scope |
| --- | --- |
| P1 | Neutral catalog/read/draft move, media contribution and lifecycle-ready types. |
| P2a | Existing authority, policy and token logic; preserve behaviour and reuse the existing core pricing engine. |
| P2b | Existing quote, offer, handlers and readiness; preserve behaviour. |
| P2c | Additive acquisition-terms selection and promise-consent API; required injected financial policy, no default policy, reference activation off. |
| P3 | Unchanged promotion application, code/claim contracts and selected native semantics; reuse core promotion engine. |
| P4 | Unchanged fixed bundle composition, allocation, availability and admin boundary; selected native stores/descriptor where needed. |
| P5 | Neutral browse/product/cart/builder/admin UI consuming explicit data/locale/media ports and lifecycle-ready DTOs; preserve existing fences. |
| P6 | Bounded refactoring after unchanged imports and preserved witnesses; no new functional scope. |
| P7 | Reference/default composition, selected native stores/schema/readiness and consumer/readback proof; no new capability or activation. |
| S1 | Separate existing-set version preparation and final packed-artifact/cold-consumer proof; no inferred version. |

## P1 boundary

`@openlup/platform/catalog` owns the existing neutral public foundation, product
and draft contracts/ports, active selection, sellable/read ports, draft
handler/validation, resolved projection and reference read handler. Named reference
shims preserve function/error identities and the observed responder binding.
`./catalog/contracts` holds dependency-free DTOs and pure helpers; server schemas
stay outside it and reference browser schemas remain local.

Media contracts/resolution and source-pack logic move unchanged, with import-only
relocation and three synthetic W8 equivalents. No assets or reference shims are
added for these previously absent subjects. The injected blob type uses the
existing exact core entry; no module graph edge or new dependency is needed.
Lifecycle/publication additions are types and ports only. Read/draft use cases
remain available through host bindings; `publicationRead`, `publish` and
`lifecycleWrite` are unsupported in the neutral reference binding. No constructor
creates a verified publisher. Missing authority is unsupported; configured outage
is `dependency_unavailable`. Known absence is distinct from either.

P1 excludes admin document contracts/handler and the current-document adapter,
which stay reference-owned; new neutral readback guards; offer-membership ports
without a consumer; SQL projections/descriptors, stores, migrations and manifest
positions. W5/W7 subjects are not moved. Rich catalog interpretation, browser
schemas, provider protocol decoders, adopter composition/assets, upload routes,
publication executors, activation/withdrawal/rollback, new graph edges and new
dependencies are excluded. Native catalog stores and their descriptor belong to
later P7/P4 work. P1 preserves reference preview/proposal responses, canonicalizer
portability and SKU-pack refusal behaviour. Executable lifecycle administration
and publication require a separate bounded plan and activation decision.

## P2a

Cut: `@openlup/platform/pricing` and `./pricing/contracts` own the existing
price authority, subscription price policy, pricing-policy token, neutral error
mapping and offer-policy constants/types. Browser schemas and flag, secret and
readiness composition remain reference-owned.

Preserved OpenLup behaviour: authority reads remain sequential, base before
history; an invalid base prevents history lookup and retains refusal precedence.
History lookup uses the validated `base.priceListId`, including malformed-adapter
observations, rather than substituting the selected-list identity.

Tests: **25 moved, 3 new**. After C1's 34, P1's 5 and P2a's 3 new cases,
the programme balance is **58 of 100**; generated boundary iterations remain
separate.

P2a measured: pending committed gates

## Witness ledger

C1 witnesses remain unchanged. A public package equivalent protects the selected
neutral subject; exporting types alone does not close a witness.

| Witness | C1 cases / protected property | P1 disposition |
| --- | --- | --- |
| W1 | 7; strict price authority, quote/offer and acquisition promise/refusal boundaries | Deferred to P2a–P2c; source witness unchanged. |
| W2 | 5; frozen subscription money, retry bytes, acquisition consent and explicit edits | Deferred to P2a–P2c/adoption; source witness unchanged. |
| W3 | 4; promotion adjustment/acceptance, floors and advisory versus durable claim | Deferred to P3; source witness unchanged. |
| W4 | 4; captured bundle composition/readback, allocation, stock and human activation | Deferred to P4; source witness unchanged. |
| W5 | 5; exact document/head/membership join, stale/mixed heads and legacy versus outage | Subjects not moved; no synthetic readback claim; source witness unchanged. |
| W6 | 4; quote-to-draft transfer/reload/navigation and fresh-consent refusal | Deferred to P5; source witness unchanged. |
| W7 | 2; authority/request/proposal/evidence transcript and advanced-head refusal | Subjects not moved; proposal remains distinct from publication; source witness unchanged. |
| W8 | 3; distinct bytes/exact immutable URLs, locale/variant/order/fallback, absence and pre-upload refusal | Three synthetic package cases, including immutable-key deduplication; no assets or wholesale media-suite copy. |

## Observable-difference inventory

| Item | P1 disposition |
| --- | --- |
| PROC-26/P1-01: canonical JSON portability | Existing OpenLup behaviour preserved: lookbehind canonicalizer moves unchanged; older-browser compatibility expansion deferred. |
| PROC-26/P1-02: optional publication preview | Existing OpenLup behaviour preserved: reference handler unchanged; early preview execution path deferred. |
| PROC-26/P1-03: proposal response publication metadata | Existing OpenLup behaviour preserved: no v2 candidate/head/post-state response addition; deferred. |
| PROC-26/P1-04: SKU-pack refusal details | Existing OpenLup behaviour preserved: no new authorization/read-unavailable details; handler unchanged. |
| PROC-26/P1-05: new neutral public API | Existing OpenLup behaviour preserved: additive media functions and lifecycle/publication types/ports only; no mounted mutation. Membership/readback implementation deferred. |
| PROC-26/P5-01: SSG media/details | Existing OpenLup behaviour preserved: optional SSG contract/example-data additions deferred to P5. |

Draft-handler boolean narrowing is type-only; canonical output is preserved.
Admin digest relocation and component-fact type exports remain reference-owned or
deferred; no server crypto enters browser contracts. Existing SKU statuses remain
`draft`/`active`/`archived`, and draft receipts remain `open`/`abandoned`.
Lifecycle `withdrawn` maps from `archived` only with an establishing authority.
No abandoned draft implies withdrawal and no active row invents publication lineage.

## Test and cap ledger

C1 consumed 34 of the programme's 100 new cases; 66 remained at P1 admission.
P1 moves eight existing suites unchanged (**87 cases**) and adds **5 new required
cases**: one reference responder-binding case, three media cases and one lifecycle
type case, leaving **61** for later work. Generated source-boundary iterations
are tracked separately; no copied 21-case resolver or 24-case source-pack suites
and no duplicate invocation. Existing browser closure/budget and cold-consumer
classification machinery is reused. The lifecycle case checks closed refusal/
success states, publish change states and opaque authorization; no runtime capability.

Whole-P1 changed production-source ceiling: **35**; actual cut: **34**.
New contracts browser entry: **3,281 B** minified+gzip; budget **4,096 B**.
P1 and P2a changed no existing entry or aggregate cap. They landed under
**800 files / 522,240 packed B / 2,088,960 unpacked B**; code gzip
**440,320 B / 800 files**; root docs gzip **40,960 B / 10 files**.
On 2026-10-20 the maintainer approved new whole-package caps for the rest of
M05, applied in a separate caps change before P2b: **2,100 files / 1,320 KiB
packed / 5,600 KiB unpacked**; code gzip **1,100 KiB / 2,000 files**. Root docs,
browser-entry and baseline values and the growth tripwire are unchanged.

Main alone, measured on `83a479e`: **684 files / 413,801 packed B /
1,764,012 unpacked B / 349,386 code gzip B / 666 code files**.
P1 measured: **753 files / 462,244 packed B / 1,974,943 unpacked B**.
