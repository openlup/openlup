import { describe, expect, it, vi } from "vitest";
import { createCommerceCheckoutHandler, createPorts, createResponse, intent, request } from "./checkoutTestFixtures.js";
describe("neutral checkout HTTP sequence", () => {
  it("keeps accepted offer review on its own journey rather than matching another order", async () => {
    const ports = createPorts();
    const res = createResponse();
    const quote = await ports.quotePort.createQuote({ mode: "one_time", lines: [], promoCodes: [] });
    quote.quote.context = { mode: "one_time", promoCodes: [] };
    ports.quotePort.createQuote.mockResolvedValue(quote);
    const findResumableOrderForClient = vi.fn();
    const verifyQuoteAcceptance = vi.fn(() => true);
    await createCommerceCheckoutHandler({
      ...ports,
      resumableOrderPort: { findResumableOrderForClient },
      offerPolicy: {
        resolve: async () => ({ kind: "bound", offerVersion: "fixed.revision", requireQuoteAcceptance: true }),
        evidence: async () => ({ revision: "fixed.revision" }),
        verifyQuoteAcceptance,
      },
    })(request("POST", {
      intent: { ...intent(), offerVersion: "fixed" },
      expectedQuote: { totalGross: quote.quote.totalGross, promotionAcceptanceToken: "fixture-review-token" },
    }), res);
    expect(verifyQuoteAcceptance).toHaveBeenCalledWith(expect.objectContaining({ offerVersion: "fixed.revision" }));
    expect(findResumableOrderForClient).not.toHaveBeenCalled();
    expect(ports.orderDraftPort.createOrderDraft).toHaveBeenCalledOnce();
  });
  it.each(["method", "invalid", "rate_refused", "rate_failed", "risk_refused", "risk_failed"] as const)("stops before identity/quote/runtime after %s", async kind => {
    const ports = createPorts(), res = createResponse();
    if (kind === "rate_refused") ports.checkRateLimit.mockResolvedValueOnce({ allowed: false });
    if (kind === "rate_failed") ports.checkRateLimit.mockRejectedValueOnce(new Error("unavailable"));
    const checkRiskBlocklist = kind === "risk_failed" ? vi.fn().mockRejectedValueOnce(new Error("unavailable")) : vi.fn().mockResolvedValue({ blocked: kind === "risk_refused" });
    const configured = { ...ports, checkRiskBlocklist };
    await createCommerceCheckoutHandler(configured)(request(kind === "method" ? "GET" : "POST", kind === "invalid" ? {} : { intent: intent() }), res);
    expect(res.status).toHaveBeenCalledWith({ method: 405, invalid: 400, rate_refused: 429, rate_failed: 503, risk_refused: 403, risk_failed: 503 }[kind]);
    expect(ports.persistencePort.persistIntent).not.toHaveBeenCalled(); expect(ports.quotePort.createQuote).not.toHaveBeenCalled(); expect(ports.runtimePort.startRuntime).not.toHaveBeenCalled();
  });
});
