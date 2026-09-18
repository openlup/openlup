import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { CustomerCommunicationPreferencesResponse } from "../../../src/domains/communications/customerPreferencesContracts.js";
import {
  createCustomerCommunicationPreferencesHandler,
  type CustomerCommunicationPreferencesPort,
} from "./customerCommunicationPreferencesHandler.js";

const PREFERENCES: CustomerCommunicationPreferencesResponse = {
  contractVersion: "customer.communication_preferences.v1",
  contact: { contactId: "contact-1", email: "ala@example.com" },
  marketingNewsletter: {
    purpose: "marketing_newsletter",
    state: "granted",
    granted: true,
    source: "customer_communication_preferences",
    reason: "customer_self_service_grant",
    capturedAt: "2026-06-14T10:00:00.000+02:00",
    updatedAt: "2026-06-14T10:00:00.000+02:00",
  },
};

describe("customer communication preferences handler", () => {
  it("returns customer-scoped communication preferences", async () => {
    const port = createPort({ get: PREFERENCES });
    const res = createResponse();

    await createHandler({ port })(request("GET"), res);

    expect(port.getPreferences).toHaveBeenCalledWith("user-1");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: PREFERENCES });
  });

  it("updates only marketing newsletter consent", async () => {
    const port = createPort({ update: PREFERENCES });
    const res = createResponse();

    await createHandler({ port })(
      request("PATCH", { marketingNewsletterConsent: false }),
      res,
    );

    expect(port.updatePreferences).toHaveBeenCalledWith("user-1", {
      marketingNewsletterConsent: false,
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("rejects invalid input, missing sessions, and unlinked customers", async () => {
    const invalid = createResponse();
    await createHandler({ port: createPort({ update: PREFERENCES }) })(
      request("PATCH", { purpose: "marketing_newsletter", state: "granted" }),
      invalid,
    );

    const unauthorized = createResponse();
    await createHandler({
      port: createPort({ get: PREFERENCES }),
      auth: { ok: false, code: "UNAUTHORIZED", message: "Customer session required" },
    })(request("GET"), unauthorized);

    const forbidden = createResponse();
    await createHandler({ port: createPort({ get: null }) })(request("GET"), forbidden);

    expect(invalid.status).toHaveBeenCalledWith(400);
    expect(unauthorized.status).toHaveBeenCalledWith(401);
    expect(forbidden.status).toHaveBeenCalledWith(403);
  });

  it("maps failures and unsupported methods to BFF errors", async () => {
    const authFailed = createResponse();
    await createHandler({ port: createPort({ get: PREFERENCES }), auth: new Error("auth down") })(
      request("GET"),
      authFailed,
    );

    const failed = createResponse();
    await createHandler({ port: createPort({ get: new Error("DB down") }) })(
      request("GET"),
      failed,
    );

    const method = createResponse();
    await createHandler({ port: createPort({ get: PREFERENCES }) })(request("POST"), method);

    expect(authFailed.status).toHaveBeenCalledWith(503);
    expect(failed.status).toHaveBeenCalledWith(503);
    expect(method.setHeader).toHaveBeenCalledWith("Allow", "GET, PATCH");
    expect(method.status).toHaveBeenCalledWith(405);
  });
});

function createHandler({
  port,
  auth = { ok: true, userId: "user-1" } as const,
}: {
  port: CustomerCommunicationPreferencesPort;
  auth?: { ok: true; userId: string } | { ok: false; code: "UNAUTHORIZED"; message: string } | Error;
}) {
  return createCustomerCommunicationPreferencesHandler({
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
  get?: CustomerCommunicationPreferencesResponse | null | Error;
  update?: CustomerCommunicationPreferencesResponse | null | Error;
}): CustomerCommunicationPreferencesPort {
  return {
    getPreferences: vi.fn().mockImplementation(async () => {
      if (result.get instanceof Error) throw result.get;
      return "get" in result ? result.get : PREFERENCES;
    }),
    updatePreferences: vi.fn().mockImplementation(async () => {
      if (result.update instanceof Error) throw result.update;
      return "update" in result ? result.update : PREFERENCES;
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
