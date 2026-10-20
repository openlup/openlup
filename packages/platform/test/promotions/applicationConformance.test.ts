import { describe, expect, it, vi } from "vitest";
import { createDbBackedCommerceQuotePort } from "../../src/pricing/index.js";
import { resolveAutomaticQuotePromotions } from "./bindingsFixtures.js";
import { applyPromotionCodesV2 } from "./bindingsFixtures.js";
import { issuePromotionQuoteAcceptance, verifyPromotionQuoteAcceptance } from "./bindingsFixtures.js";
import type { CommercePromoDataPort } from "../../src/promotions/index.js";
import type { ResolvedPromotionCodeCandidate } from "../../src/promotions/index.js";
import type { PromotionRow } from "@openlup/core/promo";

const time = "2026-10-19T12:00:00.000Z";
const request = { mode: "one_time" as const, lines: [{ sku: "ITEM", quantity: 1 }], promoCodes: ["save", "NOPE"] };
const policy = { offerPolicyVersion: "commerce.offer-policy.v2", promotionEngineVersion: "promotion-engine.v2" } as const;
const tax = { included: true as const, country: "ZZ", category: "standard", vatRateBps: 800, legalBasis: "Example VAT rule" };
function code(valueBps = 8000): ResolvedPromotionCodeCandidate {
  return { promotionId: "promotion", codeId: "code", code: "SAVE", codeRevision: 1,
    definitionFingerprint: "a".repeat(64), minimumReferenceMinor: 0, validTo: null,
    name: "Synthetic target", source: "code", lane: "product", kind: "target_percentage", valueBps, scopes: ["one_time"] };
}
function row(id: string, discount_value: number, stacking_rule: PromotionRow["stacking_rule"] = "exclusive"): PromotionRow {
  return { id, name: id, code: null, trigger_type: "automatic", discount_type: "percentage", discount_value,
    applies_to_kind: "order_total", applies_to_payload: { cart_mode: "one_time" }, stacking_rule,
    eligibility: {}, status: "active", valid_from: "2026-01-01T00:00:00.000Z", valid_to: null, region_availability: ["ZZ"] } as PromotionRow;
}
async function run(candidates = [code()], rows: PromotionRow[] = []) {
  const claim = vi.fn(() => { throw new Error("quote must not claim"); });
  const resolve = vi.fn(async () => ({ candidates, codeRejections: [{ code: "NOPE", reason: "not_eligible" as const }],
    codeRejectionDetails: [{ code: "NOPE", reason: "scope_not_applicable" as const, allowedScopes: ["subscription_initial" as const] }] }));
  const advisory = new Proxy({ resolve }, { get(target, key) { return key in target ? Reflect.get(target, key) : claim; } });
  const reads: CommercePromoDataPort = { listActivePromotions: async () => rows, countPaidOrders: async () => 1,
    countPaidOrdersByMode: async () => ({ oneTime: 1, subscription: 0 }), redemptionCounts: async () => new Map(), deviceFirstOrderRedeemed: async () => false };
  const base = { variantId: "variant", mode: "one_time" as const, matchedMinQty: 1, unitPriceMinor: 10000,
    amountKind: "gross" as const, priceListId: "list", priceEntryId: "entry", resolvedAt: time };
  const port = createDbBackedCommerceQuotePort({ now: () => time, currency: "XXX", regionCode: "ZZ", taxProfile: tax, supportedTaxProfiles: [tax],
    isStrictD1Quote: true, hasPromotionCodePort: true,
    quoteCatalogReadPort: { listQuoteCatalogItems: async () => [{ skuId: "11111111-1111-4111-8111-111111111111", skuCode: "ITEM", variantId: "variant", productSlug: "item",
      netWeightG: 400, energyPer100g: null, isAddon: false, sellability: { oneTime: true, subscription: true },
      documentRevision: { id: "22222222-2222-4222-8222-222222222222", digest: "a".repeat(64) } }] },
    commercePriceAuthorityPort: { resolvePrice: async () => ({ kind: "one_time", base, unitPriceMinor: 10000 }) },
    lineContext: () => ({}), quoteContext: () => () => ({ mode: "one_time", cadenceDays: null, feedingCoverageDays: null }),
    resolveAutomaticQuotePromotions: input => resolveAutomaticQuotePromotions({ ...input, promoDataPort: reads }),
    applyPromotionCodesV2: input => applyPromotionCodesV2({ ...input, port: advisory }),
  });
  const { quote } = await port.createQuote(request, { pricingPolicy: policy, clientId: "customer" });
  const keyring = { current: "a".repeat(48) }, now = new Date(time);
  const token = issuePromotionQuoteAcceptance({ request, quote, keyring, now });
  const accepts = (next = quote) => verifyPromotionQuoteAcceptance({ token: token!, request, quote: next, expectedTotal: quote.totalGross, keyring, now });
  if (token) {
    expect(accepts()).toBe(true);
    expect(accepts((await port.createServerAuthoritativeQuote(request, { pricingPolicy: policy, clientId: "customer" })).quote)).toBe(true);
  }
  expect(claim).not.toHaveBeenCalled();
  return { quote, token, accepts, resolve };
}

describe("neutral promotion application conformance", () => {
  it("preserves evidence, rejection details and acceptance of public money without a claim", async () => {
    const { quote, token, accepts, resolve } = await run();
    expect(quote.totalGross.amountMinor).toBe(2000);
    expect(quote.discounts[0]).toMatchObject({ code: "save", amountOffMinor: 8000, promotionCodeRevision: 1 });
    expect(quote.codeRejections).toEqual([{ code: "NOPE", reason: "not_eligible" }]);
    expect(quote.codeRejectionDetails).toEqual([{ code: "NOPE", reason: "scope_not_applicable", allowedScopes: ["subscription_initial"] }]);
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ purchaseScope: "one_time", referenceProductMinor: 10000, atTime: time }));
    expect(token).toBeTruthy();
    expect(accepts({ ...quote, discounts: quote.discounts.map(d => ({ ...d, promotionCodeRevision: 2 })) })).toBe(true);
    expect(accepts({ ...quote, discounts: quote.discounts.map(d => ({ ...d, amountOffMinor: 8001 })) })).toBe(false);
  });
  it("clamps the signed product total and tax equation to the explicit floor", async () => {
    const { quote } = await run([code(9999)]);
    expect(quote.totalGross.amountMinor).toBe(100);
    expect(quote.discounts[0]).toMatchObject({ floorApplied: true, amountOffMinor: 9900 });
    expect(quote.netTotal.amountMinor + quote.taxTotal.amountMinor).toBe(100);
  });
  it("preserves exclusive and stackable legacy parity and displaced code rejection", async () => {
    const exclusive = await run([code(1000)], [row("large", 40), row("small", 10)]);
    const stacked = await run([code(1000)], [row("first", 40, "stackable_with_any"), row("second", 10, "stackable_with_any")]);
    expect(exclusive.quote.totalGross.amountMinor).toBe(6000);
    expect(stacked.quote.totalGross.amountMinor).toBe(5000);
    expect(exclusive.quote.discounts[0]!.reasonCode).toContain("legacy_parity_floor");
    expect(exclusive.quote.codeRejections).toContainEqual({ code: "save", reason: "better_price_exists" });
  });
  it("retains one legacy coupon mirror when the advisory read has no candidates", async () => {
    const mirror = { ...row("mirror", 20), trigger_type: "coupon_code" as const, code: "save" };
    const { quote } = await run([], [mirror]);
    expect(quote.totalGross.amountMinor).toBe(8000);
    expect(quote.discounts).toHaveLength(1);
    expect(quote.discounts[0]).toMatchObject({ code: "save", amountOffMinor: 2000 });
  });
});
