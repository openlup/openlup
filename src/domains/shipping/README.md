# shipping domain

Two independent jobs live here: resolving **how much** shipping costs, and
resolving **which delivery method** a customer may pick. They are resolved by
different code on different inputs, and only the second one is wired into a live
checkout today.

## Owns / does not own
- **Owns:** shipping rule selection + amount/VAT logic (`shippingResolver.ts`), delivery option contracts, normalized pickup-point validation/search contracts, carrier tracking/evidence-to-URL resolution, and the InPost Geowidget loader/point mapper.
- **Does not own:** DB `shipping_rules` storage, carrier execution (`fulfillment`), OmniPack dispatch, or admin flat-rate persistence.

## Public surface (import cross-domain ONLY these)
- `types.ts` — `ShippingRule`, `ShippingResolverCart`, `ResolvedShipping`.
- `contracts.ts` — public re-export for hidden delivery option, pickup-point validation, and carrier tracking URL schemas/helpers.
- `deliverySelectionContracts.ts` — internal schema implementation re-exported by `contracts.ts`.
- `deliverySelectionClient.ts` — browser client for hidden shipping BFF routes.
- `pickupPointSearchContracts.ts` — normalized pickup-point search request/response schemas.
- `carrierTrackingUrls.ts` — provider-neutral carrier evidence normalization and public tracking URL resolver, re-exported by `contracts.ts`.
- `inpostGeowidgetLoader.ts` and `inpostGeowidgetPoint.ts` — InPost Geowidget token/config loader and point-to-pickup mapper.
- `shippingResolver.ts` — the resolver entry point. A one-line re-export shim;
  see **Where the code lives**.

## How the shipping amount resolves

`resolveShipping` (`packages/core/src/shipping/shippingResolver.ts`) is a pure
rule engine over a rule set the host supplies:

1. Keep rules that are active, match the cart's region and currency, and whose
   validity window covers the given instant.
2. Keep rules whose cart mode matches the cart, plus `any` fallbacks.
3. Sort: an exact cart-mode rule beats an `any` fallback; within the same
   bucket the **lower** priority number wins.
4. No eligible rule → `null`. The host owns the fallback, not the engine.

Amount: a configured free threshold makes shipping free once the cart subtotal
reaches it; otherwise the rule's fixed cost applies, and a null fixed cost means
the rule is always free. So a "free delivery this week" rule is a row, not a
code change.

VAT is snapshotted at resolve time, one of three kinds: `fixed` takes the rule's
own rate, `inherit_main_goods` takes the most common line rate in the cart, and
`highest_in_cart` takes the maximum line rate as a defensive accounting choice.
An empty line-rate list falls back to the rule's own rate in all three.

⚠️ The rule's weight threshold and the cart's total weight are carried in the
types and in the table, but the resolver **ignores both** — no rule is ever
dropped for being too heavy.

**Wiring status.** Nothing in the runtime calls `resolveShipping`, and no server
code reads `shipping_rules`; the table exists (migration
`20260603165725_commerce_v2_w6_customer_shipping.sql`, mirrored exactly by
`ShippingRule`); a deployment-only seed script adds two rules for local and
verify runs. A live quote instead prices shipping as a **flat per-order gross**
read from `commerce_settings`
(`getShippingFlatMinor`, `server/domains/commerce/dbBackedCommerceQuotePort.ts`),
resolved before promotions so a shipping-lane discount has a real amount to
zero. Discounts are then summed in two independent lanes — shipping and
everything else — and the quote validates them separately. Operators change the
flat amount through `server/domains/commerce/adminShippingRateHandler.ts`.

## How the delivery method resolves

A separate composition root, `resolveDeliverySelectionPort`
(`server/bff/shipping/deliverySelectionFactory.ts`), decides what the customer
may choose:

- A valid merchant dictionary in the environment wins. Because a dictionary may
  carry a provider's entire portfolio, the operator allowlist is **required**
  there; unset means fail-closed.
- Otherwise the option set declared in code
  (`OMNIPACK_DELIVERY_OPTIONS` in `deliverySelectionContracts.ts`) is the
  merchant-confirmed list. An unset allowlist means every declared option; a set
  one can only **narrow** that list, never widen it.

⛔ Do not "unify" those two allowlist semantics by making the declared set
fail-closed: production leaves the allowlist unset, so that would drop checkout
to zero delivery options.

Each option declares its delivery kind and whether it needs a pickup point or a
street address, and each entry keeps its carrier code equal to its service code
— a provider invariant the option schema enforces. Where the carrier supports
it, a chosen pickup-point code is confirmed against the carrier before it is
accepted, rather than trusting the browser-supplied string.

## Where the code lives
- Engine: `packages/core/src/shipping/{shippingResolver,types}.ts`, exposed as
  `@openlup/core/shipping` — `resolveShipping` plus the rule, cart and resolved
  shipping types. Rule selection and amount/VAT arithmetic change there.
  `shippingResolver.ts` and `types.ts` in this directory forward those names and
  hold no logic of their own.
- Shared/frontend: `src/domains/shipping/` — delivery-selection and pickup-point
  contracts, the carrier tracking-URL resolver, the browser clients, and the
  parcel-locker map loader/mapper
- Server/static or dictionary-backed BFF foundation: `server/domains/shipping/`
  and `server/bff/shipping/`, exposed through `/api/bff/shipping/`
- Admin flat shipping-rate mutation is currently composed through
  `server/bff/admin/commerce/shipping-rate.ts`.

Domain-boundary rules live in the maintainer canon `DOMAIN_ARCHITECTURE.md`,
which belongs to the private overlay and is not part of the published tree.
