import { describe, expect, it, vi } from "vitest";
import { createCommerceCheckoutHandler, createPorts, createResponse, intent, request } from "./checkoutTestFixtures.js";
describe("neutral checkout HTTP sequence", () => {
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
