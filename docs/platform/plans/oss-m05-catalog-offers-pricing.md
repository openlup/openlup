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

## P2b — quote and offer layer

Cut, parts A+B: neutral money/tax/quote/offer DTOs; generic quote/options/verifier
ports and errors; injected server validation; promotion evidence/rejection DTOs
and validation; bounded catalog facts, provenance and tax guard; quote computation,
price/tax/component helpers, snapshot comparison, quote/batch handlers, v1/v2 offer
projection/handler/cache and existing readiness. The existing pricing entries are
unchanged; the only added graph edges are type imports from `bff` and `http`.
Reference bindings retain settlement defaults, rich request/context admission and
snapshot reconstruction, catalog bridge, roster/request/unit/floor/scope policy,
observed BFF context, flat-fee settings and promotion application. Promotion
implementation, acquisition terms, threshold shipping, memoizers, price setup,
UI and SQL remain outside this cut.

Preserved OpenLup behavior: `getShippingFlatMinor` runs before promotion evaluation;
the existing VAT helper and both shipping/discount tax lanes remain unchanged.
Quote acceptance/fallback and batch error mapping retain their original rules,
with ordered `Promise.all`. Offers remain v1/v2, use the first successfully priced
representative and degrade only for a missing configured product price. Cache
freshness starts at load start; readiness retains its positive 60-second and
negative 5-second caps, with no acquisition-aware readiness changes.

Tests: **89 existing cases moved** across fourteen suites; **4 new required cases**
(three quote-foundation cases and one observed-responder binding case), leaving
**54 of 100** programme cases from the pre-P2b balance of 58. Assertions remain
unchanged apart from neutral fixtures: default currency → `XXX`, default country
→ `ZZ`, locale-specific
VAT legal-basis text → `Example VAT rule`, and the corresponding quote-fixture
helper rename. Foreign-currency and alternate-country cases stay distinct.
Package tests bind the exercised rich policy with local synthetic fixtures; the
two existing promotion-application suites remain at their unchanged reference
implementation boundary. Existing selectors execute each suite once; the existing
cold consumer covers both pricing entries and installed declarations.

Whole-P2b changed production/tooling files against P2a: **50** (48 package/reference
source and two tooling files), within the coordinator-approved **60** ceiling.
The overflow above 35 consists entirely of mechanical splits, package destinations,
named compatibility bindings, barrels and graph/consumer tooling; no behavior
change is included.

Working-tree pack: **864 files / 846 code files / 533,073 packed B /
2,336,564 unpacked B / 455,320 code gzip B**. Current caps are **800 files /
800 code files / 522,240 packed B / 2,088,960 unpacked B / 440,320 code gzip B**;
all five are exceeded. All approved caps hold: **2,100 files / 2,000 code files /
1,351,680 packed B / 5,734,400 unpacked B / 1,126,400 code gzip B**.
Root docs: **32,856 gzip B / 5 files**, within **40,960 B / 10 files**.
The separate cap contribution owns the package cap changes. Pricing contracts
measure **349 B** minified+gzip; only their browser-entry budget increases from
**320 B** to **416 B**.

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
Existing entry and aggregate caps are unchanged. Whole-package caps remain
**800 files / 522,240 packed B / 2,088,960 unpacked B**; code gzip
**440,320 B / 800 files**; root docs gzip **40,960 B / 10 files**.
The approved cumulative caps for P2b onward are recorded above; the current
package caps remain unchanged until the separate cap contribution lands.

Main alone, measured on `83a479e`: **684 files / 413,801 packed B /
1,764,012 unpacked B / 349,386 code gzip B / 666 code files**.
P1 measured: pending committed gates
