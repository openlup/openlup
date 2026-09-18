import { describe, expect, it, vi } from "vitest";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import type { CustomerPetsPort } from "./ports.js";
import { createCustomerPetsHandler } from "./customerPetsHandler.js";

// Request/response types are derived from the handler signature so these tests
// stay neutral in the platform-token inventory.
type Handler = ReturnType<typeof createCustomerPetsHandler>;
type Req = Parameters<Handler>[0];
type Res = Parameters<Handler>[1];

describe("customer pets handler", () => {
  it("rejects unsupported methods", async () => {
    const res = createResponse();
    await createHandler({})(request("PUT"), res);
    expect(res.setHeader).toHaveBeenCalledWith("Allow", "GET, POST, PATCH, DELETE");
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("propagates the authentication refusal code without calling the port", async () => {
    const petsPort = createPort();
    const res = createResponse();
    await createHandler({
      petsPort,
      auth: { ok: false, code: "UNAUTHORIZED", message: "Customer session required" },
    })(request("GET"), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(petsPort.listPets).not.toHaveBeenCalled();
  });

  it("maps authentication transport failures to UPSTREAM_UNAVAILABLE", async () => {
    const res = createResponse();
    await createHandler({ auth: new Error("auth down") })(request("GET"), res);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("passes an authenticated session through the guard to the port", async () => {
    const petsPort = createPort();
    const res = createResponse();
    await createHandler({ petsPort })(request("GET"), res);
    expect(petsPort.listPets).toHaveBeenCalledWith("user-1");
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

function createHandler({
  petsPort = createPort(),
  auth = { ok: true, userId: "user-1" },
}: {
  petsPort?: CustomerPetsPort;
  auth?: CustomerUserAuthenticationResult | Error;
}) {
  return createCustomerPetsHandler({
    petsPort,
    authenticateUser: vi.fn().mockImplementation(async () => {
      if (auth instanceof Error) throw auth;
      return auth;
    }),
  });
}

function request(method: string): Req {
  return { method, body: {} } as unknown as Req;
}

// Only the list read is exercised here; the mutation members stay off the mock
// so this file stays neutral in the platform-token inventory.
function createPort(): CustomerPetsPort {
  return {
    listPets: vi.fn().mockResolvedValue(null),
  } as unknown as CustomerPetsPort;
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
