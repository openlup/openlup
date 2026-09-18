import type {
  ResolvedShipping,
  ShippingResolverCart,
  ShippingRule,
} from "./types.js";

/**
 * Pure shipping resolver. It picks the most specific active shipping rule for a
 * cart's region, currency, and cart mode, then computes the shipping amount and
 * VAT-rate snapshot. Provider selection, pickup points, labels, and fulfillment
 * side effects stay outside this package.
 *
 * Resolution order:
 * 1. Filter by active + region + currency + validity window.
 * 2. Prefer an exact cart-mode rule over an `any` fallback.
 * 3. Within the same mode bucket, lower priority wins.
 * 4. Return null when no rule matches; the host application owns fallback UI or
 *    operational errors.
 *
 * Amount:
 * - A configured free threshold makes shipping free once the cart subtotal meets
 *   or exceeds it.
 * - Otherwise, fixed_cost_minor is used; null means this rule is always free.
 *
 * VAT rate snapshot:
 * - `fixed` uses the rule's vat_rate_bps.
 * - `inherit_main_goods` uses the most common line VAT rate.
 * - `highest_in_cart` uses the max line VAT rate as a defensive accounting rule.
 */
/** @beta */
export function resolveShipping(
  cart: ShippingResolverCart,
  rules: ReadonlyArray<ShippingRule>,
  now: string,
): ResolvedShipping | null {
  const eligible = rules
    .filter((r) => r.active)
    .filter((r) => r.region_code === cart.region_code)
    .filter((r) => r.currency === cart.currency)
    .filter((r) => r.valid_from <= now && (r.valid_to === null || r.valid_to >= now))
    .filter((r) => r.mode_at_cart === cart.cart_mode || r.mode_at_cart === "any");

  if (eligible.length === 0) return null;

  const sorted = [...eligible].sort((a, b) => {
    // Exact mode match beats the cross-mode fallback.
    const aSpecific = a.mode_at_cart === cart.cart_mode ? 0 : 1;
    const bSpecific = b.mode_at_cart === cart.cart_mode ? 0 : 1;
    if (aSpecific !== bSpecific) return aSpecific - bSpecific;
    return a.priority - b.priority;
  });

  const rule = sorted[0];
  const amount = computeAmount(rule, cart);
  const vatRate = resolveVatRate(rule, cart);

  return {
    amount_minor: amount,
    carrier_kind: rule.carrier_kind,
    delivery_estimate_days: rule.delivery_estimate_days,
    applied_rule_id: rule.id,
    applied_rule_name: rule.name,
    vat_rate_bps: vatRate,
  };
}

function computeAmount(rule: ShippingRule, cart: ShippingResolverCart): number {
  if (rule.free_threshold_minor !== null && cart.subtotal_minor >= rule.free_threshold_minor) {
    return 0;
  }
  return rule.fixed_cost_minor ?? 0;
}

function resolveVatRate(rule: ShippingRule, cart: ShippingResolverCart): number {
  switch (rule.vat_rate_kind) {
    case "fixed":
      return rule.vat_rate_bps;
    case "highest_in_cart":
      return cart.line_vat_rates_bps.length === 0
        ? rule.vat_rate_bps
        : Math.max(...cart.line_vat_rates_bps);
    case "inherit_main_goods": {
      if (cart.line_vat_rates_bps.length === 0) return rule.vat_rate_bps;
      const counts = new Map<number, number>();
      for (const rate of cart.line_vat_rates_bps) {
        counts.set(rate, (counts.get(rate) ?? 0) + 1);
      }
      let dominantRate = rule.vat_rate_bps;
      let dominantCount = 0;
      for (const [rate, count] of counts) {
        if (count > dominantCount) {
          dominantRate = rate;
          dominantCount = count;
        }
      }
      return dominantRate;
    }
    default:
      return rule.vat_rate_bps;
  }
}
