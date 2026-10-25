import { afterEach, describe, expect, it, vi } from "vitest";
import { createCheckoutTimingLogger } from "../../src/commerce/server/index.js";
afterEach(() => vi.restoreAllMocks());
describe("checkout stage timing", () => {
  it("preserves safe log fields and durations for the supplied request identity and route", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValueOnce(1015).mockReturnValueOnce(1030).mockReturnValueOnce(1030);
    const timing = createCheckoutTimingLogger("request-a", "/checkout");
    expect(await timing.record("rate_limit", async () => "ok")).toBe("ok");
    timing.log("total", "success");
    const logs = log.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(logs).toEqual([
      { level: "info", event: "checkout_stage", request_id: "request-a", route: "/checkout", stage: "rate_limit", duration_ms: 15, outcome: "success" },
      { level: "info", event: "checkout_stage", request_id: "request-a", route: "/checkout", stage: "total", duration_ms: 30, outcome: "success" },
    ]);
    expect(JSON.stringify(logs)).not.toContain("email"); expect(JSON.stringify(logs)).not.toContain("token");
  });
  it("rethrows a failed operation with the same identity and error timing", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValueOnce(2000).mockReturnValueOnce(2042).mockReturnValueOnce(2084);
    const timing = createCheckoutTimingLogger("request-b", "/checkout");
    await expect(timing.record("quote", async () => { throw new Error("resolver failed"); })).rejects.toThrow("resolver failed");
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ request_id: "request-b", stage: "quote", duration_ms: 42, outcome: "error" });
  });
});
