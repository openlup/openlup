import { vi } from "vitest";
import type { PromotionRow } from "@openlup/core/promo";
import type { AcquisitionFinancialPolicy, CreateQuoteRequest } from "../../src/pricing/index.js";
import { createQuotePromoDiscounts, createQuotePromotionV2, createQuoteAutomaticPromotions } from "../../src/promotions/index.js";
import type { CommercePromoDataPort, QuoteAcquisitionBinding } from "../../src/promotions/index.js";

export const AT = "2026-10-01T00:00:00.000Z";
export const END = "2026-10-02T00:00:00.000Z";
export const request: CreateQuoteRequest = { mode: "subscription", lines: [{ sku: "ITEM", quantity: 1 }], cadenceDays: 17, promoCodes: [] };
export const pricingPolicy = { offerPolicyVersion: "commerce.offer-policy.v2", promotionEngineVersion: "promotion-engine.v2" } as const;
export const metadata = { schemaVersion: "subscription-acquisition.v1" as const, revision: "offer-a", delivery2DiscountBps: 1700 };
export function row(id: string, extra: Record<string, unknown> = {}): PromotionRow {
  return { id, name: id, code: null, trigger_type: "automatic", discount_type: "percentage", discount_value: 10,
    applies_to_kind: "order_total", applies_to_payload: {}, stacking_rule: "exclusive", eligibility: {},
    valid_from: AT, valid_to: null, status: "active", region_availability: ["ZZ"], ...extra } as PromotionRow;
}
export function target(id = "target-a", extra: Record<string, unknown> = {}): PromotionRow {
  return row(id, { promotion_engine_version: "promotion-engine.v2", benefit_lane: "product", benefit_kind: "target_percentage",
    benefit_value_bps: 2300, metadata, valid_to: END, ...extra });
}
const extra = (value: PromotionRow) => value as PromotionRow & Record<string, unknown>;
export const financialPolicy: AcquisitionFinancialPolicy<PromotionRow> = {
  facts: value => ({ id: value.id, active: value.status === "active", regionCodes: value.region_availability,
    validFrom: value.valid_from, validTo: value.valid_to, mirrorOf: extra(value).v2_mirror_of,
    metadataPresent: extra(value).metadata !== undefined, metadata: extra(value).metadata }),
  classify: value => ({ baselineLegacy: extra(value).baseline === true, target: extra(value).benefit_kind === "target_percentage",
    canonicalRow: extra(value).metadata !== undefined || extra(value).baseline === true || extra(value).benefit_kind === "target_percentage",
    unconfiguredLegacyEligible: extra(value).baseline === true }),
  validateMetadata() {},
  pairMatches: (legacy, mirror) => extra(mirror).v2_mirror_of === legacy.id && legacy.valid_from === mirror.valid_from && legacy.valid_to === mirror.valid_to,
  initialDiscountBps: () => 2300,
  unconfiguredTerms: () => metadata,
};
export const acquisition: QuoteAcquisitionBinding<CreateQuoteRequest> = { financialPolicy, capability: value => (value as CreateQuoteRequest & { acquisitionCapability?: unknown }).acquisitionCapability };
export function port(rows: PromotionRow[] = [], subscription = 0): CommercePromoDataPort {
  return { listActivePromotions: vi.fn(async () => rows), countPaidOrders: vi.fn(async () => subscription),
    countPaidOrdersByMode: vi.fn(async () => ({ oneTime: 0, subscription })), redemptionCounts: vi.fn(async () => new Map()),
    deviceFirstOrderRedeemed: vi.fn(async () => false) };
}
export function orchestrators(binding?: QuoteAcquisitionBinding<CreateQuoteRequest>) {
  const common = { promotionCustomerSemantic: () => undefined, ...(binding ? { acquisition: binding } : {}) };
  const legacy = createQuotePromoDiscounts(common);
  const v2 = createQuotePromotionV2({ ...common, minimumProductPayableMinor: 7, ...legacy });
  const automatic = createQuoteAutomaticPromotions({ resolveEmailEligibility: () => false, ...legacy, ...v2,
    ...(binding ? { acquisition: binding } : {}) });
  return { ...legacy, ...v2, ...automatic };
}
export const v2Input = { clientId: null, mode: "subscription" as const, regionCode: "ZZ", referenceProductMinor: 1200,
  currentProductMinor: 1200, shippingMinor: 200, atTime: AT };
export const automaticInput = { request, regionCode: "ZZ", referenceProductMinor: 1200, subtotalGrossMinor: 1200,
  shippingGrossMinor: 200, atTime: AT };
