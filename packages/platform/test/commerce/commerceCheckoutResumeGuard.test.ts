import { describe, expect, it, vi } from "vitest";
import { resolveResumeOpenOrderResponse, intent, quoteSnapshot, CLIENT_ID, ADDRESS_ID, ORDER_ID } from "./checkoutTestFixtures.js";
function fixture() {
  const asked = intent(), quote = quoteSnapshot();
  const row = { orderId: ORDER_ID, paymentIntentId: ADDRESS_ID, status: "processing" as const, sameJourney: false, metadata: { selectedDelivery: asked.selectedDelivery, quoteSnapshot: quote } };
  const findResumableOrderForClient = vi.fn(async () => row);
  return { asked, quote, row, findResumableOrderForClient, input: { deps: { resumableOrderPort: { findResumableOrderForClient } }, clientId: CLIENT_ID, checkoutKind: "one_time" as const, intent: asked, acceptedQuote: quote.quote, now: () => new Date(0) } };
}
describe("checkout resume guard", () => {
  it("resumes the matching owned basket with no fresh provider action", async () => { const f = fixture(); const result = await resolveResumeOpenOrderResponse(f.input); expect(result).toMatchObject({ orderId: ORDER_ID, status: "processing", clientAction: { kind: "none" }, clientId: CLIENT_ID, subscription: { requested: false, cadenceDays: null, activationStatus: "not_applicable" } }); expect(f.findResumableOrderForClient).toHaveBeenCalledExactlyOnceWith({ clientId: CLIENT_ID, withinMinutes: 60, now: new Date(0), journeyKey: f.asked.idempotencyKey }); });
  it.each(["same_journey", "money", "basket", "delivery"] as const)("does not re-offer old money after %s changed", async field => { const f = fixture(); if (field === "same_journey") f.row.sameJourney = true; if (field === "money") f.input.acceptedQuote = { ...f.quote.quote, totalGross: { amountMinor: 1600, currency: "XTS" } }; if (field === "basket") f.input.acceptedQuote = { ...f.quote.quote, lines: [{ ...f.quote.quote.lines[0], quantity: 2 }] }; if (field === "delivery") f.asked.selectedDelivery = { kind: "courier", carrierKind: "carrier-b", service: "other" }; await expect(resolveResumeOpenOrderResponse(f.input)).resolves.toBeNull(); });
  it("fails open after a read error and does not read when the port is absent", async () => { const f = fixture(); f.findResumableOrderForClient.mockRejectedValueOnce(new Error("unavailable")); await expect(resolveResumeOpenOrderResponse(f.input)).resolves.toBeNull(); await expect(resolveResumeOpenOrderResponse({ ...f.input, deps: {} })).resolves.toBeNull(); expect(f.findResumableOrderForClient).toHaveBeenCalledOnce(); });
});
