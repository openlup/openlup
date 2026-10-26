import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createSavedAcquisitionContinuation } from "../../src/commerce/server/index.js";
import { intent, quoteSnapshot, type Intent, type Snapshot, type Provisioned, type Plan, CLIENT_ID, ADDRESS_ID, ORDER_ID } from "./checkoutTestFixtures.js";
import type { CreateQuoteRequest } from "../../src/pricing/index.js";
function fixture() {
  const asked = intent("subscription"), quote = quoteSnapshot(); quote.quote.lines[0].quantity = 14;
  quote.quote.context = { mode: "subscription", cadenceDays: 21, promoCodes: [] };
  const metadata = { quoteSnapshot: quote, deliveryContact: { revision: "a" }, invoiceBuyerSnapshot: { revision: "a" }, selectedDelivery: asked.selectedDelivery };
  const resumable = { orderId: ORDER_ID, paymentIntentId: ADDRESS_ID, status: "processing" as const, sameJourney: true, metadata };
  const findResumableOrderForClient = vi.fn(async () => resumable);
  const sameSubjectContext = vi.fn(() => true), buildSavedOrderResumeResponse = vi.fn(() => ({ status: "processing" }));
  const core = createSavedAcquisitionContinuation<Intent, Provisioned, CreateQuoteRequest, Snapshot, object, { status: string }>({ quoteSchema: z.custom<Snapshot>(), buildQuoteRequest: input => ({ mode: input.mode, cadenceDays: input.cadenceDays, promoCodes: input.promoCodes, lines: input.selectedVariants.map(line => ({ sku: line.sku, quantity: line.qty })) }), sameSubjectContext, runtimeMetadata: () => ({ deliveryContact: { revision: "a" }, invoiceBuyerSnapshot: { revision: "a" } }), starterDeclaration: input => input.starterOffer, starterPlan: snapshot => snapshot.quote.context?.starterPack as Plan | undefined, buildSavedOrderResumeResponse });
  const input = { deps: { resumableOrderPort: { findResumableOrderForClient } }, clientId: CLIENT_ID, provisioned: { clientId: CLIENT_ID, addressId: ADDRESS_ID, replayed: false }, checkoutKind: "subscription_initial" as const, intent: asked, expectedQuote: { totalGross: quote.quote.totalGross }, now: () => new Date("1999-01-01T00:00:00.000Z") };
  return { core, input, resumable, quote, sameSubjectContext, buildSavedOrderResumeResponse, findResumableOrderForClient };
}
describe("saved acquisition continuation", () => {
  it("returns only the matching owned saved epoch without creating a quote or new order", async () => {
    const f = fixture(); await expect(f.core.resolveSavedAcquisitionContinuation(f.input)).resolves.toEqual({ status: "processing" });
    expect(f.findResumableOrderForClient).toHaveBeenCalledExactlyOnceWith({ clientId: CLIENT_ID, withinMinutes: 60, now: f.input.now(), journeyKey: f.input.intent.idempotencyKey });
    expect(f.sameSubjectContext).toHaveBeenCalledOnce(); expect(f.buildSavedOrderResumeResponse).toHaveBeenCalledOnce();
  });
  it.each(["total", "basket", "cadence", "contact", "invoice", "subject", "offer", "starter"] as const)("falls through after changed %s", async field => {
    const f = fixture();
    if (field === "total") f.input.expectedQuote.totalGross = { ...f.input.expectedQuote.totalGross, amountMinor: 1600 };
    if (field === "basket") f.input.intent.selectedVariants[0].qty++;
    if (field === "cadence") f.input.intent.cadenceDays = 28;
    if (field === "contact") f.resumable.metadata.deliveryContact.revision = "b";
    if (field === "invoice") f.resumable.metadata.invoiceBuyerSnapshot.revision = "b";
    if (field === "subject") f.sameSubjectContext.mockReturnValue(false);
    if (field === "offer") f.input.intent.offerVersion = "offer-b";
    if (field === "starter") f.input.intent.starterOffer = { intervalDays: 14, delivery2DiscountBps: 3000, steady: { cadenceDays: 21, units: 14 } };
    await expect(f.core.resolveSavedAcquisitionContinuation(f.input)).resolves.toBeNull(); expect(f.buildSavedOrderResumeResponse).not.toHaveBeenCalled();
  });
  it("fails open on lookup failure and does not read without expected money or subscription intent", async () => {
    const f = fixture(); f.findResumableOrderForClient.mockRejectedValueOnce(new Error("unavailable"));
    await expect(f.core.resolveSavedAcquisitionContinuation(f.input)).resolves.toBeNull();
    await expect(f.core.resolveSavedAcquisitionContinuation({ ...f.input, expectedQuote: undefined })).resolves.toBeNull();
    await expect(f.core.resolveSavedAcquisitionContinuation({ ...f.input, checkoutKind: "one_time" })).resolves.toBeNull();
    expect(f.findResumableOrderForClient).toHaveBeenCalledOnce();
  });
});
