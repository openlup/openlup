import { afterEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { withObservedRoute } from "../../_lib/observability/route.js";
import { sendBffError } from "../../_lib/bff/response.js";
import { createCheckoutTimingLogger } from "./commerceCheckoutTiming.js";

describe("commerce checkout timing logger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("logs safe stage timings without accepting an arbitrary caller request id", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1015)
      .mockReturnValueOnce(1030)
      .mockReturnValueOnce(1030);
    const timing = createCheckoutTimingLogger(request({
      "x-request-id": "req-checkout",
      "x-vercel-id": "vercel-id",
    }));

    await timing.record("rate_limit", async () => "ok");
    timing.log("total", "success");

    const logs = logSpy.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(logs).toEqual([
      {
        level: "info",
        event: "checkout_stage",
        request_id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
        route: "/api/bff/commerce/checkout",
        stage: "rate_limit",
        duration_ms: 15,
        outcome: "success",
      },
      {
        level: "info",
        event: "checkout_stage",
        request_id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
        route: "/api/bff/commerce/checkout",
        stage: "total",
        duration_ms: 30,
        outcome: "success",
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain("email");
    expect(JSON.stringify(logs)).not.toContain("token");
    expect(JSON.stringify(logs)).not.toContain("req-checkout");
  });

  it("logs failed stages with the Node adapter request-id fallback", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("VERCEL", "1");
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(2000)
      .mockReturnValueOnce(2042)
      .mockReturnValueOnce(2084);
    const timing = createCheckoutTimingLogger(request({ "x-vercel-id": "iad1::vercel-only" }));

    await expect(timing.record("quote", async () => {
      throw new Error("resolver failed");
    })).rejects.toThrow("resolver failed");

    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
      request_id: "iad1::vercel-only",
      stage: "quote",
      duration_ms: 42,
      outcome: "error",
    });
  });

  it("uses the route reference for checkout stages within the observed handler", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const req = request({ "x-request-id": "bff-axiom-canary-checkout-shared" });
    const res = response();
    const handler = withObservedRoute(
      { route: "/api/bff/commerce/checkout", domain: "commerce", surface: "public", risk: "mutation" },
      (observedReq, res) => {
        createCheckoutTimingLogger(observedReq).log("total", "success");
        sendBffError(res, "CONFLICT", "Changed");
      },
    );

    await handler(req, res);

    const logs = logSpy.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(logs.map((log) => log.request_id)).toEqual([
      "bff-axiom-canary-checkout-shared",
      "bff-axiom-canary-checkout-shared",
    ]);
    expect(res.setHeader).toHaveBeenCalledWith(
      "x-request-id",
      "bff-axiom-canary-checkout-shared",
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      meta: { requestId: "bff-axiom-canary-checkout-shared" },
    }));
  });
});

function request(headers: Record<string, string>): VercelRequest {
  return { method: "POST", headers, query: {}, body: {} } as VercelRequest;
}

function response(): VercelResponse {
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as VercelResponse;
  vi.mocked(res.status).mockImplementation((status: number) => {
    res.statusCode = status;
    return res;
  });
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
