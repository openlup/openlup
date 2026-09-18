/** @beta */
export const RISK_CONTRACT_VERSION = "risk.v1" as const;
/** @beta */
export const RISK_RULESET_VERSION = "risk-rules.v1" as const;

/** @beta */
export const RISK_DECISIONS = ["allow", "manual_review", "block"] as const;
/** @beta */
export const RISK_ENFORCEMENT_MODES = ["shadow", "hold", "checkout_blocklist"] as const;
/** @beta */
export const RISK_CASE_STATUSES = ["open", "in_review", "approved", "blocked", "escalated", "closed"] as const;
/** @beta */
export const RISK_CASE_DECISIONS = ["approve", "block", "escalate", "note"] as const;
/** @beta */
export const RISK_SEVERITIES = ["low", "medium", "high", "critical"] as const;
/** @beta */
export const RISK_SUBJECT_KINDS = [
  "client",
  "email",
  "phone",
  "ip",
  "device",
  "payment_method",
  "shipping_address",
  "billing_tax_id",
  "identity_cluster",
] as const;

/** @beta */
export const RISK_REASON_CODES = [
  "exact_blocklist_match",
  "velocity_checkout_attempts",
  "velocity_email_cluster",
  "velocity_discount_reuse",
  "duplicate_payment_method",
  "subscription_promo_reuse",
  "bundle_discount_review",
  "avs_mismatch",
  "cvc_mismatch",
  "country_signal_mismatch",
  "high_risk_country",
  "payment_amount_mismatch",
  "payment_currency_mismatch",
  "prior_dispute",
] as const;

/** @beta */
export type RiskDecision = (typeof RISK_DECISIONS)[number];
/** @beta */
export type RiskEnforcementMode = (typeof RISK_ENFORCEMENT_MODES)[number];
/** @beta */
export type RiskCaseStatus = (typeof RISK_CASE_STATUSES)[number];
/** @beta */
export type RiskCaseDecision = (typeof RISK_CASE_DECISIONS)[number];
/** @beta */
export type RiskSeverity = (typeof RISK_SEVERITIES)[number];
/** @beta */
export type RiskSubjectKind = (typeof RISK_SUBJECT_KINDS)[number];
/** @beta */
export type RiskReasonCode = (typeof RISK_REASON_CODES)[number];
