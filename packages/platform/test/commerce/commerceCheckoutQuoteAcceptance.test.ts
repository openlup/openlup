import { describe, expect, it, vi } from "vitest";
import { resolveCheckoutQuoteGuard, intent, quoteSnapshot, CLIENT_ID, ADDRESS_ID } from "./checkoutTestFixtures.js";
const recordQuoteStage = async <T>(operation: () => Promise<T>) => operation();
describe("checkout financial acceptance", () => {
  it.each(["shipping", "acquisition"] as const)("requires acceptance for %s terms even with no current discount", async kind => {
    const snapshot = quoteSnapshot(); snapshot.quote.context = { mode: "one_time", promoCodes: [], ...(kind === "shipping" ? { shippingTerms: { version: "shipping-threshold.v1", currency: "XTS", flatMinor: 100, freeThresholdMinor: 2000 } } : { acquisitionTerms: { schemaVersion: "subscription-acquisition.v1", revision: "terms-a", initialDiscountBps: 2000, delivery2DiscountBps: 3000, effectiveFrom: "1999-01-01T00:00:00.000Z", effectiveTo: null, sourcePromotionId: CLIENT_ID } }) };
    const input = { quotePort: { createQuote: vi.fn(async () => snapshot) }, intent: intent(), provisioned: { clientId: CLIENT_ID, addressId: ADDRESS_ID, replayed: false }, checkoutKind: "one_time" as const, expectedQuote: { totalGross: snapshot.quote.totalGross }, recordQuoteStage };
    await expect(resolveCheckoutQuoteGuard(input)).resolves.toMatchObject({ kind: "price_changed" });
    const verifyPromotionAcceptance = vi.fn(() => true);
    await expect(resolveCheckoutQuoteGuard({ ...input, promotionAcceptanceToken: "accepted-a", verifyPromotionAcceptance })).resolves.toMatchObject({ kind: "accepted" });
    expect(verifyPromotionAcceptance).toHaveBeenCalledWith({ token: "accepted-a", request: expect.any(Object), quote: snapshot.quote, expectedTotal: snapshot.quote.totalGross });
  });
  it("rejects stale acquisition expectations independently of unchanged money", async () => {
    const snapshot = quoteSnapshot(); snapshot.quote.context = { mode: "subscription", promoCodes: [], acquisitionTerms: { schemaVersion: "subscription-acquisition.v1", revision: "terms-b", initialDiscountBps: 2000, delivery2DiscountBps: 3000, effectiveFrom: "1999-01-01T00:00:00.000Z", effectiveTo: null, sourcePromotionId: CLIENT_ID } };
    await expect(resolveCheckoutQuoteGuard({ quotePort: { createQuote: vi.fn(async () => snapshot) }, intent: intent("subscription"), provisioned: { clientId: CLIENT_ID, addressId: ADDRESS_ID, replayed: false }, checkoutKind: "subscription_initial", expectedQuote: { totalGross: snapshot.quote.totalGross, acquisitionTerms: { revision: "terms-a", delivery2DiscountBps: 3000 } }, promotionAcceptanceToken: "accepted-a", verifyPromotionAcceptance: () => true, recordQuoteStage })).resolves.toMatchObject({ kind: "price_changed" });
  });
});
