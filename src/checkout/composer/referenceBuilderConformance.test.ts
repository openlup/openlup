// @vitest-environment jsdom
import { expect, it } from "vitest";
import { createReferenceBuilderDraftStore } from "./referenceBuilderDraft";
import { acceptReferenceQuote, canNavigateReferenceBuilder, changeReferenceSelection, referenceQuoteRequest, referenceRequestKey, type ReferenceBuilderDraft, type ReferenceSelectedQuote } from "./referenceBuilderModel";
import type { ReferenceQuote } from "./referenceQuoteConsent";
import { clearAllRequestCaches, createRequestCache } from "../machine/commerceRequestCache";

const items = ["UNIT-A", "UNIT-B"].map(sku => ({ sku, title: sku, unitPrice: { amountMinor: 1000, currency: "XXX" }, permittedPurchaseModes: ["one_time", "subscription"] as ("one_time" | "subscription")[] }));
const money = { amountMinor: 8000, currency: "XXX" };
const quote: ReferenceQuote = {
  currency: "XXX", taxIncluded: true, lines: [], discounts: [], subtotalGross: money, discountTotalGross: { ...money, amountMinor: 0 }, totalGross: money, netTotal: money, taxTotal: { ...money, amountMinor: 0 },
  promotionAcceptanceToken: "opaque-signed-acceptance-bytes",
  pricingPolicy: { offerPolicyVersion: "commerce.offer-policy.v2", promotionEngineVersion: "promotion-engine.v2", pricingPolicyToken: "opaque-signed-policy-bytes-00000000" },
  acquisitionTerms: { schemaVersion: "subscription-acquisition.v1", revision: "terms-a", delivery2DiscountBps: 1500, initialDiscountBps: 2500, effectiveFrom: "2026-01-01T00:00:00Z", effectiveTo: null, sourcePromotionId: "source-a" },
};
const draft = (): ReferenceBuilderDraft => ({ selection: { mode: "subscription", lines: [{ sku: "UNIT-A", quantity: 3 }, { sku: "UNIT-B", quantity: 5 }], cadenceDays: 30 }, customer: { email: "customer@example.test" }, termsConsent: false, expectation: null });
function fresh(value = draft(), currentQuote = quote): ReferenceSelectedQuote {
  return { requestKey: referenceRequestKey(referenceQuoteRequest(value.selection, items)!), loading: false, error: null, quote: currentQuote };
}
function persisted(scope: string) {
  const value = draft(), selected = fresh(value);
  const accepted = acceptReferenceQuote(value, selected, referenceQuoteRequest(value.selection, items));
  const store = createReferenceBuilderDraftStore(scope);
  expect(store.save(accepted)).toBe("saved");
  clearAllRequestCaches();
  return { reloaded: createReferenceBuilderDraftStore(scope).load()!, selected, accepted };
}

it("W6 transfers selected SKU/count/mode and exact quote promise through save/cache reset/reload", () => {
  for (const mode of ["one_time", "subscription"] as const) {
    const value = draft(); value.selection.mode = mode;
    const request = referenceQuoteRequest(value.selection, items)!;
    expect(request).toEqual({ mode, lines: [{ sku: "UNIT-A", quantity: 3 }, { sku: "UNIT-B", quantity: 5 }], promoCodes: [], acquisitionCapability: "subscription-acquisition.v1", ...(mode === "subscription" ? { cadenceDays: 30 } : {}) });
    const selected = fresh(value), accepted = acceptReferenceQuote(value, selected, request);
    const store = createReferenceBuilderDraftStore(`transfer-${mode}`);
    expect(store.save(accepted)).toBe("saved");
    const cache = createRequestCache<ReferenceQuote>(); cache.set(selected.requestKey, quote);
    clearAllRequestCaches(); expect(cache.get(selected.requestKey)).toBeUndefined();
    const raw = window.localStorage.getItem(`openlup:reference-builder:v1:transfer-${mode}`)!;
    expect(JSON.parse(raw).data.expectation).toEqual({ totalGross: money, pricingPolicy: quote.pricingPolicy, promotionAcceptanceToken: quote.promotionAcceptanceToken, acquisitionTerms: { revision: "terms-a", delivery2DiscountBps: 1500 } });
    const reloaded = createReferenceBuilderDraftStore(`transfer-${mode}`).load()!;
    expect(reloaded).toEqual(accepted);
    expect(canNavigateReferenceBuilder(reloaded, selected, request)).toBe(true);
  }
});

it("W6 reload refuses loading, failed, missing, unsigned and wrong-selection quotes", () => {
  const { reloaded, selected } = persisted("reload");
  const request = referenceQuoteRequest(reloaded.selection, items);
  for (const state of [{ ...selected, loading: true }, { ...selected, error: "unavailable" }, { ...selected, quote: null }, { ...selected, quote: { ...quote, promotionAcceptanceToken: undefined } }, { ...selected, requestKey: "another-selection" }]) {
    expect(canNavigateReferenceBuilder(reloaded, state, request)).toBe(false);
    expect(acceptReferenceQuote(reloaded, state, request).termsConsent).toBe(false);
  }
  expect(canNavigateReferenceBuilder(reloaded, selected, request)).toBe(true);
});

it("W6 navigation independently binds amount, currency, token, policy and second-delivery promise", () => {
  const { reloaded, selected } = persisted("navigation");
  const changed: ReferenceQuote[] = [
    { ...quote, totalGross: { ...money, amountMinor: 8001 } },
    { ...quote, totalGross: { ...money, currency: "YYY" } },
    { ...quote, promotionAcceptanceToken: "different-acceptance-bytes" },
    { ...quote, pricingPolicy: { ...quote.pricingPolicy!, pricingPolicyToken: "different-policy-bytes-00000000000" } },
    { ...quote, pricingPolicy: { offerPolicyVersion: "commerce.offer-policy.v1", promotionEngineVersion: "promotion-engine.v1" } },
    { ...quote, pricingPolicy: undefined },
    { ...quote, acquisitionTerms: { ...quote.acquisitionTerms!, revision: "terms-b" } },
    { ...quote, acquisitionTerms: { ...quote.acquisitionTerms!, delivery2DiscountBps: 1501 } },
    { ...quote, acquisitionTerms: undefined },
  ];
  for (const current of changed) expect(canNavigateReferenceBuilder(reloaded, { ...selected, quote: current }, referenceQuoteRequest(reloaded.selection, items))).toBe(false);
});

it("W6 accepted basket edits clear promise and terms, retain customer facts and require fresh explicit consent", () => {
  const { reloaded, selected } = persisted("edit");
  const edited = changeReferenceSelection(reloaded, { ...reloaded.selection, lines: [{ sku: "UNIT-A", quantity: 4 }, { sku: "UNIT-B", quantity: 5 }] });
  const store = createReferenceBuilderDraftStore("edit"); expect(store.save(edited)).toBe("saved");
  clearAllRequestCaches();
  const restored = createReferenceBuilderDraftStore("edit").load()!;
  expect(restored).toEqual({ ...edited, termsConsent: false, expectation: null, customer: reloaded.customer });
  const request = referenceQuoteRequest(restored.selection, items);
  expect(canNavigateReferenceBuilder(restored, selected, request)).toBe(false);
  const next = fresh(restored);
  expect(canNavigateReferenceBuilder(restored, next, request)).toBe(false);
  const accepted = acceptReferenceQuote(restored, next, request);
  expect(canNavigateReferenceBuilder(accepted, next, request)).toBe(true);
  expect(referenceQuoteRequest({ ...restored.selection, lines: [{ sku: "UNIT-A", quantity: 0 }] }, items)).toBeNull();
  expect(referenceQuoteRequest({ ...restored.selection, lines: [{ sku: "ABSENT", quantity: 1 }] }, items)).toBeNull();
});
