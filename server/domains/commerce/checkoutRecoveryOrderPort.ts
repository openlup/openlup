import type { CheckoutRecoveryMode } from "../../../src/domains/commerce/checkoutRecoveryContracts.js";
import type { CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
import type { PaymentIntentStatus } from "../../../src/domains/payment/types.js";

export interface CheckoutRecoveryPriorPaymentEvidence {
  paymentIntentId: string;
  paymentAttemptId: string;
  provider: string;
  providerPaymentId: string | null;
  idempotencyKey: string;
  retryRequestId: string | null;
}

export interface CheckoutRecoveryOrderSnapshot {
  orderId: string;
  orderRef: string;
  orderNumber: string;
  clientId: string;
  status: string;
  mode: CheckoutRecoveryMode;
  totalMinor: number;
  currency: string;
  petName: string | null;
  cadenceDays: number | null;
  createdAt: string;
  customerEmail: string | null;
  customerName: string | null;
  paymentIntentId: string | null;
  paymentIntentStatus: PaymentIntentStatus | null;
  subscriptionId: string | null;
  subscriptionCycleId: string | null;
  shippingAddressId?: string | null;
  petId?: string | null;
  quoteSnapshot?: CreateQuoteResponse | null;
  runtimeMetadata?: Record<string, unknown>;
  invoiceBuyerSnapshot?: Record<string, unknown>;
  recoveryRootOrderId?: string;
  recreatedFromOrderId?: string | null;
  technicallyExpired?: boolean;
  priorPaymentEvidence?: CheckoutRecoveryPriorPaymentEvidence | null;
}

export interface CheckoutRecoveryOrderReadPort {
  getRecoveryOrder(input: { orderId: string }): Promise<CheckoutRecoveryOrderSnapshot | null>;
  getLatestRecoveryOrder?(input: { orderId: string }): Promise<CheckoutRecoveryOrderSnapshot | null>;
}
