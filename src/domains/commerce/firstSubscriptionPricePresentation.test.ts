import { describe, expect, it } from "vitest";

import { deriveOrderMoney } from "./orderMoney.js";
import { deriveFirstSubscriptionPricePresentation } from "./firstSubscriptionPricePresentation.js";

const metadata = {
  orderDraftSnapshot: {
    discounts: [{ customerSemantic: "first_subscription_50" }],
  },
};

const quantities = [6, 6, 6, 6, 6, 7];
const snapshots = quantities.map((quantity) => ({
  quoteLine: {
    pricingComponents: [{
      scope: "line",
      componentType: "base_unit",
      amountMinor: quantity * 1490,
    }],
  },
}));

function money(overrides: Partial<Parameters<typeof deriveOrderMoney>[0]> = {}) {
  return deriveOrderMoney({
    id: "order-1",
    currency: "EUR",
    subtotal_cents: 49_580,
    discount_cents: 22_015,
    shipping_cents: 1_500,
    shipping_discount_cents: 1_500,
    tax_cents: 0,
    total_cents: 27_565,
    ...overrides,
  }, snapshots.map((snapshot, index) => {
    const catalogTotal = index === snapshots.length - 1 ? 9_380 : 8_040;
    const effectiveTotal = index === snapshots.length - 1 ? 7_465 : 4_020;
    return ({
    id: `line-${index}`,
    quantity: 1,
    unit_price_cents: catalogTotal,
    total_cents: catalogTotal,
    discount_allocated_cents: catalogTotal - effectiveTotal,
    effective_total_cents: effectiveTotal,
    effective_net_cents: effectiveTotal,
    vat_rate_bps: 0,
    product_snapshot: snapshot,
    });
  }));
}

describe("deriveFirstSubscriptionPricePresentation", () => {
  it("reconciles the settled first-subscription offer against its frozen catalogue anchor", () => {
    expect(deriveFirstSubscriptionPricePresentation({
      metadata,
      productSnapshots: snapshots,
      money: money(),
      checkoutKind: "subscription_initial",
    })).toEqual({
      catalogProductsMinor: 55_130,
      productDiscountMinor: 27_565,
      productPayableMinor: 27_565,
      shippingGrossMinor: 1_500,
      shippingDiscountMinor: 1_500,
      shippingEffectiveMinor: 0,
      totalMinor: 27_565,
      discountPercent: 50,
    });
  });

  it.each([
    ["non-initial checkout", { checkoutKind: "one_time" as const }],
    ["missing semantic", { metadata: {} }],
    ["unreconciled paid shipping", {
      money: money({ shipping_discount_cents: 0, total_cents: 27_565 }),
    }],
    ["duplicate base anchors", {
      productSnapshots: [{
        quoteLine: { pricingComponents: [
          { scope: "line", componentType: "base_unit", amountMinor: 55_130 },
          { scope: "line", componentType: "base_unit", amountMinor: 1 },
        ] },
      }],
    }],
  ])("fails closed for %s", (_name, override) => {
    expect(deriveFirstSubscriptionPricePresentation({
      metadata,
      productSnapshots: snapshots,
      money: money(),
      checkoutKind: "subscription_initial",
      ...override,
    })).toBeNull();
  });
});
