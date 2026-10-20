# M06 stock, reservations and delivery

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
Gates: ast-grep, lint (33 warnings), typecheck, focused 1,138 cases / 22 files, package-local 2,793 / 153, collection, API, size/browser, UI neutrality and diff checks PASS. Whole-tree neutrality PASS. Witness ledger (coordinator acceptance 2026-10-20): W6 reads its expected country from the frozen reference schema to satisfy ui-6 without a baseline raise; the value is unchanged and the adopter C1 witness itself is unchanged. The pattern is never used where a test would compare the code under test against itself. Delivered as PR #236; reviewed cycles 0 and 1, each with two fresh full reviews.
Root-doc gzip: baseline 35,868 B; before repair 36,560 B (+692); repaired 36,099 B (+231), five files. Pack 620,658 B; contracts browser gzip 20 B ≤32; all caps pass. Three no-impact trailers bind candidate bytes, modes and owners against the review base.
Self-retro: version assertions folded into the order case fund plant/substitution within three cases; preserving narrowed reference ports closes type drift. A missed npm cache setting repeated the known sandbox refusal; task-local cache resolved it. No new runtime machinery was needed.

### P3b
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
