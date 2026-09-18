export {
  PAYMENT_RECOVERY_CONTRACT_VERSION,
  paymentRecoveryRedeemRequestSchema,
  paymentRecoveryRedeemResponseSchema,
  paymentRecoveryResendLatestLinkRequestSchema,
  paymentRecoveryResendLatestLinkResponseSchema,
  paymentRecoverySetupMethodRequestSchema,
  paymentRecoverySetupMethodResponseSchema,
} from "./recoveryContracts.js";
export type {
  PaymentRecoveryRedeemRequest,
  PaymentRecoveryRedeemResponse,
  PaymentRecoveryResendLatestLinkRequest,
  PaymentRecoveryResendLatestLinkResponse,
  PaymentRecoverySetupMethodRequest,
  PaymentRecoverySetupMethodResponse,
} from "./recoveryContracts.js";
// What each rail expects of a STORED payment method. Published here because the
// stored-method verdict is rendered to the customer by another domain; this is
// that domain's only sanctioned way in, and it stays read-only data.
export {
  storedMethodCapabilityKinds,
  storedMethodExpectations,
} from "./storedMethodCapabilities.js";
// Which customer-present capture flows a payer may be offered to repair a
// stored method. Published here for the same reason as the expectations above:
// the repair surface lives in another domain and must not import an adapter.
export {
  drivableRecoveryCaptureHandoffs,
  recoveryCaptureFlowCatalog,
  resolveRecoveryCaptureFlows,
} from "./recoveryCaptureFlows.js";
export type {
  PaymentMethodCaptureFlow,
  PaymentMethodCaptureHandoff,
  RecoveryCaptureFlowExclusion,
  RecoveryCaptureFlowExclusionReason,
  RecoveryCaptureFlowResolution,
} from "./recoveryCaptureFlows.js";

export const SUBSCRIPTION_ACTIVATION_GRACE_MS = 2 * 60 * 1000;

export type SubscriptionActivationStatus =
  | "not_applicable"
  | "waiting_for_mandate"
  | "active"
  | "action_required";

export interface PaidSubscriptionActivationGapRow {
  subscription_id: string;
  client_id: string;
  order_id: string;
  payment_intent_id: string;
  payment_attempt_id: string;
  paid_at: string;
}

/**
 * Customer-safe projection of subscription activation truth.
 *
 * The database view is the authoritative fail-closed Model O detector. This
 * helper deliberately does not infer provider/model from a generic
 * `pending_activation` row; it only decides how an already-settled subscription
 * should be presented while its durable activation catches up.
 */
export function deriveSubscriptionActivationStatus(input: {
  orderMode: string;
  orderStatus: string;
  intentStatus: string;
  subscriptionStatus: string | null;
  paidAt: string | null;
  hasExactGap: boolean;
  now?: Date;
}): SubscriptionActivationStatus {
  if (input.orderMode !== "subscription_cycle" || !input.subscriptionStatus) {
    return "not_applicable";
  }
  if (input.subscriptionStatus === "active") return "active";
  if (!input.hasExactGap) return "not_applicable";
  if (input.orderStatus !== "paid" || input.intentStatus !== "succeeded") {
    return "not_applicable";
  }
  if (input.subscriptionStatus !== "pending_activation") return "action_required";

  const paidAtMs = input.paidAt ? Date.parse(input.paidAt) : Number.NaN;
  if (!Number.isFinite(paidAtMs)) return "action_required";
  const ageMs = (input.now ?? new Date()).getTime() - paidAtMs;
  return ageMs < SUBSCRIPTION_ACTIVATION_GRACE_MS
    ? "waiting_for_mandate"
    : "action_required";
}
