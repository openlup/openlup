import { describe, expect, it, vi } from "vitest";
import { createPromotionQuoteAcceptance, recordPromotionAcceptanceOutcome as record } from "@openlup/platform/promotions";
import { previewPromotionCode, MINIMUM_PRODUCT_PAYABLE_MINOR } from "./promotionCodePreview.js";
import { issuePromotionQuoteAcceptance } from "./promotionQuoteAcceptance.js";
import { recordPromotionAcceptanceOutcome } from "./promotionAcceptanceTelemetry.js";
import { resolveAutomaticQuotePromotions } from "./quoteAutomaticPromotions.js";
import { evaluateOrderTotalDiscounts } from "./quotePromoDiscounts.js";
import type { CreateQuoteRequest } from "../../../src/domains/commerce/contracts.js";
import type { CommerceQuote } from "../../../src/domains/commerce/types.js";
import type { CommercePromoDataPort } from "./promoDataPort.js";

describe("reference promotion bindings", () => {
  it("retains floor, classifier, eligibility projection, request bytes and passive recorder behavior", async () => {
    const request: CreateQuoteRequest = { mode: "one_time", lines: [{ sku: "ITEM", quantity: 1 }], promoCodes: [],
      visitorId: "visitor", sizeConstraint: { kind: "unit_count", value: 1 }, customerEligibilityContext: { email: "", contactEmail: "eligible@example.com" } };
    const rows = [{ id: "offer", name: "Offer", code: null, trigger_type: "automatic", discount_type: "percentage", discount_value: 10,
      applies_to_kind: "order_total", applies_to_payload: { cart_mode: "one_time" }, stacking_rule: "exclusive", eligibility: { first_onetime_purchase: true },
      status: "active", valid_from: "2026-01-01T00:00:00.000Z", valid_to: null, region_availability: ["ZZ"] }];
    const reads: CommercePromoDataPort = { listActivePromotions: async () => rows as Awaited<ReturnType<CommercePromoDataPort["listActivePromotions"]>>,
      countPaidOrders: async () => 0, countPaidOrdersByMode: async () => ({ oneTime: 0, subscription: 0 }), redemptionCounts: async () => new Map(), deviceFirstOrderRedeemed: async () => true };
    const input = { promoDataPort: reads, request, regionCode: "ZZ", referenceProductMinor: 10000, subtotalGrossMinor: 10000, shippingGrossMinor: 0, atTime: "2026-10-01T00:00:00.000Z" };
    expect((await resolveAutomaticQuotePromotions(input)).discounts).toEqual([]);
    expect((await resolveAutomaticQuotePromotions({ ...input, request: { ...request, customerEligibilityContext: { contactEmail: "eligible@example.com" } } })).discounts[0]?.customerSemantic).toBe("first_purchase_10");
    expect((await evaluateOrderTotalDiscounts({ ...input, mode: "one_time", clientId: null, promoCodes: [], emailEligibilityConfirmed: true })).discounts[0]?.customerSemantic).toBe("first_purchase_10");
    expect(previewPromotionCode({ benefits: [{ lane: "product", kind: "target_percentage", valueBps: 9999 }], scopes: ["one_time"], promotionEngineVersion: "promotion-engine.v2", minimumReferenceMinor: 0,
      context: { referenceProductMinor: 10000, oneTimeProductMinor: 10000, subscriptionProductMinor: 10000, shippingMinor: 0 } }, "synthetic-preview-key-000000000000000000").results[0]!.productPayableMinor).toBe(MINIMUM_PRODUCT_PAYABLE_MINOR);
    const money = { amountMinor: 100, currency: "XXX" };
    const quote: CommerceQuote = { currency: "XXX", taxIncluded: true, lines: [], discounts: [{ promotionId: "offer", appliesTo: "order_total", amountOffMinor: 100,
      reasonCode: "promotion_code_v2", promotionEngineVersion: "promotion-engine.v2" }], subtotalGross: money, discountTotalGross: money, totalGross: money, netTotal: money, taxTotal: money };
    const keyring = { current: "synthetic-acceptance-key-000000000000000000" }, now = new Date(input.atTime);
    const expected = createPromotionQuoteAcceptance<CreateQuoteRequest>({ projectRequest: value => ({ mode: value.mode, cadenceDays: null,
      lines: [{ sku: "ITEM", quantity: 1, variantId: null, modeAtLine: "one_time" }], sizeConstraint: { kind: "unit_count", value: 1, dailyKcalOverride: null }, visitorId: "visitor", customerEmail: "" }) });
    expect(issuePromotionQuoteAcceptance({ request, quote, keyring, now })).toBe(expected.issuePromotionQuoteAcceptance({ request, quote, keyring, now }));
    const details = { stage: "quote_issue", outcome: "issued", reason: "issued", keySlot: "current", purchaseScope: "one_time", expiryBucket: "24_72h", promotionEngineVersion: "promotion-engine.v2" } as const;
    const recorder = vi.fn(() => { throw new Error("passive recorder"); });
    expect(() => recordPromotionAcceptanceOutcome(details, "public", recorder)).not.toThrow();
    expect(() => record(details, "public", recorder)).not.toThrow();
    expect(recorder.mock.calls[0]).toEqual(recorder.mock.calls[1]);
    expect(recorder.mock.calls[0]).toEqual([{ name: "commerce_promotion_acceptance_outcome", domain: "commerce", surface: "public", details }]);
  });
});
