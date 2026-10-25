export const CART_STATUSES = ["draft"] as const;
export const CHECKOUT_STATUSES = ["not_configured", "created", "expired"] as const;
export const ORDER_DRAFT_STATUSES = ["draft"] as const;
export const ORDER_STATUSES = [
  "draft",
  "pending_payment",
  "paid",
  "failed",
  "expired",
  "fulfillment_pending",
  "cancelled",
  "fulfilled",
  "refunded",
] as const;
export const PAYMENT_STATUSES = [
  "not_started",
  "requires_action",
  "processing",
  "paid",
  "failed",
  "expired",
  "refunded",
  "partially_refunded",
  "disputed",
] as const;
export const OMS_FULFILLMENT_BLOCK_REASONS = [
  "order_not_paid",
  "payment_not_succeeded",
  "subscription_cycle_not_paid",
  "active_hold",
  "missing_shipping_address",
  "inventory_review",
  "risk_review",
] as const;
export const OMS_INVENTORY_STATUSES = [
  "not_checked",
  "reserved",
  "missing",
  "released",
  "expired",
  "consumed",
  "review_required",
] as const;
export type CartStatus = (typeof CART_STATUSES)[number];
export type CheckoutStatus = (typeof CHECKOUT_STATUSES)[number];
export type OrderDraftStatus = (typeof ORDER_DRAFT_STATUSES)[number];
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export type OmsFulfillmentBlockReason = (typeof OMS_FULFILLMENT_BLOCK_REASONS)[number];
export type OmsInventoryStatus = (typeof OMS_INVENTORY_STATUSES)[number];

export interface CommerceFulfillmentEligibilityInput<PaymentState extends string = string, SubscriptionState extends string = string> {
  orderMode: "one_time" | "subscription_cycle";
  orderStatus: OrderStatus;
  paymentStatus: PaymentState;
  subscriptionCycleStatus?: SubscriptionState | null;
  activeHoldCount: number;
  hasShippingAddress: boolean;
  inventoryStatus?: OmsInventoryStatus;
  inventoryReviewRequired?: boolean;
  riskReviewRequired?: boolean;
}

export type OmsPaymentStatus<PaymentState extends string> = "not_started" | PaymentState;
