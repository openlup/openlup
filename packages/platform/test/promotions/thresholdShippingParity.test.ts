import { describe, expect, it, vi } from "vitest";
import { createQuoteShippingPromotions, createQuotePromotionCodeAdjustments, type PromotionCodeQuotePort, type ResolvedPromotionCodeCandidate } from "../../src/promotions/index.js";
import { createDbBackedCommerceQuotePort, type QuoteShippingPromotionResult, type CommerceQuoteCatalogItem } from "../../src/pricing/index.js";
import { resolveShippingPolicy, resolveThresholdShipping, type ShippingSettings } from "../../src/shipping/index.js";
import { terms as acquisitionTerms } from "../pricing/acquisitionFixtures.js";
import { AT, END, request, pricingPolicy, orchestrators, port, row } from "./parityFixtures.js";

const terms = { version: "shipping-threshold.v1" as const, currency: "XXX", flatMinor: 200, freeThresholdMinor: 1000 };
const settings: ShippingSettings = { legacyFlatMinor: 200, policy: { version: "shipping-policy.v1", current: {
  enabled: true, flatMinor: 200, freeThresholdMinor: 1000, effectiveFrom: AT } } };
const input = { request: { ...request, mode: "one_time" as const }, regionCode: "ZZ", currency: "XXX", referenceProductMinor: 1200, subtotalGrossMinor: 1200, atTime: AT };
const adjust = createQuotePromotionCodeAdjustments({ minimumProductPayableMinor: 7 });
function resolver(rows = [] as ReturnType<typeof row>[], codePort?: PromotionCodeQuotePort, configured = settings) {
  const automatic = vi.fn(orchestrators().resolveAutomaticQuotePromotions);
  const apply = vi.fn(adjust.applyPromotionCodesV2);
  const raw = port(rows);
  const factory = createQuoteShippingPromotions({ promoDataPort: raw, promotionCodeQuotePort: codePort,
    commerceSettingsPort: { getShippingSettings: async () => configured }, resolveAutomaticQuotePromotions: automatic, applyPromotionCodesV2: apply });
  return { ...factory, automatic, apply, raw };
}
function codeCandidate(lane: "product" | "shipping", valueMinor = 300): ResolvedPromotionCodeCandidate {
  const base = { promotionId: `code-${lane}`, name: `Code ${lane}`, source: "code" as const, code: "SAVE", codeId: "code-a",
    scopes: ["one_time", "subscription_initial"] as const, codeRevision: 1, definitionFingerprint: "a".repeat(64), minimumReferenceMinor: 0, validTo: null };
  return lane === "shipping" ? { ...base, lane, kind: "free_shipping" } : { ...base, lane, kind: "fixed_amount", valueMinor };
}
function codes(...candidates: ResolvedPromotionCodeCandidate[]): PromotionCodeQuotePort {
  return { resolve: vi.fn(async () => ({ candidates, codeRejections: [], codeRejectionDetails: [] })) };
}
function quotePort(resolve?: (value: typeof input) => Promise<QuoteShippingPromotionResult>) {
  const tax = { included: true as const, country: "ZZ", category: "standard", vatRateBps: 0, legalBasis: "Example" };
  const item: CommerceQuoteCatalogItem = { skuId: "sku", skuCode: "ITEM", variantId: "variant", productSlug: "item", netWeightG: 1,
    isAddon: false, sellability: { oneTime: true, subscription: true }, documentRevision: { id: null, digest: null } };
  const reads: string[] = [];
  const factory = createDbBackedCommerceQuotePort({ taxProfile: tax, supportedTaxProfiles: [tax], regionCode: "ZZ", currency: "XXX", now: () => AT,
    quoteCatalogReadPort: { listQuoteCatalogItems: async () => [item] }, isStrictD1Quote: false,
    pricingResolverPort: { resolvePrice: async value => ({ variantId: value.variantId, mode: value.mode, currency: "XXX", unitPriceMinor: 1000,
      priceEntryId: "price", priceListId: "list", amountKind: "gross", resolvedAt: AT, matchedMinQty: 1 }) },
    shippingFlatMinor: async () => { reads.push("flat"); return 200; }, hasPromotionCodePort: false,
    resolveAutomaticQuotePromotions: async () => { reads.push("automatic"); return { discounts: [], codeRejections: [] }; },
    applyPromotionCodesV2: async () => { reads.push("codes"); return { discounts: [], codeRejections: [], codeRejectionDetails: [] }; },
    ...(resolve ? { resolveQuoteShippingPromotions: resolve } : {}), lineContext: () => ({}), quoteContext: value => () => ({ mode: value.mode, promoCodes: value.promoCodes }) });
  return { ...factory, reads };
}

describe("threshold shipping parity", () => {
  it("retains the flat fee below threshold and preserves the omitted pricing path", async () => {
    const result = await resolver().resolveQuoteShippingPromotions({ ...input, subtotalGrossMinor: 999 });
    expect(result).toMatchObject({ shippingGrossMinor: 200, shippingTerms: terms, hasShipping: true, discounts: [] });
    expect(resolveThresholdShipping(terms, 999)).toEqual({ grossMinor: 200, remainingMinor: 1 });
    const legacy = quotePort();
    const snapshot = await legacy.createQuote(input.request);
    expect(legacy.reads).toEqual(["flat", "automatic", "codes"]);
    expect(snapshot.quote.totalGross.amountMinor).toBe(1200);
    expect(snapshot.quote.context).toEqual({ mode: "one_time", promoCodes: [] });
    const legacySettings = await resolver([], undefined, { legacyFlatMinor: 200, policy: null }).resolveQuoteShippingPromotions({ ...input, subtotalGrossMinor: 1000 });
    const opted = quotePort(async () => legacySettings);
    expect(JSON.stringify(await opted.createQuote(input.request))).toBe(JSON.stringify(snapshot));
  });
  it("makes equality free and integrates final terms and money into pricing", async () => {
    const resolve = resolver();
    const integration = quotePort(async value => ({ ...await resolve.resolveQuoteShippingPromotions(value), acquisitionTerms }));
    const snapshot = await integration.createServerAuthoritativeQuote(input.request);
    expect(snapshot.quote.shippingGross?.amountMinor).toBe(0);
    expect(snapshot.quote.totalGross.amountMinor).toBe(1000);
    expect(snapshot.quote.context).toMatchObject({ shippingTerms: terms, acquisitionTerms });
    expect(integration.reads).toEqual([]);
    expect(resolve.automatic.mock.calls.map(([v]) => v.shippingGrossMinor)).toEqual([200, 0]);
    expect(resolve.apply.mock.calls.map(([v]) => v.shippingGrossMinor)).toEqual([200, 0]);
  });
  it("makes above-threshold spend free with exactly two lane evaluations", async () => {
    const value = resolver();
    expect((await value.resolveQuoteShippingPromotions(input)).shippingGrossMinor).toBe(0);
    expect(value.automatic).toHaveBeenCalledTimes(2);
    expect(value.apply).toHaveBeenCalledTimes(2);
    expect(resolveThresholdShipping(terms, 1001)).toEqual({ grossMinor: 0, remainingMinor: 0 });
  });
  it("uses product spend after discounts when a discount crosses the threshold", async () => {
    const value = resolver([row("product", { discount_type: "fixed_amount", discount_value: 300 })]);
    const result = await value.resolveQuoteShippingPromotions(input);
    expect(result.shippingGrossMinor).toBe(200);
    expect(result.discounts).toEqual([expect.objectContaining({ appliesTo: "order_total", amountOffMinor: 300 })]);
    expect(value.automatic).toHaveBeenCalledOnce();
    expect(value.apply).toHaveBeenCalledOnce();
  });
  it("keeps independent free-shipping benefits out of product threshold spend", async () => {
    const value = resolver([row("shipping", { discount_type: "free_shipping", discount_value: 0 })]);
    const result = await value.resolveQuoteShippingPromotions({ ...input, subtotalGrossMinor: 999 });
    expect(result.shippingGrossMinor).toBe(200);
    expect(result.discounts).toEqual([expect.objectContaining({ appliesTo: "shipping", amountOffMinor: 200 })]);
    expect(value.automatic).toHaveBeenCalledOnce();
    const free = await value.resolveQuoteShippingPromotions({ ...input, subtotalGrossMinor: 1000 });
    expect(free.shippingGrossMinor).toBe(0);
    expect(free.discounts).toEqual([]);
  });
  it("evaluates shipping-only codes against the final fee and rejections", async () => {
    const codePort = codes(codeCandidate("shipping"));
    const value = resolver([], codePort);
    const coded = { ...input, request: { ...input.request, promoCodes: ["save"] } };
    const below = await value.resolveQuoteShippingPromotions({ ...coded, subtotalGrossMinor: 999 });
    expect(below.discounts).toEqual([expect.objectContaining({ code: "save", appliesTo: "shipping", amountOffMinor: 200 })]);
    const free = await value.resolveQuoteShippingPromotions(coded);
    expect(free.shippingGrossMinor).toBe(0);
    expect(free.discounts).toEqual([]);
    expect(free.codeRejections).toEqual([{ code: "save", reason: "better_price_exists" }]);
  });
  it("keeps final combined-code lane winners without stacking provisional discounts", async () => {
    const value = resolver([row("automatic", { discount_type: "fixed_amount", discount_value: 100 })], codes(codeCandidate("product", 300), codeCandidate("shipping")));
    const result = await value.resolveQuoteShippingPromotions({ ...input, request: { ...input.request, promoCodes: ["SAVE"] }, options: { pricingPolicy } });
    expect(result.shippingGrossMinor).toBe(200);
    expect(result.discounts.filter(d => d.appliesTo !== "shipping").reduce((n, d) => n + d.amountOffMinor, 0)).toBe(400);
    expect(result.discounts.filter(d => d.appliesTo === "shipping")).toEqual([expect.objectContaining({ promotionId: "code-shipping", amountOffMinor: 200 })]);
    expect(result.codeRejections).toEqual([]);
  });
  it("activates scheduled settings at the exact boundary and refuses invalid schedules", async () => {
    const scheduled: ShippingSettings = { ...settings, policy: { ...settings.policy!, scheduled: {
      enabled: true, flatMinor: 350, freeThresholdMinor: 1500, effectiveFrom: END } } };
    const value = resolver([], undefined, scheduled);
    expect((await value.resolveQuoteShippingPromotions({ ...input, atTime: new Date(Date.parse(END) - 1).toISOString() })).shippingGrossMinor).toBe(0);
    expect((await value.resolveQuoteShippingPromotions({ ...input, atTime: END })).shippingGrossMinor).toBe(350);
    expect(() => resolveShippingPolicy({ ...scheduled, policy: { ...scheduled.policy!, scheduled: { ...scheduled.policy!.scheduled!, effectiveFrom: AT } } }, END, "XXX")).toThrow();
    expect(resolveShippingPolicy({ ...settings, policy: { ...settings.policy!, current: { ...settings.policy!.current!, enabled: false } } }, AT, "XXX")).toEqual({ configured: true, flatMinor: 0 });
    expect(() => resolveShippingPolicy({ legacyFlatMinor: -1, policy: null }, AT, "XXX")).toThrow();
  });
  it("deduplicates raw reads and clones mutable views across both ordered passes", async () => {
    const raw = port([row("raw")]);
    const codePort = codes(codeCandidate("product"));
    const order: string[] = [];
    const value = createQuoteShippingPromotions({ promoDataPort: raw, promotionCodeQuotePort: codePort,
      commerceSettingsPort: { getShippingSettings: async () => settings },
      resolveAutomaticQuotePromotions: async value => {
        order.push(`automatic:${value.shippingGrossMinor}`);
        const shared = value.promoDataPort!;
        const rows = await shared.listActivePromotions(); expect(rows[0].name).toBe("raw"); rows[0].name = "mutated";
        const paid = await shared.countPaidOrdersByMode("client"); expect(paid.subscription).toBe(0); paid.subscription = 9;
        const counts = await shared.redemptionCounts("client"); expect(counts.size).toBe(0); counts.set("raw", { global: 9, perCustomer: 9 });
        await shared.countPaidOrders("client"); await shared.deviceFirstOrderRedeemed("visitor");
        return { discounts: [], codeRejections: [] };
      },
      applyPromotionCodesV2: async value => {
        order.push(`codes:${value.shippingGrossMinor}`);
        const resolution = await value.port!.resolve({ codes: ["SAVE"], clientId: null, purchaseScope: "one_time", referenceProductMinor: 1200, atTime: AT });
        expect(resolution.candidates).toHaveLength(1); resolution.candidates.pop();
        return { discounts: value.discounts, codeRejections: [], codeRejectionDetails: [] };
      } });
    await value.resolveQuoteShippingPromotions(input);
    expect(order).toEqual(["automatic:200", "codes:200", "automatic:0", "codes:0"]);
    for (const read of Object.values(raw)) expect(read).toHaveBeenCalledOnce();
    expect(codePort.resolve).toHaveBeenCalledOnce();
    expect((await raw.listActivePromotions())[0].name).toBe("raw");
  });
  it("isolates concurrent batch quotes and retries raw failures in a new request", async () => {
    const value = resolver([], codes(codeCandidate("shipping")));
    const coded = { ...input, request: { ...input.request, promoCodes: ["SAVE"] } };
    const [free, paid] = await Promise.all([value.resolveQuoteShippingPromotions(coded), value.resolveQuoteShippingPromotions({ ...coded, subtotalGrossMinor: 999, options: { clientId: "other" } })]);
    expect(free.shippingGrossMinor).toBe(0);
    expect(paid.shippingGrossMinor).toBe(200);
    expect(value.raw.listActivePromotions).toHaveBeenCalledTimes(2);
    expect(value.raw.redemptionCounts).toHaveBeenCalledTimes(2);
    vi.mocked(value.raw.listActivePromotions).mockRejectedValueOnce(new Error("raw unavailable"));
    await expect(value.resolveQuoteShippingPromotions(coded)).rejects.toThrow("raw unavailable");
    expect((await value.resolveQuoteShippingPromotions(coded)).shippingGrossMinor).toBe(0);
  });
});
