import { describe, expect, it, vi } from "vitest";
import {
  PROMOTION_CODE_QUOTE_RPC,
  type PromotionCodeQuotePort,
} from "./promotionCodeQuotePort.js";
import { applyPromotionCodesV2 } from "./quotePromotionCodeAdjustments.js";

describe("PromotionCodeQuotePort", () => {
  it("owns the additive and rollback-safe RPC names", () => {
    expect(PROMOTION_CODE_QUOTE_RPC).toEqual({
      current: "commerce_promotion_codes_quote_candidates_v2",
      legacy: "commerce_promotion_codes_quote_candidates",
    });
  });

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
