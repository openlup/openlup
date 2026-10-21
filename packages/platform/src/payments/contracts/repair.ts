import type { PaymentMethodHandoff } from "./adapter.js";
import type { ClaimedPaymentAttempt, PaymentProviderReconciliationProvider, ProviderReconciliationStatus, PaymentVerifyReadPort } from "./reconciliation.js";
import type { ProviderReadPurpose } from "./evidence.js";

export type CheckoutRecoveryPaymentResolution =
  | { kind: "paid" }
  | { kind: "retry_new" }
  | { kind: "resume_existing"; clientAction: PaymentRecoveryAction }
  | { kind: "awaiting_provider" }
  | { kind: "manual_review" };

export interface ProviderPaymentReferenceInput {
  providerAttemptId: string | null;
  providerSessionId: string | null;
  intentProviderPaymentId: string | null;
}

export type PaymentRecoveryAction = { provider: string } & PaymentMethodHandoff;

export interface ProviderRecoveryRead {
  status: ProviderReconciliationStatus;
  identityMatches: boolean;
  configuredMoneyMatches: boolean;
  manualReviewRequired: boolean;
  clientAction: PaymentRecoveryAction | null;
}

/**
 * Recovery is an explicit capability, not an optional method on generic
 * reconciliation providers. One read returns both PSP truth and any transient
 * buyer action, so a redeem never calls the provider twice.
 */
export interface PaymentProviderRecoveryProvider extends PaymentProviderReconciliationProvider {
  resolvePaymentReference(input: ProviderPaymentReferenceInput): string | null;
  readRecoveryPayment(input: {
    providerPaymentId: string;
    attempt: ClaimedPaymentAttempt;
    purpose?: ProviderReadPurpose;
  }): Promise<ProviderRecoveryRead>;
}

export interface CheckoutRecoveryPaymentResolver {
  resolve(input: {
    orderId: string;
    paymentIntentId: string | null;
    intentStatus?: string | null;
  }): Promise<CheckoutRecoveryPaymentResolution>;
}


export interface ActivePaymentActionAuthority {
  orderId: string;
  clientId: string;
  paymentIntentId: string;
  paymentAttemptId: string;
  executionRail: string;
}

export interface CheckoutActivePaymentActionResolver {
  readActiveAction(authority: ActivePaymentActionAuthority): Promise<PaymentRecoveryAction | null>;
}

export type CheckoutActionReadProvider = Pick<
  PaymentProviderRecoveryProvider,
  "resolvePaymentReference" | "readRecoveryPayment"
>;


/** Method collection only. Hosts authorize ownership before calling this port.
 * The result never confirms payment, redeems a token or writes a subscription.
 * Handoffs remain transient; unsupported must be shown as an explicit refusal.
 */
export interface PaymentRepairMethodPort {
  setupMethod(input: {
    customer: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<
    | { kind: "ready"; setupRef: string; handoff: PaymentMethodHandoff; replayed: boolean }
    | { kind: "unsupported" }
  >;
}
