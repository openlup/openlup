import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createStarterOfferGuard, withStarterPackContext } from "../../src/commerce/server/index.js";
import { intent, quoteSnapshot, CLIENT_ID, ADDRESS_ID, type Intent, type Snapshot, type Plan, type Provisioned } from "./checkoutTestFixtures.js";
import type { CreateQuoteRequest } from "../../src/pricing/index.js";
function fixture() {
  const terms = { intervalDays: 14, steadyCadenceDays: 21, steadyUnits: 14, graduationSizeConstraint: { kind: "weight", value: 7 } };
  const resolve = vi.fn(async () => ({ kind: "terms" as const, terms }));
  const discountMinor = vi.fn(() => 240);
  const core = createStarterOfferGuard<Intent, Provisioned, CreateQuoteRequest, Snapshot, Plan>({ declaration: input => input.starterOffer, defaultTermsPort: { resolve }, defaultDiscountBps: 3000, discountMinor, planSchema: z.custom<Plan>(), aggregateBySku: entries => entries, rescaleBasket: entries => entries, steadyIntent: (input, cadenceDays, _units, selectedVariants) => ({ ...input, cadenceDays, promoCodes: [], selectedVariants }), buildQuoteRequest: input => ({ mode: input.mode, cadenceDays: input.cadenceDays, promoCodes: input.promoCodes, lines: input.selectedVariants.map(line => ({ sku: line.sku, quantity: line.qty })) }) });
  const snapshot = quoteSnapshot(); snapshot.quote.context = { mode: "subscription", promoCodes: [], pricingPolicy: { offerPolicyVersion: "commerce.offer-policy.v2", promotionEngineVersion: "promotion-engine.v2" } };
  snapshot.quote.pricingComponents = [{ scope: "order", componentType: "base_unit", amountMinor: 2400, reasonCode: "list", reasonPayload: {} }];
  const createQuote = vi.fn(async () => snapshot);
  const input = { flagEnabled: true, intent: { ...intent("subscription"), starterOffer: { intervalDays: 14, delivery2DiscountBps: 3000, steady: { cadenceDays: 21, units: 14 } } }, provisioned: { clientId: CLIENT_ID, addressId: ADDRESS_ID, replayed: false }, authoritativeQuote: snapshot, quotePort: { createQuote }, isFirstOrderEligible: vi.fn(async () => true), offerVersion: "offer-a" };
  return { core, terms, resolve, discountMinor, createQuote, input, snapshot };
}
describe("injected starter admission", () => {
  it("does no work without a declaration and refuses disabled/wrong-mode asks before terms", async () => {
    const f = fixture(); await expect(f.core.resolveStarterOfferGuard({ ...f.input, intent: intent() })).resolves.toEqual({ kind: "absent" });
    await expect(f.core.resolveStarterOfferGuard({ ...f.input, flagEnabled: false })).resolves.toEqual({ kind: "rejected", reason: "starter_offer_disabled" });
    await expect(f.core.resolveStarterOfferGuard({ ...f.input, intent: { ...f.input.intent, mode: "one_time" } })).resolves.toEqual({ kind: "rejected", reason: "starter_offer_wrong_mode" });
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.createQuote).not.toHaveBeenCalled();
  });
  it.each(["basket_too_small", "basket_not_admitted", "demand_unknown"] as const)("keeps the terms refusal %s before eligibility or quoting", async reason => {
    const f = fixture(); const result = await f.core.resolveStarterOfferGuard({ ...f.input, termsPort: { async resolve() { return { kind: "refused", reason }; } } });
    expect(result).toEqual({ kind: "rejected", reason: `starter_offer_${reason}` }); expect(f.input.isFirstOrderEligible).not.toHaveBeenCalled(); expect(f.createQuote).not.toHaveBeenCalled();
  });
  it("freezes injected cadence, constraint and selected discount, and forwards policy/version on the steady quote", async () => {
    const f = fixture(); const result = await f.core.resolveStarterOfferGuard(f.input);
    expect(f.resolve).toHaveBeenCalledExactlyOnceWith({ intent: f.input.intent, authoritativeQuote: f.snapshot, offerVersion: "offer-a" });
    expect(f.discountMinor).toHaveBeenCalledWith({ bandSubtotalMinor: 1490, listAnchorTotalMinor: 2400, discountBps: 3000 });
    expect(f.createQuote).toHaveBeenCalledWith(expect.objectContaining({ mode: "subscription", cadenceDays: 21, promoCodes: [] }), { clientId: CLIENT_ID, offerVersion: "offer-a", pricingPolicy: f.snapshot.quote.context?.pricingPolicy });
    expect(result).toMatchObject({ kind: "minted", plan: { starterIntervalDays: 14, basisTemplateVersion: 1, delivery2: { discountBps: 3000, discountMinor: 240, basisSubtotalMinor: 1490 }, graduation: { cadenceDays: 21, sizeConstraint: f.terms.graduationSizeConstraint, lines: [{ sku: "ITEM-A", qty: 1, sortOrder: 0, isAddon: false }] } } });
    if (result.kind === "minted") expect(result.plan.graduation.lines[0].quoteLine).not.toHaveProperty("pricingComponents");
    expect(withStarterPackContext(f.snapshot, null)).toBe(f.snapshot);
  });
  it("rejects drift before eligibility, then refuses absent eligibility without a steady quote", async () => {
    const f = fixture(); await expect(f.core.resolveStarterOfferGuard({ ...f.input, intent: { ...f.input.intent, starterOffer: { ...f.input.intent.starterOffer, intervalDays: 13 } } })).resolves.toMatchObject({ kind: "rejected", reason: "starter_offer_terms_drifted" });
    expect(f.input.isFirstOrderEligible).not.toHaveBeenCalled();
    await expect(f.core.resolveStarterOfferGuard({ ...f.input, isFirstOrderEligible: undefined })).resolves.toMatchObject({ kind: "rejected", reason: "starter_offer_not_first_order" }); expect(f.createQuote).not.toHaveBeenCalled();
  });
  it("rejects changed acquisition revisions independently of equal totals", async () => {
    const f = fixture(); f.snapshot.quote.context!.acquisitionTerms = { schemaVersion: "subscription-acquisition.v1", revision: "terms-b", initialDiscountBps: 2000, delivery2DiscountBps: 3000, effectiveFrom: "1999-01-01T00:00:00.000Z", effectiveTo: null, sourcePromotionId: "source-a" };
    await expect(f.core.resolveStarterOfferGuard(f.input)).resolves.toMatchObject({ kind: "rejected", reason: "starter_offer_terms_drifted" });
    expect(f.input.isFirstOrderEligible).not.toHaveBeenCalled();
  });
});
