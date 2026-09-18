import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  CUSTOMER_ACCOUNT_V2_CONTRACT_VERSION,
  type CustomerAccountV2Response,
} from "../../../src/domains/customers/accountV2Contracts.js";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import { CustomerAccountReadModelError } from "./customerAccountReadDiagnostics.js";
import type { CustomerAccountPort } from "./ports.js";
import { createCustomerAccountHandler } from "./customerAccountHandler.js";

const ID = "11111111-1111-4111-8111-111111111111";

const VALID_ACCOUNT: CustomerAccountV2Response = {
  contractVersion: CUSTOMER_ACCOUNT_V2_CONTRACT_VERSION,
  profile: {
    clientId: ID,
    email: "buyer@example.com",
    firstName: "Bart",
    lastName: null,
    phone: null,
    lifecycleStage: "customer",
  },
  pets: [],
  subscriptions: [],
  addresses: [],
  ordererProfiles: [],
  billingProfiles: [],
  paymentPreferences: [],
  deliveryPreferences: [],
  recentOrders: [],
  events: [],
  actionRequired: [],
};

describe("customer account handler", () => {
  it("returns the aggregated account through the shared BFF envelope", async () => {
    const accountPort = createPort(VALID_ACCOUNT);
    const res = createResponse();

    await createHandler({ accountPort })(request("GET"), res);

    expect(accountPort.getAccount).toHaveBeenCalledWith("user-1");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: VALID_ACCOUNT });
  });

  it("returns FORBIDDEN when the session has no linked client", async () => {
    const res = createResponse();
    await createHandler({ accountPort: createPort(null) })(request("GET"), res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("returns INVALID_RESPONSE and logs issue paths when the payload fails the contract", async () => {
    // An out-of-enum subscription status (the bug this guards against) must not
    // pass validation, and the backstop must log the failing field paths.
    const invalidAccount = {
      ...VALID_ACCOUNT,
      subscriptions: [{ status: "definitely_not_a_status" }],
    } as unknown as CustomerAccountV2Response;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = createResponse();

    await createHandler({ accountPort: createPort(invalidAccount) })(request("GET"), res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "INVALID_RESPONSE" }) }),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "[customer-account] response failed contract validation:",
      expect.stringContaining("subscriptions"),
    );
    errorSpy.mockRestore();
  });

  it("rejects unsupported methods and missing sessions", async () => {
    const method = createResponse();
    await createHandler({ accountPort: createPort(VALID_ACCOUNT) })(request("POST"), method);

    const unauthorized = createResponse();
    await createHandler({
      accountPort: createPort(VALID_ACCOUNT),
      auth: { ok: false, code: "UNAUTHORIZED", message: "Customer session required" },
    })(request("GET"), unauthorized);

    expect(method.setHeader).toHaveBeenCalledWith("Allow", "GET");
    expect(method.status).toHaveBeenCalledWith(405);
    expect(unauthorized.status).toHaveBeenCalledWith(401);
  });

  it("maps auth and upstream failures to BFF errors", async () => {
    const authFailed = createResponse();
    await createHandler({ accountPort: createPort(VALID_ACCOUNT), auth: new Error("auth down") })(
      request("GET"),
      authFailed,
    );

    const failed = createResponse();
    await createHandler({ accountPort: createPort(new Error("DB down")) })(request("GET"), failed);

    expect(authFailed.status).toHaveBeenCalledWith(503);
    expect(failed.status).toHaveBeenCalledWith(503);
  });

  it("returns safe read-model diagnostics without leaking provider payloads", async () => {
    const cause = Object.assign(new Error("permission denied for table commerce_orders"), {
      code: "42501",
      token: "secret-token",
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = createResponse();

    await createHandler({
      accountPort: createPort(new CustomerAccountReadModelError("account_aggregate", cause)),
    })(request("GET"), failed);

    expect(failed.status).toHaveBeenCalledWith(503);
    expect(failed.json).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: "UPSTREAM_UNAVAILABLE",
        message: "Customer account read failed",
        details: {
          reason: "read_model_failed",
          stage: "account_aggregate",
          providerCode: "42501",
        },
      },
    });
    expect(JSON.stringify(errorSpy.mock.calls)).toContain("account_aggregate");
    expect(JSON.stringify(errorSpy.mock.calls)).toContain("42501");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("secret-token");
    errorSpy.mockRestore();
  });
});

function createHandler({
  accountPort,
  auth = { ok: true, userId: "user-1" },
}: {
  accountPort: CustomerAccountPort;
  auth?: CustomerUserAuthenticationResult | Error;
}) {
  return createCustomerAccountHandler({
    accountPort,
    authenticateUser: vi.fn().mockImplementation(async () => {
      if (auth instanceof Error) throw auth;
      return auth;
    }),
  });
}

function request(method: string, query: VercelRequest["query"] = {}): VercelRequest {
  return { method, query } as unknown as VercelRequest;
}

function createPort(result: CustomerAccountV2Response | null | Error): CustomerAccountPort {
  return {
    getAccount: vi.fn().mockImplementation(async () => {
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
