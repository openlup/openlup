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

P1b moves admin handlers and the native inventory store behind named reference bindings; provider value/validator injection is required, with no default. The normalized new-purchase projection preserves the selected adopter mechanics at commit `23fb9879c029822e8397b0db537750136bacf02f`; its transport, missing-function recognition, availability calculation, defaults and observations remain host inputs. Catalog types enter only through the relative [catalog public entry](../../../packages/platform/src/catalog/index.ts); catalog has no reverse inventory edge. Read/projection operations do not shift subscription cycles. Native/managed SQL parity remains pending.

P1b changed paths (23 including the approved graph registration): `server/domains/inventory/inventoryHandlers.ts`; `server/adapters/postgres/inventory/adminInventory.ts`; `packages/platform/src/inventory/{inventoryHandlers,adminInventory,newPurchaseStockAvailability,index}.ts`; `packages/platform/src/inventory/contracts/{newPurchaseStock,index}.ts`; `tests/platform/inventory/inventoryOperatorBoundaryCharacterization.test.ts`; `packages/platform/test/inventory/{adminInventoryConformance,inventoryAvailabilityCharacterization,newPurchaseStockBoundary}.test.ts`; `packages/platform/{CHANGELOG.md,release-gates.json}`; `packages/platform/api/{inventory,inventory-contracts}.api.md`; `config/openlup-{publication-catalog,source-release-contract}.json`; `eslint.config.js`; `docs/platform/{README.md,ARCHITECTURE_AND_EXTENSIONS.md}`; this plan; `src/domains/inventory/README.md`.

P1b adds 14 export pairs (cap 14). `./inventory` handler values `createAdminInventory{Stock,Reservations,AtpCheck,SubscriptionForecast,StockAdjustment}Handler` each feed their named reference wrapper; `createPostgresAdminInventoryPort` feeds the native reference wrapper. `NewPurchaseStockRow`, `NewPurchaseStockMode` and `NewPurchaseStockAvailabilityOptions` at both inventory entries feed package characterization/boundary tests; `NewPurchaseStockReadPort` and `createNewPurchaseStockAvailabilityPort` feed the boundary tests and the later P5a host binding. Helpers remain internal.

P1b transplants W1/W9's eight C1 assertions sets with import/binding changes only, separately from six new conformance/boundary cases (inventory lane allocation 36 new). W1 binds normalized fixture rows and fallback observations: it does not import or prove the private transport/SQL. Fixed reference wire bytes, required-provider substitution and normalized source equality are proof obligations. Root collection includes all four new files; package-local collection includes its three new files. The focused root batch passes 17 files/41 cases (81.71 ms test bodies; 24.85 ms in the 14 added cases); the package-local batch passes three files/10 cases. Eight C1-equivalent and six new cases mean 14 added root invocations plus 10 package-local invocations; no original test physically moves. Two focused passes ran after implementation/type-shape stabilization: 28 added root invocations plus 20 package-local invocations in total. These local batch times are not an isolated module delta or hosted percentile.

P1b pack base `d16dd4db` → working tree: 1,031 → 1,043 total files (+12), 1,011 → 1,023 code files (+12), 666,836 → 678,623 packed B (+11,787), 2,983,253 → 3,040,979 unpacked B (+57,726), 576,498 → 587,036 code gzip B (+10,538). Root docs: 37,098 → 37,170 gzip B (+72), five files unchanged. Inventory contracts: 20 → 20 browser B (32 B cap). No cap or released baseline changes.

P2a extracts byte-identical reservation policy and native renewal reserve/release/expiry bodies. The reference policy retains local runtime values and forwards only DTO types, so a browser import cannot reach the inventory server entry. The native reference path keeps its named factory export; subscription writers and all cycle/anchor/due/attempt logic stay incumbent. No vendor literal, SQL, dependency or graph edge is added. OpenLup lacks the adopter admission try-gate/stock-budget SQL; W2's `55P03` / `inventory_admission_busy` fixture maps to the existing managed persistence error without fallback. The adopter explicitly refuses legacy schema fallback for every `55P03`; OpenLup retains its message-based matcher, which can still match missing-function/schema-cache text on that code. That difference is preserved, not repaired. The native adapter propagates database errors unchanged. W2 does not establish the private busy protocol or native parity; those remain P2c/P5a obligations.

P2a paths (18): `src/domains/commerce/reservationPolicy.ts`; `server/adapters/postgres/inventory/renewalReservation.ts`; `packages/platform/src/inventory/{reservationPolicy,renewalReservation,index}.ts`; `packages/platform/src/inventory/contracts/{reservation,index}.ts`; `tests/platform/inventory/inventoryReservationLifecycleCharacterization.test.ts`; `packages/platform/test/inventory/reservationPolicyConformance.test.ts`; `packages/platform/{CHANGELOG.md,release-gates.json}`; `packages/platform/api/{inventory,inventory-contracts}.api.md`; `config/openlup-{publication-catalog,source-release-contract}.json`; `docs/platform/{README.md,ARCHITECTURE_AND_EXTENSIONS.md}`; this plan. Seven production paths; no physical test move.

P2a adds 10 export pairs (cap 13). At `./inventory`, `MIN_CHECKOUT_RESERVATION_TTL_MINUTES`, `MAX_CHECKOUT_RESERVATION_TTL_MINUTES`, `DEFAULT_CHECKOUT_RESERVATION_TTL_MINUTES`, `reservationPolicyFor`, `normalizedTtlMinutes` and `AutomaticRenewalInventoryPort` feed the package conformance test; `createPostgresRenewalReservationPort` feeds the named native reference shim. At `./inventory/contracts`, `ReservationPolicyInput` and `ReservationPolicy` feed the reference policy's named type exports; `AutomaticRenewalReservationResult` feeds package conformance. Unconsumed duplicate type exports are omitted.

P2a transplants W2's four expanded C1 cases from adopter commit `4595d4b3d`; assertion statements remain byte-identical. Imports and neutral provider/flow fixture bindings are the only substitutions. Four new package cases cover TTL edges, native reserve statuses/replay, release/expiry defaults and malformed/database refusals. Root node collection includes both new files; package-local collection includes the conformance file. Focused root execution passes 11 files/47 cases, including all eight added cases (10.997 ms test bodies: W2 6.268 ms, new conformance 4.729 ms). Package-local conformance passes four cases (4.779 ms). These are eight added root invocations plus four package-local invocations, with no physical test move; one local sample is not an isolated module wall-time delta or hosted percentile.

P2a own pack base `df2ed118` → working tree: 1,043 → 1,052 total files (+9), 1,023 → 1,032 code files (+9), 678,623 → 681,717 packed B (+3,094), 3,040,979 → 3,052,944 unpacked B (+11,965), 587,036 → 589,257 code gzip B (+2,221). Root docs: 37,170 → 37,221 gzip B (+51), five files unchanged; 3,739 B headroom under 40,960 B. Inventory contracts: 20 → 20 browser B (32 B cap). No cap or released baseline changes.

P2b preserves OpenLup's subscription forecast and shortage bodies, with only the approved ruling A provider injection: required identity plus P1a's injected exact-validator response factory, no default. The reference path retains named compatibility exports and binds the existing exact provider. The separate dated calculator is imported unchanged from adopter commit `553935e847761b6f2c26e576c783663aa0ebce5c`; its structural inputs remain caller-validated and do not replace OpenLup's strict forecast. This import-time neutralization follows the recorded M05 P2c precedent. No graph edge, dependency, SQL, timing, cycle/anchor/due/attempt write or activation changes. No browser runtime imports use the forecast reference path; contracts stay DTO-only. W5 preserves managed dated supply and expired hard reservations versus direct stale sellable stock, nullable coverage and absent supply; no store parity is claimed.

P2b paths (17): `src/domains/inventory/{forecast.ts,README.md}`; `packages/platform/src/inventory/{forecast,subscriptionForecastCalculation,index}.ts`; `packages/platform/src/inventory/contracts/{forecast,index}.ts`; `tests/platform/inventory/inventoryForecastReadbackCharacterization.test.ts`; `packages/platform/test/inventory/subscriptionForecastCalculation.test.ts`; `packages/platform/{CHANGELOG.md,release-gates.json}`; `packages/platform/api/{inventory,inventory-contracts}.api.md`; `config/openlup-{publication-catalog,source-release-contract}.json`; `docs/platform/README.md`; this plan. Six production paths. Registration companions append only own evidence/paths through the repository generators.

P2b adds 10 export pairs (cap 24). At `./inventory`, `forecastSubscriptionInventoryShortages` and `buildSubscriptionInventoryForecast` feed the named reference shim; `calculateSubscriptionForecastSkus` and `calculateSubscriptionForecastTotals` feed package conformance and the later adopter swap-in. At `./inventory/contracts`, `InventoryProviderStockLine` and `InventoryHardReservationLine` feed the reference named type exports; `SubscriptionForecastCalculationInput`, `SubscriptionForecastCounts`, `SubscriptionForecastSku` and `SubscriptionForecastTotals` feed package conformance. Other structural declarations remain internal; no duplicate server type exports are added.

P2b transplants W5's four expanded cases from C1 `4595d4b3d`, with assertion statements byte-identical and imports/provider fixture binding only. Four new cases cover same-date supply ordering, horizon/protection and SKU ordering, stale/missing and safety/clamp behavior, caller validation/fractional rounding/default faults/count-getter ordering, and strict OpenLup provider/schema/shortage refusals. Root node collection includes both new files; package-local collection includes the calculator test. Final focused root execution passes eight files/28 cases, including all eight added cases (20.639 ms test bodies: W5 8.129 ms, new cases 12.510 ms). Package-local execution passes four cases (11.409 ms). Across the two focused passes after implementation, the new files ran 16 root invocations plus eight package-local invocations. No original case physically moves; this local sample is not an isolated module wall-time delta or hosted percentile.

P2b own pack base `f7de0137` → working tree: 1,052 → 1,061 total files (+9), 1,032 → 1,041 code files (+9), 681,717 → 690,429 packed B (+8,712), 3,052,944 → 3,092,551 unpacked B (+39,607), 589,257 → 595,923 code gzip B (+6,666). Root docs: 37,221 → 37,287 gzip B (+66), five files unchanged; 3,673 B headroom under 40,960 B. Inventory contracts: 20 → 20 browser B (32 B cap). One platform-index line changes. No cap or released baseline changes.

## Shipping lane (P3a–P3c)

Recorded by the shipping lane PRs.

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
