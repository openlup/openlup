/**
 * commerce-v2 W8 — End-to-end: one-time bundle 14 mix happy path.
 *
 * Composes the pure-function modules from W2 (pricing resolver), W3 (basket walidator
 * + cart_mode_consistency), W4 (pricing breakdown + invariant), W5 (promo evaluator),
 * and W6 (shipping resolver) into a single deterministic scenario. Asserts every
 * invariant the plan promises lands in production once the BFF wiring catches up.
 *
 * Scope: pure-function composition only — no DB roundtrip, no BFF route. The fixture
 * uses static catalog/price/promo/shipping data identical to the prod seed so the test
 * doubles as a regression contract for the seed → resolver path.
 */
import { describe, expect, it } from "vitest";
import {
  assertBreakdownInvariant,
  buildOrderBreakdown,
  type LinePricingInput,
} from "../../domains/commerce/pricingBreakdown.js";
import {
  validateBasketSizeConstraint,
  validateCartModeConsistency,
} from "../../domains/commerce/basketSizeConstraint.js";
import { evaluatePromos } from "../../domains/promo/promoEvaluator.js";
import { resolveShipping } from "../../domains/shipping/shippingResolver.js";

const NOW = "2026-06-03T18:00:00Z";

const FOOD_VARIANT_BASE_PRICE = 1490;
const FOOD_VARIANT_SUBSCRIPTION_PRICE = 1340;

const PROMOTIONS = [
  {
    id: "promo-first-10",
    code: null,
    name: "First Purchase 10%",
    trigger_type: "automatic" as const,
    discount_type: "percentage" as const,
    discount_value: 10,
    applies_to_kind: "order_total" as const,
    applies_to_payload: {},
    stacking_rule: "exclusive" as const,
    eligibility: { first_purchase: true },
    valid_from: "2026-06-01T00:00:00Z",
    valid_to: null,
    status: "active",
    region_availability: ["PL"],
  },
];

const SHIPPING_RULES = [
  {
    id: "rule-sub-free",
    name: "subscription_free_shipping",
    region_code: "PL",
    currency: "PLN",
    mode_at_cart: "subscription" as const,
    carrier_kind: "dhl",
    free_threshold_minor: 0,
    fixed_cost_minor: null,
    weight_threshold_g: null,
    delivery_estimate_days: 3,
    priority: 10,
    vat_rate_bps: 800,
    vat_rate_kind: "fixed" as const,
    active: true,
    valid_from: "2026-06-01T00:00:00Z",
    valid_to: null,
  },
  {
    id: "rule-one-time-standard",
    name: "one_time_pln_standard",
    region_code: "PL",
    currency: "PLN",
    mode_at_cart: "one_time" as const,
    carrier_kind: "dhl",
    free_threshold_minor: 15000,
    fixed_cost_minor: 990,
    weight_threshold_g: null,
    delivery_estimate_days: 3,
    priority: 20,
    vat_rate_bps: 800,
    vat_rate_kind: "fixed" as const,
    active: true,
    valid_from: "2026-06-01T00:00:00Z",
    valid_to: null,
  },
];

describe("E2E — one-time bundle 14 mix happy path", () => {
  it("composes pricing + size_constraint + promo + shipping into a deterministic order total", () => {
    const lines = [
      makeLine({ variant_id: "lamb", line_qty: 7 }),
      makeLine({ variant_id: "beef", line_qty: 7 }),
    ];

    // 1. Cart mode consistency (cart.mode='one_time' → all lines must be one_time)
    expect(
      validateCartModeConsistency(
        "one_time",
        lines.map((l) => ({
          variant_id: l.variant_id,
          qty: l.line_qty,
          is_addon: false,
          mode_at_line: "one_time",
        })),
      ).ok,
    ).toBe(true);

    // 2. Basket size_constraint walidator (unit_count = 14)
    expect(
      validateBasketSizeConstraint(
        { kind: "unit_count", value: 14 },
        lines.map((l) => ({ variant_id: l.variant_id, qty: l.line_qty, is_addon: false })),
      ).ok,
    ).toBe(true);

    // 3. Pricing breakdown — per-line + cart-level invariants
    const shipping = resolveShipping(
      {
        region_code: "PL",
        currency: "PLN",
        cart_mode: "one_time",
        subtotal_minor: FOOD_VARIANT_BASE_PRICE * 14,
        line_vat_rates_bps: lines.map(() => 800),
      },
      SHIPPING_RULES,
      NOW,
    );
    expect(shipping).not.toBeNull();
    // subtotal 14 × 14.90 = 208.60 PLN → above 150 PLN threshold → free shipping
    expect(shipping?.amount_minor).toBe(0);
    expect(shipping?.applied_rule_id).toBe("rule-one-time-standard");

    const breakdown = buildOrderBreakdown({
      lines,
      shipping: {
        amount_minor: shipping?.amount_minor ?? 0,
        applied_rule_id: shipping?.applied_rule_id ?? null,
        carrier_kind: shipping?.carrier_kind ?? null,
        vat_rate_bps: shipping?.vat_rate_bps ?? null,
      },
    });

    const expectedSubtotal = FOOD_VARIANT_BASE_PRICE * 14;
    const expectedOrderTotal = expectedSubtotal + 0;
    expect(breakdown.orderTotalMinor).toBe(expectedOrderTotal);
    expect(() => assertBreakdownInvariant(breakdown, expectedOrderTotal)).not.toThrow();

    for (const line of breakdown.lineBreakdowns) {
      const sum = line.components.reduce((acc, c) => acc + c.amount_minor, 0);
      expect(line.line_total_minor).toBe(sum);
    }

    // 4. Promo evaluator — first-purchase 10% applies
    const applied = evaluatePromos({
      cart: {
        region_code: "PL",
        cart_mode: "one_time",
        cart_subtotal_minor: expectedSubtotal,
        shipping_amount_minor: 0,
        client_orders_count: 0,
        applied_codes: [],
      },
      candidates: PROMOTIONS,
      now: NOW,
    });
    expect(applied).toHaveLength(1);
    expect(applied[0].promotion_id).toBe("promo-first-10");
    expect(applied[0].amount_off_minor).toBe(Math.floor((expectedSubtotal * 10) / 100));

    // 5. Discounted breakdown — fold the applied promo back into the order components so
    // the persisted order.total_minor reconciles to subtotal + shipping − discount.
    const discountedBreakdown = buildOrderBreakdown({
      lines,
      shipping: {
        amount_minor: shipping?.amount_minor ?? 0,
        applied_rule_id: shipping?.applied_rule_id ?? null,
        carrier_kind: shipping?.carrier_kind ?? null,
        vat_rate_bps: shipping?.vat_rate_bps ?? null,
      },
      discounts: applied.map((a) => ({
        promotionId: a.promotion_id,
        amountOffMinor: a.amount_off_minor,
        reasonCode: `promo:${a.promotion_id}`,
      })),
    });

    const discountedTotal = expectedSubtotal + 0 - applied[0].amount_off_minor;
    const allComponents = [
      ...discountedBreakdown.lineBreakdowns.flatMap((l) => l.components),
      ...discountedBreakdown.orderComponents,
    ];
    const componentSum = allComponents.reduce((acc, c) => acc + c.amount_minor, 0);
    expect(componentSum).toBe(discountedTotal);
    expect(discountedBreakdown.orderTotalMinor).toBe(discountedTotal);
    expect(() => assertBreakdownInvariant(discountedBreakdown, discountedTotal)).not.toThrow();

    const promoComponent = discountedBreakdown.orderComponents.find(
      (c) => c.component_type === "promo",
    );
    expect(promoComponent?.amount_minor).toBe(-applied[0].amount_off_minor);
  });
});

function makeLine(overrides: Partial<LinePricingInput>): LinePricingInput {
  return {
    variant_id: "variant-base",
    line_qty: 1,
    base_unit_price_minor: FOOD_VARIANT_BASE_PRICE,
    resolved_unit_price_minor: FOOD_VARIANT_BASE_PRICE,
    matched_tier_min_qty: 1,
    mode_at_line: "one_time",
    mode_resolved_via_fallback: false,
    ...overrides,
  };
}

describe("E2E — subscription mixed-mode cart (food sub + ad-hoc addon one_time)", () => {
  it("emits a mode_discount component only for subscription lines, not for the ad-hoc add-on", () => {
    const lines: LinePricingInput[] = [
      {
        variant_id: "lamb",
        line_qty: 14,
        base_unit_price_minor: FOOD_VARIANT_BASE_PRICE,
        resolved_unit_price_minor: FOOD_VARIANT_SUBSCRIPTION_PRICE,
        matched_tier_min_qty: 1,
        mode_at_line: "subscription",
        mode_resolved_via_fallback: false,
      },
      {
        variant_id: "addon_treat",
        line_qty: 1,
        base_unit_price_minor: 500,
        resolved_unit_price_minor: 500,
        matched_tier_min_qty: 1,
        mode_at_line: "one_time",
        mode_resolved_via_fallback: false,
      },
    ];

    const shipping = resolveShipping(
      {
        region_code: "PL",
        currency: "PLN",
        cart_mode: "subscription",
        subtotal_minor: FOOD_VARIANT_SUBSCRIPTION_PRICE * 14 + 500,
        line_vat_rates_bps: [800, 800],
      },
      SHIPPING_RULES,
      NOW,
    );
    expect(shipping?.amount_minor).toBe(0);
    expect(shipping?.applied_rule_id).toBe("rule-sub-free");

    const breakdown = buildOrderBreakdown({
      lines,
      shipping: {
        amount_minor: 0,
        applied_rule_id: shipping?.applied_rule_id ?? null,
        carrier_kind: shipping?.carrier_kind ?? null,
        vat_rate_bps: shipping?.vat_rate_bps ?? null,
      },
    });

    const foodLine = breakdown.lineBreakdowns[0];
    const addonLine = breakdown.lineBreakdowns[1];

    expect(foodLine.components.some((c) => c.component_type === "mode_discount")).toBe(true);
    expect(addonLine.components.some((c) => c.component_type === "mode_discount")).toBe(false);

    // Total = 14 × 13.40 (sub) + 1 × 5.00 (addon) + 0 shipping = 187.60 + 5.00 = 192.60
    expect(breakdown.orderTotalMinor).toBe(FOOD_VARIANT_SUBSCRIPTION_PRICE * 14 + 500);
  });
});
