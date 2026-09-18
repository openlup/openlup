import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { PlatformAdminAuthorizationResult } from "./adminAuth.js";
import type { AdminSettingsPort } from "../../../src/domains/platform/ports.js";
import {
  createAdminSettingsReadHandler,
  createAdminSettingsUpdateHandler,
  createAdminUserRoleUpdateHandler,
} from "./adminSettingsHandlers.js";

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

  it("maps role-update RPC guard errors to their BFF status codes", async () => {
    const rolePort = (error: Error): Pick<AdminSettingsPort, "updateAdminUserRole"> => ({
      updateAdminUserRole: vi.fn().mockRejectedValue(error),
    });
    const body = { userId: "admin-2", role: "distributor" };

    // bffCode-carrying errors map to that code...
    const forbidden = createResponse();
    await createAdminUserRoleUpdateHandler({
      settingsPort: rolePort(Object.assign(new Error("self"), { bffCode: "FORBIDDEN" })),
      authorizeAdmin: authorize(),
    })(request("POST", {}, body), forbidden);

    const conflict = createResponse();
    await createAdminUserRoleUpdateHandler({
      settingsPort: rolePort(Object.assign(new Error("lockout"), { bffCode: "CONFLICT" })),
      authorizeAdmin: authorize(),
    })(request("POST", {}, body), conflict);

    // ...a plain error falls back to 503.
    const generic = createResponse();
    await createAdminUserRoleUpdateHandler({
      settingsPort: rolePort(new Error("DB unavailable")),
      authorizeAdmin: authorize(),
    })(request("POST", {}, body), generic);

    expect(forbidden.status).toHaveBeenCalledWith(403);
    expect(conflict.status).toHaveBeenCalledWith(409);
    expect(generic.status).toHaveBeenCalledWith(503);
  });

  it("returns CONFLICT, not 503, when a role target has inactive membership", async () => {
    const res = createResponse();
    const port: Pick<AdminSettingsPort, "updateAdminUserRole"> = {
      updateAdminUserRole: vi.fn().mockRejectedValue(
        Object.assign(new Error("The target no longer has active panel access."), { bffCode: "CONFLICT" }),
      ),
    };

    await createAdminUserRoleUpdateHandler({
      settingsPort: port,
      authorizeAdmin: authorize(),
    })(request("POST", {}, { userId: "admin-2", role: "distributor" }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.status).not.toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: "CONFLICT",
        message: "The target no longer has active panel access.",
      },
    });
  });

});

function request(method: string, query = {}, body?: unknown): VercelRequest {
  return { method, query, body } as unknown as VercelRequest;
}

function authorize(
  result: PlatformAdminAuthorizationResult = { ok: true },
): () => Promise<PlatformAdminAuthorizationResult> {
  return vi.fn().mockResolvedValue(result);
}

function createPort(
  result?: unknown,
): Pick<AdminSettingsPort, "readSettings" | "updateSetting"> {
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
