import { describe, expect, it } from "vitest";
import { PROMOTION_CODE_QUOTE_RPC } from "./promotionCodeQuotePort.js";
describe("managed advisory read names", () => {
  it("owns the additive and rollback-safe RPC names", () => {
    expect(PROMOTION_CODE_QUOTE_RPC).toEqual({
      current: "commerce_promotion_codes_quote_candidates_v2",
      legacy: "commerce_promotion_codes_quote_candidates",
    });
  });

});
