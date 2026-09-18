import { afterEach, describe, expect, it, vi } from "vitest";
import { PSP_PROVIDER_KINDS } from "../../../src/domains/payment/pspIntegrationPlan.js";

import {
  composeCheckoutPaymentContinuationMinter,
  composeCheckoutPersonalizationCookies,
} from "./checkoutComposition.js";

const originalSecret = process.env.COMMERCE_CHECKOUT_RESUME_TOKEN_SECRET;
const originalPersonalizationFlag = process.env.COMMERCE_PERSONALIZATION_DECLENSION_ENABLED;
const originalPersonalizationSecret = process.env.PERSONALIZATION_COOKIE_SECRET;

afterEach(() => {
  if (originalSecret === undefined) delete process.env.COMMERCE_CHECKOUT_RESUME_TOKEN_SECRET;
  else process.env.COMMERCE_CHECKOUT_RESUME_TOKEN_SECRET = originalSecret;
  if (originalPersonalizationFlag === undefined) {
    delete process.env.COMMERCE_PERSONALIZATION_DECLENSION_ENABLED;
  } else process.env.COMMERCE_PERSONALIZATION_DECLENSION_ENABLED = originalPersonalizationFlag;
  if (originalPersonalizationSecret === undefined) delete process.env.PERSONALIZATION_COOKIE_SECRET;
  else process.env.PERSONALIZATION_COOKIE_SECRET = originalPersonalizationSecret;
});

describe("checkout continuation composition", () => {
  it("disables issuance without a valid existing root", () => {
    delete process.env.COMMERCE_CHECKOUT_RESUME_TOKEN_SECRET;
    expect(composeCheckoutPaymentContinuationMinter()).toBeUndefined();
    process.env.COMMERCE_CHECKOUT_RESUME_TOKEN_SECRET = "short";
    expect(composeCheckoutPaymentContinuationMinter()).toBeUndefined();
  });

  it("appends the continuation cookie without replacing personalization cookies", () => {
    process.env.COMMERCE_CHECKOUT_RESUME_TOKEN_SECRET = "s".repeat(32);
    const setHeader = vi.fn();
    const res = {
      getHeader: vi.fn().mockReturnValue(["openlup_personalization=existing; Path=/"]),
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
      "openlup_personalization=existing; Path=/",
      expect.stringContaining("__Host-openlup_checkout_continuation="),
    ]);
  });

  it("keeps personalization minting behind its flag and injected cookie builder", () => {
    process.env.COMMERCE_PERSONALIZATION_DECLENSION_ENABLED = "true";
    process.env.PERSONALIZATION_COOKIE_SECRET = "personalization-secret";
    const buildCookies = vi.fn().mockReturnValue(["openlup_personalization=signed; Path=/"]);

    expect(composeCheckoutPersonalizationCookies(buildCookies)?.("client-1")).toEqual([
      "openlup_personalization=signed; Path=/",
    ]);
    expect(buildCookies).toHaveBeenCalledWith("client-1", "personalization-secret");
  });
});
