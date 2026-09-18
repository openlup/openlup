import { describe, expect, it } from "vitest";
import { evaluateCommerceFulfillmentCreateReadiness } from "./commerceFulfillmentReadiness.js";

describe("commerce fulfillment create readiness", () => {
  it("allows fulfillment create only after OMS and cross-module facts are ready", () => {
    expect(
      evaluateCommerceFulfillmentCreateReadiness({
        omsEligibility: { allowed: true, reason: null },
        hasClient: true,
        hasShippingAddress: true,
        orderItemCount: 1,
        allOrderItemsHaveSku: true,
        allOrderItemsReserved: true,
      }),
    ).toEqual({ allowed: true, reason: null, omsReason: null });
  });

  it("delegates payment, hold, subscription, and inventory gate failures to OMS", () => {
    expect(
      evaluateCommerceFulfillmentCreateReadiness({
        omsEligibility: { allowed: false, reason: "payment_not_succeeded" },
        hasClient: true,
        hasShippingAddress: true,
        orderItemCount: 1,
        allOrderItemsHaveSku: true,
        allOrderItemsReserved: true,
      }),
    ).toEqual({ allowed: false, reason: "oms_blocked", omsReason: "payment_not_succeeded" });
  });

  it("blocks missing client/address/order/SKU/reservation facts without owning those modules", () => {
    const base = {
      omsEligibility: { allowed: true as const, reason: null },
      hasClient: true,
      hasShippingAddress: true,
      orderItemCount: 1,
      allOrderItemsHaveSku: true,
      allOrderItemsReserved: true,
    };

    expect(evaluateCommerceFulfillmentCreateReadiness({ ...base, hasClient: false }).reason).toBe("missing_client");
    expect(evaluateCommerceFulfillmentCreateReadiness({ ...base, hasShippingAddress: false }).reason).toBe("missing_shipping_address");
    expect(evaluateCommerceFulfillmentCreateReadiness({ ...base, orderItemCount: 0 }).reason).toBe("missing_order_items");
    expect(evaluateCommerceFulfillmentCreateReadiness({ ...base, allOrderItemsHaveSku: false }).reason).toBe("missing_catalog_sku");
    expect(evaluateCommerceFulfillmentCreateReadiness({ ...base, allOrderItemsReserved: false }).reason).toBe("missing_inventory_reservation");
  });
});
