import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { createCustomerVerifyOtpRoute } from "./verify-otp.js";

describe("POST /api/bff/customers/verify-otp", () => {
  const originalFlag = process.env.COMMERCE_V2_W12_CUSTOMER_AUTH_UI;
  beforeAll(() => { process.env.COMMERCE_V2_W12_CUSTOMER_AUTH_UI = "true"; });
  afterAll(() => {
    if (originalFlag === undefined) delete process.env.COMMERCE_V2_W12_CUSTOMER_AUTH_UI;
    else process.env.COMMERCE_V2_W12_CUSTOMER_AUTH_UI = originalFlag;
  });
  it("returns the bounded session from the selected binding", async () => {
    const verifyChallenge = vi.fn().mockResolvedValue({
      accessToken: "signed-session",
      expiresAt: "2099-01-01T00:00:00.000Z",
      user: {
        id: "11111111-1111-4111-8111-111111111111",
        email: "customer@example.invalid",
      },
    });
    const route = createCustomerVerifyOtpRoute(() => ({
      binding: { requestChallenge: vi.fn(), verifyChallenge },
    }));
    const response = createResponse();

    await route(request({ email: "customer@example.invalid", token: "one-time-code-1234" }), response.res);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, data: { accessToken: "signed-session" } });
    expect(verifyChallenge).toHaveBeenCalledWith("one-time-code-1234");
  });

  it("maps used challenges and invalid configuration without exposing details", async () => {
    const used = createResponse();
    await createCustomerVerifyOtpRoute(() => ({
      binding: { requestChallenge: vi.fn(), verifyChallenge: vi.fn().mockResolvedValue(null) },
    }))(request({ email: "customer@example.invalid", token: "used-code-1234567" }), used.res);
    expect(used.status).toBe(401);

    const unavailable = createResponse();
    await createCustomerVerifyOtpRoute(() => ({ error: "customer_session_issuer_invalid" }))(
      request({ email: "customer@example.invalid", token: "configured-code-1" }),
      unavailable.res,
    );
    expect(unavailable.status).toBe(503);
    expect(JSON.stringify(unavailable.body)).not.toContain("PRIVATE_JWK");
  });
});

function request(body: unknown): VercelRequest {
  return { method: "POST", query: {}, headers: {}, body } as unknown as VercelRequest;
}

function createResponse() {
  let status = 200;
  let body: unknown;
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    status(code: number) { status = code; res.statusCode = code; return res; },
    json(value: unknown) { body = value; return res; },
  } as unknown as VercelResponse;
  return {
    res,
    get status() { return status; },
    get body() { return body; },
  };
}
