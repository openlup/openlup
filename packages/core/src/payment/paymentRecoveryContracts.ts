/** Checkout guidance describes evidence; it never authorizes another charge. */
import type { PaymentRetryAdviceCode } from "./paymentFailureTaxonomyContracts.js";

/** @beta */
export const PAYMENT_RECOVERY_CAUSES = [
  "generic_decline", "insufficient_funds", "expired_card", "invalid_payment_data",
  "authentication_required", "operation_unsupported", "recurring_setup_failed",
] as const;
/** @beta */
export type PaymentRecoveryCause = (typeof PAYMENT_RECOVERY_CAUSES)[number];
/** @beta */
export const PAYMENT_RECOVERY_ACTIONS = [
  "change_method", "change_instrument", "correct_data", "authenticate",
  "check_status", "review_order", "contact_support", "retry",
] as const;
/** @beta */
export type PaymentRecoveryAction = (typeof PAYMENT_RECOVERY_ACTIONS)[number];
/** @beta */
export type PaymentRecoveryOperation =
  "one_time_payment" | "recurring_setup" | "stored_method_payment";
/** @beta */
export interface PaymentRecoveryMethod {
  /** A method identity, never an operator identity or an instrument fingerprint. */
  kind: string;
  /** Canonical visible choice; changing operator alone cannot change this key. */
  recoveryMethodKey: string;
  interaction: "new_instrument" | "stored_instrument";
}
/** @beta */
export interface PaymentRecoveryAdvice {
  code: PaymentRetryAdviceCode;
  scope: "instrument" | "method" | "operation" | "unknown";
}
/** @beta */
export interface PaymentRecoveryEvidence {
  /** Established refusal, not merely an unconfirmed or locally failed request. */
  refusalVerified: boolean;
  cause: PaymentRecoveryCause;
  certainty: "verified" | "unknown";
  disclosure: "safe" | "restricted";
  method: PaymentRecoveryMethod | null;
  operation: PaymentRecoveryOperation | null;
  advice: PaymentRecoveryAdvice | null;
}
/** @beta */
export interface PaymentRecoveryCandidate {
  method: PaymentRecoveryMethod;
  operation: PaymentRecoveryOperation;
  capability: "supported" | "unsupported" | "unknown";
  /** Resolved deployment, merchant and client eligibility, not operator marketing. */
  available: boolean;
  actions: readonly PaymentRecoveryAction[];
}
/**
 * Companion to execution capabilities. A caller injects provider normalizers;
 * the kernel sees only their neutral outputs. An absent normalizer adds no facts.
 * @beta
 */
export interface PaymentRecoveryNormalizer<TInput = unknown> {
  normalize(input: TInput): PaymentRecoveryEvidence | null;
}
