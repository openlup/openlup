import type { CatalogProductSlug } from "../catalog/types.js";
import type { PaymentIntentStatus } from "../payment/types.js";
import type { SubscriptionCycleStatus } from "../subscription/types.js";
import type { CommerceCodeRejectionDetail } from "./quoteCodeRejectionDetails.js";
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
export const COMMERCE_CONTRACT_VERSION = "commerce.v0";
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
export type CommerceCurrency = string;
// The closed one-member vocabularies these three aliases came from are gone:
// Stage 1 widened the aliases and nothing read the arrays again. See
// src/lib/currency/fiscalProfile.ts, which now owns the facts they froze.
export type CommerceTaxCountry = string;
export type CommerceTaxCategory = string;
export type CommerceTaxLegalBasis = string;
export type CartStatus = (typeof CART_STATUSES)[number];
export type CheckoutStatus = (typeof CHECKOUT_STATUSES)[number];
export type OrderDraftStatus = (typeof ORDER_DRAFT_STATUSES)[number];
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export type OmsPaymentStatus = "not_started" | PaymentIntentStatus;
export type OmsFulfillmentBlockReason = (typeof OMS_FULFILLMENT_BLOCK_REASONS)[number];
export type OmsInventoryStatus = (typeof OMS_INVENTORY_STATUSES)[number];

export interface CommerceMoney {
  amountMinor: number;
  currency: CommerceCurrency;
}

export interface CartLineInput {
  sku: string;
  quantity: number;
  variantId?: string;
  modeAtLine?: "one_time" | "subscription";
  isAddon?: boolean;
}

export interface CommerceTaxProfile {
  included: true;
  country: CommerceTaxCountry;
  category: CommerceTaxCategory;
  vatRateBps: number;
  legalBasis: CommerceTaxLegalBasis;
}

export interface CommerceTaxBreakdown extends CommerceTaxProfile {
  netAmount: CommerceMoney;
  vatAmount: CommerceMoney;
  grossAmount: CommerceMoney;
}

export interface CommerceQuotePricingComponent {
  scope: "line" | "order";
  componentType: "base_unit" | "mode_discount" | "qty_tier" | "promo" | "loyalty" | "shipping" | "bundle";
  amountMinor: number;
  reasonCode: string;
  reasonPayload: Record<string, unknown>;
}

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

export interface CommerceQuoteLine {
  sku: string;
  productSlug: CatalogProductSlug;
  quantity: number;
  unitPriceGross: CommerceMoney;
  lineSubtotalGross: CommerceMoney;
  tax: CommerceTaxBreakdown;
  pricingComponents?: CommerceQuotePricingComponent[];
}

export type CommercePromotionCustomerSemantic =
  | "first_purchase_10"
  | "first_subscription_50"
  | "bundle_5";

export interface CommerceQuoteDiscount {
  promotionId: string;
  code?: string | null;
  label?: string;
  appliesTo: "order_total" | "line" | "shipping";
  amountOffMinor: number;
  reasonCode: string;
  /** Stable presentation identity for canonical offers; never inferred from an editable name. */
  customerSemantic?: CommercePromotionCustomerSemantic;
  promotionEngineVersion?: "promotion-engine.v2";
  promotionCodeId?: string;
  promotionCodeRevision?: number;
  promotionDefinitionFingerprint?: string;
  promotionCodeScopes?: Array<"one_time" | "subscription_initial">;
  promotionMinimumReferenceMinor?: number;
  promotionCodeValidTo?: string | null;
  promotionBenefitKind?: "target_percentage" | "percentage" | "fixed_amount" | "free_shipping";
  promotionBenefitValueBps?: number;
  promotionBenefitValueMinor?: number;
  floorApplied?: boolean;
}

/**
 * Why a customer-submitted promo code did not produce a discount, surfaced so the FE
 * can show a specific message instead of a generic "invalid". `better_price_exists` is
 * the one non-error reason (eligible but unused because an automatic offer is equally
 * good or better; the FE renders it neutrally); `scope_not_applicable` means the code
 * is real but does not apply to this order type. The last two are v2-engine-only reasons.
 */
export type CommerceCodeRejectionReason =
  | "not_recognized" | "already_used" | "not_eligible" | "expired"
  | "better_price_exists" | "scope_not_applicable";

export interface CommerceCodeRejection {
  code: string;
  reason: CommerceCodeRejectionReason;
}

export interface CommerceQuote {
  currency: CommerceCurrency;
  taxIncluded: true;
  lines: CommerceQuoteLine[];
  discounts: CommerceQuoteDiscount[];
  pricingComponents?: CommerceQuotePricingComponent[];
  context?: CommerceQuoteContext;
  /** Submitted coupon codes that produced no discount, with the reason. Omitted when empty. */
  codeRejections?: CommerceCodeRejection[];
  /** UI-safe specifics for selected rejected codes. Omitted when no detail is available. */
  codeRejectionDetails?: CommerceCodeRejectionDetail[];
  subtotalGross: CommerceMoney;
  discountTotalGross: CommerceMoney;
  /** Gross shipping before any free-shipping promo. Optional; absent ⇒ shipping not priced (legacy/0). */
  shippingGross?: CommerceMoney;
  /** Gross shipping discount from a free-shipping promo (≤ shippingGross). Optional; absent ⇒ 0. */
  shippingDiscountGross?: CommerceMoney;
  totalGross: CommerceMoney;
  netTotal: CommerceMoney;
  taxTotal: CommerceMoney;
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
