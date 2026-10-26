import { describe, expect, it } from "vitest";
import { resolvedAcquisitionTermsSchema, shippingTermsSchema } from "@openlup/platform/pricing/browser";
import { quoteContextSchema } from "../../../src/domains/commerce/contracts.js";
import { withCheckoutOfferContext } from "./checkoutOfferPolicyPort.js";
import { intent, quoteSnapshot } from "./commerceCheckoutHandler.testFixtures.js";
describe("checkout quote context binding", () => {
  it("retains bounded offer evidence and the resolved shipping/acquisition promises at the actual validator", async () => {
    const acquisitionTerms = { schemaVersion: "subscription-acquisition.v1", revision: "terms-a", initialDiscountBps: 2000, delivery2DiscountBps: 3000, effectiveFrom: "1999-01-01T00:00:00.000Z", effectiveTo: null, sourcePromotionId: "11111111-1111-4111-8111-111111111111" } as const;
    const shippingTerms = { version: "shipping-threshold.v1", currency: "XTS", flatMinor: 100, freeThresholdMinor: 2000 } as const;
    const snapshot = quoteSnapshot(); snapshot.quote.context = { mode: "one_time", promoCodes: [], acquisitionTerms, shippingTerms };
    const accepted = await withCheckoutOfferContext({ offerVersion: "offer-a", port: { async resolve() { return { kind: "bound", offerVersion: "offer-a" }; }, async evidence() { return { tier: "a", units: 14 }; } } }, intent(), snapshot);
    expect(quoteContextSchema.parse(accepted.quote.context)).toEqual({ mode: "one_time", promoCodes: [], acquisitionTerms, shippingTerms, offerVersion: "offer-a", offerEvidence: { tier: "a", units: 14 } });
  });
  it("reuses the existing optional terms validators and retains strict legacy context parsing", () => {
    expect(quoteContextSchema.shape.shippingTerms.unwrap()).toBe(shippingTermsSchema);
    expect(quoteContextSchema.shape.acquisitionTerms.unwrap()).toBe(resolvedAcquisitionTermsSchema);
    expect(quoteContextSchema.parse({ mode: "one_time" })).toEqual({ mode: "one_time", promoCodes: [] });
    expect(quoteContextSchema.safeParse({ mode: "one_time", unexpected: true }).success).toBe(false);
  });
  it("keeps evidence and financial promise refusal at the final reference boundary", () => {
    expect(quoteContextSchema.safeParse({ mode: "one_time", offerEvidence: { invalid_key: "a" } }).success).toBe(false);
    expect(quoteContextSchema.safeParse({ mode: "one_time", offerEvidence: { text: "x".repeat(4097) } }).success).toBe(false);
    expect(quoteContextSchema.safeParse({ mode: "one_time", acquisitionTerms: { revision: "invalid revision" } }).success).toBe(false);
    expect(quoteContextSchema.safeParse({ mode: "one_time", shippingTerms: { version: "shipping-threshold.v1", currency: "XTS", flatMinor: -1, freeThresholdMinor: 1 } }).success).toBe(false);
  });
});
