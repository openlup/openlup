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
| P7 | Explicit inert reference composition, selected native stores/schema/readiness and consumer/readback proof; default remains unmounted, no new capability or activation. |
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

The owner accepted D8-1 through D8-4 as native-backend capability gaps on
2026-10-20: "zgadzam sie na rekomendacje". These dispositions claim no parity.

| Outcome | Status and remaining proof |
| --- | --- |
| D8-1: Native advisory v2 promo-code candidates and rejection details | Accepted native-backend capability gap (owner decision 2026-10-20: "zgadzam sie na rekomendacje"): Native v2 advisory code resolution remains unimplemented; no native/managed parity claim. |
| D8-2: Native mounted quote issue/honor/fallback | Accepted native-backend capability gap (owner decision 2026-10-20: "zgadzam sie na rekomendacje"): Native mounted v2 code issue/honor/fallback remains pending on native advisory code resolution; incumbent native quote behaviour preserved. |
| D8-3: Acquisition-only mounted acceptance | Accepted native-backend capability gap (owner decision 2026-10-20: "zgadzam sie na rekomendacje"): Low-level terms binding proven; acquisition-only mounted issuance/honor remains unimplemented and reference activation remains off. |
| D8-4: Full native/managed eligibility matrix | Accepted native-backend capability gap (owner decision 2026-10-20: "zgadzam sie na rekomendacje"): Incumbent eligibility differences recorded; full equivalence not claimed. |

Existing native lifecycle/read is proven in P3b on real PostgreSQL using the
complete canonical installation chain. This proves the incumbent read/sweep and
selected lifecycle subset, with no managed-schema import or new claim writer;
it does not supply the missing capabilities recorded in the four accepted gaps above.

### P6 acceptance obligation

No adopter policy constant remains in OpenLup application code; the reference
composition supplies the adopter's values. The immutable managed baseline schema
(legacy-offer v2 mirror backfill and mirror-closing trigger predicates) and its
pgTAP tests retain the incumbent value; removing it requires a forward migration
that changes managed schema behaviour, recorded as an M05 follow-up needing an
owner decision.

The moved package tests are neutralized without weakening assertions, including
legacy policy fixtures, fact fields and contact values. **SATISFIED in P6 for the
moved package tests.** Q1 is behavior-preserving: both reference classifiers
require the host's threshold without a default. The quote-discount composition
owns the single named reference constant; v2 quote and admin compositions reuse
it. Comparison tolerance and existing assertions remain unchanged, with zero
new executed cases. Owner decision 2026-10-20: "zgadzam sie na rekomendacje".

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
At P4b all bundle parity rows remained PENDING; row 1 was characterized, not
closed. The dated owner dispositions below supersede that pending status for
Bundle-1 and Bundle-2.
The existing binding case remains one case. Confirmed changed-test collection:
PostgreSQL 5, binding 1, package boundary 1,030 and cold-consumer tooling 37 (pre-merge counts). Generated
source-boundary iterations do not consume programme cases.

Historical P4a predecessor: `e581e1aae980efcea06cb580a15357a45db360bf`.
Changed production/tooling paths from the P4b fork point after main carry-over,
`020e6479cfc8e37810796cf3f67b52e5fa99bf12`, to the landed P4b tree:
**18/35**, including JSON companions; tests, API snapshots and prose excluded.
Pack measured before the main merge (A1 P1): **1,024 files / 1,002 code files / 667,279 packed B / 2,986,256 unpacked B /
571,700 code gzip B**; root docs **37,278 gzip B / 5 files**. Browser entries:
catalog contracts **3,281/4,096 B**, pricing contracts **386/416 B**, promotions
contracts **20/32 B** minified+gzip. Existing aggregate caps and released baseline
are unchanged. Local packed runtime/declaration diagnostics complement, and do
not replace, the supervisor's committed-candidate package gates.

### Bundle parity pending ledger

The owner accepted Bundle-1 and Bundle-2 as capability gaps on 2026-10-20:
"zgadzam sie na rekomendacje". Bundle-3 is closed for the M05 mounted readback
boundary with an injected stock reader; its native stock read remains M06 P5a
work. Bundle-4 is closed only to the incumbent contention characterization
proved on real PostgreSQL in P7 Phase A; no stronger replay guarantee is claimed.

| Outcome | Status and remaining proof |
| --- | --- |
| Bundle-1: Native database independent human-only actor-kind gate | Accepted native-backend capability gap (owner decision 2026-10-20: "zgadzam sie na rekomendacje"): Native human-only publication relies on the handler gate; independent database actor-kind enforcement is absent. First item of a future native-backend parity round. |
| Bundle-2: Native history actor identity | Accepted native-backend capability gap (owner decision 2026-10-20: "zgadzam sie na rekomendacje"): Native principal audit exists; managed-equivalent actor kind/email history is unavailable and not claimed. |
| Bundle-3: Native mounted admin/feed readback (M05) | Closed for M05: mounted admin/feed readback proven through the merged M06 availability builder with an injected stock reader. The real native stock read is M06's PENDING row (NewPurchaseStockReadPort native implementation, → M06 P5a), dispositioned there. |
| Bundle-4: Replay/concurrency beyond sequential replay | CLOSED as incumbent characterization by P7 Phase A `native-bundle-replay-contention-characterization` on real PostgreSQL: global-key blocking, commit/unique-conflict rollback, first-attempt rollback, and conflicting payload/entity/routine recognition. No payload-bound or exactly-once guarantee. |

## P6 — bounded refactor and fixture neutralization

The coordinator approved the original seven-source-path cut and the Q1
five-path reference composition extension. The outcome is corrected
comments, delegation of duplicate VAT arithmetic to the existing helper, and
neutral moved-test fixtures with all assertions retained. Both VAT exports,
signatures and distinct function identities remain; API snapshot changes are
comments only. No package API, dependency, SQL, migration, functional or cap change is
included. Required reference classifier parameters preserve composed behavior. A behaviour change is never a refactor. C1 witnesses remain unchanged.

Authority is local implementation and the requested focused checks; the
supervisor owns commits, native candidate review and delivery. This task grants
no merge, release, activation or adopter continuation. P5 functional paths and the concurrent inventory, shipping and communications
work remain excluded. The owner decision 2026-10-20, "zgadzam sie na rekomendacje",
authorizes Q1 and Q2. STEP 0 selects the existing quote-discount composition for
the constant, avoiding an additional production path. The starter-offer comment
describes arithmetic parity rather than the threshold location and stays unchanged.

Final-diff ledger against `a2edd8ebd9d72dea5be22197750743e4d2f3d198`:
**12 production source paths / 12**, **12 production/tooling paths / 35**;
**37 existing test/helper paths** (28 suites and 9 helpers), **0 new executed
cases**. The post-P5 programme balance stays **5**. The publication catalogue and
source-release contract were regenerated through their existing generators and
are byte-unchanged; three API snapshots change comments only. Prose and API
snapshots are excluded from the production/tooling count.

The original seven source paths are pricing `commerceQuoteCatalogReadPort.ts`,
`commerceOfferPricing.ts` and `dbBackedCommerceQuoteHelpers.ts`; promotions
`adminPromotionsDataPort.ts`; catalog `bundleRules.ts` and `bundleRuleCodes.ts`
(all under `packages/platform/src/`); and `src/domains/bundle/bundleSpec.ts`.
Q1 adds exactly five reference production paths:
`server/domains/commerce/promotionCustomerSemantic.ts`,
`server/domains/commerce/adminPromotionSemantic.ts`,
`server/domains/commerce/quotePromoDiscounts.ts`,
`server/domains/commerce/quotePromotionV2.ts` and
`server/adapters/supabase/adminPromotions.ts`. No tooling source path changes.
Tests comprise 4 catalog, 19 pricing and 10 promotions package paths, plus
`tests/platform/catalog/bundleBindings.test.ts`,
`tests/postgres/bundleNative.test.ts` and the two reference semantic suites
`server/domains/commerce/promotionCustomerSemantic.test.ts` and
`server/domains/commerce/adminPromotionSemantic.test.ts`. The feed fixture derives its reason code
through the existing helper. The native read case deletes only its returned
temporary tier-row IDs in `finally`, after its unchanged no-write assertions.

Neutralization preserves lookup identities, cohort distinctions, validators,
null/optional fields, refusal precedence and exact projections. The synthetic
legacy percentage is 37.537: `floor(16,000 × 37.537 / 100) = 6,005`, and
`16,000 − 6,005 = 19,990 / 2 = 9,995`. Coverage arithmetic stays 492 and 21.
Synthetic GTINs retain their valid/invalid checksum distinction. Frozen token
witnesses remain unchanged. D8-1..4 and Bundle-1/2 are accepted native-backend
capability gaps under the owner decision above, with no parity claim; Bundle-1
is the first item of a future native-backend parity round. These gaps must be
named in the S1 CHANGELOG/docs as "not supported on the native backend". The
managed path is unaffected. Bundle-3 is closed for M05 by P7's mounted readback
with an injected stock reader; the native reader remains M06 P5a work. Bundle-4
is closed by P7's real-PostgreSQL replay/contention characterization only.

The original seven-path proof compares production tokens with comments removed,
allows only the named VAT delegation, compares API declaration tokens, and checks each test's
substitution map, assertion arguments, matcher sequence and collection count.
All original **425 expect call sites** across the original 35 changed test/helper
paths remain. The two reference semantic suites retain their 15 assertions,
bringing the final changed-test total to **440 expect call sites** across 37 paths.
Their only changes are the explicit threshold argument and its import. The
original focused collection stays **1,248 cases** across 27 files. Including the
two reference semantic suites (7 cases), adapter suite (8), reference binding
suite (1) and legacy-code outcome suite (6), final focused collection is
**1,270 → 1,270 cases across 32 files**. All 1,265 non-database cases and 5 native
PostgreSQL cases pass. No new case or mandatory full-suite execution is claimed;
the host-load rule permits explicit focused paths only. Required local checks
and their actual exits are retained in the implementation handoff; supervisor
candidate gates remain outside this local delivery boundary. The continuation's
ast-grep, lint, published-tree typecheck, public-reference build, focused Vitest
run and collection checks exit 0. Lint reports 33 warnings and zero errors. Policy
with regenerated navigation has five obligations and zero unanswered. Package
exports are unchanged, so this continuation adds no Unreleased changelog note.
The threshold search has 11 matches: one reference constant, three reference
fixtures, two immutable baseline SQL predicates and five managed pgTAP matches.

### Deferred P6 advisories

- Discriminated-union authority ports: public API; coordinator/owner.
- `customerSemantic` vocabulary: public contract; coordinator/owner.
- Zod/jitless import order: pricing module owner; needs module-evaluation proof.
- Acquisition delegation `Vary`: observable HTTP/cache behaviour; coordinator.
- Direct Rolldown dependency: dependency owner.
- Docker-free SQL tests, SELECT-only cold-consumer evidence and explicit
  anon/authenticated assertions: native proof owner, P7/C5.

Retro: an initial install omitted the cache setting and was rerun correctly.
Diff inspection caught a residual fixture label and comment grammar before final
checks. The simpler path was the existing named VAT wrapper and test-local
substitutions; public-contract and new-proof advisories stay deferred. In the Q1/Q2
continuation, initial collection failed because package build outputs were absent;
building the existing workspaces restored collection without source changes.
Lesson: absent build outputs → build existing prerequisites before collection.
The chosen constant location avoided a thirteenth production source path.

## P7 — inert native composition and M05 mounted readback

Status: Phase A plus Phase B M05 readback implemented on the assigned task
branch, after merging main `32a31f37` (including M06 P1b), with P6 stack base
`4cab99ad16871e84c273188fedce2cfb53ee9143`; no Git writes, signed candidate,
submission, merge, release or activation. The supervisor owns commits, applicable
API read, fresh native review and delivery. Scope is the unchanged native store
cut, sparse projections, explicit inert roots, companions and five bounded cases.
Phase B adds one port-boundary test double case and ledger wording only; the
coordinator permits an injected `NewPurchaseStockReadPort` feeding the merged M06
builder, without a native stock claim. P5 source is absent on this stack.
M06 implementation and native stock proof,
default BFF/browser/profile/prerender changes and release preparation are excluded.

### Source and API ledger

The package implementations of `catalogSkuEnvelope.ts`, `catalogSkuEnvelopeMapper.ts` and
`catalogDraftStore.ts` are byte-equal to their P6 donor bodies after import-path
substitution. The two old store paths are named reference shims. The old mapper
path was removed because nothing imported it; the package mapper is its only
home. The managed envelope keeps its own mapper. This move adds no public
exports or package deep imports.

The catalog API report adds exactly two store factories:
`createPostgresCatalogSkuEnvelopeReadPort` and `createPostgresCatalogDraftStore`.
Their existing parameter/return types need no new type exports. The separately
required `CATALOG_MIGRATIONS` descriptor adds canonical units **1, 8, 58, 59, 61**
with byte-identical projections and unchanged canonical manifest/history.
Composition adds `createCatalogContribution` and `CatalogContributionInput` with
one appended barrel line. It uses readiness types only; catalog's existing
**type-only data** edge is unchanged and **no composition-to-catalog edge** is
needed. Package boundary assertions and release smoke evidence retain parity.

`server/runtime/public-reference/m05CatalogBinding.ts` selects native envelope,
draft, price-authority and bundle stores, existing identity verification,
quote/offer/promotion callbacks, selected bundle handlers, stock injection and
owned-resource closure. `m05CatalogSchema.ts` supplies finite selected relations,
columns and exact routine overloads. Existing readiness checks actual callable
identity and host-observed inventory/schema facts. Publication read/publish,
lifecycle writes, native acquisition acceptance, native promotion-admin writes
and native code-candidate resolution remain unsupported. All operation flags
default off; default caller routes and shipped pages/profile remain unchanged.

### Proof and case ledger

Phase A provides four explicit cases; Phase B supplies the single remaining
`native-mounted-bundle-admin-stock-readback` case. There is no
skipped case or new parameterized expansion. Existing generated source-boundary
iterations remain separate from the programme's authored-case budget.

| Case | File | Observed result |
| --- | --- | --- |
| #1 `native-mounted-bundle-admin-stock-readback` | `tests/postgres/m05CatalogComposition.test.ts` | PASS: native catalog/bundle rows on the canonical PostgreSQL chain, selected admin/feed handlers registered by the inert reference composition, and component-derived bundle availability through the merged M06 builder with an injected stock reader. Changing one component from four units to zero changes both readbacks; reader calls assert both component SKUs, horizon and exclusion options. No native stock implementation is proved. |
| #2 `native-bundle-replay-contention-characterization` | `tests/postgres/m05CatalogComposition.test.ts` | PASS on real PostgreSQL: independent blocked transactions on disjoint entities; first commit yields exact `23505`/`uq_catalog_bundle_write_events_key` and aborted/rolled-back second effects; first rollback lets the second commit; conflicting payload/entity/routine reuse is recognized without extra effects. Bundle-4 CLOSED to this characterization only. |
| #3 native consumer readback | Same PostgreSQL file | PASS: native document/identifier envelope, strict price authority and quote/offer projection, existing native authorizer, exact transported draft bytes/fingerprint, durable revision/receipt and admin open-state readback, denied access and unchanged catalog authority. Existing issuance returns no acquisition acceptance token. P5 builder display/Continue wiring is absent and remains for the slot merge. |
| #4 selected readiness / cold-consumer refusal | `tests/platform/catalog/m05Composition.test.ts` | PASS: actual callable/store identities, unsupported declarations, absent store/stock refusal, missing ports, incomplete/unknown schema and mismatched candidate refusal; packed SDK-absent consumer runs the reused real-operation/named-refusal scenario. |
| #5 `SSR/default-exposure-unchanged` | `tests/platform/catalog/m05ReferenceComposition.test.ts` | PASS: both original pages render identically through the app and SSR entry, undeclared catalog/builder/admin/feed paths remain unexposed, empty BFF caller table and activation default preserved. |

Phase A `vitest list` collected **2 / 1 / 1** cases in those three files respectively.
The initial Phase A focused run collects and passes **1,202 cases in 9 explicit files**,
including package-boundary, cold-consumer, moved-store and selected contract
regressions. No broad test command, coverage or resource gate runs.
Pretest, focused ast-grep, lint (33 existing warnings, zero errors), public-tree
typecheck (zero edges/diagnostics), default build, subscription reference build,
platform API check, root/UI neutrality and whitespace checks pass.

After the supervisor staged Phase A and removed the unused native mapper path,
the mapper-move follow-up regenerated the publication catalogue, source-release
contract and navigation through the existing generators. Policy passes with
**7 obligations, 0 unanswered**; inventory passes with **5,340 public paths**.
The follow-up's unstaged prose and generated companions do not require staging
for either check to pass. No Git writes are authorized or performed. Lint passes
with 33 warnings and zero errors; public-tree typecheck passes with zero edges
or diagnostics. The requested four-file focused run passes **1,091 cases**;
neutrality reports zero increases and whitespace checks pass. Package build
outputs are removed. These checks do not replace S1 artifact proof or the
supervisor's committed-candidate review and delivery gates.

### Size, pending work and self-retro

Recomputed last with `--no-renames`, taking the union of each committed diff
and working-tree changes. Against the review base
`32a31f377122994826e0126980ec5444db6095f3`
(`git merge-base HEAD origin/main`), the combined P6/P7 delta has **91 distinct
changed paths**: **33 production/tooling/schema paths**, **24 runtime source
paths** (including the removed mapper), **41 test/helper paths** and
**17 documentation/API-report paths**. These combined figures include P6 and
are not the P7-only runtime budget.

Against P6 `4cab99ad16871e84c273188fedce2cfb53ee9143`, excluding main-only
paths by retaining Phase A's own `4cab99ad..659b167` path set plus Phase B's
working changes, P7 has **38 distinct changed paths**:
**21 production/tooling/schema paths / 35**, **12 runtime source paths / 20**
(including the removed mapper), **4 test/helper paths** and
**13 documentation/API-report paths**. Counting the mapper move once instead
is **37 entries**, **20 production/tooling/schema entries**, and **11 runtime
source files**. The unfiltered P6-to-HEAD diff has **62 paths**, including main
carry-over; it is not P7's own scope. Phase B adds **0 production/tooling/schema
paths**, **0 runtime source paths** and **1 case**, completing **5 P7 cases**;
the programme balance is **5 → 0**. No production file is changed in Phase B.

Final Phase B focused verification: `vitest list` collects **3 / 1 / 1** cases
in the PostgreSQL, composition and reference files; all **5 pass**. The six
focused catalog/inventory package suites pass **31 cases**. Public-tree typecheck
reports **0 unresolved edges / 0 diagnostics**; changed-file ESLint, ast-grep,
policy (**7 obligations / 0 unanswered**), neutrality (**0 increases**) and
`git diff --check` pass. Navigation needs no regeneration: policy validates the
current projections. No broad tests, coverage or resource-gate command runs.

Bundle-3 is closed for the M05 boundary by
`native-mounted-bundle-admin-stock-readback`. The merged inventory entry supplies
`createNewPurchaseStockAvailabilityPort`, `NewPurchaseStockReadPort`,
`NewPurchaseStockRow`, `NewPurchaseStockMode` and
`NewPurchaseStockAvailabilityOptions`. The case assigns the builder result to
catalog's `BundleStockPort` without shape casts, then selects the reference
composition inside the test. The injected stock reader is a port-boundary test
double; the native normalized reader remains M06's PENDING disposition toward
P5a. Neither this case nor its real PostgreSQL catalog/bundle rows proves native
stock. P5 consumer-derived builder/admin rendering and SSR inputs remain for the
slot merge after their source arrives.

Self-retro: early fixture failures identified required document payload/provenance
and the actual native operator allowlist. A packed proof also raced a package
rebuild; subsequent builds and packed verification were serialized. The simpler
path is unchanged store bodies, the existing authorizer/readiness checker and
inert declarations. The mapper-move follow-up confirmed that an unused helper
needs no compatibility copy or extra public API; generating companions after
removing the stale path kept inventory and policy consistent.
Phase B fixture corrections consumed two focused batches (7.35 s and 8.25 s):
use the HTTP slug contract and the existing native gateway timestamp parser;
use a writable temporary npm cache for the packed consumer. Existing parser
configuration avoided a production change or duplicate serialization logic.

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
