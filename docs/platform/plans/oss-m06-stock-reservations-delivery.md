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
Gates: ast-grep, lint (33 warnings), typecheck, focused 1,138 cases / 22 files, package-local 2,793 / 153, collection, API, size/browser, UI neutrality and diff checks PASS. Whole-tree neutrality PASS: W6's expected country is read from the reference contract schema instead of a repeated literal; the expected value is unchanged. Publication policy deferred until supervisor commit; native review/delivery pending.
Root-doc gzip: baseline 35,868 B; before repair 36,560 B (+692); repaired 36,099 B (+231), five files. Pack 620,658 B; contracts browser gzip 20 B ≤32; all caps pass. Three proposed no-impact trailers in `/private/tmp/m06-doc-impact-trailers.txt` retain their digests, computed read-only from candidate bytes, modes and owners against the merge base; commit needed only to accept trailers.
Self-retro: version assertions folded into the order case fund plant/substitution within three cases; preserving narrowed reference ports closes type drift. A missed npm cache setting repeated the known sandbox refusal; task-local cache resolved it. No new runtime machinery was needed.
