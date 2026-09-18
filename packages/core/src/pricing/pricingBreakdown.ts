/**
 * Pricing breakdown builder — pure functions that emit signed pricing components for
 * a given (cart, resolved unit price) tuple. Sums always reconcile to the order /
 * order_line totals via two persistence-ready invariants:
 *
 *   perLine:  sum(line_components.amount) = order_line.line_total_minor
 *   perOrder: sum(all_components.amount)  = order.total_minor (including shipping)
 *
 * Current components: base_unit (always), mode_discount (when subscription resolves
 * below the base unit price), qty_tier (when a quantity tier above 1 matched),
 * bundle (line-scoped and negative, carrying the share of a composed bundle's
 * target-price discount that the allocator assigned to this line), shipping
 * (order-scoped, when a rule or non-zero amount applies), and promo (one negative
 * order-scoped component per applied discount). loyalty remains a reserved
 * component type for downstream engines.
 */

/** @beta */
export const PRICING_COMPONENT_TYPES = [
  "base_unit",
  "mode_discount",
  "qty_tier",
  "bundle",
  "promo",
  "loyalty",
  "shipping",
] as const;
/** @beta */
export type PricingComponentType = (typeof PRICING_COMPONENT_TYPES)[number];

/** @beta */
export interface PricingComponent {
  sequence: number;
  component_type: PricingComponentType;
  amount_minor: number;
  reason_code: string;
  reason_payload: Record<string, unknown>;
}

/** @beta */
export interface LinePricingInput {
  variant_id: string;
  line_qty: number;
  base_unit_price_minor: number;
  resolved_unit_price_minor: number;
  matched_tier_min_qty: number;
  mode_at_line: "one_time" | "subscription";
  mode_resolved_via_fallback: boolean;
  /**
   * Positive amount-off this line carries because it is a component of a bundle sold
   * at one target price — `discountAllocatedMinor` from the target-price allocator,
   * already summed over the one or two lines a component may split into. Positive on
   * the way in, exactly like an order discount; the emitted component carries it as a
   * negative adjustment. Absent or zero emits nothing.
   */
  bundle_allocated_discount_minor?: number;
}

/** @beta */
export interface OrderShippingInput {
  amount_minor: number;
  applied_rule_id: string | null;
  carrier_kind: string | null;
  vat_rate_bps: number | null;
}

/** @beta */
export interface OrderDiscountInput {
  promotionId: string;
  amountOffMinor: number;
  reasonCode: string;
}

/** @beta */
export interface BuildOrderBreakdownInput {
  lines: ReadonlyArray<LinePricingInput>;
  shipping: OrderShippingInput;
  discounts?: ReadonlyArray<OrderDiscountInput>;
}

/** @beta */
export interface BuildOrderBreakdownResult {
  lineBreakdowns: Array<{
    variant_id: string;
    line_total_minor: number;
    components: PricingComponent[];
  }>;
  orderComponents: PricingComponent[];
  orderTotalMinor: number;
}

const ZERO_SHIPPING: OrderShippingInput = {
  amount_minor: 0,
  applied_rule_id: null,
  carrier_kind: null,
  vat_rate_bps: null,
};

/** @beta */
export function buildLineBreakdown(input: LinePricingInput): PricingComponent[] {
  const components: PricingComponent[] = [];
  let sequence = 0;

  // 1) Base unit price: positive, the cost-floor everything else adjusts against.
  components.push({
    sequence: sequence++,
    component_type: "base_unit",
    amount_minor: input.base_unit_price_minor * input.line_qty,
    reason_code: "variant_unit_price",
    reason_payload: {
      variant_id: input.variant_id,
      line_qty: input.line_qty,
      base_unit_price_minor: input.base_unit_price_minor,
    },
  });

  // 2) Mode discount: negative if subscription got a dedicated entry below `any`.
  if (
    input.mode_at_line === "subscription" &&
    !input.mode_resolved_via_fallback &&
    input.resolved_unit_price_minor < input.base_unit_price_minor
  ) {
    const delta = (input.resolved_unit_price_minor - input.base_unit_price_minor) * input.line_qty;
    components.push({
      sequence: sequence++,
      component_type: "mode_discount",
      amount_minor: delta,
      reason_code: "subscription_band",
      reason_payload: {
        unit_delta_minor: input.resolved_unit_price_minor - input.base_unit_price_minor,
        line_qty: input.line_qty,
      },
    });
  }

  // 3) Quantity tier: negative if eligibleCartQty crossed a tier breakpoint above 1.
  // The qty-tier discount value is encoded in the resolver's matched_tier price already, so
  // the component only fires when matched_tier_min_qty > 1 AND we have not already applied
  // the full delta via mode_discount.
  if (
    input.matched_tier_min_qty > 1 &&
    input.resolved_unit_price_minor === input.base_unit_price_minor
  ) {
    components.push({
      sequence: sequence++,
      component_type: "qty_tier",
      amount_minor: 0,
      reason_code: `qty_tier_${input.matched_tier_min_qty}`,
      reason_payload: { matched_tier_min_qty: input.matched_tier_min_qty },
    });
  }

  // 4) Bundle allocation: negative, the share of a bundle's target-price discount the
  // allocator assigned to this line. It is line-scoped rather than order-scoped because
  // a bundle prices a subset of the cart, and a refund of one line must return exactly
  // the money that line was charged.
  const bundleDiscount = input.bundle_allocated_discount_minor ?? 0;
  if (bundleDiscount !== 0) {
    components.push({
      sequence: sequence++,
      component_type: "bundle",
      amount_minor: -bundleDiscount,
      reason_code: "bundle_target_price",
      reason_payload: {
        variant_id: input.variant_id,
        line_qty: input.line_qty,
        allocated_discount_minor: bundleDiscount,
      },
    });
  }

  return components;
}

/** @beta */
export function buildOrderBreakdown(
  input: BuildOrderBreakdownInput,
): BuildOrderBreakdownResult {
  const shipping = input.shipping ?? ZERO_SHIPPING;
  const lineBreakdowns = input.lines.map((line) => {
    const components = buildLineBreakdown(line);
    const line_total_minor = components.reduce((sum, c) => sum + c.amount_minor, 0);
    return { variant_id: line.variant_id, line_total_minor, components };
  });

  const orderComponents: PricingComponent[] = [];
  let orderSequence = 0;
  if (shipping.amount_minor !== 0 || shipping.applied_rule_id !== null) {
    orderComponents.push({
      sequence: orderSequence++,
      component_type: "shipping",
      amount_minor: shipping.amount_minor,
      reason_code: shipping.applied_rule_id ? `shipping:${shipping.applied_rule_id}` : "shipping:zero",
      reason_payload: {
        applied_rule_id: shipping.applied_rule_id,
        carrier_kind: shipping.carrier_kind,
        vat_rate_bps: shipping.vat_rate_bps,
      },
    });
  }

  // Order-scoped promo: one negative component per applied discount so the order total
  // reconciles to the discounted price. amount_off is positive on the way in; the
  // component carries it as a negative adjustment against the line + shipping subtotal.
  for (const discount of input.discounts ?? []) {
    orderComponents.push({
      sequence: orderSequence++,
      component_type: "promo",
      amount_minor: -discount.amountOffMinor,
      reason_code: discount.reasonCode,
      reason_payload: {
        promotion_id: discount.promotionId,
        amount_off_minor: discount.amountOffMinor,
      },
    });
  }

  const lineTotal = lineBreakdowns.reduce((sum, l) => sum + l.line_total_minor, 0);
  const orderComponentsTotal = orderComponents.reduce((sum, c) => sum + c.amount_minor, 0);

  return {
    lineBreakdowns,
    orderComponents,
    orderTotalMinor: lineTotal + orderComponentsTotal,
  };
}

/**
 * Cart-level invariant: every order's total_minor equals the sum of all components
 * (line + order-level). Callers must assert this before persisting to commerce_orders
 * to prevent a sale from going out with a hidden price-snapshot drift.
 */
/** @beta */
export function assertBreakdownInvariant(
  result: BuildOrderBreakdownResult,
  orderTotalMinor: number,
): void {
  if (result.orderTotalMinor !== orderTotalMinor) {
    throw new Error(
      `Pricing breakdown invariant broken: components sum to ${result.orderTotalMinor} but order.total_minor is ${orderTotalMinor}`,
    );
  }
}
