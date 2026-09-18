import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { createStockNotifyHandler } from "./stockNotifyHandler.js";

describe("stock notify domain handler", () => {
  it("stops before subscribing when the durable limiter denies the request", async () => {
    const subscribe = vi.fn();
    const check = vi.fn().mockResolvedValue({
      allowed: false,
      reason: "email_sku_quota",
      attemptsByIp: 2,
      attemptsByEmailSku: 3,
    });
    const handler = createStockNotifyHandler({
      subscribePort: { subscribe },
      rateLimitPort: { check },
    });
    const res = response();

    await handler(request("POST", validBody()), res);

    expect(check).toHaveBeenCalledWith({
      headers: {},
      email: "buyer@example.com",
      sku: "OPENLUP-LAMB-5KG",
    });
    expect(subscribe).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: "RATE_LIMITED",
        details: expect.objectContaining({ reason: "email_sku_quota" }),
      }),
    }));
  });

  it("subscribes after the limiter allows a valid request", async () => {
    const subscribe = vi.fn().mockResolvedValue(undefined);
    const handler = createStockNotifyHandler({
      subscribePort: { subscribe },
      rateLimitPort: {
        check: vi.fn().mockResolvedValue({
          allowed: true,
          attemptsByIp: 1,
          attemptsByEmailSku: 1,
        }),
      },
    });
    const res = response();

    await handler(request("POST", validBody()), res);

    expect(subscribe).toHaveBeenCalledWith({
      sku: "OPENLUP-LAMB-5KG",
      email: "buyer@example.com",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });
});

function validBody() {
  return {
    sku: "OPENLUP-LAMB-5KG",
    email: "buyer@example.com",
    marketingConsent: true,
    locale: "pl",
  };
}

function request(method: string, body: unknown): VercelRequest {
  return { method, body, query: {}, headers: {} } as unknown as VercelRequest;
}

function response(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
