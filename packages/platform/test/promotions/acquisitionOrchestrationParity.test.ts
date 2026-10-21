import { describe, expect, it, vi } from "vitest";
import { ACQUISITION_TERMS_CAPABILITY } from "../../src/pricing/index.js";
import { acquisition, AT, END, metadata, row, target, port, request, pricingPolicy, orchestrators, v2Input, automaticInput } from "./parityFixtures.js";

const capable = { ...request, acquisitionCapability: ACQUISITION_TERMS_CAPABILITY };
const enabled = () => orchestrators(acquisition);

describe("acquisition orchestration parity", () => {
  it("bypasses malformed acquisition and first-subscription rows for an existing paid subscriber", async () => {
    const rows = [target("malformed", { metadata: { invalid: true } }), row("first", { eligibility: { first_subscription_purchase: true } }), row("ordinary")];
    const result = await enabled().resolveAutomaticQuotePromotions({ ...automaticInput, promoDataPort: port(rows, 1), options: { clientId: "paid", pricingPolicy } });
    expect(result.discounts.map(d => d.promotionId)).toEqual(["ordinary"]);
    expect(result).not.toHaveProperty("acquisitionTerms");
    await expect(enabled().evaluateAutomaticPromotionV2({ ...v2Input, promoDataPort: port(rows, 1), clientId: "paid" })).resolves.toMatchObject({ discounts: [expect.objectContaining({ promotionId: "ordinary" })] });
  });
  it("uses half-open schedule boundaries and propagates the selected next terms", async () => {
    const rows = [target(), target("target-b", { valid_from: END, valid_to: null, metadata: { ...metadata, revision: "offer-b" } })];
    const result = await enabled().resolveAutomaticQuotePromotions({ ...automaticInput, request: capable, atTime: END, promoDataPort: port(rows), options: { pricingPolicy } });
    expect(result.acquisitionTerms).toMatchObject({ revision: "offer-b", sourcePromotionId: "target-b", effectiveFrom: END });
    expect(result.discounts.map(d => d.promotionId)).toEqual(["target-b"]);
    const before = await enabled().evaluateAutomaticPromotionV2({ ...v2Input, atTime: new Date(Date.parse(END) - 1).toISOString(), promoDataPort: port(rows), acquisitionCapability: ACQUISITION_TERMS_CAPABILITY });
    expect(before.acquisitionTerms?.sourcePromotionId).toBe("target-a");
  });
  it("refuses malformed acquisition metadata before evaluation", async () => {
    await expect(enabled().resolveAutomaticQuotePromotions({ ...automaticInput, request: capable, promoDataPort: port([target("bad", { metadata: {} })]), options: { pricingPolicy } }))
      .rejects.toMatchObject({ reason: "acquisition_terms_invalid" });
  });
  it("refuses overlapping acquisition schedules", async () => {
    await expect(enabled().evaluateAutomaticPromotionV2({ ...v2Input, promoDataPort: port([target(), target("overlap", { metadata: { ...metadata, revision: "overlap" } })]), acquisitionCapability: ACQUISITION_TERMS_CAPABILITY }))
      .rejects.toMatchObject({ reason: "acquisition_terms_ambiguous" });
  });
  it("refuses a configured schedule gap without legacy fallback", async () => {
    await expect(enabled().resolveAutomaticQuotePromotions({ ...automaticInput, request: capable, promoDataPort: port([target(), target("later", { valid_from: "2026-10-03T00:00:00.000Z", valid_to: null, metadata: { ...metadata, revision: "later" } })]), options: { pricingPolicy } }))
      .rejects.toMatchObject({ reason: "acquisition_terms_not_effective" });
  });
  it("requires capability before engine negotiation for a standalone offer", async () => {
    await expect(enabled().resolveAutomaticQuotePromotions({ ...automaticInput, promoDataPort: port([target()]) }))
      .rejects.toMatchObject({ reason: "acquisition_terms_capability_required" });
    await expect(enabled().evaluateAutomaticPromotionV2({ ...v2Input, promoDataPort: port([target()]) }))
      .rejects.toMatchObject({ reason: "acquisition_terms_capability_required" });
  });
  it("refuses a capable standalone offer on the legacy engine", async () => {
    await expect(enabled().resolveAutomaticQuotePromotions({ ...automaticInput, request: capable, promoDataPort: port([target()]) }))
      .rejects.toMatchObject({ reason: "acquisition_terms_v2_required" });
  });
  it("propagates selected terms through v2 and a negotiated legacy pair", async () => {
    const standalone = await enabled().evaluateAutomaticPromotionV2({ ...v2Input, promoDataPort: port([target()]), acquisitionCapability: ACQUISITION_TERMS_CAPABILITY });
    expect(standalone.acquisitionTerms).toEqual({ ...metadata, initialDiscountBps: 2300, effectiveFrom: AT, effectiveTo: END, sourcePromotionId: "target-a" });
    const baseline = row("baseline", { baseline: true, metadata, valid_to: END });
    const paired = target("paired", { v2_mirror_of: "baseline" });
    const result = await enabled().resolveAutomaticQuotePromotions({ ...automaticInput, request: capable, promoDataPort: port([baseline, paired]) });
    expect(result.acquisitionTerms?.sourcePromotionId).toBe("paired");
    const unnegotiated = await enabled().resolveAutomaticQuotePromotions({ ...automaticInput, promoDataPort: port([baseline, paired]) });
    expect(unnegotiated).not.toHaveProperty("acquisitionTerms");
  });
  it("preserves ordinary coupons and omitted-seam results and raw read order", async () => {
    const rows = [row("coupon", { trigger_type: "coupon_code", code: "SAVE" })];
    const raw = port(rows);
    const base = orchestrators();
    const value = { ...automaticInput, request: { ...request, promoCodes: ["save"] }, promoDataPort: raw };
    const incumbent = await base.resolveAutomaticQuotePromotions(value);
    expect(incumbent.discounts).toEqual([expect.objectContaining({ promotionId: "coupon", code: "SAVE", amountOffMinor: 120 })]);
    expect(raw.listActivePromotions).toHaveBeenCalledOnce();
    expect(raw.countPaidOrdersByMode).not.toHaveBeenCalled();
    expect(vi.mocked(raw.listActivePromotions).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(raw.redemptionCounts).mock.invocationCallOrder[0]);
    expect(await enabled().resolveAutomaticQuotePromotions({ ...value, promoDataPort: port(rows) })).toEqual(incumbent);
  });
  it("keeps all legacy candidates for canonical spellings and rejection precedence", async () => {
    const rows = [row("tagged", { trigger_type: "coupon_code", code: "KNOWN", metadata, redemption_limit_per_customer: 1 }),
      row("first", { trigger_type: "coupon_code", code: "FIRST", eligibility: { first_subscription_purchase: true } }),
      row("ordinary", { trigger_type: "coupon_code", code: "OTHER" })];
    const raw = port(rows, 1);
    raw.redemptionCounts = async () => new Map([["tagged", { global: 1, perCustomer: 1 }]]);
    const value = { promoDataPort: raw, clientId: "paid", mode: "subscription" as const, promoCodes: ["known", "first", "other", "absent"],
      regionCode: "ZZ", subtotalGrossMinor: 1200, atTime: AT };
    const result = await enabled().evaluateOrderTotalDiscounts(value);
    expect(result.discounts).toEqual([expect.objectContaining({ promotionId: "ordinary", code: "OTHER" })]);
    expect(result.codeRejections).toEqual([{ code: "known", reason: "already_used" }, { code: "first", reason: "not_eligible" }, { code: "absent", reason: "not_recognized" }]);
  });
});
