
export const OUTBOX_ORDER_CONFIRMATION_TEMPLATE_SLUG = "commerce-order-confirmation";

export interface OrderRecipient {
  email: string;
  firstName: string | null;
  country?: string | null;
  contextName?: string | null;
}

export interface OrderRecipientPort {
  resolve(orderUuid: string, signal: AbortSignal): Promise<OrderRecipient | null>;
}

export interface OrderPaymentLifecycleState {
  orderStatus: string | null;
  paymentStatus: string | null;
  paymentUpdatedAt?: string | null;
  hasPayment: boolean;
  /** The activation sweep abandoned this order's provisional subscription: it writes
   * `cancelled`, not `expired`, so the expired-checkout gate needs this to tell a swept
   * first subscription from any other cancellation. Absent for every one-time order. */
  subscriptionActivationAbandoned?: boolean;
}

export interface OrderPaymentLifecyclePort {
  read(orderUuid: string, signal: AbortSignal): Promise<OrderPaymentLifecycleState | null>;
}

export interface OrderEmailLineItem {
  name: string;
  quantity: number;
  lineTotalLabel: string;
}

export interface OrderEmailTotals {
  subtotalLabel: string | null;
  discountLabel: string | null;
  totalLabel: string;
  firstSubscription?: {
    discountPercent?: number;
    catalogLabel: string;
    productPayableLabel: string;
    shippingLabel: string | null;
    shippingFree: boolean;
  };
}

export interface OrderConfirmationEmailInput<Locale extends string = string> {
  to: string;
  firstName: string | null;
  contextName?: string | null;
  orderId: string;
  outboxEventId: string;
  items: OrderEmailLineItem[];
  totals: OrderEmailTotals | null;
  locale?: Locale;
  signal: AbortSignal;
}

export interface TransactionalEmailSendOutcome {
  ok: boolean;
  messageId: string | null;
  httpStatus: number;
  providerError: string | null;
  aborted: boolean;
  providerErrorCode?: string | null;
  /** Terminal intentional non-send; callers must not count it as sent. */
  skipReason?: "admin_disabled" | "egress_suppressed" | null;
}

export const OUTBOX_ORDER_PAID_TEMPLATE_SLUG = "commerce-order-paid";

export const OUTBOX_CHECKOUT_RECOVERY_TEMPLATE_SLUG = "commerce-checkout-recovery";

export interface CheckoutRecoveryEmailInput<Locale extends string = string> {
  to: string;
  firstName: string | null;
  contextName?: string | null;
  orderId: string;
  recoveryToken: string;
  mode: string;
  reminderHours: number;
  linkSource?: "buyer_hatch";
  outboxEventId: string;
  locale?: Locale;
  signal: AbortSignal;
}

export interface OrderPaidRawLine {
  /** Frozen historical display label, or null for sparse legacy snapshots. */
  label: string | null;
  quantity: number;
  lineTotalMinor: number;
}

export interface OrderPaidRawData {
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  presentation?: unknown;
  lines: OrderPaidRawLine[];
}

export interface OrderPaidLinesPort {
  read(orderUuid: string, signal: AbortSignal): Promise<OrderPaidRawData | null>;
}

export interface OrderPaidConfirmationEmailInput<Locale extends string = string> {
  to: string;
  firstName: string | null;
  contextName?: string | null;
  orderId: string;
  mode: string;
  outboxEventId: string;
  items: OrderEmailLineItem[];
  totals: OrderEmailTotals | null;
  parcelNote?: string | null;
  locale?: Locale;
  signal: AbortSignal;
}

export const OUTBOX_PAYMENT_FAILED_TEMPLATE_SLUG = "commerce-payment-failed";

export interface PaymentFailedEmailInput<Locale extends string = string> {
  to: string;
  firstName: string | null;
  orderId: string;
  amountLabel: string | null;
  recoveryToken: string;
  mode: string;
  outboxEventId: string;
  locale?: Locale;
  signal: AbortSignal;
}

export const OUTBOX_CHECKOUT_EXPIRED_TEMPLATE_SLUG = "commerce-checkout-expired";

export interface CheckoutExpiredEmailInput<Locale extends string = string> {
  to: string;
  firstName: string | null;
  orderId: string;
  amountLabel: string | null;
  /** Raw checkout-recovery token, emitted only in the outbox payload: the database
   * stores only its hash, and the host renderer builds the recovery link. */
  recoveryToken?: string | null;
  outboxEventId: string;
  locale?: Locale;
  signal: AbortSignal;
}

export const OUTBOX_ORDER_CANCELED_TEMPLATE_SLUG = "commerce-order-canceled";

export interface OrderCanceledEmailInput<Locale extends string = string> {
  to: string;
  firstName: string | null;
  orderId: string;
  amountLabel: string | null;
  outboxEventId: string;
  locale?: Locale;
  signal: AbortSignal;
}

export const OUTBOX_ORDER_REFUNDED_TEMPLATE_SLUG = "commerce-order-refunded";

export interface OrderRefundedEmailInput<Locale extends string = string> {
  to: string;
  firstName: string | null;
  orderId: string;
  amountLabel: string | null;
  outboxEventId: string;
  locale?: Locale;
  signal: AbortSignal;
}

export const OUTBOX_SHIPMENT_DISPATCHED_TEMPLATE_SLUG = "commerce-shipment-dispatched";

export interface ShipmentDispatchedEmailInput<Locale extends string = string> {
  to: string;
  firstName: string | null;
  contextName?: string | null;
  orderId: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  outboxEventId: string;
  locale?: Locale;
  signal: AbortSignal;
}

export const OUTBOX_SHIPMENT_DELIVERED_TEMPLATE_SLUG = "commerce-shipment-delivered";

export interface ShipmentDeliveredEmailInput<Locale extends string = string> {
  to: string;
  firstName: string | null;
  contextName?: string | null;
  orderId: string;
  outboxEventId: string;
  locale?: Locale;
  signal: AbortSignal;
}

export const OUTBOX_SHIPMENT_EXCEPTION_TEMPLATE_SLUG = "commerce-shipment-exception";

export interface ShipmentExceptionEmailInput<Locale extends string = string> {
  to: string;
  firstName: string | null;
  orderId: string;
  outboxEventId: string;
  locale?: Locale;
  signal: AbortSignal;
}

export const OUTBOX_RETURN_APPROVED_TEMPLATE_SLUG = "commerce-return-approved";

export const OUTBOX_RETURN_REJECTED_TEMPLATE_SLUG = "commerce-return-rejected";

export interface ReturnDecisionEmailInput<Locale extends string = string> {
  to: string;
  firstName: string | null;
  orderId: string;
  outboxEventId: string;
  locale?: Locale;
  signal: AbortSignal;
}

export interface TransactionalEmailPort<Locale extends string = string> {
  findExistingSend(templateSlug: string, outboxEventId: string): Promise<boolean>;
  sendReturnApprovedNotice(input: ReturnDecisionEmailInput<Locale>): Promise<TransactionalEmailSendOutcome>;
  sendReturnRejectedNotice(input: ReturnDecisionEmailInput<Locale>): Promise<TransactionalEmailSendOutcome>;
  sendOrderConfirmation(input: OrderConfirmationEmailInput<Locale>): Promise<TransactionalEmailSendOutcome>;
  sendCheckoutRecovery(input: CheckoutRecoveryEmailInput<Locale>): Promise<TransactionalEmailSendOutcome>;
  sendOrderPaidConfirmation(input: OrderPaidConfirmationEmailInput<Locale>): Promise<TransactionalEmailSendOutcome>;
  sendPaymentFailedNotice(input: PaymentFailedEmailInput<Locale>): Promise<TransactionalEmailSendOutcome>;
  sendCheckoutExpiredNotice(input: CheckoutExpiredEmailInput<Locale>): Promise<TransactionalEmailSendOutcome>;
  sendOrderCanceledNotice(input: OrderCanceledEmailInput<Locale>): Promise<TransactionalEmailSendOutcome>;
  sendOrderRefundedNotice(input: OrderRefundedEmailInput<Locale>): Promise<TransactionalEmailSendOutcome>;
  sendShipmentDispatchedNotice(input: ShipmentDispatchedEmailInput<Locale>): Promise<TransactionalEmailSendOutcome>;
  sendShipmentDeliveredNotice(input: ShipmentDeliveredEmailInput<Locale>): Promise<TransactionalEmailSendOutcome>;
  sendShipmentExceptionNotice(input: ShipmentExceptionEmailInput<Locale>): Promise<TransactionalEmailSendOutcome>;
}
