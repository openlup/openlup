export interface CheckoutRecoveryPriorPaymentEvidence {
  paymentIntentId: string;
  paymentAttemptId: string;
  provider: string;
  providerPaymentId: string | null;
  idempotencyKey: string;
  retryRequestId: string | null;
}

export type CheckoutRecoveryOrderSnapshot<Quote, PaymentStatus, Host extends object = object> = Host & {
  orderId: string;
  orderRef: string;
  orderNumber: string;
  clientId: string;
  status: string;
  mode: "subscription_cycle" | "one_time_order";
  totalMinor: number;
  currency: string;
  cadenceDays: number | null;
  createdAt: string;
  customerEmail: string | null;
  customerName: string | null;
  paymentIntentId: string | null;
  paymentIntentStatus: PaymentStatus | null;
  subscriptionId: string | null;
  subscriptionCycleId: string | null;
  shippingAddressId?: string | null;
  quoteSnapshot?: Quote | null;
  runtimeMetadata?: Record<string, unknown>;
  invoiceBuyerSnapshot?: Record<string, unknown>;
  recoveryRootOrderId?: string;
  recreatedFromOrderId?: string | null;
  technicallyExpired?: boolean;
  priorPaymentEvidence?: CheckoutRecoveryPriorPaymentEvidence | null;
}

export interface CheckoutRecoveryOrderReadPort<Order> {
  getRecoveryOrder(input: { orderId: string }): Promise<Order | null>;
  getLatestRecoveryOrder?(input: { orderId: string }): Promise<Order | null>;
}
