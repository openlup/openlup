import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { CustomerPaymentPreference } from "../../../src/domains/customers/contracts.js";
import type { CustomerUserAuthenticationResult } from "./customerAuth.js";
import type { CustomerPaymentPreferencesPort } from "./ports.js";
import { createCustomerPaymentPreferencesHandler } from "./customerPreferencesHandler.js";

const PREFERENCE: CustomerPaymentPreference = {
  scope: "one_time",
  methodKind: "card",
  lastSelectedAt: "2026-06-06T12:00:00.000+02:00",
};

describe("customer payment preferences handler", () => {
  it("returns customer-scoped payment preferences", async () => {
    const port = createPort({ list: [PREFERENCE] });
    const res = createResponse();

    await createHandler({ port })(request("GET"), res);

    expect(port.listPaymentPreferences).toHaveBeenCalledWith("user-1");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: {
        contractVersion: "customer.preferences.v1",
        preferences: [PREFERENCE],
      },
    });
  });

  it("upserts a sanitized payment preference", async () => {
    const port = createPort({ upsert: PREFERENCE });
    const res = createResponse();

    await createHandler({ port })(
      request("PATCH", { scope: "one_time", methodKind: "card" }),
      res,
    );

    expect(port.upsertPaymentPreference).toHaveBeenCalledWith("user-1", {
      scope: "one_time",
      methodKind: "card",
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("rejects invalid input, missing sessions, and unlinked customers", async () => {
    const invalid = createResponse();
    await createHandler({ port: createPort({ upsert: PREFERENCE }) })(
      request("PATCH", { scope: "one_time", methodKind: "pm_123" }),
      invalid,
    );

    const unauthorized = createResponse();
    await createHandler({
      port: createPort({ list: [PREFERENCE] }),
      auth: { ok: false, code: "UNAUTHORIZED", message: "Customer session required" },
    })(request("GET"), unauthorized);

    const forbidden = createResponse();
    await createHandler({ port: createPort({ list: null }) })(request("GET"), forbidden);

    expect(invalid.status).toHaveBeenCalledWith(400);
    expect(unauthorized.status).toHaveBeenCalledWith(401);
    expect(forbidden.status).toHaveBeenCalledWith(403);
  });

  it("maps failures and unsupported methods to BFF errors", async () => {
    const authFailed = createResponse();
    await createHandler({ port: createPort({ list: [PREFERENCE] }), auth: new Error("auth down") })(
      request("GET"),
      authFailed,
    );

    const failed = createResponse();
    await createHandler({ port: createPort({ list: new Error("DB down") }) })(request("GET"), failed);

    const method = createResponse();
    await createHandler({ port: createPort({ list: [PREFERENCE] }) })(request("POST"), method);

    expect(authFailed.status).toHaveBeenCalledWith(503);
    expect(failed.status).toHaveBeenCalledWith(503);
    expect(method.setHeader).toHaveBeenCalledWith("Allow", "GET, PATCH");
    expect(method.status).toHaveBeenCalledWith(405);
  });
});

function createHandler({
  port,
  auth = { ok: true, userId: "user-1" },
}: {
  port: CustomerPaymentPreferencesPort;
  auth?: CustomerUserAuthenticationResult | Error;
}) {
  return createCustomerPaymentPreferencesHandler({
    preferencesPort: port,
    authenticateUser: vi.fn().mockImplementation(async () => {
      if (auth instanceof Error) throw auth;
      return auth;
    }),
  });
}

function request(method: string, body?: unknown): VercelRequest {
  return { method, body, query: {} } as unknown as VercelRequest;
}

function createPort(result: {
  list?: CustomerPaymentPreference[] | null | Error;
  upsert?: CustomerPaymentPreference | null | Error;
}): CustomerPaymentPreferencesPort {
  return {
    listPaymentPreferences: vi.fn().mockImplementation(async () => {
      if (result.list instanceof Error) throw result.list;
      return "list" in result ? result.list : [];
    }),
    upsertPaymentPreference: vi.fn().mockImplementation(async () => {
      if (result.upsert instanceof Error) throw result.upsert;
      return "upsert" in result ? result.upsert : PREFERENCE;
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
