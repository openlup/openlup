/** Private structural contracts for the unchanged execution and observation slices. */
import type { PaymentExecutionBaseInput, PaymentExecutionBaseResult } from "@openlup/core/payment";
import type { ProviderReadPurpose } from "../contracts/index.js";
export type PaymentProviderFlow = "one_time_payment" | "setup_reusable_method" | "off_session_payment" | "blik_one_time" | "blik_one_click" | "pbl_one_time" | "blik_recurring_activation" | "recurring_charge";
export const PAYMENT_NEXT_ACTION_KINDS = ["redirect", "3ds_challenge", "sca_required"] as const;
export type PaymentNextActionKind = (typeof PAYMENT_NEXT_ACTION_KINDS)[number];
export interface PaymentExecutionInput extends PaymentExecutionBaseInput {
  orderRef: string;
  orderId?: string;
  subjectId?: string | null;
  returnContext?: "public" | "account";
  payer?: { email: string; name: string; ip?: string | null; userAgent?: string | null };
  transientProviderInput?: TpayTransientProviderInput | null;
  paymentMethodAliasType?: "UID" | "PAYID";
  paymentMethodRecurringModel?: "O" | "M";
  providerFlow?: PaymentProviderFlow;
  customerRef?: string;
  paymentMethodRef?: string;
  saveForFutureUse?: boolean;
  clientId?: string;
}
export interface PaymentExecutionResult extends PaymentExecutionBaseResult {
  nextActionKind: PaymentNextActionKind | null;
  redirectUrl?: string | null;
  clientSecret?: string | null;
  customerProviderRef?: string | null;
  paymentMethodRef?: string | null;
  webhookExpected?: boolean;
  recoveryRequired?: boolean;
}
export interface PaymentExecutionPort {
  validateInput?(input: PaymentExecutionInput): void;
  execute(input: PaymentExecutionInput): Promise<PaymentExecutionResult>;
}
export type PaymentWebhookEventType = "payment.succeeded" | "payment.failed" | "payment.refunded" |
  "payment.requires_action" | "payment.disputed" | "setup.succeeded" | "setup.failed" | "setup.requires_action";
export interface CanonicalPaymentEvent {
  provider_event_id: string;
  event_type: PaymentWebhookEventType;
  payment_provider_id: string;
  amount_minor?: number;
  next_action_kind?: PaymentNextActionKind;
  raw_payload: Record<string, unknown>;
}
export interface NormalizedProviderPaymentWebhook {
  provider: string;
  providerEventId: string;
  eventType: PaymentWebhookEventType;
  providerPaymentId: string;
  paymentIntentId?: string | null;
  paymentAttemptId?: string | null;
  amountMinor?: number | null;
  currency?: string | null;
  occurredAt: string;
  refundKind?: "full" | "partial" | null;
  rawPayload: Record<string, unknown>;
  reusableMethod?: {
    clientId: string;
    subscriptionId?: string | null;
    providerCustomerRef?: string | null;
    providerMethodRef: string;
    providerMandateRef?: string | null;
    methodKind: "card";
    status: "active";
    consentSnapshot?: Record<string, unknown>;
  } | null;
}
export interface ProviderReconciliationStatus {
  status: "succeeded" | "failed" | "pending" | "unknown";
  providerStatus: string;
  occurredAt: string | null;
  failureReason: string | null;
  amountMinor: number | null;
  currency: string | null;
  rawPayload: Record<string, unknown>;
}
export interface ClaimedPaymentAttempt {
  paymentAttemptId: string; paymentIntentId: string; paymentId: string; orderId: string;
  subscriptionId: string | null; subscriptionCycleId: string | null; provider: string;
  providerPaymentId: string | null; providerAttemptId: string | null; providerSessionId: string | null;
  attemptStatus: string; intentStatus: string; amountMinor: number; currency: string;
  orderMode: "one_time" | "subscription_cycle"; cycleRetryAttempt: number; cycleNextRetryAt: string | null;
  localUpdatedAt: string;
}
export type ProviderRecoveryAction = { kind: "redirect"; url: string };
export interface PaymentProviderRecoveryProvider {
  resolvePaymentReference(input: { providerAttemptId: string | null; intentProviderPaymentId: string | null;
    providerSessionId: string | null }): string | null;
  readPayment(input: { providerPaymentId: string; attempt?: ClaimedPaymentAttempt;
    purpose?: ProviderReadPurpose }): Promise<ProviderReconciliationStatus>;
  readRecoveryPayment(input: { providerPaymentId: string; attempt: ClaimedPaymentAttempt;
    purpose?: ProviderReadPurpose }): Promise<{ status: ProviderReconciliationStatus; identityMatches: boolean;
      configuredMoneyMatches: boolean; manualReviewRequired: boolean; clientAction: ProviderRecoveryAction | null }>;
  closePayment?(input: { providerPaymentId: string }): Promise<ProviderReconciliationStatus>;
  findPaymentByLocalIntent?(input: { attempt: ClaimedPaymentAttempt }): Promise<"found" | "absent">;
}

export interface TpayTransientProviderInput {
  provider: "tpay";
  flow: "blik_one_time" | "blik_one_click" | "pbl_one_time" | "blik_recurring_activation" | "recurring_charge";
  blikToken?: string;
  channelId?: string;
  recurringModel?: "O" | "M";
}
