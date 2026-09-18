import type {
  RiskDecision,
  RiskEnforcementMode,
  RiskReasonCode,
  RiskSeverity,
} from "../types.js";

/** @beta */
export interface RiskCheckoutFacts {
  checkoutKind: "one_time" | "subscription_initial";
  totalMinor: number;
  currency: string;
  promoCodeCount: number;
  bundleDiscountApplied: boolean;
  shippingCountry?: string | null;
  billingCountry?: string | null;
  ipCountry?: string | null;
  saveForFutureUse?: boolean;
}

/** @beta */
export interface RiskPaymentFacts {
  resultStatus?: "succeeded" | "failed" | "refunded" | "partially_refunded" | "disputed" | null;
  localAmountMinor?: number | null;
  providerAmountMinor?: number | null;
  localCurrency?: string | null;
  providerCurrency?: string | null;
  avsResult?: "match" | "mismatch" | "unavailable" | null;
  cvcResult?: "match" | "mismatch" | "unavailable" | null;
}

/** @beta */
export interface RiskSignalFacts {
  exactBlocklistMatches: Array<{ subjectKind: string; reasonCode?: string | null }>;
  recentCheckoutAttemptsByIdentity: number;
  distinctEmailsByIp24h: number;
  discountedPaidOrders30d: number;
  clientsSharingPaymentMethod7d: number;
  priorDisputes: number;
  highRiskCountries: string[];
}

/** @beta */
export interface RiskEvaluationInput {
  source: "checkout" | "paid_order" | "payment_webhook" | "admin_replay";
  mode: RiskEnforcementMode;
  checkout?: RiskCheckoutFacts;
  payment?: RiskPaymentFacts;
  signals: RiskSignalFacts;
}

/** @beta */
export interface RiskRuleMatch {
  code: RiskReasonCode;
  score: number;
  severity: RiskSeverity;
  evidence: Record<string, unknown>;
}

/** @beta */
export interface RiskEvaluationOutput {
  decision: RiskDecision;
  score: number;
  severity: RiskSeverity;
  reasonCodes: RiskReasonCode[];
  matchedRules: RiskRuleMatch[];
  enforcement: {
    mode: RiskEnforcementMode;
    applied: boolean;
    checkoutBlocked: boolean;
    holdRequested: boolean;
  };
}
