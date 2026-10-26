import { describe, expect, it, vi } from "vitest";
import { CheckoutOrchestrationError, createCheckoutFailureHandler, CheckoutOfferRefusedError } from "../../src/commerce/server/index.js";
import { createResponse, responder, intent, CLIENT_ID, ADDRESS_ID, quoteSnapshot, type Intent, type Snapshot, type Provisioned } from "./checkoutTestFixtures.js";
import type { CreateQuoteRequest } from "../../src/pricing/index.js";
function fixture(error: unknown) {
  const events: string[] = [], res = createResponse();
  const compensationPort = { releaseOrderReservations: vi.fn(async () => { events.push("release"); return { releasedCount: 1 }; }), cancelUnstartedPromotionOrder: vi.fn(async () => { events.push("promotion"); return { cancelled: false }; }), cancelAbandonedOrder: vi.fn(async () => { events.push("abandon"); return { cancelled: true }; }) };
  const respondToPromotionCodePriceChange = vi.fn(async () => { events.push("requote"); return true; });
  const core = createCheckoutFailureHandler<Intent, Provisioned, CreateQuoteRequest, Snapshot>({ responder, logProviderFailure: () => {}, respondQuoteFailure: () => false, previewDiagnosticsEnabled: () => false, respondToPromotionCodePriceChange });
  const input = { error, res, compensationPort, intent: intent(), quotePort: { createQuote: vi.fn(async () => quoteSnapshot()) }, provisioned: { clientId: CLIENT_ID, addressId: ADDRESS_ID, replayed: false }, checkoutKind: "one_time" as const, acceptedQuoteSnapshot: null, recordQuote: async <T>(operation: () => Promise<T>) => operation() };
  return { core, input, res, compensationPort, events, respondToPromotionCodePriceChange };
}
describe("checkout failure response", () => {
  it.each(["provider_attempt_in_flight", "inventory_admission_busy"] as const)("withholds cleanup for %s", async reason => {
    const f = fixture(new CheckoutOrchestrationError("failure", null, reason)); await f.core.respondToCheckoutFailure(f.input);
    expect(f.compensationPort.releaseOrderReservations).not.toHaveBeenCalled(); expect(f.res.status).toHaveBeenCalledWith(reason === "inventory_admission_busy" ? 503 : 409);
  });
  it("compensates stock refusal exactly once before returning conflict", async () => {
    const f = fixture(new CheckoutOrchestrationError("start_runtime: Inventory reservation conflict", "draft-a")); await expect(f.core.respondToCheckoutFailure(f.input)).resolves.toBe("rejected");
    expect(f.events).toEqual(["release", "promotion", "abandon"]); expect(f.compensationPort.cancelAbandonedOrder).toHaveBeenCalledExactlyOnceWith({ idempotencyKey: "intent-example-a", orderId: "draft-a", reason: "checkout_stock_unavailable" }); expect(f.res.status).toHaveBeenCalledWith(409);
  });
  it("cleans a proved stale acquisition draft before re-quoting", async () => {
    const f = fixture(new CheckoutOrchestrationError("Acquisition terms changed", "draft-a", "acquisition_terms_changed")); await expect(f.core.respondToCheckoutFailure(f.input)).resolves.toBe("rejected"); expect(f.events).toEqual(["release", "promotion", "abandon", "requote"]); expect(f.respondToPromotionCodePriceChange).toHaveBeenCalledOnce();
  });
  it("refuses an unsupported offer without any compensation", async () => { const f = fixture(new CheckoutOfferRefusedError("offer_version_unsupported")); await f.core.respondToCheckoutFailure(f.input); expect(f.res.status).toHaveBeenCalledWith(409); expect(f.events).toEqual([]); });
});
