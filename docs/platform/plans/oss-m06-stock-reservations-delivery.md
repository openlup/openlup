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

P2c adds sparse `INVENTORY_MIGRATIONS` (one export, cap one), consumed by `tests/postgres/inventoryNative.test.ts`. The two SQL assets project canonical positions 27/33 byte-for-byte; no canonical migration, manifest, graph edge, activation or production timing change. Install the full catalogue, never just these projections. Native invoker rights and managed service-role/lot semantics remain distinct.

P2c paths (19 after repair closure reduction): `packages/platform/src/inventory/{sql,index}.ts`; `packages/platform/sql/{20260814000000_fulfillment_stock_evidence,20260815120000_automatic_subscription_renewal}.sql`; `tests/postgres/inventoryNative.test.ts`; `tests/platform/inventory/{reservationMaintenanceCharacterization,subscriptionStockContinuityCharacterization,reservationMaintenanceConformance,stockWaitConformance}.test.ts`; `packages/platform/{CHANGELOG.md,README.md,release-gates.json}`; `packages/platform/api/inventory.api.md`; `config/openlup-{publication-catalog,source-release-contract}.json`; `docs/platform/{README.md,DATA_AND_MIGRATIONS.md}`; this plan; `src/domains/inventory/README.md`. Two production paths; append-only evidence registration.

P2c W3 (four) binds incumbent manual/automatic routes; W4 (five expanded boundary transcripts) binds the incumbent charge routine to finite admission fixtures. All C1 assertion statements from `4595d4b3d` remain byte-identical, with imports, host-owned currency/provider fixture bindings and authored finite transcript helpers (neutrally named `createAdmissionTranscriptStore` / `createAdmissionTranscriptPorts`). The helpers supply captured admission results, not the private selection/recovery/stock-wait SQL; a transcript cannot establish its durable effects. Of eighteen allocated P2c outcomes, fourteen remain new Vitest cases (eight native real-PG, three maintenance, three preflight refusals); four managed real-host outcomes reuse pgTAP. Execution, collection and P2c-only pack delta against `b4fe7ed2` are recorded below. The duplicate `inventoryManaged.test.ts` harness is removed as a closure reduction; its four outcomes bind to the existing raw diagnostic pgTAP job instead of adding a second managed runner.

P2c collection after repair: five new root-node files, no package-local additions (they bind reference routes/stores). W3 four + W4 five transplants and 14 new Vitest cases (eight real native PostgreSQL, three maintenance, three preflight refusals) remain the focused execution set. Four allocated managed outcomes now reuse existing pgTAP assertions rather than adding test invocations. The local `node scripts/public-ci-pgtap.mjs` run with supplied CLI `2.98.2` and direct `ai-resource-gate run --wait openlup:coverage:m06-p2c` passed all 210 shipped files / 4,700 assertions, including the four mapped files below (55 existing assertions). No CLI was installed or changed. Historical development evidence remains: 76 executions of the original six files (66 passed, ten repaired fixture/setup failures), four CLI-mismatch self-skips, and the 76-case reference batch PASS. The subsequent pinned-CLI duplicate harness failed in startup (10 s hook timeout, then withheld Docker-stage error); removing that duplicate does not remove the raw diagnostic pgTAP proof. No test physically moves.

P2c repair focused execution: all 23 Vitest cases PASS (14 new + nine transplants), zero skipped; the four reused managed outcomes PASS in the existing pgTAP files, so none of those four remains PENDING. Full lifecycle/anchor and broader parity claims below remain PENDING. Fresh serial native before/after samples at candidate `51c7a0c4` plus local repairs: 10,986.857 → 7,059.224 ms test body sums (historical sample 11,493.341 ms), eight/eight cases in each run. The prefix inventory probe now rolls back its transaction before the real prefix install/upgrade on the same disposable cluster, reducing three boots to two. The full-install cluster stays separate because immutable cluster-global roles forbid pre-existing identities. The expiry case uses its own earlier time window, so unrelated held rows cannot affect its 0/1/0 counts in any case order. Commands were direct resource-gated focused Vitest runs on this local Docker host, default workers, no coverage; 7.06 s is below the 9.0 s forecast, not a hosted median/p90 or an isolated module gate. Aggregate module measurement/disposition remains P5a/S1; no budget increase is claimed.

P2c own pack base `b4fe7ed2` → working tree: 1,061 → 1,066 total files (+5), 1,041 → 1,044 code files (+3), 690,429 → 701,095 packed B (+10,666), 3,092,551 → 3,156,878 unpacked B (+64,327), 595,923 → 596,983 code gzip B (+1,060). Root docs: 37,287 → 37,467 gzip B (+180), five files unchanged; 3,493 B headroom under 40,960 B. Inventory contracts: 20 → 20 browser B (32 B cap). No cap or released baseline changes.

P2c repair authority: local edits and bounded serial checks only, in the assigned worktree at `51c7a0c4`, pinned to predecessor `b4fe7ed2a5cdfda9b6bfca70b0247aa6b34b9898`. No Git writes, installation, external submission, merge or release; the author commits. Acceptance is the six requested repairs and focused evidence, with unresolved full effects explicitly PENDING; closure may only shrink. No optional advisory repairs. Repair retro: reuse the existing raw diagnostic managed runner rather than duplicate setup; transactional rollback removes one redundant native boot while preserving role isolation. The official policy command cannot read an unstaged tracked deletion, so the author must stage the removal and rerun it after adding the computed repair trailer. Materialized catalogue/navigation diagnostics pass without changing the index.

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
Gates: ast-grep, lint (33 warnings), typecheck, focused 1,138 cases / 22 files, package-local 2,793 / 153, collection, API, size/browser, UI neutrality and diff checks PASS. Whole-tree neutrality PASS: W6's expected country is read from the reference contract schema instead of a repeated literal; the expected value is unchanged. Historical pre-merge policy/review deferral; superseded by the PR #236 landing recorded below.
Root-doc gzip: baseline 35,868 B; before repair 36,560 B (+692); repaired 36,099 B (+231), five files. Pack 620,658 B; contracts browser gzip 20 B ≤32; all caps pass. Three proposed no-impact trailers were recorded in the P3a handoff, computed read-only from candidate bytes, modes and owners against its merge base; the later landing record supersedes their pending status.
Self-retro: version assertions folded into the order case fund plant/substitution within three cases; preserving narrowed reference ports closes type drift. A missed npm cache setting repeated the known sandbox refusal; task-local cache resolved it. No new runtime machinery was needed.

Merge reconciliation (2026-10-20, main `34eaffb`): user authorizes working-file conflict resolution and focused coexistence proof only; no Git writes, secrets, network writes, other worktrees, ai-resource-gate or broad tests. Preserve both registrations, regenerate catalogs and keep every non-shipping plan section byte-identical to main. API update/check, ast-grep, lint (33 warnings), typecheck and 1,204 focused tests / 23 files pass; no API snapshot outside shipping changes. Policy/navigation and neutrality refuse the unmerged index, which remains for the supervisor. Pack: 673,322 packed B / 3,014,898 unpacked B / 1,058 files; code 582,076 gzip B / 1,038 files; root docs 37,324 gzip B / five files; inventory and shipping contracts each 20/32 browser B. All measured caps pass. Self-retro: using main as the plan skeleton made preservation directly verifiable; no additional abstraction or repair was needed.

Gates: ast-grep, lint (33 warnings), typecheck, focused 1,138 cases / 22 files, package-local 2,793 / 153, collection, API, size/browser, UI neutrality and diff checks PASS. Whole-tree neutrality PASS. Witness ledger (coordinator acceptance 2026-10-20): W6 reads its expected country from the frozen reference schema to satisfy ui-6 without a baseline raise; the value is unchanged and the adopter C1 witness itself is unchanged. The pattern is never used where a test would compare the code under test against itself. Merged as PR #236 (020e647); reviewed cycles 0 and 1, each with two fresh full reviews.
Root-doc gzip: baseline 35,868 B; before repair 36,560 B (+692); repaired 36,099 B (+231), five files. Pack 620,658 B; contracts browser gzip 20 B ≤32; all caps pass. Three no-impact trailers bind candidate bytes, modes and owners against the review base.

### P3b
Delivery ruling (coordinator, 2026-10-20): P3b and P3c land as ONE combined PR, with 51 paths approved for the combination.
Outcome/authority: unchanged address lookup, own-session address-book handlers and row helpers; same coordinator assignment and grants as P3a, stacked on P3a; two fresh full reviews. Excludes inventory, native writer, migrations, release/adopter/staging proof; acceptance: exact 24 paths, ≤53 consumed exports, frozen W7 and unchanged O suites. Smallest alternative: incumbent body moves plus required host injection, no new writer or runtime layer.
Neutralization ledger: required schemas retain host source/geography/postal/tax policy and conflict identity; canonicalizer/default country explicitly injected, application fallback stays in the reference shim. No shipping→inventory import. W7 uses O's existing checkout contact builder; its country/provider fixture values (inputs that the handlers pass through) are read from the reference contracts for ui-6, with identical values; the adopter C1 witness is unchanged and no absent private fixture is needed.
Open debt (coordinator 2026-10-20): the national-registry address fields (tercCode, simcCode, municipalityTercCode, ulicCode, voivodeshipName) and the locale-specific character fold in canonicalAddressKey are locale/market-pack material; owner M16 (disposition: move behind a host-supplied market pack, with a canonical-key migration plan). Unchanged in M06 by design; no new locale-specific names are added. Reference shipping UI copy is specific to the reference app's locale; moves behind a locale pack in M16.
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

### P4

Outcome/authority (2026-10-21): fixes-only join at main `b47f5f3b`; no behavior change, new cases, Git writes, submission or release. Sixteen approved paths: `src/domains/inventory/ports.ts`; `src/domains/shipping/deliverySelectionSummary.ts`; `server/domains/shipping/deliverySelectionPort.ts`; `server/domains/address-canon/ports.ts`; `packages/platform/release-gates.json`; `config/openlup-publication-catalog.json`; `config/openlup-source-release-contract.json`; `docs/platform/README.md`; this plan; `docs/platform/ARCHITECTURE_AND_EXTENSIONS.md`; a platform changelog fragment (replaces the CHANGELOG slot under #243); `packages/platform/test/inventory/inventoryAvailabilityCharacterization.test.ts`; `packages/platform/README.md`; `src/domains/inventory/README.md`; `packages/platform/src/inventory/contracts/{forecast,reservation}.ts`.

Shim disposition: all four already contain explicit named exports/bindings without duplicated implementation; unchanged. The server delivery port intentionally narrows the package port to the reference validators; address lookup forwards the existing reference named type. No star export, name removal or abstraction. Frozen C1 witnesses stay unchanged. Remove seven root-test paths from inventory package smoke evidence; shipping evidence is already package-owned. Neutralize only W1's synthetic transport vocabulary through a local dictionary, preserving assertion statements apart from dictionary references and all four cases. Complete the compact inventory surface row, remove the domain double blank, narrow retry-maintenance wording to subscription/retry-cycle state proved by pgTAP, and trim only the two DTO files' trailing blank. Keep main's CHANGELOG/source-release contract and publication catalog; the validated fragment is catalog-exempt.

Recorded debt (not fixed): OpenLup forecast and adopter calculator duplicate coverage simulation but are different subjects; consolidation risks behavior. Existing `expectTypeOf` assertions are inert until a separate tsconfig change compiles them. Reference/server TTL policy copies exist by design for browser safety.

Shipping carry-overs: remove P3a's machine-local evidence coordinate and qualify its stale pending status as historical; retain the chronological measurements and later landing evidence. M16 owns the reference UI locale copy and registry fields/canonical-key fold recorded under P3b. Noted-not-fixed outside this closure: packageBoundary shipping-loop blank; address conformance strict union/intersection type error; local shipping-rate authorization union; dual-entry DTO exports/optional country shape; shipping README hook list. W6's synthetic dictionary adaptation, country expectation sourced from the reference schema, test-only consumers and additive registration order remain disclosed, unchanged. Main's CHANGELOG grouping/loose-list nits and duplicate historical P3a gate rows remain unchanged under this task's main-byte/history constraints. No parity, activation or new acceptance claim.

P4 joins both lanes and preserves the frozen witness equivalence. P5a/P5b remain serial because they share reference composition. Installed consumer, selected-store/schema/readiness and final set artifact proof belong to these cuts. S1 retains the previously released baseline and explains growth above 30%; no version or publication is implied by the extraction.

### P5a

Outcome/authority (2026-10-21): inventory composition on reviewed P4 head `3edc3708`, containing main `d9976243`. Frozen 20 paths plus three approved proof paths; #243 substitutes one changelog fragment for CHANGELOG and preserves main's source-release snapshot. Local content and focused serial verification only; no Git writes, other worktrees, secrets, submission, merge or release. Supervisor retains committed native review and delivery. Four public additions, no module/export expansion, writer/admission change, stock reader SQL or activation.

Smallest adequate alternative: use the existing native store and normalized projection with an injected managed factory and one structural contribution. The inventory module keeps no catalog declaration edge; the reference assignment to catalog's stock port catches drift. No other module's graph changes. Bindings select exactly one executor/store, reject missing/incompatible stores and mismatched provider identities, and validate forecast responses against the injected exact provider schema. The reference injects its existing literal/schema. Native adjustment remains refused. Native new-purchase reads are unsupported even if a reader is supplied: `inventory_native_new_purchase_stock_read_unsupported`. Requiring that capability leaves a missing port in Core readiness; absence never becomes an empty stock answer. The opt-in reference joins the normalized projection to merged catalog bundle availability and registers nothing on import.

| Entry | Added symbol | Cross-entry consumer |
| --- | --- | --- |
| `./inventory` | `createInventoryBindings` | `server/runtime/public-reference/m06InventoryBinding.ts` |
| `./inventory` | `InventoryBindingDependencies` | same reference input |
| `./inventory` | `InventoryBindings` | same reference selected result |
| `./composition` | `createInventoryContribution` | installed `inventoryConsumer.test.ts` and reference binding |

Proof plan: reuse the seven existing inventory replay/lot/recount/retry/preflight/cancellation/lease pgTAP files. The read addition targets local FEFO/expired-lot/safety and actual adjustment/listing authority; the lifecycle addition targets actual consume replay and full payment-control refund without consumed-stock resurrection. These do not duplicate existing batch rollback, paid pin/reacquire or cancellation assertions. Native role proof extends the existing case with successful explicitly granted reserve/replay/release, alongside denial; installed proof loads the tarball outside the workspace and reads an actual native store and ledger. The normalized reader fixture proves the composition seam only, never production native or managed stock SQL.

Execution/budgets: focused pgTAP PASS with pinned CLI 2.98.2 through the named resource gate: nine files / 102 assertions, including 22 new assertions in two files; pg_prove reports 0 wallclock s / 0.06 CPU s (installation/cleanup excluded). The first gate invocation admitted but received no child stdin and executed no proof; the corrected direct invocation passed. Final Vitest/artifact measurements follow below. No unexecuted claim is proved. Hosted median/p90 and complete managed upgrade/ledger/host-adapter forecast remain named gates, not inferred from primitive SQL assertions. New semantic Vitest forecast four; generated boundary invocations and SQL assertions are reported separately.

### P5b — shipping composition and final consumer

Coordinator delivery decision: P5a and P5b land as one combined PR to save a merge slot; the serial cuts below retain their original implementation and evidence boundaries.

Coordinator continuation: two generated API companions (pricing/promotions) extend the closure to 22/35 paths. As in the M05 P1 identity-snapshot precedent, they preserve every enum member and type, changing order only; the scratch proof compares exact changed blocks and member multisets. No other module source changes. Native flat-rate composition refuses required readiness with shipping_native_flat_rate_save_unsupported; fixture save/audit/UI conformance is not native save support.

Finite outcome: select shipping sources, injected address validation/store and the incumbent flat-rate handler; expose four consumed exports and an inert reference factory. P5b stacks on P5a `ccf2fbd8`. Authority is the frozen 19 paths plus one proof-only SQL path and two mechanical API companions (22/35; fragment replaces CHANGELOG); content edits and focused serial checks only. No Git writes, other worktrees, secrets, activation, writer/admission work, new stock SQL, submission or release. Supervisor owns commit, native review and delivery. Smallest adequate alternative: existing handlers plus one structural contribution, preserving all graph controls; no new module edge or ESLint edit.

The final isolated tarball consumer uses public inventory/shipping entries, real nonempty native stock reads and selected reference-source shipping reads, an injected managed rate fixture and picker/settings/manual UI. Injected managed address mutation proves forwarding and UI continuity, not durable host support. The new rollback-only shipping pgTAP file fills own-session address mutation/default and frozen-destination gaps; existing row-isolation, address-change, settings and audit files are reused. Native address writes remain UNSUPPORTED with binding/Core readiness refusal; their parity row stays PENDING for a separate bounded writer decision. The native flat-rate follow-up below closes the forward-migration decision through a seed and named lane, without a grant. Complete managed host support retains its gate below. Incumbent empty dictionary 502 and withdrawn-selection legacy fallback remain unchanged; no new locale copy.

## Parity (PENDING rows)

Executed evidence is scoped to the named test and store. Remaining required outcomes stay PENDING until their stated disposition before S1; transcripts and self-skips are not durable parity proof.

| OpenLup operation | Direct/native store | Managed store | Executed P2c evidence / remaining proof |
| --- | --- | --- | --- |
| Stock/ATP | Observed-source quantities; stale stock excluded from ATP; no lots, unavailable, incoming or safety stock | Lot/location balances, expiry/FEFO/safety rules implemented | `inventoryNative.test.ts`: “projects fresh/stale/missing stock, held/committed/expired rows and aggregate demand while refusing adjustment” PASS. P5a managed primitive FEFO/expired-lot/safety assertions PASS in `m06_inventory_read_conformance_test.sql`; host ATP adapter readback stays PENDING (M06 lead, S1 managed-host gate). |
| Subscription forecast | Aggregate 30/45/60 demand, stale sellable projection retained; planned supply zero, coverage/shortage date null | Dated supply/coverage and expired-reservation projection differ | Same native “projects…” test PASS; P5a/P5b installed-consumer proofs cover real native stock reads and selected-store composition, not managed forecast parity. Managed host forecast/dated-supply readback stays PENDING (M06 lead, S1 managed-host gate). |
| Adjustment / admin reservation listing | Adjustment explicitly refused; listing maps held/committed to reserved | Adjustment and listing implemented under managed authority | Native “projects…” proves adjustment refusal. P5a native listing and managed allocation listing/adjustment/replay/denied roles PASS in the native suite and `m06_inventory_read_conformance_test.sql`; no identical-semantics claim or managed adapter pagination proof. |
| Renewal reserve/release/expiry | Fenced public renewal functions; replay, lease, expiry, stock-row serialization and invoker grants | Separate managed batch/lot reservation, release/consume, paid hold and recount routines | P5a extends the existing restricted-role case with successful runtime-granted reserve/replay/release alongside denied writes and SELECT-only listing. Native “reserves and releases once…”, “expires only eligible holds…”, “fences stale claims…”, “serializes competing baskets…” and “requires explicit relation privileges…” PASS. Managed reserve/released replay: `supabase/tests/inventory_reservation_replay_characterization_test.sql` (6 assertions); expired-lot consumption refusal/browser-role denial and invalidation replay: `supabase/tests/inventory_lot_runtime_boundary_test.sql` (12). Status: proved by the existing raw diagnostic pgTAP job + local run (CLI 2.98.2, 210 files / 4,700 assertions PASS). P5a focused pgTAP additionally executes consume replay/full payment-control refund without consumed-stock resurrection, paid pin/reacquire, cancellation and batch rollback. Managed concurrency/lock order and any unexecuted compensation path stay PENDING (M06 lead, real two-session managed-host gate); no blanket equivalence claim. |
| Installation / trust | Complete canonical catalogue; sparse descriptors are not an install chain | Complete managed baseline/forwards required | Native “installs the full catalogue…” and “upgrades the exact complete prefix before unit 33…” PASS with canonical ledger/object inventory and unchanged prefix rows. P5a `inventoryConsumer.test.ts` PASS: isolated installed public entries read a real native stock row and compare sparse SQL bytes/hashes with the installed complete ledger. Managed clean baseline/forward transactional replay PASS; exact-prefix managed upgrade/ledger still PENDING (S1 managed installation proof gate). |
| Dormant maintenance / stock wait | Inventory-only expiry; no private stock-wait lifecycle implementation | Manual repair, automatic expiry, provider sync and recount are distinct; retry sweep release-only | W3/W4 and `reservationMaintenanceConformance.test.ts` / `stockWaitConformance.test.ts` PASS only for route/port transcripts and incumbent preflight. Maintenance separation is limited to negative source regexes over two cron files plus route/port responses; it cannot establish absence of schedules elsewhere or actual provider-sync/recount separation. Managed recount dry-run/apply conservation and denied roles: `supabase/tests/inventory_recount_reserved_balances_test.sql` (25 assertions); retry expiry preserving subscription and retry-cycle state: `supabase/tests/retry_window_release_only_sweep_test.sql` (12). Status: proved by the existing raw diagnostic pgTAP job + local run (same 210-file PASS). P5a re-executes the two files and `no_cron_inventory_reservation_leases_test.sql`. Private stock-wait lifecycle/anchor effects and staging observations use the explicit C5 dispositions below; they are not PASS. |

| Remaining required outcome / report-only observation | Disposition PR |
| --- | --- |
| Managed real ATP/lots/expiry/FEFO/safety/forecast/supply, direct/managed listing and adjustment boundaries beyond the executed native refusal; preserve expired/stale differences | P5a partial proof: new read pgTAP (13 assertions) proves local FEFO/expired exclusion/safety, listing and runtime adjustment/replay/denial. Native suite proves real listing, stale equality, forecast differences and refusal. PENDING: managed host ATP/forecast/dated-supply/pagination readback; gate: M06 lead's real managed-adapter evidence at S1. |
| Managed reserve/batch/compensation/release/consume replay, paid pin/reacquire, cancellation/full one-time refund without stock resurrection, invalidation/recount beyond the proved four pgTAP outcomes; real ACL/role isolation/rollback/concurrency/lock order/freshness beyond executed native and pgTAP subsets | P5a: seven reused pgTAP files plus new lifecycle file (9 assertions) PASS for the named replay/invalidation/recount/expiry/preflight/paid pin/reacquire/batch rollback/cancellation/consume/full-refund subset; native runtime writes/denial/rollback/contention PASS. PENDING: remaining managed two-session lock order/concurrency and uncovered compensation; gate: M06 lead's bounded managed-host proof/scope decision before S1. |
| Managed clean install/upgrade/ledger and installed artifact projection identity; native actual installed consumer proof; no invented durable in-memory parity | P5a installed native read/SQL hashes/canonical ledger PASS in `inventoryConsumer.test.ts`; canonical full install/exact-prefix upgrade retained in native suite. Managed clean transactional baseline/forward replay PASS in focused harness. PENDING: managed exact-prefix upgrade/ledger; gate: S1 managed installation proof. |
| Adopter listing/BOM/renewal priority/own credit once; closed stale equality, READ COMMITTED/try-advisory/50 ms/55P03 and no busy-to-legacy fallback. OpenLup lacks private admission/budget/stock-wait SQL; no donor SQL imported | transferred to C5 adopter evidence; evidence owner: the M06 lead; endpoint: the adopter's canonical staging at C5/C6. This is a disposition, not a PASS. |
| Original active subscription and durable due/order/cycle/attempt preservation remain PENDING. `stockWaitConformance.test.ts` exercises `chargeSubscriptionCycleOffSession`: frozen snapshots and literal schedule/identity reach order creation; short/stale/busy prevent intent, preparation, execution and outcome-note calls. Input/snapshot immutability does not prove durable lifecycle or next-anchor effects. W4's unchanged `f.due.nextCycleAt === AT` assertion checks a local fixture only; it cannot prove the next anchor is unchanged in storage. Provider-owned recovery, paid/full commitment/local fulfillment before resumption, late payment/actual delivery extending later only without earlier/stacked/catch-up cycles remain real-host obligations. Subscription/payment/delivery writers stay incumbent; no production timing code changes | transferred to C5 adopter evidence; evidence owner: the M06 lead; endpoint: the adopter's canonical staging at C5/C6. This is a disposition, not a PASS. |
| Manual POST/auth/flag/manual_admin lease/no schedule versus separate automatic expiry: W3's four named traces execute against incumbent routes; conformance covers two-route source regexes, disabled/denied lease and release-only RPC; regexes do not prove system-wide scheduling or durable sync/recount separation. Actual staging controls and TTL-doc/staging flag-control mismatch remain report-only, PENDING; no activation/fix | transferred to C5 adopter evidence; evidence owner: the M06 lead; endpoint: the adopter's canonical staging at C5/C6. This is a disposition, not a PASS. |
| Empty dictionary 502, withdrawn-selection legacy fallback, static/dictionary/canonical point and fresh-selection equivalence | P5b: selected static/dictionary binding and isolated installed selection PASS; W6/W8 source/canonical-point/fresh-option/fallback characterizations re-executed PASS. Empty dictionary remains 502; no live-provider certification inferred. |
| Address ownership/default/mutation, frozen destination and ACL; absent native writer; offline versus no-match/manual save | P5b: binding identity/conflict/denied mutation, installed captured-row/manual/offline versus no-match, actual managed own-row/default/mutation/ACL and frozen snapshot subset PASS. Native address writes remain UNSUPPORTED/PENDING: separately bounded writer/schema decision. Full managed adapter idempotency/conflict and host readback remain PENDING, M06 lead before S1; no fixture-to-host equivalence. |
| Flat-rate read/save/audit/refusal and useful stock/settings/picker/manual/address UI through selected real stores | P5a isolated installed stock→catalog bundle composition PASS with an injected normalized reader; this does not prove production native new-purchase SQL or managed reader semantics. P5b installed stock/reference selection and picker/settings/manual conformance PASS with injected managed rate/address fixtures; audit/denial SQL primitives PASS. Managed runtime rate read/save authority remains PENDING (current shipped service_role table refusal; M06 lead host/grant decision before S1). No new locale copy. |
| native flat-rate save needs a commerce_settings grant not shipped in the baseline; forward-migration decision | CLOSED by design B: position-72 `20261021200000_shipping_flat_rate_seed` seed-only forward and named role-free native rate capability; no database grant. |
| Native new-purchase stock read | deferred to the native-backend parity round (owner 2026-10-21), second after M05 bundle-1 |
| native shipping-rate save has no durable audit | Native-backend parity gap: best-effort unsupported audit is swallowed by the incumbent handler; no durable audit claimed. |
| Native flat-rate value guard (coordinator advisory, 2026-10-21) | value_minor >= 0 is a known non-DB guard (host request schema); a CHECK is a candidate for the native-backend parity round. |

### Native flat-rate decision (2026-10-21)

Owner: "M06: do the native flat-rate save grant now (forward migration, least privilege); defer the native stock read to the native-backend parity round."

The coordinator ruled B as the delegate on 2026-10-21. A literal grant would
contradict the portable kernel's deliberate absence of `service_role`
(`packages/platform/src/data/postgresGateway.ts:40`). A native capability instead
gets a named role-free lane because the lane name is the access rule. The sole
forward statement seeds the fixed setting without overwriting it or changing
privileges. Native save requires its port and Core readiness for the new forward;
managed host-save remains PENDING.

Audit ruling 2: the native bundle routines append principal-attributed history to
`catalog_bundle_write_events`, whose action constraint accepts only seven bundle
actions. It cannot record `shipping_rate_change` without an out-of-scope schema
change; the portable chain has no generic `record_admin_audit_event`. The native
port explicitly reports unsupported audit, and the existing best-effort handler
swallows it. Durable native shipping-rate audit is a parity gap.

Native new-purchase stock read is deferred to the native-backend parity round
(owner 2026-10-21), second after M05 bundle-1. No implementation is added; C5
retains the adopter-owned reader. The next row records the native audit gap.

The proof adds six semantic cases and extends incumbent binding and
installed-consumer cases.

## Budgets

Native flat-rate follow-up allocation: six new semantic cases; M06 reaches 96/100
under the coordinator's current count. Earlier allocation estimates below are
historical; generated invocations count separately. No new package source file
or generated file-boundary invocation is introduced.

Static allocation: inventory 36 new cases / 14.7 s; shipping 14 / 5.3 s; P4–S1 nine / 5.7 s. Total: 59 new + 36 C1 = 95/100, leaving five cases; 25.7 s public + 3.0 s C1 allowance = 28.7/30 s. Equivalent witness transplants still count as actual public invocations/runtime. Estimates do not establish hosted median/p90.

Package caps: 2,100 files / 2,000 code files; 1,351,680 packed B / 5,734,400 unpacked B / 1,126,400 code gzip B. Root docs remain capped at 40,960 gzip B / 10 files; the combined M05/M06 estimate leaves about 454 B, requiring actual measurements and compact root prose. Stop on a measured excess. Inventory contracts use a 32 B browser minified+gzip budget; DTO-only output must be measured with the existing browser-entry tool.

Combined P2 delivery (2026-10-21): the owner/coordinator decided that P2a + P2b + P2c land as one combined PR to save a merge slot; the per-cut records above remain historical scope and budget evidence. This reconciliation targets main `cae83c61` from candidate `e98c2454` in the assigned `m06-p2c` worktree. Authority is file-content resolution, API generation, projected documentation-impact computation and the requested serial focused checks only; the author stages and commits. No Git writes, installation, external delivery, merge or release is delegated. Main #243 supersedes the historical Rule 1 generator instruction: publication rows remain authored, fragments need no rows, and the source-release snapshot stays at main until release preparation. Main’s final P1b structural bundle-stock shapes and empty inventory type edges remain authoritative. pgTAP is a raw diagnostic job, outside the six required checks; its retry-sweep proof covers subscription and retry-cycle state only.

Combined P2 merged-tree budget against main `cae83c61`: 34 changed paths including the fragment; 21 added export pairs against combined caps 13 + 24 + 1 = 38 (P2a 10, P2b 10, P2c one), 59 total inventory export pairs. Offline pack main → merged: 1,111 → 1,134 files (+23), 1,089 → 1,110 code files (+21), 712,249 → 734,526 packed B (+22,277), 3,204,470 → 3,320,052 unpacked B (+115,582), 610,907 → 621,446 code gzip B (+10,539). Root docs: 38,576 → 38,785 gzip B (+209), five files unchanged, 2,175 B headroom. Inventory contracts: 20/32 browser gzip B. All artifact caps pass; no cap or released-baseline changes. The fragment is excluded from the pack. Main measurement uses its exact package source in a temporary snapshot without Git metadata, with the same existing compiler/dependencies and no installation.

Merged-tree focused proof: ast-grep, lint (zero errors / 33 warnings), five-project typecheck (zero unresolved edges or consumer errors), API update/check, 47 inventory Vitest cases / 13 files and eight native PostgreSQL cases / one isolated file pass, zero skips. Native test bodies total 12.72 s in this one local run (12.90 s wall); this is a new observation above the earlier 9.0 s forecast, not an isolated module delta or hosted percentile. P5a/S1 still owns aggregate measurement/disposition. UI neutrality passes. Policy/catalog/live bindings and regenerated navigation pass before the impact guard; policy and tree neutrality then refuse the intentionally unmerged index. The projected tree against `cae83c61` has one unanswered tests obligation; P2a's adapter and commerce trailers remain valid. The author must stage the six handoff files, include the computed tests trailer, and rerun native policy and tree neutrality.

Merge self-retro: reconstructing the plan from main plus the P2 records preserved final P1b and shipping evidence; fragment admission avoided another shared changelog edit. No semantic conflict or broader repair was needed.

P5a final focused measurement (2026-10-21; uncommitted content on P4): 20 changed paths of 23 approved; six production paths, four added consumed exports, four new authored Vitest cases / zero transplants. Two proof files add 22 pgTAP assertions for the existing parity criteria, separately from the authored Vitest count; seven reused files contribute 80 assertions. No cap, baseline, runner or control changes. ESLint needs no registration: inventory already has empty values/types and composition's existing structural pattern needs no new edge; zero lines changed.

Four new Vitest cases: 0.094149 s bodies. Generated `it.each` boundaries: two new package files × three existing checks = six root invocations / 0.005257 s, selected with an exact filename regex; package-local reruns not executed. Aggregate new Vitest bodies including generated invocations: 0.099406 s, versus P5a's 2.0 s forecast. The two extended incumbent binding cases, “selects the direct request binding for node-postgres” and “preserves the managed gateway composition for a Supabase bundle”, add no authored cases; all three incumbent binding cases, including unchanged “does not disguise a missing direct adapter as a Supabase read”, execute in 0.014184 s. Native suite: eight existing cases, one final passing focused run / 7.773333 s bodies, 11.203948 s from Vitest start to last test (including initial cluster setup). The three-file focused binding/installed-consumer run is seven passing cases / 0.108333 s bodies, 7.945781 s through last test including cold-pack/install and database setup. All exercised Vitest bodies total 7.886922 s including the native suite and generated boundary checks. Setup/cleanup is not hidden in the new-case body total. The pgTAP phase reports 0 wallclock s / 0.06 CPU s for all 102 assertions; exact new-SQL-only elapsed time is unavailable at that reporting precision. A final lifecycle-only rerun after replacing its provider-independent fixture identity passes all nine assertions (0 reported wallclock/CPU s). These are local observations, not isolated whole-module delta or hosted median/p90. Hosted aggregate budget remains PENDING P5a/S1; no owner override inferred.

Final pack: 1,163/2,100 files, 1,134/2,000 code files, 781,830/1,351,680 packed B, 3,526,465/5,734,400 unpacked B, 658,347/1,126,400 code gzip B. Root docs: 39,399/40,960 gzip B across five/ten files, 1,561 B shared headroom; P4 39,292 B (+107), main d9976243 39,395 B (+4 net including P4). Inventory contracts 20/32 browser gzip B. Retain released 0.16.0 baseline 256,973 packed B; cumulative >30% growth comes from the existing expanded module surface, SQL and declarations and still needs the set release's growth explanation. No release preparation here.

Final checks: ast-grep, lint (zero errors / 33 existing warnings), five-project typecheck (zero unresolved edges/consumer errors), API update/check (only inventory/composition snapshots differ), new-file collection, focused Vitest, named pgTAP and both neutrality scripts PASS (tree: zero increases). Generated navigation renders identical. Policy/docs-update refuses seven untracked additions against the materialized output inventory under the explicit no-Git-writes boundary; supervisor must stage/commit, apply the final computed no-impact trailers and rerun policy. This is a delivery blocker, not a policy PASS. Main's source-release snapshot and CHANGELOG remain byte-identical. Managed host/upgrade and C5 dispositions above remain effective.

P5a self-retro: two incomplete runtime-role grant fixtures exposed the existing response's cycle/order/settlement reads before the final passing run; inspect that response's full relation set first. New vendor literals were removed by reading the canonical reference schema value and using a synthetic provider in the provider-independent refund fixture. Resource-gate child stdin performed no proof; a bounded argument script executed correctly. Pattern → simpler path: use existing contracts and inspect dependencies instead of guessing fixture grants or introducing another seam. No successor or optional repair opened.


P5b focused completion evidence (2026-10-21, content-only on P5a ccf2fbd8): 19/22 approved paths, seven production paths, four consumed added exports; zero ESLint/graph edits. Coordinator-approved generated pricing/promotions API companions follow the M05 P1 identity-snapshot precedent: 18/19 reordered enum blocks, all per-block member multisets and outside bytes identical. Proof script/result remain in the task scratch evidence. Native rate requests refuse shipping_native_flat_rate_save_unsupported; the generic native service lane uses service_role, while named owner lanes preserve the caller login. No native rate writer/owner lane or commerce_settings runtime grant is shipped; no local grant substitutes for it. The native catalogue also lacks addresses; captured managed rows are fixture conformance, not native storage support.

Actual authored cases four/four forecast, zero transplants: 0.410486125 s new Vitest bodies versus 2.5 s forecast. Six generated it.each invocations add 0.006012834 s separately; package-local reruns not executed. Eleven incumbent shipping characterizations total 0.231994 s. Required inventoryNative-alone rerun: eight/eight PASS, 10.442411084 s bodies. Final selected binding/characterization run: 13/13 PASS; isolated installed consumer: 2/2 PASS. Selected Vitest bodies including native/generated total 11.090904043 s; no whole-module delta or hosted median/p90 inferred. Hosted aggregate remains PENDING S1 under unchanged 30 s cap. Named pgTAP: six files/215 assertions PASS (203 reused, 12 new), 0 reported wallclock s/0.03 CPU s; setup/cleanup and new-SQL-only elapsed time are unavailable at that precision. No skipped scenario is claimed as proof.

Pack: 1,169/2,100 files, 1,140/2,000 code; 784,904/1,351,680 packed B, 3,541,641/5,734,400 unpacked B, 660,875/1,126,400 code gzip B. P5a delta: +6/+6 files, +3,074/+15,176/+2,528 B respectively. Root docs unchanged 39,399/40,960 gzip B across five/ten files, 1,561 B shared headroom. Shipping contracts 20/32 browser gzip B. Released baseline remains 0.16.0/256,973 packed B; S1 retains its cumulative growth explanation. No release preparation or cap change.

Final lint PASS (zero errors/33 existing warnings); five-project typecheck PASS (zero unresolved edges/consumer errors); API update/check, generated-companion multiset proof, new-file collection, all focused tests above, UI neutrality and tree neutrality PASS (5,379 text/56 binary, zero increases against P5a). Policy/docs-update refuses the six untracked authored source/test rows under the no-Git-writes boundary; supervisor must stage/commit, attach computed impact trailers and rerun it. Navigation renders byte-identical. This is a delivery blocker, not a policy PASS; no committed review or clean-tree verification is inferred from content-only checks.

P5b self-retro: incorrect fixture assumptions caused setup failures (a non-exported package.json path and a nonexistent native address table); two UI fixture failures exposed initial-read timing and strict search-result fields. Pattern → simpler path: resolve public entries, inspect the actual catalogue and wait for readback before edits; preserve the incumbent schemas rather than bypassing them. Generator spill was stopped and explicitly authorized before inclusion. No production ACL/schema/writer repair or automatic successor was added.


Combined P5a/P5b merge reconciliation (2026-10-21, main `b18460e7`): local content edits and requested focused serial checks only; the author stages and commits. No Git writes, secrets, other worktrees, full suite, `test:scoped`, resource gate, submission or release. Scope is the combined PR paths and generated companions. Preserve main’s sorted registrations, CHANGELOG and source-release contract; keep both P5 fragments unreleased. Remove only the unconsumed adjustment metadata (the existing native adjustment refusal remains), correct the two stale evidence statements and regenerate API snapshots; outside inventory/shipping/composition only pure API reorders are allowed. Exact checks, merged-tree impact trailers, pack/docs comparison and staging list are in the requested merge report. Delivery still requires the author’s index reconciliation, commit and required native review/verification.

Merge self-retro: unchanged registrations need verification rather than edits; removing unused refusal metadata is smaller than adding a redundant consumer. No successor work opened.


## S1: 0.20.0 package set

Finite outcome (2026-10-21, merge-slot row 27, "M06 S1"): prepare the complete
minor `0.20.0` set from main `4c0554890eb91bb0256dea26a8483b3160f69a36`,
following the `0.19.0` preparation in #266. Core and outbox are unchanged
republications from `0.19.0`; UI remains private `0.0.0`. The new platform entry
consumes only `dunning-lifecycle-active-repair.md` and
`m06-native-flat-rate-save.md`, records M06's shipped development-preview
outcomes and retains the current limitations. P5a/P5b already shipped in
`0.19.0`; their release entries are not repeated as new changes.

Authority: the coordinator's row-27 brief assigns Codex file-content preparation
and the named focused checks on branch `claude/m06-s1-0.20.0`. No Git writes of
any kind (including fixture repositories), other worktrees, secrets, broad suite,
`npm test`, `test:scoped`, `verify`, submission, merge, tag, account or registry
mutation are delegated. The supervisor owns staging, commits and required native
review/final verification. Release dispatch and protected approval are human-only. The
2026-10-21 continuation permits public npm registry reads and published-version
downloads, with scratch only under `/private/tmp/claude-501/m06-s1/baseline/`;
it requires the three prior repair edits to be preserved and the focused
package, source-preparation, Migration, ast-grep, lint and docs-size checks.

Acceptance/proof plan: generate versions, exact internal pins, lock carriers,
changelog sections and source bindings with the existing release functions;
preserve all pre-0.20.0 changelog history byte-for-byte and empty Unreleased
sections. Keep caps unchanged, including platform root-docs gzip at 49,152 B.
Use the smallest content-only adaptation of the existing bump planner because
the CLI stages fragment deletions. No persistent tool or control is added.
Validate Migration blocks against the existing migration rule, measure root-docs
bytes and run only the requested focused static/package checks. Source-preparation
fixture tests require Git writes and therefore remain a supervisor obligation.
The initial pre-commit policy and strict source-preparation refusals under the
unstaged fragment deletions were reported, not treated as passing committed
evidence. Exact results and computed no-impact trailer proposals accompany the
supervisor handoff.

Release-order gate (coordinator, 2026-10-21): `0.19.0` is published and its
C4 artifact readback passed on dispatch target #266 merge `fd1513ba`. This
satisfies the predecessor publication/readback gate for `0.20.0`. Later main
commits still carried version `0.19.0` with post-release shipping code, API and
SQL; they are not the baseline source. This S1 preparation refreshes
`pack.baseline` in `packages/core/release-gates.json`,
`packages/outbox/release-gates.json` and `packages/platform/release-gates.json`
from the downloaded published `0.19.0` tarballs: 161,650 B, 39,421 B and
805,872 B respectively. Full registry shasum and integrity match each downloaded
artifact, and shasums match the coordinator's prefixes. All caps are unchanged.
The baseline refresh belongs to this reviewed preparation, whose remaining
commit/review/final-verification gates precede dispatch. Publication evidence
and a prepared version grant no dispatch or protected-approval authority.

S1 disposition of the Parity PENDING rows: managed host ATP/forecast/dated-supply/
pagination readback remains PENDING with the M06 lead; managed two-session lock
order/concurrency and uncovered compensation remain PENDING with the M06 lead's
bounded managed-host proof/scope decision; managed exact-prefix upgrade/ledger
remains PENDING under the managed installation proof gate; full managed address
adapter idempotency/conflict/readback remains PENDING with the M06 lead; and
successful managed flat-rate read/save remains PENDING the M06 lead's host/grant
decision. None is proved on a managed host or claimed by S1; the native flat-rate
save follow-up does not close them. Only the existing adopter admission/busy,
stock-wait/durable timing and staging-control rows are transferred to C5 adopter
evidence, owned by the M06 lead at the adopter's canonical staging at C5/C6.
Those transfers are dispositions, not PASS; no other pending row is transferred
or promoted to PASS here.

Risk: inaccurate release claims or fabricated baseline identity could mislead
adopters or erase the growth comparison. Retain the actual prior artifact
identity and the coordinator-confirmed predecessor readback. No runtime, SQL, API,
export, cap or budget change belongs to S1.


### S1 focused preparation evidence

The three publishable manifests, exact pins and both lock carriers now name
`0.20.0`. Only the two named fragments are consumed; all three changelogs keep
one empty Unreleased section and byte-identical history from `0.19.0` onward.
Core/outbox runtime source trees match #266. Canonical materialized-candidate source
binding derivation is generated. The 2026-10-21 pre-commit strict CLI write/check
and policy refused the then-unstaged fragment deletions; that observation is
historical. On committed candidate `1bc62d30`,
`node --experimental-strip-types scripts/source-release-preparation.ts --check`
passes with the committed snapshot fresh. No refusal is waived.

Initial pre-commit results (2026-10-21): ast-grep, lint (zero errors / 33 existing warnings), five-project
typecheck (zero unresolved edges or consumer errors), all three API checks and
set manifest-only validation PASS. Migration-marker/history validation PASS;
this is not a committed-base/head `assertMigrationBlocks` run. Canonical navigation
is byte-identical. Direct documentation-impact computation reports four
obligations, one answered by the package README and three awaiting proposed
supervisor commit trailers. Platform root docs measure 42,575/49,152 gzip B
across five/ten files, leaving 6,577 B. Full artifact/installed-consumer evidence,
Git-writing source-preparation tests, predecessor C4/rebaseline and committed
review/final verification were then outstanding supervisor/human gates. The
predecessor gate and baseline refresh are now satisfied as recorded above; the
remaining gates retain their existing authority.

Self-retro: automatic deletion staging conflicts with content-only preparation
→ reuse the existing pure bump planner and source derivation, report native
refusals explicitly, and leave Git reconciliation to the supervisor.

Repair cycle 1 (2026-10-21): restore every still-true `0.19.0` limitation in the
standalone `0.20.0` release body, update native flat-rate support, retain all
managed-host pending classes above, name the additive shipping API and exact-set
upgrade, and restore the package README to main. This repair changes release
claims and evidence only; no runtime, generated version/lock, cap or budget edit.
Repair checks: source-preparation `--check`, ast-grep and lint (zero errors /
33 existing warnings) pass. The committed Migration-block rule passes; no API
snapshot changes occur in S1, and the new release text independently retains
three Migration blocks, unique empty Unreleased and byte-identical prior history.
Platform root docs measure 42,882/49,152 gzip B across five/ten files, leaving
6,270 B. Navigation remains byte-identical. Against base `4c055489`, the policy
counts the three existing commit trailers and refuses the newly unanswered
`platform-substrate` obligation after the README restore; its computed no-impact
trailer awaits the supervisor's commit. No refusal or delivery gate is waived.
Self-retro: a release body must stand alone → carry forward each limitation from
the preceding release, then update it against code and the parity ledger.


Baseline refresh continuation (2026-10-21): the published `0.19.0` artifacts now
supply all three release-gate baselines, completing the refresh in this S1
preparation. The README baseline sentence now names the prepared `0.20.0` set
and published `0.19.0` tarball; its earlier exact-main equality is historical.
The new `0.20.0` changelog records the refresh, while all released history and
the earlier repair's standalone limitations remain intact. No cap changed.

Focused results on this continuation: source-preparation `--check` passes with
computed bindings valid and the committed snapshot fresh (5,450 tracked public
paths), so no `--write` or snapshot change is needed. The native committed
Migration-block rule from `4c055489` to `1bc62d30` passes; candidate
`packageSurface` objects equal HEAD, and release markers/history independently
pass (core/outbox one Migration block each, platform three). Ast-grep and lint
pass (zero errors / 33 existing warnings; eight structural rule tests pass).
Root-docs gzip measures core 23,746/49,152 B (10/20 files), outbox
13,447/26,624 B (6/12 files) and platform 42,918/49,152 B (5/10 files), leaving
6,234 B platform headroom. These use the repository's sorted-content
`measurePack` function, not a local tarball baseline.

`npm run packages:check` exits 1 on its three mandatory dirty-package guards;
no artifact proof is claimed or guard bypassed. Supplemental manifest-only
checking passes for all three packages. Policy with `--docs-update` validates
source bindings, structural policy and byte-identical navigation, but exits 1
with two unanswered core/outbox impact obligations after their baseline changes.
The README update answers platform structurally; the existing repository trailer
still matches. All four exact replacement trailer proposals for the complete
delta from `4c055489` are recorded with registry identities, measurements and
check logs in the requested side-session notes and baseline scratch evidence.
Only the authorized supervisor can commit the refreshed trailers and obtain
clean-package artifact proof, native review and final verification. No refusal
is waived; no staging, commit, ref or release/account action was performed.
HEAD and staged entries remain unchanged. A raw index-file hash change was
observed during read-only checking; its cause is unestablished and no index
restoration was attempted. The side-session evidence records this discrepancy.

Self-retro: a published artifact's own identity and byte count remove the need
for a source rebuild or inferred baseline; preserve native dirty-tree refusals
and hand off the exact remaining evidence rather than widening this preparation.
