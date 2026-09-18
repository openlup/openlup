import { describe, expect, it, vi } from "vitest";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import type { CustomerBillingProfilesPort } from "./ports.js";
import { createCustomerBillingProfilesHandler } from "./customerBillingProfilesHandler.js";

// Request/response types are derived from the handler signature so these tests
// stay neutral in the platform-token inventory.
type Handler = ReturnType<typeof createCustomerBillingProfilesHandler>;
type Req = Parameters<Handler>[0];
type Res = Parameters<Handler>[1];

describe("customer billing profiles handler", () => {
  it("rejects unsupported methods", async () => {
    const res = createResponse();
    await createHandler({})(request("PUT"), res);
    expect(res.setHeader).toHaveBeenCalledWith("Allow", "GET, POST, PATCH, DELETE");
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("propagates the authentication refusal code without calling the port", async () => {
    const billingPort = createPort(null);
    const res = createResponse();
    await createHandler({
      billingPort,
      auth: { ok: false, code: "UNAUTHORIZED", message: "Customer session required" },
    })(request("GET"), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(billingPort.listBillingProfiles).not.toHaveBeenCalled();
  });

  it("maps authentication transport failures to UPSTREAM_UNAVAILABLE", async () => {
    const res = createResponse();
    await createHandler({ auth: new Error("auth down") })(request("GET"), res);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("passes an authenticated session through the guard to the port", async () => {
    const billingPort = createPort(null);
    const res = createResponse();
    await createHandler({ billingPort })(request("GET"), res);
    expect(billingPort.listBillingProfiles).toHaveBeenCalledWith("user-1");
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

function createHandler({
  billingPort = createPort(null),
  auth = { ok: true, userId: "user-1" },
}: {
  billingPort?: CustomerBillingProfilesPort;
  auth?: CustomerUserAuthenticationResult | Error;
}) {
  return createCustomerBillingProfilesHandler({
    billingPort,
    authenticateUser: vi.fn().mockImplementation(async () => {
      if (auth instanceof Error) throw auth;
      return auth;
    }),
  });
}

function request(method: string): Req {
  return { method, query: {}, body: {} } as unknown as Req;
}

function createPort(result: null): CustomerBillingProfilesPort {
  return {
    listBillingProfiles: vi.fn().mockResolvedValue(result),
    upsertBillingProfile: vi.fn().mockResolvedValue(result),
    deleteBillingProfile: vi.fn().mockResolvedValue(result),
  } as unknown as CustomerBillingProfilesPort;
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
