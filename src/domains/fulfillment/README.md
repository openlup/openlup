# fulfillment domain

Commerce-fulfillment control plane that orchestrates other domains' facts
without owning them, plus the provider surfaces that execute a handoff.

**Two provider classes live here and must not be conflated.** The production
path is a *fulfillment house* (`type: 3pl`, currently OmniPack): it warehouses,
picks, packs, acts as the stock oracle, and routes each parcel through whichever
courier the customer chose. The fallback is a *direct carrier* (`type:
direct-carrier`, currently DHL): shipment, label, pickup booking, and tracking
only — no warehouse, no picking or packing, no stock authority. It backs legacy
admin tester tooling and a dormant emergency switch for a fulfillment-house
outage, and is deliberately retained as the direct-carrier reference example.

The same courier can be reached both ways — as a carrier *inside* an OmniPack
shipment, and as the direct DHL integration — so the carrier never
determines the provider; only an explicit `providerKind` does. The registry,
capability contract, and this three-layer invariant live in the maintainer canon
`FULFILLMENT_PROVIDER_PLUGIN_GUIDE.md`, which belongs to the private overlay and
is not part of the published tree.

## Owns / does not own
- **Owns:** OmniPack dispatch/webhook/reconciliation/stock-evidence surfaces, DHL shipment create/labels/cleanup/courier booking, shipment read models, tracking state mapping, fulfillment workflow contracts.
- **Does not own:** client identity, order/payment ownership, email behavior.

## Public surface (import cross-domain ONLY these)
- Direct-carrier admin clients: `adminDhl*` and `adminShipmentsOverviewClient.ts`
  for cleanup, shipment create, labels, courier booking, repair, and shipment
  overview.
- Commerce fulfillment clients/contracts/ports/read models:
  `commerceFulfillment*` and `commerceV2FulfillmentPort.ts` for create, detail,
  label recording, provider attempts, handoff, and readiness.
- Preview audit proof: `previewHandoffProof.ts` validates hidden-preview
  fulfillment handoff evidence for Stripe -> accounting audits. It accepts
  `noop_shipping` only when evidence explicitly marks it as preview/mock and
  sanitized; it does not call the fulfillment house or any provider.
- Shared shipment contracts/ports/types: `contracts.ts`, `ports.ts`,
  `providerFulfillment.ts`, `status.ts`, `types.ts`, and
  `providerCapabilities.ts`. `types.ts` exposes the provider-neutral evidence
  facade used by read models to map active tracking refs and sanitized
  status/operation timelines without migrating direct-carrier data.
  `providerCapabilities` exposes browser-safe plugin metadata for each registered
  provider kind; it is descriptive and does not authorize provider mutations.
- Normalized evidence: `normalizedFulfillmentFacts.ts` binds the generic
  `@openlup/core/fulfillment` fact schema to the single Layer B vocabulary
  derived from `statusMap.ts`. Its public unknown-input parser validates the
  existing canon; the application that eventually writes facts must mint the
  `evidence:<uuid>` reference and keep provider/customer payloads behind that
  governed evidence boundary. It defines no mapper, reducer, persistence, or
  external effect.

## Where the code lives
- Shared/frontend: `src/domains/fulfillment/`
- Server: `server/domains/fulfillment/` (provider-neutral kernel and policy,
  fulfillment-house dispatch and reconciliation workers, direct-carrier admin
  handlers)
- Fulfillment-house provider glue: `server/infra/omnipack/`; execution adapters:
  `server/adapters/omnipack/`
- Direct-carrier provider glue: `server/infra/dhl/`; execution adapters:
  `server/adapters/dhl/`
- BFF routes: `api/bff/admin/fulfillment/…`

Domain-boundary rules live in the maintainer canon `DOMAIN_ARCHITECTURE.md`,
which belongs to the private overlay and is not part of the published tree.
