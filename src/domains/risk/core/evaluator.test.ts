import { describe, expect, it } from "vitest";
import { evaluateRisk } from "./evaluator";
import type { RiskEvaluationInput } from "./types";

const baseInput: RiskEvaluationInput = {
  source: "paid_order",
  mode: "shadow",
  checkout: {
    checkoutKind: "one_time",
    totalMinor: 12900,
    currency: "PLN",
    promoCodeCount: 0,
    bundleDiscountApplied: false,
  },
  payment: {
    resultStatus: "succeeded",
    localAmountMinor: 12900,
    providerAmountMinor: 12900,
    localCurrency: "PLN",
    providerCurrency: "PLN",
  },
  signals: {
    exactBlocklistMatches: [],
    recentCheckoutAttemptsByIdentity: 0,
    distinctEmailsByIp24h: 0,
    discountedPaidOrders30d: 0,
    clientsSharingPaymentMethod7d: 0,
    priorDisputes: 0,
    highRiskCountries: [],
  },
};

describe("risk evaluator", () => {
  it("allows clean paid orders in shadow mode", () => {
    expect(evaluateRisk(baseInput)).toMatchObject({
      decision: "allow",
      score: 0,
      severity: "low",
      reasonCodes: [],
      enforcement: {
        mode: "shadow",
        applied: false,
        holdRequested: false,
      },
    });
  });

  it("requests manual review for subscription promo reuse and CVC mismatch", () => {
    const result = evaluateRisk({
      ...baseInput,
      mode: "hold",
      checkout: {
        ...baseInput.checkout,
        checkoutKind: "subscription_initial",
        promoCodeCount: 1,
      },
      payment: {
        ...baseInput.payment,
        cvcResult: "mismatch",
      },
      signals: {
        ...baseInput.signals,
        discountedPaidOrders30d: 1,
      },
    });

    expect(result.decision).toBe("manual_review");
    expect(result.enforcement.holdRequested).toBe(true);
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining(["subscription_promo_reuse", "cvc_mismatch"]),
    );
  });

  it("blocks exact blocklist hits and applies checkout blocking only at checkout", () => {
    const result = evaluateRisk({
      ...baseInput,
      source: "checkout",
      mode: "checkout_blocklist",
      signals: {
        ...baseInput.signals,
        exactBlocklistMatches: [{ subjectKind: "email", reasonCode: "exact_blocklist_match" }],
      },
    });

    expect(result).toMatchObject({
      decision: "block",
      severity: "critical",
      enforcement: {
        applied: true,
        checkoutBlocked: true,
        holdRequested: false,
      },
    });
  });
});
