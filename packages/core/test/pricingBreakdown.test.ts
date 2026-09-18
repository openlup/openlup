import { describe, expect, it } from "vitest";
import {
  PRICING_COMPONENT_TYPES,
  assertBreakdownInvariant,
  buildLineBreakdown,
  buildOrderBreakdown,
  type LinePricingInput,
  type OrderShippingInput,
} from "../src/pricing/index.js";

function line(overrides: Partial<LinePricingInput> = {}): LinePricingInput {
  return {
    variant_id: "variant-alpha",
    line_qty: 1,
    base_unit_price_minor: 1490,
    resolved_unit_price_minor: 1490,
    matched_tier_min_qty: 1,
    mode_at_line: "one_time",
    mode_resolved_via_fallback: false,
    ...overrides,
  };
}

const noShipping: OrderShippingInput = {
  amount_minor: 0,
  applied_rule_id: null,
  carrier_kind: null,
  vat_rate_bps: null,
};

describe("pricing breakdown", () => {
  it("emits a base component for flat pricing", () => {
    expect(buildLineBreakdown(line({ line_qty: 3 }))).toMatchObject([
      { sequence: 0, component_type: "base_unit", amount_minor: 4470, reason_code: "variant_unit_price" },
    ]);
  });

  it("separates subscription discounts and quantity markers", () => {
    const discounted = buildLineBreakdown(line({
      mode_at_line: "subscription",
      base_unit_price_minor: 1490,
      resolved_unit_price_minor: 1340,
      line_qty: 7,
    }));
    const tiered = buildLineBreakdown(line({ matched_tier_min_qty: 14, line_qty: 7 }));

    expect(discounted.find(({ component_type }) => component_type === "mode_discount"))
      .toMatchObject({ amount_minor: -1050, reason_code: "subscription_band" });
    expect(tiered.find(({ component_type }) => component_type === "qty_tier"))
      .toMatchObject({ reason_code: "qty_tier_14" });
  });

  it("does not report a mode discount for an any-mode fallback", () => {
    expect(buildLineBreakdown(line({
      mode_at_line: "subscription",
      mode_resolved_via_fallback: true,
    })).map(({ component_type }) => component_type)).toEqual(["base_unit"]);
  });

  it("keeps component and order totals equal with shipping and discounts", () => {
    const result = buildOrderBreakdown({
      lines: [line({ variant_id: "alpha", line_qty: 7 }), line({ variant_id: "beta", line_qty: 7 })],
      shipping: {
        amount_minor: 990,
        applied_rule_id: "standard",
        carrier_kind: "example-carrier",
        vat_rate_bps: 0,
      },
      discounts: [
        { promotionId: "promo-a", amountOffMinor: 500, reasonCode: "promo_a" },
        { promotionId: "promo-b", amountOffMinor: 300, reasonCode: "promo_b" },
      ],
    });
    const sum = [...result.lineBreakdowns.flatMap(({ components }) => components), ...result.orderComponents]
      .reduce((total, component) => total + component.amount_minor, 0);

    for (const lineBreakdown of result.lineBreakdowns) {
      expect(lineBreakdown.line_total_minor).toBe(
        lineBreakdown.components.reduce((total, component) => total + component.amount_minor, 0),
      );
    }
    expect(result.orderTotalMinor).toBe(1490 * 14 + 990 - 800);
    expect(result.orderTotalMinor).toBe(sum);
    expect(result.orderComponents.filter(({ component_type }) => component_type === "promo"))
      .toMatchObject([
        {
          amount_minor: -500,
          reason_code: "promo_a",
          reason_payload: { promotion_id: "promo-a", amount_off_minor: 500 },
        },
        {
          amount_minor: -300,
          reason_code: "promo_b",
          reason_payload: { promotion_id: "promo-b", amount_off_minor: 300 },
        },
      ]);
    expect(() => assertBreakdownInvariant(result, sum)).not.toThrow();
  });

  it("omits absent shipping and records an applied free rule", () => {
    expect(buildOrderBreakdown({ lines: [line()], shipping: noShipping }).orderComponents).toEqual([]);
    const free = buildOrderBreakdown({
      lines: [line()],
      shipping: { ...noShipping, applied_rule_id: "free-rule", carrier_kind: "example-carrier" },
    });
    expect(free.orderComponents).toMatchObject([
      { component_type: "shipping", amount_minor: 0, reason_code: "shipping:free-rule" },
    ]);
  });

  it("fails loudly when the caller total disagrees", () => {
    const result = buildOrderBreakdown({ lines: [line()], shipping: noShipping });
    expect(() => assertBreakdownInvariant(result, 9999)).toThrow(/components sum to 1490/);
  });

  it("keeps the public component vocabulary stable", () => {
    expect(PRICING_COMPONENT_TYPES).toEqual([
      "base_unit",
      "mode_discount",
      "qty_tier",
      "bundle",
      "promo",
      "loyalty",
      "shipping",
    ]);
  });

  it("carries a bundle's allocated share as a negative line component", () => {
    expect(buildLineBreakdown(line({ line_qty: 2, bundle_allocated_discount_minor: 380 })))
      .toMatchObject([
        { component_type: "base_unit", amount_minor: 2980 },
        {
          sequence: 1,
          component_type: "bundle",
          amount_minor: -380,
          reason_code: "bundle_target_price",
          reason_payload: { variant_id: "variant-alpha", line_qty: 2, allocated_discount_minor: 380 },
        },
      ]);
  });

  it("emits no bundle component when the line carries no allocated share", () => {
    expect(buildLineBreakdown(line({ bundle_allocated_discount_minor: 0 }))
      .map(({ component_type }) => component_type)).toEqual(["base_unit"]);
    expect(buildLineBreakdown(line()).map(({ component_type }) => component_type)).toEqual(["base_unit"]);
  });

  it("reconciles an order whose lines carry bundle allocations", () => {
    const result = buildOrderBreakdown({
      lines: [
        line({ variant_id: "alpha", line_qty: 2, bundle_allocated_discount_minor: 380 }),
        line({ variant_id: "beta", line_qty: 1, bundle_allocated_discount_minor: 120 }),
      ],
      shipping: noShipping,
    });

    expect(result.orderTotalMinor).toBe(1490 * 3 - 500);
    expect(() => assertBreakdownInvariant(result, 1490 * 3 - 500)).not.toThrow();
  });
});
