# commerce domain

Core ecommerce engine: cart/basket, recommendation, product compatibility,
offer availability projection,
quote, order-draft, checkout runtime saga, OMS read models, payment-status
bridge, subscription checkout metadata, and idempotency shell. The hidden
one-time/subscription-initial checkout lives here.

## Owns / does not own
- **Owns:** cart, checkout, recommendations, product compatibility, orders,
  payment orchestration, subscription linkage, discounts, idempotency shell,
  order-draft outbox event contracts, OMS read models, and the checkout
  `invoicePreference` contract that writes the final order buyer snapshot.
- **Does not own:** product copy (`catalog`), DHL provider details
  (`fulfillment`/`server/infra`), Supabase/provider adapters, or invoice issuing
  policy/provider execution (`accounting`).

## Public surface (import cross-domain ONLY these)
- UI/BFF clients: `commerceClient.ts`, `omsClient.ts`,
  `adminPromotionsClient.ts` (admin "Rabaty" editor),
  `adminCatalogClient.ts`, and `customerEligibilityClient.ts`.
- Public contracts/helpers: `checkout*`, `quoteContracts.ts`,
  `offerPricingContracts.ts`, `useCommerceOfferPricing.ts`,
  `adminPromotionsContracts.ts`,
  `orderDraftSnapshotContracts.ts`, `runtimeContracts.ts`, `recommendation*`,
  `productCompatibility*`, `offerAvailability*`, `paymentStatus.ts`, `oms*`, `configuratorIntent*`,
  `customerDefaultsSnapshotContracts.ts`, `outboxEventContracts.ts`,
  `contractPrimitives.ts`, and `basketSizeConstraint.ts`.
- Frozen completed-order money seam: `orderMoney.ts` exports shared select
  columns and `deriveOrderMoney()`. It validates persisted catalog, allocated,
  effective, VAT, delivery, and total equations but never allocates a discount
  or reads quote metadata as completed-order truth.
- Public acquisition prices use the versioned, published-dog-product-only
  offer-pricing projection. When the v2 capability flag is enabled, the hook
  binds the request to the app-level first-party visitor id; without that id it
  stays amount-free and fail-closed. Transactional totals still come only from
  the quote contract, and historical receipt totals only from canonical order recap.
- Ports/types: `ports.ts`, `runtimePorts.ts`, `omsPorts.ts`, `types.ts`.
- Pure policy helpers: pricing breakdown, recommendation engine/variant
  selection, recommendation policy contracts, offer availability derivation, and OMS fulfillment
  eligibility/summary (`pricingBreakdown.ts`, `omsFulfillment*`).
- Petfood policy implementations live downstream in `src/domains/petfood`,
  which is withheld by the deployment overlay and is not part of the published
  tree. `energyPolicy.ts` keeps only compatibility type exports and
  `packageQuantityPolicy.ts` keeps the package policy contract/version exports;
  a published tree binds its own implementation of those contracts at the
  composition root, which is where this deployment injects the openlup petfood
  policies.
- Transactional email *content* (commerce owns the copy; chrome/transport live
  in `communications` + `server/infra/resend`): `emails/*` — e.g.
  `emails/orderDraft.ts` builds the localized order-draft resume nudge as
  blocks. Consumed by the outbox dispatch adapter, not imported cross-domain.

Everything else (handlers, orchestration, `dbBacked*`/`supabase*` ports) is internal.

## Where the code lives
- Shared/frontend: `src/domains/commerce/`
- Server (handlers, orchestration, Supabase ports, runtime saga): `server/domains/commerce/`
- BFF public URLs: `/api/bff/commerce/...`, `/api/bff/admin/commerce/...`
- BFF handler files: `server/bff/commerce/...`, `server/bff/admin/commerce/...`
  via the catch-all Vercel entrypoint `api/bff/[...path].ts`

## Admin discounts and promotion codes
The "Rabaty" admin surface separates automatic promotions from Code Center.
The legacy promotion list is a semantic read model: raw technical values are
not returned, and rows linked to v2 mirrors are system-managed/read-only in both
the UI and service-role adapter. Editable legacy rows and subscription/catalog
pricing mutations are unconditional behind admin auth (the `COMMERCE_PROMOTIONS_MUTATIONS_ENABLED` launch flag was removed in release-gates-w7).

Code Center list, preview, create and update are unconditional behind admin
auth: the five rollout flags were retired in PR 2243 after the feature went
permanently live. Create/update additionally require a human actor. Automatic
offer-policy rollout is still a separate control and is not implied here.

Domain-boundary rules, including the Domain Map and the feature trace, live in
the maintainer canon `DOMAIN_ARCHITECTURE.md`, which belongs to the private
overlay and is not part of the published tree.
