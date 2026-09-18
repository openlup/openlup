import { describe, expect, it } from "vitest";
import {
  PRICING_AMOUNT_KINDS,
  PRICING_MODES,
  allocateBundleTargetPrice,
  assertBreakdownInvariant,
  buildOrderBreakdown,
  PricingResolverNotConfiguredError,
} from "@openlup/core/pricing";
import { createNullPricingResolverPort } from "./nullAdapters.js";

describe("pricing standalone smoke", () => {
  it("exposes neutral pricing primitives and resolver port behavior", async () => {
    expect(PRICING_MODES).toEqual(["one_time", "subscription", "any"]);
    expect(PRICING_AMOUNT_KINDS).toEqual(["gross", "net"]);

    const resolver = createNullPricingResolverPort();
    await expect(resolver.resolvePrice({
      variantId: "core-alpha",
      mode: "subscription",
      lineQty: 1,
      eligibleCartQty: 2,
      regionCode: "EXAMPLE",
      currency: "USD",
    })).resolves.toMatchObject({
      variantId: "core-alpha",
      mode: "subscription",
      unitPriceMinor: 2100,
    });
    await expect(resolver.resolvePrice({
      variantId: "missing",
      mode: "one_time",
      lineQty: 1,
      eligibleCartQty: 1,
      regionCode: "EXAMPLE",
      currency: "USD",
    })).resolves.toBeNull();
  });

  it("keeps missing-price errors contextual without seller defaults", () => {
    const error = new PricingResolverNotConfiguredError({
      variantId: "variant-example",
      mode: "one_time",
      lineQty: 1,
      eligibleCartQty: 1,
      regionCode: "EXAMPLE",
      currency: "USD",
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PricingResolverNotConfiguredError");
    expect(error.message).toContain("variant-example");
    expect(error.message).toContain("one_time");
    expect(error.message).toContain("EXAMPLE/USD");
  });

  it("builds a neutral order pricing breakdown with subscription and promo components", () => {
    const breakdown = buildOrderBreakdown({
      lines: [
        {
          variant_id: "core-alpha",
          line_qty: 2,
          base_unit_price_minor: 1200,
          resolved_unit_price_minor: 1000,
          matched_tier_min_qty: 1,
          mode_at_line: "subscription",
          mode_resolved_via_fallback: false,
        },
      ],
      shipping: {
        amount_minor: 300,
        applied_rule_id: "standard",
        carrier_kind: "neutral-carrier",
        vat_rate_bps: 0,
      },
      discounts: [
        { promotionId: "promo-neutral", amountOffMinor: 100, reasonCode: "neutral_credit" },
      ],
    });

    expect(breakdown.lineBreakdowns[0]?.components.map((component) => component.component_type)).toEqual([
      "base_unit",
      "mode_discount",
    ]);
    expect(breakdown.orderComponents.map((component) => component.component_type)).toEqual([
      "shipping",
      "promo",
    ]);
    expect(breakdown.orderTotalMinor).toBe(2200);
    expect(() => assertBreakdownInvariant(breakdown, 2200)).not.toThrow();
  });

  it("allocates a bundle target price down to exact per-component money", () => {
    const allocation = allocateBundleTargetPrice({
      components: [
        { sku: "CORE-ALPHA", unitPriceMinor: 1200, quantity: 3 },
        { sku: "CORE-BETA", unitPriceMinor: 700, quantity: 1 },
      ],
      targetPriceMinor: 4000,
    });

    expect(allocation).toMatchObject({ ok: true, referenceTotalMinor: 4300, discountTotalMinor: 300 });
    expect(allocation.ok && allocation.lines.reduce((total, line) => total + line.lineSubtotalMinor, 0))
      .toBe(4000);
    expect(allocation.ok && allocation.lines.every(
      (line) => line.effectiveUnitPriceMinor * line.quantity === line.lineSubtotalMinor,
    )).toBe(true);
  });
});
