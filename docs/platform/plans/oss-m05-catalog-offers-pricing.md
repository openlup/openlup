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
P1 → P2a → P2b → P2c → P3a → P3b → P4a → P4b → P5 → P6 → P7 → S1.
P2 is split into three parts; checkout, claims and finalize stay with the checkout module.

| PR | Bounded scope |
| --- | --- |
| P1 | Neutral catalog/read/draft move, media contribution and lifecycle-ready types. |
| P2a | Existing authority, policy and token logic; preserve behaviour and reuse the existing core pricing engine. |
| P2b | Existing quote, offer, handlers and readiness; preserve behaviour. |
| P2c | Additive acquisition-terms selection and promise-consent API; required injected financial policy, no default policy, reference activation off. |
| P3a | Unchanged promotion application/acceptance with explicit host bindings; additive resolved-terms callback argument; ≤35 production/tooling paths. |
| P3b | Admin, existing native read/sweep store and SQL 47/48 descriptor; no new migration; ≤35 production/tooling paths. |
| P4a | Unchanged fixed-bundle application/admin in existing catalog entries; no native store or SQL; ≤35 production/tooling paths. |
| P4b | Native read store and SQL 16/19 descriptor with real PostgreSQL proof; no new migration; ≤35 production/tooling paths. |
| P5 | Neutral browse/product/cart/builder/admin UI consuming explicit data/locale/media ports and lifecycle-ready DTOs; preserve existing fences. |
| P6 | Bounded refactoring after unchanged imports and preserved witnesses; no new functional scope. |
| P7 | Reference/default composition, selected native stores/schema/readiness and consumer/readback proof; no new capability or activation. |
| S1 | Separate existing-set version preparation and final packed-artifact/cold-consumer proof; no inferred version. |

Execution change: P4 split into P4a (application/admin, ≤35 paths) and P4b (native read store and SQL 16/19 descriptor, ≤35 paths), replacing the master P4 ≤25 row; reason: full cut is 36 paths; two reviewable PRs.

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

P2a measured: **789 files / 480,886 packed B / 2,038,883 unpacked B / 406,639 code gzip B**.

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

Pack with P2b: **864 files / 846 code files / 533,073 packed B /
2,336,564 unpacked B / 455,320 code gzip B**, within the raised caps of
**2,100 files / 2,000 code files / 1,351,680 packed B / 5,734,400 unpacked B /
1,126,400 code gzip B** (the earlier caps of 800 files / 800 code files /
522,240 / 2,088,960 / 440,320 B would not hold it).
Root docs: **32,856 gzip B / 5 files**, within **40,960 B / 10 files**.
P2b changes no package cap. Pricing contracts
measure **349 B** minified+gzip; only their browser-entry budget increases from
**320 B** to **416 B**.

## P2c — acquisition selection and promise consent

Cut: additive acquisition DTOs, strict schemas, schedule selection/filtering,
capability refusal, asymmetric promise comparison, offer v3 negotiation and
freshness, boundary-aware readiness and explicit acceptance binding under the
existing pricing entries. No package coordinate or graph value edge is added.
The required `AcquisitionFinancialPolicy<Row>` supplies facts, classification,
metadata validation, pair matching, initial rate and unconfigured terms. There
is no default; absent policy has the named `acquisition_terms_policy_unconfigured`
refusal before row/time evaluation. Financial values and predicates stay with
the host; schedule calculations, refusal order and serialization are preserved.

Activation is off in reference composition. Its original offer handler, shared
readiness and request/context schemas remain in use. Quote/batch acquisition
mapping requires explicit configuration. Acceptance adds the full resolved
object only from explicit server input, in the whole money and existing totals
section; absence omits the property and preserves token bytes. Unsupported
acquisition requests refuse only through the opt-in API; the inactive endpoint
continues ignoring their header.

Tests: **15 new required cases**, leaving **39 of 100** programme cases.
Synthetic fixtures cover schedules, required policy, capability/engine refusal,
promise comparison and binding, real terms-only token consent, quote/batch
refusal/fallback, negotiated v3/freshness, readiness boundaries and inactive
transcripts including a fixed historical token generated from the predecessor.
Existing pricing suites remain unchanged. The existing smoke inventory and
cold consumer include the additive API and missing-policy refusal.

Changed production/tooling source files against the P2b predecessor: **18**;
including four JSON inventory, browser-import and release-gate companions: **22**,
within the **35** ceiling. The module graph declaration is unchanged: pricing
retains only type edges to HTTP/BFF and no cross-module value edge.

Pack: **894 files / 876 code files / 549,299 packed B / 2,416,236 unpacked B /
470,217 code gzip B**; root docs **33,580 gzip B / 5 files**. Pricing contracts
measure **386/416 B** minified+gzip; no cap increase is needed.

Pending: the existing acquisition-only route issuer remains unchanged; its
mounted-route proof is still missing. Adopter composition, unchanged C1 witness
reruns and behavior parity belong to adoption. Checkout admission, claims and
finalization remain outside this cut. Native reviews and committed package
gates belong to the supervisor's signed candidate; this local implementation
makes no merge, release or activation claim.

## P3a — promotion application and acceptance

The delegate approved splitting the former P3 into P3a/P3b, each at most 35
production/tooling paths (replacing the former 25-path ceiling). P3a moves the
four application files, benefit definition, two advisory read ports, preview,
money binding, acceptance and telemetry. Named reference bindings preserve floor
resolution timing, customer classification, eligibility facts, request projection,
recorder behavior, outputs and refusals. Core remains the evaluator. Managed RPC
names/transport, admin, native stores/SQL and claim writers remain outside P3a.
No activation, checkout/finalize, timer or communications trigger is added.

The deliberate additive public-contract change passes server-resolved acquisition
terms to both issue and honor callbacks. Absent configuration omits terms; the
fixed historical token witness protects byte identity. Low-level terms support
does not establish acquisition-only mounted acceptance.

Tests: four synthetic W3 conformance cases, one terms-to-callback composition case
and one reference-binding case: **6 new required cases**, leaving **33 of 100**
programme cases from the pre-P3a balance of 39. Existing subject assertions move
with default currency → `XXX`, default country → `ZZ`, and the local VAT
legal-basis text → `Example VAT rule`; other fixtures stay distinct.
The managed RPC-name and mixed create-schema/preview cases stay reference-owned;
checkout-heavy cross-surface and
quote integration suites remain reference-owned. The acceptance unit fixture
uses only synthetic request and money values rather than checkout orchestration.

Changed production/tooling paths against the P2c predecessor: **32/35**, including
JSON companions. Both promotions entries were non-adapters at P3a (P3b
reclassifies the server entry; see below); only promotions has a pricing value
edge, through its server entry. The contracts entry has no imports.

Pack: **933 files / 915 code files / 582,993 packed B / 2,573,175 unpacked B /
501,214 code gzip B**; root docs **35,073 gzip B / 5 files**, all within the
existing aggregate caps. Promotions contracts measure **20 B** minified+gzip
with a **32 B** budget; pricing contracts remain **386/416 B**. No aggregate cap,
released baseline or growth-tripwire policy changes.

### D8 pending outcome ledger

Each row is **PENDING, not N/A, not claimed; must be dispositioned before M05 S1**.
Disposition requires later implementation/proof or one bounded scope packet to
the delegate; any reduction of admitted acceptance requires the owner's decision.

| Outcome | Status and remaining proof |
| --- | --- |
| Native advisory v2 promo-code candidates and rejection details | PENDING capability/parity; the managed resolver is not a native implementation. |
| Native mounted quote issue/honor/fallback | PENDING composition proof on the native mount. |
| Acquisition-only mounted acceptance | PENDING composition proof; low-level token tests do not close it. |
| Full native/managed eligibility matrix | PENDING explicit outcome matrix, including paid-order classification and native device evidence differences. |

Existing native lifecycle/read is proven in P3b on real PostgreSQL using the
complete canonical installation chain. This proves the incumbent read/sweep and
selected lifecycle subset, with no managed-schema import or new claim writer;
it does not close any of the four PENDING rows above.

### P6 acceptance obligation

P6 must replace every non-neutral fixture value still present in the moved
package tests (including a legacy policy constant and industry-specific fact
fields and contact values carried over unchanged from the existing public
tests) with neutral synthetic values, without weakening any
assertion. M05 S1 requires this row closed, so no adopter policy constant
remains anywhere in OpenLup.

## P3b — promotion admin and native read/sweep

The unchanged move includes two admin handlers, two ports and promotion-owned
DTOs/server schemas, with named reference compatibility exports. Reference
wrappers inject the existing shared admin kit/error constructor, response writers,
preview helpers and currency validator. Adjacent shipping/catalog-price/band
schemas and managed adapters retain their owners. Human-only mutation gates,
required audit, activation proof, revision-aware replay delegation and mirror
fences preserve existing behavior.

The existing native store and sweep port use an injected data executor. Their
data edge is type-only; no client construction or runtime data dependency is
needed. The promotions server entry is classified as an adapter because its
declarations reach optional pg types; contracts remain dependency-free and
non-adapter. Canonical units 47/48 are byte-identical sparse projections with
catalogPath/position/sha256/url descriptors. There is no migration, manifest or
baseline change, claim writer or reservation addition.

Six new executed cases (five real-PG and one admin-binding case) consume six of
the prior 33 programme cases, leaving **27 of 100**. Existing subject suites move
with assertions retained; the global-environment case stays reference-owned.
Synthetic region `ZZ` replaces the default-country fixture in the moved admin
list suite, and synthetic code `EXAMPLE10` replaces a brand-style code in the
moved admin suite. The moved handler suites run from `tests/platform/promotions`. Real-PG evidence covers fresh full-chain application,
projection identity/validated constraints and repeat runner application; read-only
active definitions/counts/device evidence; paid/released transitions; bounded
sweep/replay with receipt/outbox fences and unchanged money; lock/settlement
skips; denied-role and explicit invoker read grants. Atomic writer concurrency,
prior-prefix upgrade and the four D8 outcomes are not claimed by this subset.

Changed production/tooling paths against the P3a predecessor: **29/35**, including
JSON companions. Pack: **968 files / 948 code files / 612,089 packed B /
2,738,249 unpacked B / 522,847 code gzip B**; root docs **35,737 gzip B / 5
files**, all within the aggregate caps. Advisory for P5: the reference admin
browser clients reach the admin schemas through the promotions server entry via
the reference contract re-exports; no admin bundle is built in this tree, so an
admin browser bundle needs a browser-safe schema home first.

## P4a

The unchanged move puts bundle rules/codes, pure availability, catalog read port,
stock service, admin write port, nine mutation handlers, four read/preview
handlers and the public sellable feed in the existing catalog server entry.
Core composition contracts/ports and allocation retain their existing owners.
Native read stores, SQL, migrations, mounting and activation are outside this slice.
OpenLup preview selection and refusal behavior are preserved; newer selection and
readiness differences in the comparison inventory are not adopted.

Reference wrappers bind the existing lifecycle predicate, stock status/reason
helpers, shared admin kit, operation spec/flags, response schemas, responder and
wire versions. The reference-owned BundleRpcError constructor is injected;
BundleCatalogReadError moves once and remains identical through its named shim.
No shared kit or operation authority is relocated or duplicated.

Browser-reached bundle schemas continue defining Zod locally. Catalog contracts
add plain DTO types only, with no Zod, Node, ambient loader or cross-contract-entry
imports; server handlers receive the reference validators. The one binding case
checks DTO/schema type parity and both browser client closures. Catalog server
remains non-adapter in P4a; no data edge is introduced.

Four W4 equivalents preserve ordered captured composition, one deduplicated stock
request, 2,001 → 801/800/400 allocation and unknown stock; invalid composition;
machine virtual draft versus unsupported fulfillment; and activation authority.
The new equivalents use XXX (EUR → XXX); the original witness is unchanged.
Witness provenance: the supplied characterization is held outside this tree and
is byte-identical at its original and current reference points; neither that
commit object nor witness file is present in this public checkout.
Seven suites relocate unchanged: 44 package cases and 18 root binding cases,
62 total. Five new executed cases leave the programme balance at **22**.

Changed production/tooling paths versus eeb549c: **30/35**, including JSON
companions. Pack measured before main's A1 merge: **1,010 files / 990 code files / 649,889 packed B /
2,909,269 unpacked B / 561,429 code gzip B**; root docs **36,506 gzip B / 5
files**. Catalog contracts remain **3,281/4,096 B** minified+gzip. All measurements
are within existing caps; no released baseline or growth tripwire changes.
Collection confirms each moved/new file inside an existing include: package
rules 20, availability 11, stock service 6, read port 1, feed 6; root admin mutation
6, admin read 12, W4 conformance 4, binding/browser closure 1. Generated source
boundary iterations remain separate from the five programme cases.

## P4b

Five new executed real-PostgreSQL cases leave the programme balance at **17**.
Fresh full-chain/repeat installation, SQL identity, native reads without data
writes, canonical write refusal/rollback/dry-run/price history, sequential key
recognition and explicit invoker grants characterize the incumbent native subset.
All bundle parity rows remain PENDING; row 1 is now characterized, not closed.
The existing binding case remains one case. Confirmed changed-test collection:
PostgreSQL 5, binding 1, package boundary 1,030 and cold-consumer tooling 37 (pre-merge counts). Generated
source-boundary iterations do not consume programme cases.

Changed production/tooling paths versus e581e1aae980efcea06cb580a15357a45db360bf:
**18/35**, including JSON companions; tests, API snapshots and prose excluded.
Pack measured before the main merge (A1 P1): **1,024 files / 1,002 code files / 667,279 packed B / 2,986,256 unpacked B /
571,700 code gzip B**; root docs **37,278 gzip B / 5 files**. Browser entries:
catalog contracts **3,281/4,096 B**, pricing contracts **386/416 B**, promotions
contracts **20/32 B** minified+gzip. Existing aggregate caps and released baseline
are unchanged. Local packed runtime/declaration diagnostics complement, and do
not replace, the supervisor's committed-candidate package gates.

### Bundle parity pending ledger

Each row remains PENDING, not N/A, and must be dispositioned before M05 S1,
together with D8 and P6. Package application proof closes none of these rows.

| Outcome | Status and remaining proof |
| --- | --- |
| Native database independent human-only actor-kind gate | PENDING: characterized in P4b; native database has no independent gate, handler gate only. |
| Native history actor identity | PENDING: native actor fields are null versus managed audit identity. |
| Native mounted admin/feed with actual stock | PENDING: P7 composition proof. |
| Replay/concurrency beyond sequential replay | PENDING: characterize incumbent outcomes before claiming stronger guarantees. |

## P5

The approved reference-only cut repairs browser promotion schemas and applies
Decision B's exponent-aware subscribe display, including fallback and refusal to
guess. Local schemas preserve current package semantics; package server exports,
DTOs, shipping and band behavior remain unchanged.

Explicit locale/data/media/lifecycle inputs feed additive catalog, product and
selected-basket pages through testable reference routes. The shipped public root
is not mounted here; that composition remains P7. The builder maps neutral
acquisition terms into a separate persisted consent expectation, with fresh
selected-quote navigation and consent invalidation on basket edits. Existing
admin pages accept optional read/lifecycle bindings without changing default
transports, gates or mutations. Optional SSG details/media preserve legacy detail
lookup and gallery behavior. The W6 source witness remains unchanged outside
this tree; the neutral reference transcript exercises production save/reload and
navigation paths without activating incumbent endpoints or caches.

Task authority: implementation and focused local verification only, in the
assigned task worktree. The supervisor owns commits, native candidate review and
delivery. No Git writes, release, external mutation or adopter change is included.
The separate in-flight extraction is not a dependency. The agreed stock-card,
reservation and shipping-handler exclusions remain intact; no communications
integration is introduced. Existing D8, bundle parity and P6 obligations stay open
as recorded below and above.

Final diff versus `34eaffb3a734fec44b481323aac169e078e3d67c`:
**21/35 production/tooling paths**, comprising 19 reference source paths and two
generated JSON companions. Tests and prose are excluded from this path count.
**12 new executed cases** consume the coordinator's supplied post-extraction
planning balance **17 → 5**; this is not a claim that the separate extraction
has landed in this checkout. The allocation is currency 2 (both normal/fallback
tables in one case, exponent refusal in one), promotion parity/browser closure 3,
W6 4 and SSR/locale/lifecycle 3. The existing D8, bundle parity and P6 rows are
unchanged.

Collection on the final source: subscribe entry model **8**, promotion binding
**4**, reference builder conformance **4**, reference SSR **1**, reference page
DOM **2**. All are in existing include globs: Node `src/**/*.{test,spec}.ts` and
`tests/platform/**/*.{test,spec}.ts`, DOM `src/**/*.{test,spec}.tsx`; the builder
Node path explicitly selects the DOM environment for actual persistence. The
full focused selection collected and passed **19 files / 122 cases**. Existing
client, document panel, bundle helper, quote/cache, draft, subscribe journey,
product FAQ/support, reference-store and public-entry SSR guards remain intact.

The existing browser measurement helper reports **22,007 B** for the promotion
client, **20,610 B** for the code client and **43,459 B** for the opt-in reference
routes (minified+gzip, including their runtime closures). Replacing only the two
schema inputs with their baseline versions makes browser bundling refuse Node
built-ins; a comparable baseline browser-byte total is therefore unavailable.
These are application measurements, not package-entry limits. No package or
browser budget change is requested.

Working-tree pretest, structural scan, lint, typecheck, static and subscription
builds, focused tests, collection and diff whitespace checks pass. Lint retains
existing warnings. Build outputs were removed. Root neutrality has zero increases
against the assigned base; its default moving-main comparison also reports an
unrelated shipping-evidence difference. The publication catalogue and source
contract were regenerated with their existing generators. The materialized
candidate passes inventory, contract, navigation and all four documentation
impact obligations. The index-based policy command refuses the new untracked
paths until the supervisor stages them, as this implementation grant forbids Git
writes; committed-candidate policy/native review remain supervisor obligations.

Self-retro: checking actual legacy renderer fields caught incorrect new fixture
assumptions before handoff. Use rendered composition cards and FAQ/supplement
facts to test the supplied-details seam; keep the finite case allocation rather
than adding a second harness or new runner. No successor work is opened.

## Witness ledger

C1 witnesses remain unchanged. A public package equivalent protects the selected
neutral subject; exporting types alone does not close a witness.

| Witness | C1 cases / protected property | P1 disposition |
| --- | --- | --- |
| W1 | 7; strict price authority, quote/offer and acquisition promise/refusal boundaries | Deferred to P2a–P2c; source witness unchanged. |
| W2 | 5; frozen subscription money, retry bytes, acquisition consent and explicit edits | Deferred to P2a–P2c/adoption; source witness unchanged. |
| W3 | 4; promotion adjustment/acceptance, floors and advisory versus durable claim | Four neutral package conformance transcripts in P3a; source witness unchanged. |
| W4 | 4; captured bundle composition/readback, allocation, stock and human activation | Four neutral bound package conformance transcripts in P4a; original witness remains outside this tree and unchanged. |
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
