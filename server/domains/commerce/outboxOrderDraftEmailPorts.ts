import type { Locale } from "../../../src/lib/i18n/resolveLocale.js";
import type { FirstSubscriptionPricePresentation } from "../../../src/domains/commerce/firstSubscriptionPricePresentation.js";

export const OUTBOX_ORDER_CONFIRMATION_TEMPLATE_SLUG = "commerce-order-confirmation";

export interface OrderRecipient {
  email: string;
  firstName: string | null;
  // clients.country, used to resolve the email locale. Optional/null when the
  // column is empty; resolveLocale falls back to PL.
  country?: string | null;
  // Pet tied to this order. Optional keeps test/legacy adapters compatible;
  // the Supabase adapter always emits a string or null.
  petName?: string | null;
}

export interface OrderRecipientPort {
  // orderUuid -> commerce_orders.client_id -> clients.email; null when the
  // order has no client attached (expected for anonymous drafts today).
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
  // Re-read order/payment state at send time so delayed or redriven outbox rows
  // cannot email a customer with stale checkout copy after the order converts.
  read(orderUuid: string, signal: AbortSignal): Promise<OrderPaymentLifecycleState | null>;
}

// One itemized order line, already resolved + money-formatted by the handler so
// the renderer/content stay free of catalog and currency concerns.
export interface OrderEmailLineItem {
  name: string;
  quantity: number;
  // Formatted gross line total, e.g. "129,98 zł".
  lineTotalLabel: string;
}

// Money breakdown for the order summary. discountLabel/subtotalLabel are null
// when their value is unknown so the email omits that row entirely (never aliases
// the grand total into the subtotal row, which would not reconcile against a
// separate discount line).
export interface OrderEmailTotals {
  subtotalLabel: string | null;
  discountLabel: string | null;
  totalLabel: string;
  firstSubscription?: {
    catalogLabel: string;
    productPayableLabel: string;
    shippingLabel: string | null;
    shippingFree: boolean;
  };
}

export interface OrderConfirmationEmailInput {
  to: string;
  firstName: string | null;
  petName?: string | null;
  // Display id, e.g. "order_<uuid>" from the event payload.
  orderId: string;
  // Dedupe key persisted into email_sends.provider_response.outboxEventId.
  outboxEventId: string;
  // Resolved, money-formatted line items; the adapter renders HTML around them
  // and never learns the order-draft snapshot shape.
  items: OrderEmailLineItem[];
  // Money breakdown, or null when totals are unknown/malformed.
  totals: OrderEmailTotals | null;
  // Email locale resolved from the recipient's country; the adapter defaults to
  // "pl" when absent so existing callers keep the Polish copy.
  locale?: Locale;
  signal: AbortSignal;
}

export interface TransactionalEmailSendOutcome {
  ok: boolean;
  resendId: string | null;
  // 0 = network-level failure (no HTTP response).
  httpStatus: number;
  providerError: string | null;
  // True when the POST was cancelled by the handler-timeout AbortSignal.
  // Callers must map this to a retry (attempt consumed), NOT to the snooze
  // (attempt-refunded provider-outage) path: a reliably-slow send that kept
  // refunding attempts could re-execute ~maxSnoozes times instead of <= max
  // attempts, and each cycle is a potential duplicate email.
  aborted: boolean;
  /** Terminal intentional non-send; callers must not count it as sent. */
  skipReason?: "admin_disabled" | "egress_suppressed" | null;
}

// Paid-order confirmation (distinct from the pre-payment order-draft nudge).
export const OUTBOX_ORDER_PAID_TEMPLATE_SLUG = "commerce-order-paid";

// Checkout-recovery (W3): transactional nudge to complete payment for an unpaid order via a
// signed deep-link. One slug for both waves; 1h/20h differ only in copy, carried by reminderHours.
export const OUTBOX_CHECKOUT_RECOVERY_TEMPLATE_SLUG = "commerce-checkout-recovery";

export interface CheckoutRecoveryEmailInput {
  to: string;
  firstName: string | null;
  petName?: string | null;
  // Order UUID — used only for the email_sends/delivery-timeline order linkage.
  orderId: string;
  // Raw recovery token; the renderer builds the locale-aware deep-link
  // /konto/dokoncz-platnosc?token=… from it.
  recoveryToken: string;
  // "subscription_cycle" | "one_time" — varies the copy.
  mode: string;
  // 1 = first nudge, 20 = final nudge.
  reminderHours: number;
  // Present only for the buyer's own escape hatch off a stuck payment step: the renderer adds
  // one deep-link parameter so the landing page can tell that arrival apart. Absent for every
  // other producer, whose URLs stay exactly what they were.
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
  firstSubscriptionPricePresentation?: FirstSubscriptionPricePresentation | null;
  lines: OrderPaidRawLine[];
}

export interface OrderPaidLinesPort {
  read(orderUuid: string, signal: AbortSignal): Promise<OrderPaidRawData | null>;
}

export interface OrderPaidConfirmationEmailInput {
  to: string;
  firstName: string | null;
  petName?: string | null;
  orderId: string;
  // "one_time" | "subscription_cycle" (free-form per the event contract); the
  // content module varies the intro copy and defaults to one-time framing.
  mode: string;
  outboxEventId: string;
  items: OrderEmailLineItem[];
  totals: OrderEmailTotals | null;
  locale?: Locale;
  signal: AbortSignal;
}

// Payment-failed nudge (recoverable decline while the order/subscription context
// is still alive).
export const OUTBOX_PAYMENT_FAILED_TEMPLATE_SLUG = "commerce-payment-failed";

export interface PaymentFailedEmailInput {
  to: string;
  firstName: string | null;
  orderId: string;
  // Formatted gross order total, e.g. "129,99 zł", or null when unknown.
  amountLabel: string | null;
  recoveryToken: string;
  mode: string;
  outboxEventId: string;
  locale?: Locale;
  signal: AbortSignal;
}

export const OUTBOX_CHECKOUT_EXPIRED_TEMPLATE_SLUG = "commerce-checkout-expired";

export interface CheckoutExpiredEmailInput {
  to: string;
  firstName: string | null;
  orderId: string;
  amountLabel: string | null;
  /** Raw checkout-recovery token, emitted only in the outbox payload: the database
   * stores only its hash, and renderers turn this into /konto/dokoncz-platnosc. */
  recoveryToken?: string | null;
  outboxEventId: string;
  locale?: Locale;
  signal: AbortSignal;
}

// Order-cancellation notice (a paid/in-fulfillment order that was cancelled).
export const OUTBOX_ORDER_CANCELED_TEMPLATE_SLUG = "commerce-order-canceled";

export interface OrderCanceledEmailInput {
  to: string;
  firstName: string | null;
  orderId: string;
  // Formatted gross order total, e.g. "129,99 zł", or null when unknown.
  amountLabel: string | null;
  outboxEventId: string;
  locale?: Locale;
  signal: AbortSignal;
}

// Refund confirmation (an order that was refunded).
export const OUTBOX_ORDER_REFUNDED_TEMPLATE_SLUG = "commerce-order-refunded";

export interface OrderRefundedEmailInput {
  to: string;
  firstName: string | null;
  orderId: string;
  // Formatted gross refund total, e.g. "129,99 zł", or null when unknown.
  amountLabel: string | null;
  outboxEventId: string;
  locale?: Locale;
  signal: AbortSignal;
}

// Shipment-dispatched notice (the order was handed to the carrier).
export const OUTBOX_SHIPMENT_DISPATCHED_TEMPLATE_SLUG = "commerce-shipment-dispatched";

export interface ShipmentDispatchedEmailInput {
  to: string;
  firstName: string | null;
  petName?: string | null;
  orderId: string;
  // Opaque carrier tracking id, or null when the attempt carried none.
  trackingNumber: string | null;
  // Absolute customer-facing tracking URL the adapter built from the tracking
  // number, or null when there is no tracking id; the content omits the CTA.
  trackingUrl: string | null;
  outboxEventId: string;
  locale?: Locale;
  signal: AbortSignal;
}

// Shipment-delivered notice (the carrier marked the parcel delivered).
export const OUTBOX_SHIPMENT_DELIVERED_TEMPLATE_SLUG = "commerce-shipment-delivered";

export interface ShipmentDeliveredEmailInput {
  to: string;
  firstName: string | null;
  petName?: string | null;
  orderId: string;
  outboxEventId: string;
  locale?: Locale;
  signal: AbortSignal;
}

// Shipment-exception notice (a fulfillment_exception hold was placed — e.g. a
// split-shipment order routed to manual review). Reassurance-only: no internal
// reason is exposed and the customer is asked to do nothing.
export const OUTBOX_SHIPMENT_EXCEPTION_TEMPLATE_SLUG = "commerce-shipment-exception";

export interface ShipmentExceptionEmailInput {
  to: string;
  firstName: string | null;
  orderId: string;
  outboxEventId: string;
  locale?: Locale;
  signal: AbortSignal;
}

// Return decision notices (admin approved/rejected a return request). No amount —
// approved tells the customer to send items back; rejected explains we can't accept.
export const OUTBOX_RETURN_APPROVED_TEMPLATE_SLUG = "commerce-return-approved";
export const OUTBOX_RETURN_REJECTED_TEMPLATE_SLUG = "commerce-return-rejected";

export interface ReturnDecisionEmailInput {
  to: string;
  firstName: string | null;
  orderId: string;
  outboxEventId: string;
  locale?: Locale;
  signal: AbortSignal;
}

export interface TransactionalEmailPort {
  findExistingSend(templateSlug: string, outboxEventId: string): Promise<boolean>;
  sendReturnApprovedNotice(input: ReturnDecisionEmailInput): Promise<TransactionalEmailSendOutcome>;
  sendReturnRejectedNotice(input: ReturnDecisionEmailInput): Promise<TransactionalEmailSendOutcome>;
  sendOrderConfirmation(input: OrderConfirmationEmailInput): Promise<TransactionalEmailSendOutcome>;
  sendCheckoutRecovery(input: CheckoutRecoveryEmailInput): Promise<TransactionalEmailSendOutcome>;
  sendOrderPaidConfirmation(input: OrderPaidConfirmationEmailInput): Promise<TransactionalEmailSendOutcome>;
  sendPaymentFailedNotice(input: PaymentFailedEmailInput): Promise<TransactionalEmailSendOutcome>;
  sendCheckoutExpiredNotice(input: CheckoutExpiredEmailInput): Promise<TransactionalEmailSendOutcome>;
  sendOrderCanceledNotice(input: OrderCanceledEmailInput): Promise<TransactionalEmailSendOutcome>;
  sendOrderRefundedNotice(input: OrderRefundedEmailInput): Promise<TransactionalEmailSendOutcome>;
  sendShipmentDispatchedNotice(input: ShipmentDispatchedEmailInput): Promise<TransactionalEmailSendOutcome>;
  sendShipmentDeliveredNotice(input: ShipmentDeliveredEmailInput): Promise<TransactionalEmailSendOutcome>;
  sendShipmentExceptionNotice(input: ShipmentExceptionEmailInput): Promise<TransactionalEmailSendOutcome>;
}
