# M06 stock, reservations and delivery

## Scope and placement

Development-preview extraction into `@openlup/platform/{inventory,inventory/contracts,shipping,shipping/contracts}`; no new package. Core retains ATP, FEFO and shipping arithmetic. Reference application policy, provider translation and composition retain their owners. C1 identity: adopter commit `4595d4b3d`, nine characterization witnesses, 36 cases; unchanged witnesses remain the comparison source. Extraction does not establish native-store parity or activation.

A stock wait preserves the active subscription, full frozen basket and due/order/cycle/attempt identity. It extends the next cycle later only, never earlier and never stacked. Replacement alignment requires actual arrival; an undelivered replacement remains outstanding and cannot be confirmed as delivered.

## Ledger

C2 started on 2026-10-20 before the whole M05 stack merged, by owner decision; M06 PRs consume only merged M05 contracts. The frozen stack has two independent lanes rooted at main, followed by their join. “None” means no external gate; lane predecessors still apply.

| PR | Content | Predecessor / external gate |
| --- | --- | --- |
| P1a | Inventory DTOs, schemas, ports, registration | Main / none |
| P1b | Admin/native reads and normalized stock projection | P1a / M05 P4a merged |
| P2a | Reservation policy and native reserve/release/expiry | P1b / none |
| P2b | Existing forecast and separate dated calculator | P2a / none |
| P2c | SQL projections, real-store conformance, dormant maintenance/stock wait | P2b / none |
| P3a | Delivery DTOs, ports/evidence, injected-schema handlers | Main / none |
| P3b | Address lookup, ownership/default handlers and row helpers | P3a / none |
| P3c | Flat rate and neutral picker/fields/stock/settings UI | P3b / none |
| P4 | Consolidate reference shims and witness equivalence | Both merged lane tips / none |
| P5a | Inventory composition, store/schema/readiness | P4 / M05 P7 merged |
| P5b | Shipping/address/rate composition and installed consumer | P5a / M05 P7 merged |
| S1 | Existing-set preparation and final artifact proof | P5b / M05 S1 merged |

Rule 1: registration companions are shared append-only surfaces: `config/openlup-publication-catalog.json`, `config/openlup-source-release-contract.json`, `eslint.config.js`, `packages/platform/test/packageBoundary.test.ts`, `scripts/packages/platform-cold-consumer.ts` and its test. Each lane adds only its own entries, never another module's lines or generic controls. Regenerate both JSONs with their generators; reconcile conflicts by merging main through the authorized delivery owner.

Export counts are caps, with one named cross-entry consumer per export; internal helpers and test-only factories remain internal. P1a's cap is 49. Each frozen PR has at most 35 total paths.

Required native outcomes: an explicit supported-operation/refusal matrix for OpenLup stores and real-host proof for adopter-only budget/stock-wait SQL. A necessary forward migration or native address writer returns as a bounded cut before P2c/P5 review. Array calculations and fake executors do not establish durable parity.

Import-time neutralization: the stock-master provider identity is a required injected value; precedent M05 P2c (required injected financial policy). There is no default. Package runtime validation must reject a different identity. Reference browser validators stay local and exact; DTO contracts contain types only. Later reference server bindings inject the exact incumbent validator.

## Inventory lane (P1a–P2c)

P1a adds the inventory entries, explicit DTOs, unchanged schema counterparts and read/mutation ports. Named port/error and DTO compatibility exports retain existing imports; browser validators and the exact reference forecast response type stay local. Stock/reservation response aliases also stay derived locally to preserve the browser compiler profile. The forecast response schema factory substitutes only the required injected provider validator. Fixed wire-byte, substitution/refusal and equality proofs protect that exception.

P1a: 23 total paths, seven production paths; 24 exports against the 49 cap. Four authored cases plus 15 generated package-boundary iterations add 19 root invocations, with no physical test moves. All are collected; focused added test-body time is 12.75 ms (6.31 ms authored, 6.44 ms generated), not an isolated whole-suite wall-time delta or hosted percentile. The affected nine-file root batch passes 1,070 cases; the package-local inventory batch passes two.

Pack main `0594f24` → repaired P1a: 1,016 → 1,031 files (+15); 996 → 1,011 code files (+15); 660,962 → 666,836 packed B (+5,874); 2,951,746 → 2,983,253 unpacked B (+31,507); 571,347 → 576,498 code gzip B (+5,151). Root docs: 36,912 → 37,098 gzip B (+186), five → five files (+0). Inventory contracts: 20/32 browser bytes. No cap or released baseline changes.

P1b moves admin handlers and the native inventory store behind named reference bindings; provider value/validator injection is required, with no default. The normalized new-purchase projection preserves the selected adopter mechanics at commit `23fb9879c029822e8397b0db537750136bacf02f`; its transport, missing-function recognition, availability calculation, defaults and observations remain host inputs. The approved catalog type edge was withdrawn after M05 P4b made catalog an adapter entry. Inventory declares the bundle-stock shapes structurally and remains non-adapter; typecheck catches drift where catalog consumes them in M05 P7’s bundle proof and M06 P5a composition. Read/projection operations do not shift subscription cycles. Native/managed SQL parity remains pending.

P1b changed paths (23 including the approved graph registration): `server/domains/inventory/inventoryHandlers.ts`; `server/adapters/postgres/inventory/adminInventory.ts`; `packages/platform/src/inventory/{inventoryHandlers,adminInventory,newPurchaseStockAvailability,index}.ts`; `packages/platform/src/inventory/contracts/{newPurchaseStock,index}.ts`; `tests/platform/inventory/inventoryOperatorBoundaryCharacterization.test.ts`; `packages/platform/test/inventory/{adminInventoryConformance,inventoryAvailabilityCharacterization,newPurchaseStockBoundary}.test.ts`; `packages/platform/{CHANGELOG.md,release-gates.json}`; `packages/platform/api/{inventory,inventory-contracts}.api.md`; `config/openlup-{publication-catalog,source-release-contract}.json`; `eslint.config.js`; `docs/platform/{README.md,ARCHITECTURE_AND_EXTENSIONS.md}`; this plan; `src/domains/inventory/README.md`.

P1b adds 14 export pairs (cap 14). `./inventory` handler values `createAdminInventory{Stock,Reservations,AtpCheck,SubscriptionForecast,StockAdjustment}Handler` each feed their named reference wrapper; `createPostgresAdminInventoryPort` feeds the native reference wrapper. `NewPurchaseStockRow`, `NewPurchaseStockMode` and `NewPurchaseStockAvailabilityOptions` at both inventory entries feed package characterization/boundary tests; `NewPurchaseStockReadPort` and `createNewPurchaseStockAvailabilityPort` feed the boundary tests and the later P5a host binding. Helpers remain internal.

P1b transplants W1/W9's eight C1 assertions sets with import/binding changes only, separately from six new conformance/boundary cases (inventory lane allocation 36 new). W1 binds normalized fixture rows and fallback observations: it does not import or prove the private transport/SQL. Fixed reference wire bytes, required-provider substitution and normalized source equality are proof obligations. Root collection includes all four new files; package-local collection includes its three new files. The focused root batch passes 17 files/41 cases (81.71 ms test bodies; 24.85 ms in the 14 added cases); the package-local batch passes three files/10 cases. Eight C1-equivalent and six new cases mean 14 added root invocations plus 10 package-local invocations; no original test physically moves. Two focused passes ran after implementation/type-shape stabilization: 28 added root invocations plus 20 package-local invocations in total. These local batch times are not an isolated module delta or hosted percentile.

P1b pack base `d16dd4db` → repaired merged working tree: 1,031 → 1,081 total files (+50), 1,011 → 1,059 code files (+48), 666,836 → 701,330 packed B (+34,494), 2,983,253 → 3,144,165 unpacked B (+160,912), 576,498 → 601,480 code gzip B (+24,982). These deltas include merged main changes. Root docs: 37,098 → 38,408 gzip B (+1,310), five files unchanged; main `47a3f8da` is 38,339 B (+69 B for P1b). Inventory contracts: 20 → 20 browser B (32 B cap). No cap or released baseline changes.

## Shipping lane (P3a–P3c)

Authority: coordinator assignment 2026-10-20 under the recorded M06 start grant and PROC-27 merge grant; supervisor = spare H Claude session; Codex implements. Native review: two fresh full reviews (public contract); supervisor owns committed review and delivery.
Outcome: import delivery DTOs, ports, injected-schema handlers, summary and evidence with unchanged reference behaviour. Exclusions: P3b/P3c work, inventory, vendors, migrations, release and adopter/staging proof.
Acceptance: unchanged 31-path closure (PR diff), 27 consumed export pairs (cap 44), frozen W6, three new cases, unchanged O suites through shims, no inventory import, contracts browser gzip ≤32 B and required gates/package caps.
Smallest adequate alternative: move incumbent bodies and inject existing schemas/responder through named wrappers; no new runtime abstraction. Risks: validation/error/order drift, widened reference types and evidence priority; proof: O/W6/conformance and typecheck.
Ledger: Import-time neutralization (coordinator ruling 2026-10-20): provider/carrier DTO fields are opaque strings in the package; DeliverySelectionSchemas is required; the reference binding injects today's zod schemas unchanged; precedents M05 P2c and M06 P1a.
Exports (27 pairs, one consumer each):

| Subpath | Symbol | Consumer |
| --- | --- | --- |
| `./shipping` | `DeliverySelectionSummaryKind` | `src/domains/shipping/deliverySelectionSummary.ts` |
| `./shipping` | `DeliverySelectionSummary` | `src/domains/shipping/deliverySelectionSummary.ts` |
| `./shipping` | `DeliverySelectionSourceKey` | `src/domains/shipping/readDeliverySelectionEvidence.ts` |
| `./shipping` | `DeliverySelectionSources` | `src/domains/shipping/readDeliverySelectionEvidence.ts` |
| `./shipping` | `DeliverySelectionEvidence` | `src/domains/shipping/readDeliverySelectionEvidence.ts` |
| `./shipping` | `DeliverySelectionPort` | `server/domains/shipping/deliverySelectionPort.ts` |
| `./shipping` | `PickupPointSearchPort` | `server/domains/shipping/pickupPointSearchPort.ts` |
| `./shipping` | `DeliverySelectionSchemas` | `server/domains/shipping/deliverySelectionHandler.ts` |
| `./shipping` | `createDeliveryOptionsHandler` | `server/domains/shipping/deliverySelectionHandler.ts` |
| `./shipping` | `createPickupPointSearchHandler` | `server/domains/shipping/deliverySelectionHandler.ts` |
| `./shipping` | `createPickupPointValidationHandler` | `server/domains/shipping/deliverySelectionHandler.ts` |
| `./shipping` | `DELIVERY_SELECTION_CONTRACT_VERSION` | `packages/platform/test/shipping/deliveryConformance.test.ts` |
| `./shipping` | `PICKUP_POINT_SEARCH_CONTRACT_VERSION` | `packages/platform/test/shipping/deliveryConformance.test.ts` |
| `./shipping` | `summarizeDeliverySelection` | `src/domains/shipping/deliverySelectionSummary.ts` |
| `./shipping` | `resolveDeliverySelectionEvidence` | `src/domains/shipping/readDeliverySelectionEvidence.ts` |
| `./shipping/contracts` | `DeliveryKind` | `packages/platform/test/shipping/deliveryConformance.test.ts` |
| `./shipping/contracts` | `DeliveryProviderKind` | `packages/platform/test/shipping/deliveryConformance.test.ts` |
| `./shipping/contracts` | `DeliveryCarrierKind` | `packages/platform/test/shipping/deliveryConformance.test.ts` |
| `./shipping/contracts` | `DeliveryService` | `packages/platform/test/shipping/deliveryConformance.test.ts` |
| `./shipping/contracts` | `PickupPoint` | `packages/platform/test/shipping/deliveryConformance.test.ts` |
| `./shipping/contracts` | `DeliveryOption` | `packages/platform/test/shipping/deliveryConformance.test.ts` |
| `./shipping/contracts` | `DeliveryOptionsResponse` | `packages/platform/test/shipping/deliveryConformance.test.ts` |
| `./shipping/contracts` | `PickupPointValidationRequest` | `packages/platform/test/shipping/deliveryConformance.test.ts` |
| `./shipping/contracts` | `PickupPointValidationResponse` | `packages/platform/test/shipping/deliveryConformance.test.ts` |
| `./shipping/contracts` | `PickupPointSearchRequest` | `packages/platform/test/shipping/deliveryConformance.test.ts` |
| `./shipping/contracts` | `PickupPointSearchResult` | `packages/platform/test/shipping/deliveryConformance.test.ts` |
| `./shipping/contracts` | `PickupPointSearchResponse` | `packages/platform/test/shipping/deliveryConformance.test.ts` |

Test ledger: shipping-lane budget 14 new cases / 5.3 s (P3a 3, P3b 5, P3c 6). P3a: 3 new + 4 frozen W6 transplants; root case time 11.26 ms (3 new) + 6.90 ms (4 W6); package-local 5.09 ms (3 new); total 23.24 ms across 10 invocations (<1.2 s P3a allowance). Root + package-local: 10 new-file case invocations per full verification pair.
Collection proof: `npx --no -- vitest list --filesOnly --project=node tests/platform/shipping/deliverySelectionBoundaryCharacterization.test.ts packages/platform/test/shipping/deliveryConformance.test.ts packages/platform/test/packageBoundary.test.ts scripts/packages/platform-cold-consumer.test.ts`; package-local: `cd packages/platform && npx --no -- vitest list --filesOnly test/shipping/deliveryConformance.test.ts`.
Reference equivalence: existing `server/domains/shipping/*.test.ts`, `server/bff/shipping/*.test.ts` and `src/domains/shipping/*.test.ts` have empty Git diff and all 88 cases pass through the shims (18 files). Reference schemas and zod-inferred types stay unchanged; W6 stays frozen.
Gates: ast-grep, lint (33 warnings), typecheck, focused 1,138 cases / 22 files, package-local 2,793 / 153, collection, API, size/browser, UI neutrality and diff checks PASS. Whole-tree neutrality PASS: W6's expected country is read from the reference contract schema instead of a repeated literal; the expected value is unchanged. Publication policy deferred until supervisor commit; native review/delivery pending.
Root-doc gzip: baseline 35,868 B; before repair 36,560 B (+692); repaired 36,099 B (+231), five files. Pack 620,658 B; contracts browser gzip 20 B ≤32; all caps pass. Three proposed no-impact trailers in `/private/tmp/m06-doc-impact-trailers.txt` retain their digests, computed read-only from candidate bytes, modes and owners against the merge base; commit needed only to accept trailers.
Self-retro: version assertions folded into the order case fund plant/substitution within three cases; preserving narrowed reference ports closes type drift. A missed npm cache setting repeated the known sandbox refusal; task-local cache resolved it. No new runtime machinery was needed.

Merge reconciliation (2026-10-20, main `34eaffb`): user authorizes working-file conflict resolution and focused coexistence proof only; no Git writes, secrets, network writes, other worktrees, ai-resource-gate or broad tests. Preserve both registrations, regenerate catalogs and keep every non-shipping plan section byte-identical to main. API update/check, ast-grep, lint (33 warnings), typecheck and 1,204 focused tests / 23 files pass; no API snapshot outside shipping changes. Policy/navigation and neutrality refuse the unmerged index, which remains for the supervisor. Pack: 673,322 packed B / 3,014,898 unpacked B / 1,058 files; code 582,076 gzip B / 1,038 files; root docs 37,324 gzip B / five files; inventory and shipping contracts each 20/32 browser B. All measured caps pass. Self-retro: using main as the plan skeleton made preservation directly verifiable; no additional abstraction or repair was needed.

Gates: ast-grep, lint (33 warnings), typecheck, focused 1,138 cases / 22 files, package-local 2,793 / 153, collection, API, size/browser, UI neutrality and diff checks PASS. Whole-tree neutrality PASS. Witness ledger (coordinator acceptance 2026-10-20): W6 reads its expected country from the frozen reference schema to satisfy ui-6 without a baseline raise; the value is unchanged and the adopter C1 witness itself is unchanged. The pattern is never used where a test would compare the code under test against itself. Merged as PR #236 (020e647); reviewed cycles 0 and 1, each with two fresh full reviews.
Root-doc gzip: baseline 35,868 B; before repair 36,560 B (+692); repaired 36,099 B (+231), five files. Pack 620,658 B; contracts browser gzip 20 B ≤32; all caps pass. Three no-impact trailers bind candidate bytes, modes and owners against the review base.

### P3b
Delivery ruling (coordinator, 2026-10-20): P3b and P3c land as ONE combined PR, with 51 paths approved for the combination.
Outcome/authority: unchanged address lookup, own-session address-book handlers and row helpers; same coordinator assignment and grants as P3a, stacked on P3a; two fresh full reviews. Excludes inventory, native writer, migrations, release/adopter/staging proof; acceptance: exact 24 paths, ≤53 consumed exports, frozen W7 and unchanged O suites. Smallest alternative: incumbent body moves plus required host injection, no new writer or runtime layer.
Neutralization ledger: required schemas retain host source/geography/postal/tax policy and conflict identity; canonicalizer/default country explicitly injected, application fallback stays in the reference shim. No shipping→inventory import. W7 uses O's existing checkout contact builder; its country/provider fixture values (inputs that the handlers pass through) are read from the reference contracts for ui-6, with identical values; the adopter C1 witness is unchanged and no absent private fixture is needed.
Open debt (coordinator 2026-10-20): the national-registry address fields (tercCode, simcCode, municipalityTercCode, ulicCode, voivodeshipName) and the locale-specific character fold in canonicalAddressKey are locale/market-pack material; owner M16 (disposition: move behind a host-supplied market pack, with a canonical-key migration plan). Unchanged in M06 by design; no new locale-specific names are added.
| Subpath | Symbol | Consumer |
| --- | --- | --- |
| `./shipping/contracts` | `CanonicalAddressInput` | `addressConformance.test.ts` |
| `./shipping/contracts` | `AddressCanonSource` | `addressConformance.test.ts` |
| `./shipping/contracts` | `AddressCanonLocalityCandidate` | `addressConformance.test.ts` |
| `./shipping/contracts` | `AddressCanonStreet` | `addressConformance.test.ts` |
| `./shipping/contracts` | `AddressCanonPostalCodeLookupRequest` | `addressConformance.test.ts` |
| `./shipping/contracts` | `AddressCanonLocalitiesLookupRequest` | `addressConformance.test.ts` |
| `./shipping/contracts` | `AddressCanonStreetsLookupRequest` | `addressConformance.test.ts` |
| `./shipping/contracts` | `AddressCanonPostalCodeLookupResponse` | `addressConformance.test.ts` |
| `./shipping/contracts` | `AddressCanonLocalitiesLookupResponse` | `addressConformance.test.ts` |
| `./shipping/contracts` | `AddressCanonStreetsLookupResponse` | `addressConformance.test.ts` |
| `./shipping/contracts` | `CustomerAddressKind` | `addressConformance.test.ts` |
| `./shipping/contracts` | `CustomerAddress` | `addressConformance.test.ts` |
| `./shipping/contracts` | `CustomerOrdererProfile` | `addressConformance.test.ts` |
| `./shipping/contracts` | `CustomerAddressesRequest` | `addressConformance.test.ts` |
| `./shipping/contracts` | `CustomerAddressesResponse` | `addressConformance.test.ts` |
| `./shipping/contracts` | `CustomerAddressUpsertRequest` | `addressConformance.test.ts` |
| `./shipping/contracts` | `CustomerAddressDeleteRequest` | `addressConformance.test.ts` |
| `./shipping` | `CanonicalAddressInput` | `src/domains/customers/addressCanonical.ts` |
| `./shipping` | `AddressCanonLookupPort` | `addressConformance.test.ts` |
| `./shipping` | `AddressCanonLookupDeps` | `addressConformance.test.ts` |
| `./shipping` | `CustomerAddressesDeps` | `addressConformance.test.ts` |
| `./shipping` | `CustomerAddressBookPort` | `addressConformance.test.ts` |
| `./shipping` | `CustomerAddressMutationPort` | `addressConformance.test.ts` |
| `./shipping` | `CustomerAddressReadStore` | `addressConformance.test.ts` |
| `./shipping` | `AddressLookupSchemas` | `addressConformance.test.ts` |
| `./shipping` | `CustomerAddressSchemas` | `addressConformance.test.ts` |
| `./shipping` | `createAddressCanonPostalCodeHandler` | `server/domains/address-canon/addressCanonLookupHandler.ts` |
| `./shipping` | `createAddressCanonLocalitiesHandler` | `server/domains/address-canon/addressCanonLookupHandler.ts` |
| `./shipping` | `createAddressCanonStreetsHandler` | `server/domains/address-canon/addressCanonLookupHandler.ts` |
| `./shipping` | `createCustomerAddressesHandler` | `server/domains/customers/customerAddressesHandler.ts` |
| `./shipping` | `canonicalAddressKey` | `src/domains/customers/addressCanonical.ts` |
| `./shipping` | `readAddresses` | `server/domains/customers/customerSelfServiceAddressModels.ts` |
| `./shipping` | `readOrdererProfiles` | `server/domains/customers/customerSelfServiceAddressModels.ts` |
| `./shipping` | `addressUsedByActiveSubscription` | `server/domains/customers/customerSelfServiceAddressModels.ts` |
| `./shipping` | `addressRow` | `server/domains/customers/customerSelfServiceAddressModels.ts` |
| `./shipping` | `findCanonicalAddressId` | `server/domains/customers/customerSelfServiceAddressModels.ts` |
| `./shipping` | `clearDefaultAddress` | `server/domains/customers/customerSelfServiceAddressModels.ts` |
Test ledger: 5 new root 25.83 ms + package-local 7.33 ms; 3 frozen W7 6.08 ms, 39.24 ms total (<1.8 s allocation); lane budget 14/5.3 s. Focused 1,549/103 files and package-local 2,935/161 PASS. Consumer shorthand = `packages/platform/test/shipping/addressConformance.test.ts`.
Collection proof: `vitest list --filesOnly --project=node` selects both new paths; package-local `vitest list --filesOnly test/shipping/addressConformance.test.ts` selects that path. Lint (33 warnings), typecheck, API, size, both neutrality checks (0 increases), collection and diff PASS; policy PASS against the P3a stack base. Root-doc gzip 37,153→37,196 B (+43), pack 676,402 B; browser 20≤32 B. Four scoped no-impact records answer the owner obligations in the commit.
Self-retro: repeated frozen literals → read the same values from reference contracts; this preserved W7 byte-equivalent fixtures/assertions without baseline changes. Existing ports plus injected canonicalizer avoid a new writer; reference dependency interfaces retain their original narrowed types. No incumbent behaviour delta.

### P3c
Delivery ruling (coordinator, 2026-10-20): P3b and P3c land as ONE combined PR, with 51 paths approved for the combination.
Outcome: unchanged O flat-rate handler body behind required injection; selected V dictionary restore/selection, manual address and list-first pickup mechanics in reference src. O card bodies retained; catalog availability import stays outside inventory.
Authority/delivery: user assignment on P3b 164f02b; local edits/checks only, no Git writes or network writes. Supervisor retains committed review/delivery; no new grant. M05 BundleStockCard unchanged on local origin/main since 46e9c22.
Excludes private configurator, account prefill, map/geolocation loaders, transports, policy editor, new busy handling, migrations and activation. Acceptance: exact 27 paths, 10 consumed exports, 6 new + 4 frozen W8 cases, focused gates and neutrality without baseline increases.
Smallest alternative/risk: move the incumbent body with structural picks and injected schemas/resolver/responder; select only useful UI mechanics. Proof targets validation/refusal/audit order, fresh evidence, fallback and server-owned unknown stock.
Neutralization ledger: required ShippingRateHandlerSchemas has no default; DTOs carry no market policy. W8 reads identical country/provider fixture values from reference contracts after ratchet refusal; expectations remain frozen and never compare output with itself. Search uses the existing free-text request contract instead of a country-specific locator classifier.
| Subpath | Symbol | Consumer |
| --- | --- | --- |
| `./shipping` | `createAdminShippingRateHandler` | `server/domains/commerce/adminShippingRateHandler.ts` |
| `./shipping` | `AdminShippingRateHandlerDeps` | `server/domains/commerce/adminShippingRateHandler.ts` |
| `./shipping` | `ShippingRateDataPort` | `server/domains/commerce/adminShippingRateHandler.ts` |
| `./shipping` | `ShippingRateHandlerSchemas` | `server/domains/commerce/adminShippingRateHandler.ts` |
| `./shipping` | `AdminShippingRateResponse` | `shippingRateConformance.test.ts` |
| `./shipping` | `AdminSetShippingRateRequest` | `shippingRateConformance.test.ts` |
| `./shipping` | `AdminSetShippingRateResponse` | `shippingRateConformance.test.ts` |
| `./shipping/contracts` | `AdminShippingRateResponse` | `src/components/admin/ShippingRateCard.tsx` |
| `./shipping/contracts` | `AdminSetShippingRateRequest` | `src/components/admin/ShippingRateCard.tsx` |
| `./shipping/contracts` | `AdminSetShippingRateResponse` | `src/components/admin/ShippingRateCard.tsx` |
Test ledger: root 3 conformance 6.90 ms + DeliveryMethodCard 71.68 ms + PickupPointPicker 1123.14 ms + BundleStockCard 17.78 ms = 6 new / 1219.50 ms; W8 4 / 220.09 ms. Package-local new 3 / 3.26 ms; P3c new-case invocation time 1222.76 ms <2.3 s. Lane = 14 new (3+5+6), unchanged. Focused root 87/18 files, 5.92 s wall; package-local shipping 11/3 files, 0.448 s wall, all PASS.
Collection: root `vitest list --filesOnly --project=dom` names all four new TSX tests; root `--project=node` and package-local node each name `shippingRateConformance.test.ts`. No runner/config change; no full/scoped/required-package/resource gate ran. No pre-existing ShippingRateCard suite exists in this checkout.
Evidence: ast-grep, lint (33 warnings), typecheck (zero edges/errors), focused tests, API update/check, size/browser, both neutrality checks (0 increases), collection and diff checks PASS. Root docs 37,196→37,241 gzip B (+45), pack 678,465 B / 3,043,437 unpacked B / 1,073 files; code 586,208 gzip B / 1,053 files; shipping contracts 20≤32 B. No caps/baselines raised.
Policy/navigation: `--policy --docs-update` regenerated identical navigation, then refused unindexed new files under the Git-write prohibition. Direct candidate impact against 164f02b reports architecture updated and domain-commerce/domain-shipping/platform-substrate trailers outstanding; supervisor must stage/commit and rerun policy. Exact closure and unchanged-body comparisons are recorded in the handoff.
Self-retro: strict package availability DTOs broke the existing caller's inferred optionality → retain the incumbent reference catalog schema import. Two new response assertions assumed metadata absent from the incumbent → assert the actual frozen flat-rate envelope. Both repairs stayed inside the closure; private dependencies needed no new runtime abstraction.

Merge reconciliation (2026-10-20, main `32a31f3`): working-file resolution and focused proof only; no Git writes, secrets, network writes, other worktrees, ai-resource-gate or broad tests. Main's non-shipping sections and changelog text remain verbatim; both catalogs are regenerated, all 24 entries survive without duplicates, and no shipping→inventory import exists in package or UI. API update/check has zero snapshot changes, including outside shipping. Ast-grep, lint (33 warnings), typecheck (zero unresolved edges/errors), focused node 1,447/67 files, DOM 7/4 files, package-local shipping 11/3 files, UI neutrality and diff checks pass. Absent ShippingRateCard test skipped. Policy/navigation and whole-tree neutrality refuse the unmerged index, left untouched for the supervisor. Pack: 712,166 packed B / 3,204,212 unpacked B / 1,111 files; code 610,907 gzip B / 1,089 files; root docs 38,493 gzip B / five files. All caps pass; shipping and inventory contracts each 20/32 browser gzip B. Untracked build directories removed after measurement.
Self-retro: missing Core declarations caused the first API update to fail → use lint's existing prerequisite builds before retrying; no source repair or new mechanism was needed. Main's plan skeleton plus only changed shipping lines made both-side preservation directly checkable.

## Composition and set (P4–S1)

P4 joins both lanes and preserves the frozen witness equivalence. P5a/P5b remain serial because they share reference composition. Installed consumer, selected-store/schema/readiness and final set artifact proof belong to these cuts. S1 retains the previously released baseline and explains growth above 30%; no version or publication is implied by the extraction.

## Parity (PENDING rows)

All eight rows remain PENDING; none is claimed. Each requires its stated disposition before S1.

| Outcome | Disposition PR |
| --- | --- |
| Managed/direct ATP, lots, expiry, safety, forecast, supply; direct adjustment refusal; expired/stale projection differences | P2c → P5a |
| Reserve/batch/release/consume, paid pin/reacquire, cancel/full refund, invalidate/recount; replay/conservation, rollback/ACL/freshness/locks/concurrency/55P03 | P2c → P5a |
| Fresh full chain/exact-prefix upgrade, ledger/object inventory, installed projection identity; no invented durable in-memory parity | P2c → P5a |
| Adopter listing/BOM/renewal priority/own credit and stock-wait/preflight; missing/different managed routines | P1b/P2c → P5a |
| Dormant manual POST/auth/flag/manual_admin lease without schedule versus automatic expiry; TTL/staging flag-control discrepancies report-only | P2c → P5a |
| Empty dictionary 502, withdrawn-selection legacy fallback, static/dictionary/canonical point and fresh-selection equivalence | P3a/P3c → P5b |
| Address ownership/default/mutation, frozen destination and ACL; absent native writer; offline versus no-match/manual save | P3b → P5b |
| Flat-rate read/save/audit/refusal and useful stock/settings/picker/manual/address UI through selected real stores | P3c → P5a/P5b |

## Budgets

Static allocation: inventory 36 new cases / 14.7 s; shipping 14 / 5.3 s; P4–S1 nine / 5.7 s. Total: 59 new + 36 C1 = 95/100, leaving five cases; 25.7 s public + 3.0 s C1 allowance = 28.7/30 s. Equivalent witness transplants still count as actual public invocations/runtime. Estimates do not establish hosted median/p90.

Package caps: 2,100 files / 2,000 code files; 1,351,680 packed B / 5,734,400 unpacked B / 1,126,400 code gzip B. Root docs remain capped at 40,960 gzip B / 10 files; the combined M05/M06 estimate leaves about 454 B, requiring actual measurements and compact root prose. Stop on a measured excess. Inventory contracts use a 32 B browser minified+gzip budget; DTO-only output must be measured with the existing browser-entry tool.
