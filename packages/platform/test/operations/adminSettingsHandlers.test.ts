import { describe, expect, it, vi } from "vitest";
import type { HttpRequest, HttpResponse } from "../../src/http/index.js";
import type { OperationsAuthorizationResult } from "../../src/operations/contracts/index.js";
import type { AdminSettingsOperationsPort } from "../../src/operations/contracts/index.js";
import {
  createAdminSettingsReadHandler,
  createAdminSettingsUpdateHandler,
} from "../../src/operations/server/adminSettingsHandlers.js";

describe("admin settings handlers", () => {
  it("reads settings and admin users through the shared BFF envelope", async () => {
    const settingsPort = createPort();
    const res = createResponse();

    await createAdminSettingsReadHandler({
      settingsPort,
      authorizeAdmin: authorize(),
    })(request("GET"), res);

    expect(settingsPort.readSettings).toHaveBeenCalledWith({});
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: settingsResponse(),
    });
  });

  it("updates a setting through the shared BFF envelope", async () => {
    const settingsPort = createPort();
    const res = createResponse();

    await createAdminSettingsUpdateHandler({
      settingsPort,
      authorizeAdmin: authorize(),
    })(request("POST", {}, { key: " tester_cap ", value: 250 }), res);

    expect(settingsPort.updateSetting).toHaveBeenCalledWith({ key: "tester_cap", value: 250 });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: { key: "tester_cap", saved: true },
    });
  });

  it("rejects unsupported methods and non-admin users", async () => {
    const method = createResponse();
    await createAdminSettingsReadHandler({
      settingsPort: createPort(),
      authorizeAdmin: authorize(),
    })(request("POST"), method);

    const unauthorized = createResponse();
    await createAdminSettingsReadHandler({
      settingsPort: createPort(),
      authorizeAdmin: authorize({
        ok: false,
        code: "UNAUTHORIZED",
        message: "Admin session required",
      }),
    })(request("GET"), unauthorized);

    const forbidden = createResponse();
    await createAdminSettingsReadHandler({
      settingsPort: createPort(),
      authorizeAdmin: authorize({
        ok: false,
        code: "FORBIDDEN",
        message: "Admin role required",
      }),
    })(request("GET"), forbidden);

    expect(method.setHeader).toHaveBeenCalledWith("Allow", "GET");
    expect(method.status).toHaveBeenCalledWith(405);
    expect(unauthorized.status).toHaveBeenCalledWith(401);
    expect(forbidden.status).toHaveBeenCalledWith(403);
  });

  it("maps authorization, invalid output, and upstream failures", async () => {
    const authFailed = createResponse();
    await createAdminSettingsReadHandler({
      settingsPort: createPort(),
      authorizeAdmin: vi.fn().mockRejectedValue(new Error("Auth unavailable")),
    })(request("GET"), authFailed);

    const invalid = createResponse();
    await createAdminSettingsReadHandler({
      settingsPort: createPort({ settings: {}, adminUsers: [{ id: "", email: null, role: null }] }),
      authorizeAdmin: authorize(),
    })(request("GET"), invalid);

    const failed = createResponse();
    await createAdminSettingsReadHandler({
      settingsPort: createPort(new Error("DB unavailable")),
      authorizeAdmin: authorize(),
    })(request("GET"), failed);

    expect(authFailed.status).toHaveBeenCalledWith(503);
    expect(invalid.status).toHaveBeenCalledWith(502);
    expect(failed.status).toHaveBeenCalledWith(503);
  });

  it("maps update validation, invalid output, and upstream failures", async () => {
    const invalidRequest = createResponse();
    await createAdminSettingsUpdateHandler({
      settingsPort: createPort(),
      authorizeAdmin: authorize(),
    })(request("POST", {}, { key: "", value: 250 }), invalidRequest);

    const invalidResponse = createResponse();
    await createAdminSettingsUpdateHandler({
      settingsPort: createPort({ key: "", saved: true }),
      authorizeAdmin: authorize(),
    })(request("POST", {}, { key: "tester_cap", value: 250 }), invalidResponse);

    const failed = createResponse();
    await createAdminSettingsUpdateHandler({
      settingsPort: createPort(new Error("DB unavailable")),
      authorizeAdmin: authorize(),
    })(request("POST", {}, { key: "tester_cap", value: 250 }), failed);

    expect(invalidRequest.status).toHaveBeenCalledWith(400);
    expect(invalidResponse.status).toHaveBeenCalledWith(502);
    expect(failed.status).toHaveBeenCalledWith(503);
  });


});

function request(method: string, query = {}, body?: unknown): HttpRequest {
  return { method, query, body } as unknown as HttpRequest;
}

function authorize(
  result: OperationsAuthorizationResult = { ok: true },
): () => Promise<OperationsAuthorizationResult> {
  return vi.fn().mockResolvedValue(result);
}

function createPort(
  result?: unknown,
): Pick<AdminSettingsOperationsPort, "readSettings" | "updateSetting"> {
  return {
    readSettings: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return result ?? settingsResponse();
    }),
    updateSetting: vi.fn().mockImplementation(async (request) => {
      if (result instanceof Error) throw result;
      return result ?? { key: request.key, saved: true };
    }),
  };
}

function createResponse(): HttpResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as HttpResponse;

  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function settingsResponse() {
  return {
    settings: {
      tester_cap: 300,
      counter_display: true,
      dhl_shipper_name: "openlup",
    },
    adminUsers: [
      { id: "admin-1", email: "admin@openlup.com", role: "admin" },
      { id: "admin-2", email: "ops@openlup.com", role: "distributor" },
    ],
  };
}
