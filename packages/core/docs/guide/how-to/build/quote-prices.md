# Read prices for a quote

Compose a PostgreSQL price reader with the price authority to resolve current
quote amounts from stored price and subscription-policy histories. Supply the
installation's restricted runtime executor; the reader does not choose prices,
discounts or rounding policy for you.

## Resolve prices and adjustments

Core's `PricingResolverPort` from `@openlup/core/pricing` resolves price-list
entries asynchronously. Your adapter owns fallback choices; a missing entry
returns `null`, which your caller must report rather than silently quoting free
products. The pure breakdown builders turn supplied resolved prices, discounts
and shipping into line and order components whose sums reconcile to the totals.
They do not read prices or persist an order.

For promotion candidates, `evaluatePromos` from `@openlup/core/promo` checks
active time windows, region and cart eligibility, including coupon codes and
stacking rules. Order discounts and free shipping use separate lanes.
`evaluatePromotionAdjustmentsV2` selects product and shipping adjustments and
returns payable amounts and rejected-code facts. These pure evaluators supply
no persistence or checkout activation. Use the database ports below when your
quote needs stored prices and promotion facts.

## Compose a request scope

Import `createPostgresCommercePriceAuthorityReadPort` from
`@openlup/platform/commerce/server/postgres` and
`createConcurrentCommercePriceAuthorityPort` from `@openlup/platform/pricing`.
The executor implements `PgQueryExecutor`, imported as a type from
`@openlup/platform/data`.

For each request, pass the executor to the PostgreSQL factory, then pass the
returned `CommercePriceAuthorityReadPort` to the concurrent authority factory.
Call the resulting port's `resolvePrice` with the variant, region, currency,
channel, purchase mode and optional `atTime`. Without `atTime`, resolution uses
the current time.

The read scope shares raw histories and batches entry reads. Allocate it once
per request and discard it afterwards: it retains successful and failed reads,
so reusing it across requests can preserve stale data. Effective intervals and
policy digests are checked during each resolution.

## Preserve the price history

The read port exposes `listPriceLists`, `listExactBaseEntries`,
`listExactLegacySubscriptionEntries` and `listSubscriptionPolicyHistory`.
The PostgreSQL implementation reads active lists and active entries with an
exact base-quantity constraint, retaining their validity intervals. Consult the
[API report](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/api/commerce-server-postgres.api.md) and its linked implementation
for the selection constraint. Policies
are scoped by list, region, currency and channel.

Resolution requires a unique effective list and a unique gross base entry.
One-time purchases use that base. Subscription purchases use a validated,
effective policy revision to derive the amount. Legacy subscription entries
are considered only when the policy history is empty; an existing history
with no effective revision does not fall back to legacy pricing.

Use this authority for current quote money. Keep frozen renewal obligations
on the subscription path; do not replace their saved money with a new quote.
See the [pricing reference](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/README.md#pricing)
for the surrounding contract.

## Handle refusals

Catch `CommercePriceAuthorityError` from `@openlup/platform/pricing` and use its
`code` to distinguish the cause. Correct the stored history or request context
before trying again; choosing the newest overlapping row would hide the error.

| Condition | Code |
| --- | --- |
| No effective list, or overlapping lists | `active_price_list_not_found`, `active_price_list_ambiguous` |
| Missing or overlapping exact base entry | `base_price_not_found`, `base_price_ambiguous` |
| Base entry is not gross | `base_price_amount_kind_invalid` |
| Missing or overlapping legacy subscription entry | `legacy_subscription_price_not_found`, `legacy_subscription_price_ambiguous` |
| Policy history exists but has no unique effective revision | `subscription_price_policy_not_effective`, `subscription_price_policy_ambiguous` |
| Policy validation or digest check fails | `subscription_price_policy_invalid`, `subscription_price_policy_digest_mismatch` |

## Add advisory promotion reads

If the quote also evaluates promotions, import
`createPostgresCommercePromoDataPort` from `@openlup/platform/promotions` and
pass the runtime executor. It reads active definitions, paid-order counts,
counts by purchase mode, redemption counts and device first-order evidence.

The native device routine returns `false` because it has no persisted visitor
identity. Redemption counts group by promotion identifier and do not combine
related promotion families. Treat these reads as advisory; a false device
result does not establish first-order eligibility.
