import { describe, expect, it, vi } from "vitest";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import type { CustomerPaymentRecoveryStartPort } from "./ports.js";
import { createCustomerPaymentRecoveryStartHandler } from "./customerPaymentRecoveryStartHandler.js";

// Request/response types are derived from the handler signature so these tests
// stay neutral in the platform-token inventory.
type Handler = ReturnType<typeof createCustomerPaymentRecoveryStartHandler>;
type Req = Parameters<Handler>[0];
type Res = Parameters<Handler>[1];

describe("customer payment recovery start handler", () => {
  it("rejects unsupported methods", async () => {
    const res = createResponse();
    await createHandler({})(request("GET"), res);
    expect(res.setHeader).toHaveBeenCalledWith("Allow", "POST");
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("propagates the authentication refusal code without calling the port", async () => {
    const paymentRecoveryStartPort = createPort();
    const res = createResponse();
    await createHandler({
      paymentRecoveryStartPort,
      auth: { ok: false, code: "UNAUTHORIZED", message: "Customer session required" },
    })(request("POST"), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(paymentRecoveryStartPort.startPaymentRecovery).not.toHaveBeenCalled();
  });

  it("maps authentication transport failures to UPSTREAM_UNAVAILABLE", async () => {
    const res = createResponse();
    await createHandler({ auth: new Error("auth down") })(request("POST"), res);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("passes an authenticated session through the guard to request validation", async () => {
    const res = createResponse();
    await createHandler({})(request("POST"), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

function createHandler({
  paymentRecoveryStartPort = createPort(),
  auth = { ok: true, userId: "user-1" },
}: {
  paymentRecoveryStartPort?: CustomerPaymentRecoveryStartPort;
  auth?: CustomerUserAuthenticationResult | Error;
}) {
  return createCustomerPaymentRecoveryStartHandler({
    paymentRecoveryStartPort,
    authenticateUser: vi.fn().mockImplementation(async () => {
      if (auth instanceof Error) throw auth;
      return auth;
    }),
  });
}

function request(method: string): Req {
  return { method, body: {} } as unknown as Req;
}

function createPort(): CustomerPaymentRecoveryStartPort {
  return {
    startPaymentRecovery: vi.fn().mockResolvedValue(null),
  } as unknown as CustomerPaymentRecoveryStartPort;
}

function createResponse(): Res {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as Res;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
