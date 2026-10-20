# M06 stock, reservations and delivery

## Scope and placement

Development-preview extraction into `@openlup/platform/{inventory,inventory/contracts,shipping,shipping/contracts}`; no new package. Core retains ATP, FEFO and shipping arithmetic. Reference application policy, provider translation and composition retain their owners. C1 identity: adopter commit `4595d4b3d`, nine characterization witnesses, 36 cases; unchanged witnesses remain the comparison source. Extraction does not establish native-store parity or activation.

A stock wait preserves the active subscription, full frozen basket and due/order/cycle/attempt identity. It extends the next cycle later only, never earlier and never stacked. Replacement alignment requires actual arrival; an undelivered replacement remains outstanding and cannot be confirmed as delivered.

## Ledger

The owner's 2026-10-20 start grant supersedes the earlier hold for the whole M05 stack. The frozen stack has two independent lanes rooted at main, followed by their join. “None” means no external gate; lane predecessors still apply.

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

Pack before → after (post-merge): 971 → 1,031 files; 951 → 1,011 code files; 614,196 → 667,038 packed B; 2,749,012 → 2,984,720 unpacked B; 525,409 → 576,665 code gzip B. Root docs: 35,868 → 37,098 gzip B, five files throughout. Inventory contracts: 20/32 browser bytes. No cap or released baseline changes.

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
