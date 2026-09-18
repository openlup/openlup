import { describe, expect, it } from "vitest";
import { resolveShipping, type ShippingResolverCart, type ShippingRule } from "@openlup/core/shipping";

const NOW = "2026-07-01T10:00:00Z";

describe("shipping resolver standalone smoke", () => {
  it("resolves a neutral shipping rule and inherited tax snapshot", () => {
    const resolved = resolveShipping(
      cart({ subtotal_minor: 7500, line_vat_rates_bps: [500, 500, 2000] }),
      [
        rule({ id: "fallback", mode_at_cart: "any", fixed_cost_minor: 1200, priority: 50 }),
        rule({
          id: "subscription",
          mode_at_cart: "subscription",
          carrier_kind: "neutral-carrier",
          fixed_cost_minor: 0,
          priority: 10,
          vat_rate_kind: "inherit_main_goods",
        }),
      ],
      NOW,
    );

    expect(resolved).toMatchObject({
      amount_minor: 0,
      carrier_kind: "neutral-carrier",
      applied_rule_id: "subscription",
      vat_rate_bps: 500,
    });
  });
});

function cart(overrides: Partial<ShippingResolverCart> = {}): ShippingResolverCart {
  return {
    region_code: "EXAMPLE",
    currency: "USD",
    cart_mode: "subscription",
    subtotal_minor: 5000,
    line_vat_rates_bps: [500],
    ...overrides,
  };
}

function rule(overrides: Partial<ShippingRule> = {}): ShippingRule {
  return {
    id: "rule",
    name: "Rule",
    region_code: "EXAMPLE",
    currency: "USD",
    mode_at_cart: "any",
    carrier_kind: "neutral-carrier",
    free_threshold_minor: null,
    fixed_cost_minor: 900,
    weight_threshold_g: null,
    delivery_estimate_days: 3,
    priority: 100,
    vat_rate_bps: 500,
    vat_rate_kind: "fixed",
    active: true,
    valid_from: "2026-01-01T00:00:00Z",
    valid_to: null,
    ...overrides,
  };
}
