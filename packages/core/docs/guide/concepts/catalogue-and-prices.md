# Catalogue and prices

Keep product identity, permission to sell and quoted money separate when
building a storefront or checkout.

## Products and trade items

The native catalogue separates a product from its SKUs. A product has a slug
and a declared primary SKU; each SKU belongs to a product and carries its own
code, net content, identifiers and purchase-mode sellability. The quote reader
uses the SKU's identifier as `variantId`; a storefront item is a projection
with display and purchase facts, rather than another product identity.

The neutral SKU envelope carries product-scoped document references, not the
document payload. Looking up a product slug follows its declared primary SKU;
it does not infer a default from row order. An invalid primary relationship
refuses with `catalog_sku_authority_primary_sku_invalid`.

## Sellability and availability

The commerce catalogue reader selects active SKUs sellable in a purchase mode
and excludes inactive products. Public discovery can include active SKUs that
are temporarily unsellable. The quote engine checks the requested mode and
refuses an absent SKU, mismatched variant or disallowed mode with `UNKNOWN_SKU`.

Sellability does not establish stock availability: inventory computes available
stock after reservations, unavailable units and safety stock. See
[fulfillment](../how-to/build/fulfillment.md) for reservation composition and
[bundles](../how-to/build/bundles.md) for composition and activation rules.

The quote catalogue reader requires host document verification and checks
current references, but does not establish a publication-wide snapshot.

## Price data and history

A price list scopes entries by region, currency and validity window. An entry
attaches a unit amount in minor units, amount kind, purchase mode, minimum
quantity and its own validity window to a variant. Resolved prices retain the
list and entry identities and resolution time.

The generic resolver contract distinguishes the line quantity from the eligible
cart quantity used to select a tier; fallback policy belongs to its adapter.
The strict commerce authority instead resolves an exact base price and, for
subscriptions, a policy history or legacy observation. These are distinct
resolution paths: see [Read prices for a quote](../how-to/build/quote-prices.md)
for selection, history, ambiguity refusals and request-scoped reads.

The database-backed quote refuses a subscription price above its corresponding
one-time price with `PRICING_INVARIANT_VIOLATION`.

## Promotions

Promotion evaluation adjusts supplied quote amounts; it does not rewrite price
entries. Core's evaluators compute discounts from supplied candidates and cart
facts; they do not persist redemptions. The adjustment engine evaluates product
and shipping lanes separately and requires a caller-supplied product payable
floor. Quote reads do not reserve promotion capacity.

Use the [quote how-to](../how-to/build/quote-prices.md#add-advisory-promotion-reads)
for the native eligibility-read limits. Consult [maturity](../reference/maturity.md),
[exports](../reference/exports.md), [configuration](../reference/configuration.md),
[refusal codes](../reference/refusal-codes.md) and
[limits](../reference/limits.md#catalogue-and-runtime-limits) before composing
the application.
