import type { CommerceQuote as NeutralCommerceQuote, CommerceCurrency, CommerceMoney, CartLineInput } from "@openlup/platform/pricing/contracts";
export type { CommerceCurrency, CommerceTaxCountry, CommerceTaxCategory, CommerceTaxLegalBasis, CommerceMoney, CartLineInput, CommerceTaxProfile, CommerceTaxBreakdown, CommerceQuotePricingComponent, CommerceQuoteLine, CommercePromotionCustomerSemantic, CommerceQuoteDiscount, CommerceCodeRejectionReason, CommerceCodeRejection } from "@openlup/platform/pricing/contracts";
import type { PaymentIntentStatus } from "../payment/types.js";
import type { SubscriptionCycleStatus } from "../subscription/types.js";
export type { CommerceCodeRejectionDetail } from "./quoteCodeRejectionDetails.js";
export {
  deriveOrderMoney,
  emitOrderMoneyDiagnostic,
  ORDER_HEADER_MONEY_COLUMNS,
  ORDER_ITEM_MONEY_COLUMNS,
} from "./orderMoney.js";
export type {
  CanonicalOrderMoney,
  CanonicalOrderMoneyLine,
  OrderMoneyDiagnostic,
  OrderMoneyHeaderRow,
  OrderMoneyIssueCode,
  OrderMoneyItemRow,
} from "./orderMoney.js";
export { COMMERCE_CONTRACT_VERSION } from "@openlup/platform/pricing/contracts";
import { COMMERCE_CONTRACT_VERSION } from "@openlup/platform/pricing/contracts";
export { PLATFORM_ACCEPTED_CURRENCIES as COMMERCE_CURRENCIES } from "../../lib/currency/platformCurrency.js";
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
export type OmsPaymentStatus = "not_started" | PaymentIntentStatus;
export type OmsFulfillmentBlockReason = (typeof OMS_FULFILLMENT_BLOCK_REASONS)[number];
export type OmsInventoryStatus = (typeof OMS_INVENTORY_STATUSES)[number];

export interface CommerceQuoteContext {
  mode: "one_time" | "subscription";
  cadenceDays?: number | null;
  /** Trusted-catalog coverage of the final quoted recipe lines; informational only. */
  feedingCoverageDays?: number | null;
  sizeConstraint?: {
    kind: "unit_count" | "total_weight_g" | "feeding_days";
    value: number;
    petId?: string | null;
    dailyKcalOverride?: number | null;
  };
  promoCodes: string[];
  petId?: string | null;
  petProfileContext?: {
    petId?: string | null;
    ageBand?: "puppy" | "young" | "adult" | "senior";
    breed?: string;
    weightKg?: number;
    activityLevel?: "low" | "normal" | "high";
    bcs?: "thin" | "ideal" | "overweight";
    allergenSlugs?: string[];
    dailyKcalOverride?: number | null;
  };
}

export interface CommerceQuote extends Omit<NeutralCommerceQuote, "context"> {
  context?: CommerceQuoteContext;
}

export interface CartDraft {
  id: string;
  status: CartStatus;
  lines: CartLineInput[];
  currency: CommerceCurrency;
}

export interface CheckoutSessionPlaceholder {
  id: string;
  cartId: string;
  status: CheckoutStatus;
  redirectUrl: string | null;
  paymentProviderSessionId: string | null;
}

export interface OrderDraftSummary {
  orderId: string;
  status: OrderDraftStatus;
  paymentStatus: "not_started";
  idempotencyKey: string;
  quoteSnapshot: {
    contractVersion: typeof COMMERCE_CONTRACT_VERSION;
    quote: CommerceQuote;
  };
  replayed: boolean;
}

export interface OrderSummary {
  id: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  total: CommerceMoney | null;
  lines: CartLineInput[];
}

export interface PaymentSummary {
  id: string;
  orderId: string;
  status: PaymentStatus;
  amount: CommerceMoney | null;
  providerReference: string | null;
}

export interface CommerceFulfillmentEligibilityInput {
  orderMode: "one_time" | "subscription_cycle";
  orderStatus: OrderStatus;
  paymentStatus: OmsPaymentStatus;
  subscriptionCycleStatus?: SubscriptionCycleStatus | null;
  activeHoldCount: number;
  hasShippingAddress: boolean;
  inventoryStatus?: OmsInventoryStatus;
  inventoryReviewRequired?: boolean;
  riskReviewRequired?: boolean;
}

export function evaluateCommerceFulfillmentEligibility(
  input: CommerceFulfillmentEligibilityInput,
): { allowed: boolean; reason: OmsFulfillmentBlockReason | null } {
  if (input.activeHoldCount > 0) return { allowed: false, reason: "active_hold" };
  if (!input.hasShippingAddress) return { allowed: false, reason: "missing_shipping_address" };
  if (input.riskReviewRequired) return { allowed: false, reason: "risk_review" };
  if (!["paid", "fulfillment_pending", "fulfilled"].includes(input.orderStatus)) {
    return { allowed: false, reason: "order_not_paid" };
  }
  if (input.paymentStatus !== "succeeded") {
    return { allowed: false, reason: "payment_not_succeeded" };
  }
  if (input.orderMode === "subscription_cycle" && input.subscriptionCycleStatus !== "paid") {
    return { allowed: false, reason: "subscription_cycle_not_paid" };
  }
  if (
    input.inventoryReviewRequired ||
    ["missing", "released", "expired", "review_required"].includes(input.inventoryStatus ?? "not_checked")
  ) {
    return { allowed: false, reason: "inventory_review" };
  }
  return { allowed: true, reason: null };
}

export function mapOmsPaymentStatus(status: string | null): OmsPaymentStatus {
  if (!status) return "not_started";
  if (status === "pending") return "processing";
  if (status === "paid") return "succeeded";
  return status as OmsPaymentStatus;
}
