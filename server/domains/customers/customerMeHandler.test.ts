import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { CustomerMeResponse } from "../../../src/domains/customers/contracts.js";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import type { CustomerMePort } from "./ports.js";
import { createCustomerMeHandler } from "./customerMeHandler.js";

const PROFILE: CustomerMeResponse = {
  clientId: "11111111-1111-1111-1111-111111111111",
  email: "buyer@example.com",
  firstName: "Bart",
  lastName: null,
  lifecycleStage: "customer",
};

describe("customer me handler", () => {
  it("returns the linked customer profile through the shared BFF envelope", async () => {
    const mePort = createPort(PROFILE);
    const res = createResponse();

    await createHandler({ mePort })(request("GET"), res);

    expect(mePort.getCustomerMe).toHaveBeenCalledWith("user-1");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: PROFILE });
  });

  it("returns FORBIDDEN when the session has no linked client", async () => {
    const res = createResponse();
    await createHandler({ mePort: createPort(null) })(request("GET"), res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("rejects unsupported methods and missing sessions", async () => {
    const method = createResponse();
    await createHandler({ mePort: createPort(PROFILE) })(request("POST"), method);

    const unauthorized = createResponse();
    await createHandler({
      mePort: createPort(PROFILE),
      auth: { ok: false, code: "UNAUTHORIZED", message: "Customer session required" },
    })(request("GET"), unauthorized);

    expect(method.setHeader).toHaveBeenCalledWith("Allow", "GET");
    expect(method.status).toHaveBeenCalledWith(405);
    expect(unauthorized.status).toHaveBeenCalledWith(401);
  });

  it("maps auth and upstream failures to BFF errors", async () => {
    const authFailed = createResponse();
    await createHandler({ mePort: createPort(PROFILE), auth: new Error("auth down") })(
      request("GET"),
      authFailed,
    );

    const failed = createResponse();
    await createHandler({ mePort: createPort(new Error("DB down")) })(request("GET"), failed);

    expect(authFailed.status).toHaveBeenCalledWith(503);
    expect(failed.status).toHaveBeenCalledWith(503);
  });
});

function createHandler({
  mePort,
  auth = { ok: true, userId: "user-1" },
}: {
  mePort: CustomerMePort;
  auth?: CustomerUserAuthenticationResult | Error;
}) {
  return createCustomerMeHandler({
    mePort,
    authenticateUser: vi.fn().mockImplementation(async () => {
      if (auth instanceof Error) throw auth;
      return auth;
    }),
  });
}

function request(method: string, query: VercelRequest["query"] = {}): VercelRequest {
  return { method, query } as unknown as VercelRequest;
}

function createPort(result: CustomerMeResponse | null | Error): CustomerMePort {
  return {
    getCustomerMe: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

function createResponse(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as VercelResponse;

  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
