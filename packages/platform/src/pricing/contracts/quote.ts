import type { CommerceCurrency, CommerceMoney, CommerceTaxBreakdown } from "./money.js";
import type { CommerceCodeRejectionDetail } from "./evidence.js";

export const COMMERCE_CONTRACT_VERSION = "commerce.v0";

export interface CommerceQuotePricingComponent {
  scope: "line" | "order";
  componentType: "base_unit" | "mode_discount" | "qty_tier" | "promo" | "loyalty" | "shipping" | "bundle";
  amountMinor: number;
  reasonCode: string;
  reasonPayload: Record<string, unknown>;
}

/** Hosts may extend this context with their own validated policy. */
export interface CommerceQuoteContext {
  mode: "one_time" | "subscription";
  cadenceDays?: number | null;
  promoCodes: string[];
}

export interface CommerceQuoteLine {
  sku: string;
  productSlug: string;
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

export interface CreateQuoteRequest {
  mode: "one_time" | "subscription";
  lines: import("./money.js").CartLineInput[];
  cadenceDays?: number | null;
  promoCodes: string[];
}

export interface CreateQuoteResponse {
  contractVersion: typeof COMMERCE_CONTRACT_VERSION;
  quote: Omit<CommerceQuote, "lines"> & { lines: Array<CommerceQuoteLine & { catalogFacts?: import("./provenance.js").CatalogFactsProvenance }> };
}
