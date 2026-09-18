import { describe, expect, it } from "vitest";
import { resolveShipping } from "./shippingResolver.js";
import type { ShippingResolverCart, ShippingRule } from "./types.js";

const NOW = "2026-06-03T14:00:00Z";

function makeRule(overrides: Partial<ShippingRule> = {}): ShippingRule {
  return {
    id: "rule-base",
    name: "base",
    region_code: "PL",
    currency: "PLN",
    mode_at_cart: "any",
    carrier_kind: "dhl",
    free_threshold_minor: null,
    fixed_cost_minor: 990,
    weight_threshold_g: null,
    delivery_estimate_days: 3,
    priority: 100,
    vat_rate_bps: 800,
    vat_rate_kind: "fixed",
    active: true,
    valid_from: "2026-06-01T00:00:00Z",
    valid_to: null,
    ...overrides,
  };
}

function makeCart(overrides: Partial<ShippingResolverCart> = {}): ShippingResolverCart {
  return {
    region_code: "PL",
    currency: "PLN",
    cart_mode: "one_time",
    subtotal_minor: 5000,
    line_vat_rates_bps: [800],
    ...overrides,
  };
}

describe("resolveShipping — rule selection", () => {
  it("picks the subscription rule for a subscription cart even when an any rule exists", () => {
    const subRule = makeRule({
      id: "sub-free",
      name: "subscription_free_shipping",
      mode_at_cart: "subscription",
      fixed_cost_minor: null,
      free_threshold_minor: 0,
      priority: 10,
    });
    const anyRule = makeRule({
      id: "any-paid",
      name: "any_paid",
      mode_at_cart: "any",
      fixed_cost_minor: 1500,
      priority: 50,
    });
    const resolved = resolveShipping(
      makeCart({ cart_mode: "subscription" }),
      [subRule, anyRule],
      NOW,
    );

    expect(resolved?.applied_rule_id).toBe("sub-free");
    expect(resolved?.amount_minor).toBe(0);
  });

  it("falls back to any when no rule for the cart_mode is active", () => {
    const onlyAny = makeRule({
      id: "any",
      mode_at_cart: "any",
      fixed_cost_minor: 1500,
    });
    const resolved = resolveShipping(
      makeCart({ cart_mode: "subscription" }),
      [onlyAny],
      NOW,
    );

    expect(resolved?.applied_rule_id).toBe("any");
    expect(resolved?.amount_minor).toBe(1500);
  });

  it("returns null when no rule matches the region/currency", () => {
    const resolved = resolveShipping(
      makeCart({ region_code: "PL", currency: "PLN" }),
      [makeRule({ region_code: "EU", currency: "EUR" })],
      NOW,
    );

    expect(resolved).toBeNull();
  });

  it("respects active flag and validity window", () => {
    const rules = [
      makeRule({ id: "inactive", active: false, priority: 1 }),
      makeRule({ id: "future", valid_from: "2027-01-01T00:00:00Z", priority: 1 }),
      makeRule({ id: "expired", valid_to: "2025-01-01T00:00:00Z", priority: 1 }),
      makeRule({ id: "ok", priority: 50 }),
    ];
    const resolved = resolveShipping(makeCart(), rules, NOW);

    expect(resolved?.applied_rule_id).toBe("ok");
  });
});

describe("resolveShipping — amount", () => {
  it("free when subtotal >= free_threshold", () => {
    const rule = makeRule({
      free_threshold_minor: 15000,
      fixed_cost_minor: 990,
    });
    const resolved = resolveShipping(makeCart({ subtotal_minor: 20000 }), [rule], NOW);

    expect(resolved?.amount_minor).toBe(0);
  });

  it("paid when subtotal < free_threshold", () => {
    const rule = makeRule({
      free_threshold_minor: 15000,
      fixed_cost_minor: 990,
    });
    const resolved = resolveShipping(makeCart({ subtotal_minor: 5000 }), [rule], NOW);

    expect(resolved?.amount_minor).toBe(990);
  });

  it("zero when fixed_cost_minor is NULL (always-free rule)", () => {
    const rule = makeRule({
      free_threshold_minor: 0,
      fixed_cost_minor: null,
    });
    const resolved = resolveShipping(makeCart({ subtotal_minor: 100 }), [rule], NOW);

    expect(resolved?.amount_minor).toBe(0);
  });
});

describe("resolveShipping — vat snapshot", () => {
  it("fixed kind uses rule.vat_rate_bps verbatim", () => {
    const rule = makeRule({ vat_rate_bps: 800, vat_rate_kind: "fixed" });
    const resolved = resolveShipping(
      makeCart({ line_vat_rates_bps: [2300, 2300, 2300] }),
      [rule],
      NOW,
    );

    expect(resolved?.vat_rate_bps).toBe(800);
  });

  it("inherit_main_goods picks the dominant rate from the cart lines", () => {
    const rule = makeRule({ vat_rate_kind: "inherit_main_goods", vat_rate_bps: 800 });
    const resolved = resolveShipping(
      makeCart({ line_vat_rates_bps: [800, 800, 800, 2300] }),
      [rule],
      NOW,
    );

    expect(resolved?.vat_rate_bps).toBe(800);
  });

  it("highest_in_cart picks the maximum rate", () => {
    const rule = makeRule({ vat_rate_kind: "highest_in_cart", vat_rate_bps: 800 });
    const resolved = resolveShipping(
      makeCart({ line_vat_rates_bps: [800, 800, 2300] }),
      [rule],
      NOW,
    );

    expect(resolved?.vat_rate_bps).toBe(2300);
  });
});
