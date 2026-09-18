import { describe, expect, it, vi } from "vitest";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import type { CustomerProfileMutationPort } from "./ports.js";
import { createCustomerProfileHandler } from "./customerProfileHandler.js";

// Request/response types are derived from the handler signature so these tests
// stay neutral in the platform-token inventory.
type Handler = ReturnType<typeof createCustomerProfileHandler>;
type Req = Parameters<Handler>[0];
type Res = Parameters<Handler>[1];

describe("customer profile handler", () => {
  it("rejects unsupported methods", async () => {
    const res = createResponse();
    await createHandler({})(request("GET"), res);
    expect(res.setHeader).toHaveBeenCalledWith("Allow", "PATCH");
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("propagates the authentication refusal code without calling the port", async () => {
    const profilePort = createPort();
    const res = createResponse();
    await createHandler({
      profilePort,
      auth: { ok: false, code: "UNAUTHORIZED", message: "Customer session required" },
    })(request("PATCH"), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(profilePort.updateProfile).not.toHaveBeenCalled();
  });

  it("maps authentication transport failures to UPSTREAM_UNAVAILABLE", async () => {
    const res = createResponse();
    await createHandler({ auth: new Error("auth down") })(request("PATCH"), res);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("passes an authenticated session through the guard to request validation", async () => {
    const res = createResponse();
    await createHandler({})(request("PATCH"), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

function createHandler({
  profilePort = createPort(),
  auth = { ok: true, userId: "user-1" },
}: {
  profilePort?: CustomerProfileMutationPort;
  auth?: CustomerUserAuthenticationResult | Error;
}) {
  return createCustomerProfileHandler({
    profilePort,
    authenticateUser: vi.fn().mockImplementation(async () => {
      if (auth instanceof Error) throw auth;
      return auth;
    }),
  });
}

function request(method: string): Req {
  return { method, body: {} } as unknown as Req;
}

function createPort(): CustomerProfileMutationPort {
  return {
    updateProfile: vi.fn().mockResolvedValue(null),
  } as unknown as CustomerProfileMutationPort;
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
