# pricing domain

Deterministic, variant-anchored price resolution: one price entry per (variant,
mode, minimum quantity), scoped to a region/currency price list and a validity
window. Enforces "subscription is cheapest per unit".

## Owns / does not own
- **Owns:** price resolution + `PricingResolverPort` contract, the signed
  pricing-component breakdown and its reconciliation invariants, bundle
  target-price allocation, and the immutable subscription-price-policy semantics
  (discount, quantum and rounding).
- **Does not own:** promotions (`promo`), shipping (`shipping`), catalog metadata
  (`catalog`), or tax rates — a quote reads those from the deployment's
  settlement profile.

## Public surface (import cross-domain ONLY these)
- `ports.ts` — `PricingResolverPort`.
- `types.ts` — `ResolvedPrice`, `PricingMode`.
- `targetPriceAllocation.ts` — `allocateBundleTargetPrice`: derives exact per-component
  money for a bundle sold at one operator-set target price. In-domain surface today;
  the cross-domain guardrail's public segments are `contracts`/`ports`/`types`, so
  another domain imports `@openlup/core/pricing` directly rather than this shim.
- `subscriptionPricePolicy.ts` — dark W2a policy revision schema, canonical
  digest tuple and integer-only subscription price derivation. It does not seed
  a policy row or activate a quote/runtime reader.

## How pricing resolves

A caller passes **two** quantities, and the difference between them is the point
of the contract (`packages/core/src/pricing/ports.ts`):

- `eligibleCartQty` selects the quantity tier,
- `lineQty` is what the resolved unit price is multiplied by.

That is what lets a fixed-size box assembled from several variants reach the
whole-box tier instead of each line matching its own, smaller tier. The quote
computes the eligible quantity per pricing mode and excludes add-on lines
(`eligibleQtyForMode` in
`server/domains/commerce/dbBackedCommerceQuoteHelpers.ts`).

Resolution order, identical in both adapters:

1. Active price lists for the requested region and currency whose validity
   window covers the request time.
2. Entries for that variant and mode that are active and whose minimum quantity
   is at or below `eligibleCartQty`.
3. Highest minimum quantity wins; a later `valid_from` breaks a tie.
4. No match for the requested mode, and the mode is not `any` → one retry
   against `any`. That retry is how an ad-hoc add-on prices independently of the
   cart's mode; it is adapter policy, and the port itself preserves the
   requested mode.
5. Still nothing → `null`. Callers must refuse rather than quote zero; the quote
   raises `PRICE_NOT_CONFIGURED`
   (`server/domains/commerce/dbBackedCommerceQuotePort.ts`).

Amounts carry an explicit `gross`/`net` kind. A quote converts once to gross and
splits tax back out of it as `net = round(gross * 10000 / (10000 + vatRateBps))`;
the rate comes from the settlement profile, never from this domain.

**Subscription-cheapest invariant.** For a subscription line the quote also
resolves the one-time price of the same variant at the same quantities and
refuses with `PRICING_INVARIANT_VIOLATION` when the subscription gross is higher
(`assertSubscriptionCheapest`). It is a hard refusal, not a warning.

**Breakdown.** `buildLineBreakdown` / `buildOrderBreakdown`
(`packages/core/src/pricing/pricingBreakdown.ts`) emit signed components that
reconcile twice: per line to the line total, and per order — shipping and promo
included — to the order total. `assertBreakdownInvariant` throws on drift and
must run before anything is persisted.

| Component | Scope | Emitted when |
| --- | --- | --- |
| `base_unit` | line | always; base unit price x line quantity |
| `mode_discount` | line | subscription resolved on its own entry, not via the `any` fallback, below the base unit price |
| `qty_tier` | line | a tier above 1 matched — a **zero-amount marker**, because the tier discount already sits inside the resolved unit price |
| `bundle` | line | the line carries its share of a bundle target-price discount |
| `shipping` | order | a shipping amount or an applied rule exists |
| `promo` | order | one negative component per applied discount |
| `loyalty` | — | reserved; nothing emits it |

Teaching the kernel a new component type is a two-sided change: the vocabulary
and the transport/persistence check must move in the same commit, or one half
puts a value on the wire that the other half rejects.

**Catalog list price** is a narrow special case of the same resolver: mode
`one_time`, quantity 1, region and currency from the settlement profile
(`server/domains/catalog/catalogPricingJoin.ts`). A variant with no matching
entry stays `not_configured` rather than displaying zero.

## Where the code lives
- Engine: `packages/core/src/pricing/`, exposed as `@openlup/core/pricing` —
  `PricingResolverPort`, the pricing primitive types, the breakdown, and
  `allocateBundleTargetPrice`. This is where resolution behaviour changes.
- Shared/frontend: `src/domains/pricing/`. `ports.ts`, `types.ts` and
  `targetPriceAllocation.ts` are re-export shims over the engine and carry no
  logic. `subscriptionPricePolicy.ts` is the one module still implemented here.
- Adapters: one per data capability a deployment bundle can declare, bound by
  adopter-owned composition; the extension boundary is in
  [Architecture and extension boundaries](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md).
  Consumers receive the port injected and never import an adapter, so a
  database-backed price-list resolver stays in this deployment's server domains
  rather than in the package.

## Public navigation and availability

Use [Architecture and extension boundaries](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md)
for public ownership and extension seams, and the
[publication catalog](../../../config/openlup-publication-catalog.json) for the
bounded public-source inventory. A repository path establishes source existence
at the reviewed commit; a listed `/api/...` value is a logical interface
coordinate. Mounting needs separate dispatcher or registry evidence, and even a
mounted reference interface is not proof that an adopter deployment exposes it.
