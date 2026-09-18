import { describe, expect, it } from "vitest";
import type { CommercePromoDataPort, PromotionRedemptionCount } from "./promoDataPort.js";

describe("CommercePromoDataPort contract", () => {
  it("keeps first-order device eligibility optional at the data-port boundary", async () => {
    const redemptionCounts = new Map<string, PromotionRedemptionCount>([
      ["promo-first-order", { global: 1, perCustomer: 0 }],
    ]);
    const port: CommercePromoDataPort = {
      listActivePromotions: async () => [],
      countPaidOrders: async () => 0,
      countPaidOrdersByMode: async () => ({ oneTime: 0, subscription: 0 }),
      redemptionCounts: async () => redemptionCounts,
      deviceFirstOrderRedeemed: async (visitorId) => visitorId === "known-visitor",
    };

    await expect(port.deviceFirstOrderRedeemed(null)).resolves.toBe(false);
    await expect(port.deviceFirstOrderRedeemed("known-visitor")).resolves.toBe(true);
    await expect(port.redemptionCounts(null)).resolves.toBe(redemptionCounts);
  });
});
