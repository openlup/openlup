import { describe, expect, it } from "vitest";
import {
  RISK_CONTRACT_VERSION,
  RISK_REASON_CODES,
  RISK_RULESET_VERSION,
  evaluateRisk,
  type RiskEvaluationInput,
} from "@openlup/core/risk";

const baseInput: RiskEvaluationInput = {
  source: "paid_order",
  mode: "shadow",
  checkout: {
    checkoutKind: "one_time",
    totalMinor: 12900,
    currency: "USD",
    promoCodeCount: 0,
    bundleDiscountApplied: false,
    shippingCountry: "EX",
    billingCountry: "EX",
  },
  payment: {
    resultStatus: "succeeded",
    localAmountMinor: 12900,
    providerAmountMinor: 12900,
    localCurrency: "USD",
    providerCurrency: "USD",
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

describe("risk standalone smoke", () => {
  it("exposes neutral risk vocabulary and package versions", () => {
    expect(RISK_CONTRACT_VERSION).toBe("risk.v1");
    expect(RISK_RULESET_VERSION).toBe("risk-rules.v1");
    expect(RISK_REASON_CODES).toEqual(expect.arrayContaining([
      "exact_blocklist_match",
      "velocity_checkout_attempts",
      "payment_currency_mismatch",
    ]));
  });

  it("allows a clean neutral paid order", () => {
    expect(evaluateRisk(baseInput)).toMatchObject({
      decision: "allow",
      score: 0,
      severity: "low",
      reasonCodes: [],
      enforcement: {
        mode: "shadow",
        applied: false,
      },
    });
  });

  it("keeps checkout blocklist enforcement separate from paid-order holds", () => {
    expect(evaluateRisk({
      ...baseInput,
      source: "checkout",
      mode: "checkout_blocklist",
      signals: {
        ...baseInput.signals,
        exactBlocklistMatches: [{ subjectKind: "email", reasonCode: "exact_blocklist_match" }],
      },
    })).toMatchObject({
      decision: "block",
      enforcement: {
        applied: true,
        checkoutBlocked: true,
        holdRequested: false,
      },
    });
  });

  it("requests manual review for subscription promo reuse and verification mismatch", () => {
    const result = evaluateRisk({
      ...baseInput,
      mode: "hold",
      checkout: {
        checkoutKind: "subscription_initial",
        totalMinor: 12900,
        currency: "USD",
        promoCodeCount: 1,
        bundleDiscountApplied: false,
        shippingCountry: "EX",
        billingCountry: "EX",
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
    expect(result.reasonCodes).toEqual(expect.arrayContaining(["subscription_promo_reuse", "cvc_mismatch"]));
  });
});
