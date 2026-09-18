import type { RiskSeverity } from "../types.js";
import type {
  RiskEvaluationInput,
  RiskRuleMatch,
} from "./types.js";

const SEVERITY_WEIGHT: Record<RiskSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** @beta */
export function collectRiskRuleMatches(input: RiskEvaluationInput): RiskRuleMatch[] {
  const matches: RiskRuleMatch[] = [];
  const add = (match: RiskRuleMatch) => matches.push(match);
  const { checkout, payment, signals } = input;

  if (signals.exactBlocklistMatches.length > 0) {
    add({
      code: "exact_blocklist_match",
      score: 100,
      severity: "critical",
      evidence: { matchCount: signals.exactBlocklistMatches.length },
    });
  }
  if (signals.recentCheckoutAttemptsByIdentity >= 3) {
    add({
      code: "velocity_checkout_attempts",
      score: 35,
      severity: "medium",
      evidence: { attempts: signals.recentCheckoutAttemptsByIdentity, window: "1h" },
    });
  }
  if (signals.distinctEmailsByIp24h >= 3) {
    add({
      code: "velocity_email_cluster",
      score: 45,
      severity: "high",
      evidence: { distinctEmails: signals.distinctEmailsByIp24h, window: "24h" },
    });
  }
  if (signals.discountedPaidOrders30d >= 2) {
    add({
      code: "velocity_discount_reuse",
      score: 40,
      severity: "medium",
      evidence: { discountedPaidOrders: signals.discountedPaidOrders30d, window: "30d" },
    });
  }
  if (signals.clientsSharingPaymentMethod7d >= 2) {
    add({
      code: "duplicate_payment_method",
      score: 50,
      severity: "high",
      evidence: { clients: signals.clientsSharingPaymentMethod7d, window: "7d" },
    });
  }
  if (signals.priorDisputes > 0) {
    add({
      code: "prior_dispute",
      score: 80,
      severity: "critical",
      evidence: { disputes: signals.priorDisputes },
    });
  }
  if (checkout?.checkoutKind === "subscription_initial" && checkout.promoCodeCount > 0 && signals.discountedPaidOrders30d > 0) {
    add({
      code: "subscription_promo_reuse",
      score: 45,
      severity: "high",
      evidence: { promoCodeCount: checkout.promoCodeCount, priorDiscounts: signals.discountedPaidOrders30d },
    });
  }
  if (checkout?.bundleDiscountApplied && signals.discountedPaidOrders30d > 0) {
    add({
      code: "bundle_discount_review",
      score: 30,
      severity: "medium",
      evidence: { priorDiscounts: signals.discountedPaidOrders30d },
    });
  }
  if (payment?.avsResult === "mismatch") {
    add({ code: "avs_mismatch", score: 25, severity: "medium", evidence: { avsResult: "mismatch" } });
  }
  if (payment?.cvcResult === "mismatch") {
    add({ code: "cvc_mismatch", score: 35, severity: "high", evidence: { cvcResult: "mismatch" } });
  }
  if (checkout && hasCountryMismatch(checkout.shippingCountry, checkout.billingCountry, checkout.ipCountry)) {
    add({
      code: "country_signal_mismatch",
      score: 30,
      severity: "medium",
      evidence: {
        shippingCountry: checkout.shippingCountry ?? null,
        billingCountry: checkout.billingCountry ?? null,
        ipCountry: checkout.ipCountry ?? null,
      },
    });
  }
  if (checkout && signals.highRiskCountries.some((country) => [checkout.shippingCountry, checkout.billingCountry, checkout.ipCountry].includes(country))) {
    add({ code: "high_risk_country", score: 70, severity: "critical", evidence: { highRiskCountries: signals.highRiskCountries } });
  }
  if (payment?.localAmountMinor != null && payment.providerAmountMinor != null && payment.localAmountMinor !== payment.providerAmountMinor) {
    add({
      code: "payment_amount_mismatch",
      score: 80,
      severity: "critical",
      evidence: { localAmountMinor: payment.localAmountMinor, providerAmountMinor: payment.providerAmountMinor },
    });
  }
  if (payment?.localCurrency && payment.providerCurrency && payment.localCurrency !== payment.providerCurrency) {
    add({
      code: "payment_currency_mismatch",
      score: 80,
      severity: "critical",
      evidence: { localCurrency: payment.localCurrency, providerCurrency: payment.providerCurrency },
    });
  }

  return matches.sort((a, b) => b.score - a.score || SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] || a.code.localeCompare(b.code));
}

function hasCountryMismatch(...countries: Array<string | null | undefined>): boolean {
  const present = countries.filter((country): country is string => Boolean(country));
  return new Set(present).size > 1;
}
