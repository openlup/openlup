import type {
  RecordSubscriptionPaymentRecoveryRequest,
  RecordSubscriptionPaymentRecoveryResponse,
} from "../../../src/domains/subscription/runtimeContracts.js";

export { findRecoveryTokenEvidence, hashRecoveryToken } from "./recoveryTokenHash.js";

export interface SubscriptionRecoveryTokenEvidence {
  tokenId: string;
  caseId: string;
  clientId: string;
  authUserId: string | null;
  purpose: "repair_payment" | "resume_subscription";
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}
export type SubscriptionPaymentRecoveryInput = RecordSubscriptionPaymentRecoveryRequest;

export interface SubscriptionPaymentRecoveryPort {
  findTokenEvidenceByHash(
    tokenHash: string,
  ): Promise<SubscriptionRecoveryTokenEvidence | null>;
  recordSubscriptionPaymentRecovery(
    input: SubscriptionPaymentRecoveryInput,
  ): Promise<RecordSubscriptionPaymentRecoveryResponse>;
}

export interface SubscriptionRecoveryCaseResolution {
  caseId: string;
  subscriptionId: string;
  providerCustomerRef: string | null;
}

export interface SubscriptionPaymentRecoverySetupPort extends SubscriptionPaymentRecoveryPort {
  resolveRecoveryCaseSubscription(input: {
    tokenEvidence: SubscriptionRecoveryTokenEvidence;
  }): Promise<SubscriptionRecoveryCaseResolution | null>;
}

export interface CustomerRecoveryAuthenticationResult {
  ok: true;
  userId: string;
}

export type PaymentRecoveryRecordErrorReason =
  | "idempotency_conflict"
  | "token_invalid_or_expired"
  | "resume_method_not_chargeable"
  | "resume_case_state_changed";

const PAYMENT_RECOVERY_RECORD_ERROR_MESSAGES: Record<PaymentRecoveryRecordErrorReason, string> = {
  idempotency_conflict: "Payment recovery idempotency conflict",
  token_invalid_or_expired: "Payment recovery token is invalid",
  // The stored method is not yet usable unattended — typically the method-ref
  // row the confirm webhook writes is not durable yet. The redeem rolled back.
  resume_method_not_chargeable: "Payment recovery method is not chargeable yet",
  resume_case_state_changed: "Payment recovery case is no longer in the expected state",
};

export class PaymentRecoveryRecordError extends Error {
  constructor(readonly reason: PaymentRecoveryRecordErrorReason) {
    super(PAYMENT_RECOVERY_RECORD_ERROR_MESSAGES[reason]);
    this.name = "PaymentRecoveryRecordError";
  }
}
