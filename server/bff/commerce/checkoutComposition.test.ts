import { afterEach, describe, expect, it, vi } from "vitest";
import { PSP_PROVIDER_KINDS } from "../../../src/domains/payment/pspIntegrationPlan.js";

import { composeCheckoutPaymentContinuationMinter } from "./checkoutComposition.js";

const originalSecret = process.env.COMMERCE_CHECKOUT_RESUME_TOKEN_SECRET;

afterEach(() => {
  if (originalSecret === undefined) delete process.env.COMMERCE_CHECKOUT_RESUME_TOKEN_SECRET;
  else process.env.COMMERCE_CHECKOUT_RESUME_TOKEN_SECRET = originalSecret;
});

describe("checkout continuation composition", () => {
  it("disables issuance without a valid existing root", () => {
    delete process.env.COMMERCE_CHECKOUT_RESUME_TOKEN_SECRET;
    expect(composeCheckoutPaymentContinuationMinter()).toBeUndefined();
    process.env.COMMERCE_CHECKOUT_RESUME_TOKEN_SECRET = "short";
    expect(composeCheckoutPaymentContinuationMinter()).toBeUndefined();
  });

  it("appends the continuation cookie without replacing cookies already set", () => {
    process.env.COMMERCE_CHECKOUT_RESUME_TOKEN_SECRET = "s".repeat(32);
    const setHeader = vi.fn();
    const res = {
      getHeader: vi.fn().mockReturnValue(["openlup_existing=value; Path=/"]),
      setHeader,
    };

    composeCheckoutPaymentContinuationMinter()?.(res, {
      journeyId: "checkout:11111111-1111-4111-8111-111111111111",
      orderId: "22222222-2222-4222-8222-222222222222",
      clientId: "33333333-3333-4333-8333-333333333333",
      paymentIntentId: "44444444-4444-4444-8444-444444444444",
      paymentAttemptId: "55555555-5555-4555-8555-555555555555",
      executionRail: PSP_PROVIDER_KINDS[0],
    });

    expect(setHeader).toHaveBeenCalledWith("Set-Cookie", [
      "openlup_existing=value; Path=/",
      expect.stringContaining("__Host-openlup_checkout_continuation="),
    ]);
  });

});
