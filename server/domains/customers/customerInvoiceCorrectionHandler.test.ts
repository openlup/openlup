import { describe, expect, it, vi } from "vitest";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import type { CustomerInvoiceCorrectionPort } from "./ports.js";
import { createCustomerInvoiceCorrectionHandler } from "./customerInvoiceCorrectionHandler.js";

// Request/response types are derived from the handler signature so these tests
// stay neutral in the platform-token inventory.
type Handler = ReturnType<typeof createCustomerInvoiceCorrectionHandler>;
type Req = Parameters<Handler>[0];
type Res = Parameters<Handler>[1];

describe("customer invoice correction handler", () => {
  it("rejects unsupported methods", async () => {
    const res = createResponse();
    await createHandler({})(request("GET"), res);
    expect(res.setHeader).toHaveBeenCalledWith("Allow", "POST");
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("propagates the authentication refusal code without calling the port", async () => {
    const invoiceCorrectionPort = createPort();
    const res = createResponse();
    await createHandler({
      invoiceCorrectionPort,
      auth: { ok: false, code: "UNAUTHORIZED", message: "Customer session required" },
    })(request("POST"), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(invoiceCorrectionPort.requestInvoiceCorrection).not.toHaveBeenCalled();
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
  invoiceCorrectionPort = createPort(),
  auth = { ok: true, userId: "user-1" },
}: {
  invoiceCorrectionPort?: CustomerInvoiceCorrectionPort;
  auth?: CustomerUserAuthenticationResult | Error;
}) {
  return createCustomerInvoiceCorrectionHandler({
    invoiceCorrectionPort,
    authenticateUser: vi.fn().mockImplementation(async () => {
      if (auth instanceof Error) throw auth;
      return auth;
    }),
  });
}

function request(method: string): Req {
  return { method, body: {} } as unknown as Req;
}

function createPort(): CustomerInvoiceCorrectionPort {
  return {
    requestInvoiceCorrection: vi.fn().mockResolvedValue(null),
  } as unknown as CustomerInvoiceCorrectionPort;
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
