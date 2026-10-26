import type { CommerceQuote as NeutralCommerceQuote, CommerceQuoteContext as NeutralCommerceQuoteContext, CommerceCurrency, CommerceMoney, CartLineInput } from "@openlup/platform/pricing/contracts";
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
export { CART_STATUSES, CHECKOUT_STATUSES, ORDER_DRAFT_STATUSES, ORDER_STATUSES, PAYMENT_STATUSES, OMS_FULFILLMENT_BLOCK_REASONS, OMS_INVENTORY_STATUSES } from "@openlup/platform/commerce";
export type { CartStatus, CheckoutStatus, OrderDraftStatus, OrderStatus, PaymentStatus, OmsFulfillmentBlockReason, OmsInventoryStatus } from "@openlup/platform/commerce/contracts";
import type { OmsFulfillmentBlockReason } from "@openlup/platform/commerce/contracts";
export type OmsPaymentStatus = import("@openlup/platform/commerce/contracts").OmsPaymentStatus<PaymentIntentStatus>;

export interface CommerceQuoteContext extends NeutralCommerceQuoteContext {
  shippingTerms?: import("@openlup/platform/shipping/contracts").ShippingTerms;
  acquisitionTerms?: import("@openlup/platform/pricing/contracts").ResolvedAcquisitionTerms;
  offerVersion?: string;
  offerEvidence?: import("@openlup/platform/commerce").CommerceOfferEvidence;
  /** Trusted-catalog coverage of the final quoted recipe lines; informational only. */
  feedingCoverageDays?: number | null;
  sizeConstraint?: {
    kind: "unit_count" | "total_weight_g" | "feeding_days";
    value: number;
    petId?: string | null;
    dailyKcalOverride?: number | null;
  };
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

export type CartDraft = import("@openlup/platform/commerce/contracts").CartDraft<CartLineInput, CommerceCurrency>;
export type { CheckoutSessionPlaceholder } from "@openlup/platform/commerce/contracts";
export type OrderDraftSummary = import("@openlup/platform/commerce/contracts").OrderDraftSummary<CommerceQuote, typeof COMMERCE_CONTRACT_VERSION>;
export type OrderSummary = import("@openlup/platform/commerce/contracts").OrderSummary<CartLineInput, CommerceMoney>;
export type PaymentSummary = import("@openlup/platform/commerce/contracts").PaymentSummary<CommerceMoney>;
export type CommerceFulfillmentEligibilityInput = import("@openlup/platform/commerce/contracts").CommerceFulfillmentEligibilityInput<OmsPaymentStatus, SubscriptionCycleStatus>;

import { mapOmsPaymentStatus as mapPaymentStatus } from "@openlup/platform/commerce";
export function mapOmsPaymentStatus(status: string | null): OmsPaymentStatus { return mapPaymentStatus(status) as OmsPaymentStatus; }

import { evaluateCommerceFulfillmentEligibility as evaluateEligibility } from "@openlup/platform/commerce";
export function evaluateCommerceFulfillmentEligibility(input: CommerceFulfillmentEligibilityInput): { allowed: boolean; reason: OmsFulfillmentBlockReason | null } { return evaluateEligibility(input); }
