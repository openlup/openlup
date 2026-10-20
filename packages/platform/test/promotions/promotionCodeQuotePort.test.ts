import { describe, expect, it, vi } from "vitest";
import {
  type PromotionCodeQuotePort,
} from "../../src/promotions/promotionCodeQuotePort.js";
import { applyPromotionCodesV2 } from "./bindingsFixtures.js";

describe("PromotionCodeQuotePort", () => {
  it("maps checkout facts into the advisory port and propagates its rejection", async () => {
    const port: PromotionCodeQuotePort = {
      resolve: vi.fn().mockResolvedValue({
        candidates: [],
        codeRejections: [{ code: "SAVE80", reason: "expired" }],
        codeRejectionDetails: [],
      }),
    };
    await expect(applyPromotionCodesV2({
      port,
      clientId: "client-1",
      mode: "subscription",
      promoCodes: ["SAVE80"],
      referenceProductMinor: 10_000,
      subtotalGrossMinor: 5_000,
      shippingGrossMinor: 990,
      discounts: [],
      codeRejections: [{ code: "OLD", reason: "not_recognized" }],
      atTime: "2026-07-14T10:00:00.000Z",
    })).resolves.toEqual({
      discounts: [],
      codeRejections: [
        { code: "OLD", reason: "not_recognized" },
        { code: "SAVE80", reason: "expired" },
      ],
      codeRejectionDetails: [],
    });
    expect(port.resolve).toHaveBeenCalledWith({
      codes: ["SAVE80"],
      clientId: "client-1",
      purchaseScope: "subscription_initial",
      referenceProductMinor: 10_000,
      atTime: "2026-07-14T10:00:00.000Z",
    });
  });
});
