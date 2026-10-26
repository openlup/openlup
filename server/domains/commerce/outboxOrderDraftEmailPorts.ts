import type { Locale } from "../../../src/lib/i18n/resolveLocale.js";
import type * as Neutral from "@openlup/platform/commerce";
import type { FirstSubscriptionPricePresentation } from "../../../src/domains/commerce/firstSubscriptionPricePresentation.js";
export { OUTBOX_ORDER_CONFIRMATION_TEMPLATE_SLUG, OUTBOX_ORDER_PAID_TEMPLATE_SLUG, OUTBOX_CHECKOUT_RECOVERY_TEMPLATE_SLUG, OUTBOX_PAYMENT_FAILED_TEMPLATE_SLUG, OUTBOX_CHECKOUT_EXPIRED_TEMPLATE_SLUG, OUTBOX_ORDER_CANCELED_TEMPLATE_SLUG, OUTBOX_ORDER_REFUNDED_TEMPLATE_SLUG, OUTBOX_SHIPMENT_DISPATCHED_TEMPLATE_SLUG, OUTBOX_SHIPMENT_DELIVERED_TEMPLATE_SLUG, OUTBOX_SHIPMENT_EXCEPTION_TEMPLATE_SLUG, OUTBOX_RETURN_APPROVED_TEMPLATE_SLUG, OUTBOX_RETURN_REJECTED_TEMPLATE_SLUG } from "@openlup/platform/commerce";
export type { OrderPaymentLifecycleState, OrderPaymentLifecyclePort, OrderEmailLineItem, OrderEmailTotals, OrderPaidRawLine } from "@openlup/platform/commerce";
export type OrderRecipient = Omit<Neutral.OrderRecipient, "contextName"> & { petName?: string | null };
export type OrderConfirmationEmailInput = Omit<Neutral.OrderConfirmationEmailInput<Locale>, "contextName"> & { petName?: string | null };
export type CheckoutRecoveryEmailInput = Omit<Neutral.CheckoutRecoveryEmailInput<Locale>, "contextName"> & { petName?: string | null };
export type OrderPaidConfirmationEmailInput = Omit<Neutral.OrderPaidConfirmationEmailInput<Locale>, "contextName"> & { petName?: string | null };
export type ShipmentDispatchedEmailInput = Omit<Neutral.ShipmentDispatchedEmailInput<Locale>, "contextName"> & { petName?: string | null };
export type ShipmentDeliveredEmailInput = Omit<Neutral.ShipmentDeliveredEmailInput<Locale>, "contextName"> & { petName?: string | null };
export type TransactionalEmailSendOutcome = Omit<Neutral.TransactionalEmailSendOutcome, "messageId"> & { resendId: string | null };
export interface OrderRecipientPort { resolve(orderUuid: string, signal: AbortSignal): Promise<OrderRecipient | null> }
export type OrderPaidRawData = Omit<Neutral.OrderPaidRawData, "presentation"> & { firstSubscriptionPricePresentation?: OrderPaidPricePresentation | null };
export interface OrderPaidLinesPort { read(orderUuid: string, signal: AbortSignal): Promise<OrderPaidRawData | null> }
export interface TransactionalEmailPort {
  findExistingSend(templateSlug: string, outboxEventId: string): Promise<boolean>;
  sendReturnApprovedNotice(input: Neutral.ReturnDecisionEmailInput<Locale>): Promise<TransactionalEmailSendOutcome>;
  sendReturnRejectedNotice(input: Neutral.ReturnDecisionEmailInput<Locale>): Promise<TransactionalEmailSendOutcome>;
  sendOrderConfirmation(input: OrderConfirmationEmailInput): Promise<TransactionalEmailSendOutcome>;
  sendCheckoutRecovery(input: CheckoutRecoveryEmailInput): Promise<TransactionalEmailSendOutcome>;
  sendOrderPaidConfirmation(input: OrderPaidConfirmationEmailInput): Promise<TransactionalEmailSendOutcome>;
  sendPaymentFailedNotice(input: Neutral.PaymentFailedEmailInput<Locale>): Promise<TransactionalEmailSendOutcome>;
  sendCheckoutExpiredNotice(input: Neutral.CheckoutExpiredEmailInput<Locale>): Promise<TransactionalEmailSendOutcome>;
  sendOrderCanceledNotice(input: Neutral.OrderCanceledEmailInput<Locale>): Promise<TransactionalEmailSendOutcome>;
  sendOrderRefundedNotice(input: Neutral.OrderRefundedEmailInput<Locale>): Promise<TransactionalEmailSendOutcome>;
  sendShipmentDispatchedNotice(input: ShipmentDispatchedEmailInput): Promise<TransactionalEmailSendOutcome>;
  sendShipmentDeliveredNotice(input: ShipmentDeliveredEmailInput): Promise<TransactionalEmailSendOutcome>;
  sendShipmentExceptionNotice(input: Neutral.ShipmentExceptionEmailInput<Locale>): Promise<TransactionalEmailSendOutcome>;
}
export type OrderPaidPricePresentation = Omit<FirstSubscriptionPricePresentation, "discountPercent"> & { discountPercent: number };
export type PaymentFailedEmailInput = Neutral.PaymentFailedEmailInput<Locale>;
export type CheckoutExpiredEmailInput = Neutral.CheckoutExpiredEmailInput<Locale>;
export type OrderCanceledEmailInput = Neutral.OrderCanceledEmailInput<Locale>;
export type OrderRefundedEmailInput = Neutral.OrderRefundedEmailInput<Locale>;
export type ShipmentExceptionEmailInput = Neutral.ShipmentExceptionEmailInput<Locale>;
export type ReturnDecisionEmailInput = Neutral.ReturnDecisionEmailInput<Locale>;
