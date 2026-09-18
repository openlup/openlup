import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { PlatformAdminAuthorizationResult } from "./adminAuth.js";
import type { AdminSettingsPort } from "../../../src/domains/platform/ports.js";
import {
  createAdminUserInviteHandler,
  createAdminUserRemoveHandler,
  createAdminUserRoleUpdateHandler,
} from "./adminSettingsHandlers.js";

describe("admin user management handlers", () => {
  it("updates an admin user role through the shared BFF envelope", async () => {
    const settingsPort = createPort();
    const res = createResponse();

    await createAdminUserRoleUpdateHandler({
      settingsPort,
      authorizeAdmin: authorize(),
    })(request("POST", {}, { userId: "admin-2", role: "admin" }), res);

    expect(settingsPort.updateAdminUserRole).toHaveBeenCalledWith({
      userId: "admin-2",
      role: "admin",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: { userId: "admin-2", role: "admin", saved: true },
    });
  });

  it("invites an admin user through the shared BFF envelope", async () => {
    const settingsPort = createPort();
    const res = createResponse();

    await createAdminUserInviteHandler({
      settingsPort,
      authorizeAdmin: authorize(),
    })(request("POST", {}, { email: " NEW@OPENLUP.COM ", role: "admin" }), res);

    expect(settingsPort.inviteAdminUser).toHaveBeenCalledWith({
      email: "new@openlup.com",
      role: "admin",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: { message: "Zaproszenie wysłane" },
    });
  });

  it("revokes an admin user through the compatibility URL and shared BFF envelope", async () => {
    const settingsPort = createPort();
    const res = createResponse();

    await createAdminUserRemoveHandler({
      settingsPort,
      authorizeAdmin: authorize(),
    })(request("POST", {}, { userId: "admin-2" }), res);

    expect(settingsPort.removeAdminUser).toHaveBeenCalledWith({ userId: "admin-2" });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: { revoked: true },
    });
  });

  it("maps admin user role validation, invalid output, and upstream failures", async () => {
    const invalidRequest = createResponse();
    await createAdminUserRoleUpdateHandler({
      settingsPort: createPort(),
      authorizeAdmin: authorize(),
    })(request("POST", {}, { userId: "admin-2", role: "owner" }), invalidRequest);

    const invalidResponse = createResponse();
    await createAdminUserRoleUpdateHandler({
      settingsPort: createPort({ userId: "", role: "admin", saved: true }),
      authorizeAdmin: authorize(),
    })(request("POST", {}, { userId: "admin-2", role: "admin" }), invalidResponse);

    const failed = createResponse();
    await createAdminUserRoleUpdateHandler({
      settingsPort: createPort(new Error("DB unavailable")),
      authorizeAdmin: authorize(),
    })(request("POST", {}, { userId: "admin-2", role: "admin" }), failed);

    expect(invalidRequest.status).toHaveBeenCalledWith(400);
    expect(invalidResponse.status).toHaveBeenCalledWith(502);
    expect(failed.status).toHaveBeenCalledWith(503);
  });

  it("maps admin user invite validation, invalid output, and upstream failures", async () => {
    const invalidRequest = createResponse();
    await createAdminUserInviteHandler({
      settingsPort: createPort(),
      authorizeAdmin: authorize(),
    })(request("POST", {}, { email: "invalid", role: "admin" }), invalidRequest);

    const invalidResponse = createResponse();
    await createAdminUserInviteHandler({
      settingsPort: createPort({ message: "" }),
      authorizeAdmin: authorize(),
    })(request("POST", {}, { email: "new@openlup.com", role: "admin" }), invalidResponse);

    const failed = createResponse();
    await createAdminUserInviteHandler({
      settingsPort: createPort(new Error("Ten użytkownik jest już dodany")),
      authorizeAdmin: authorize(),
    })(request("POST", {}, { email: "new@openlup.com", role: "admin" }), failed);

    expect(invalidRequest.status).toHaveBeenCalledWith(400);
    expect(invalidResponse.status).toHaveBeenCalledWith(502);
    expect(failed.status).toHaveBeenCalledWith(503);
    expect(failed.json).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: "UPSTREAM_UNAVAILABLE",
        message: "Ten użytkownik jest już dodany",
      },
    });
  });

  it("maps admin user remove validation, invalid output, and upstream failures", async () => {
    const invalidRequest = createResponse();
    await createAdminUserRemoveHandler({
      settingsPort: createPort(),
      authorizeAdmin: authorize(),
    })(request("POST", {}, { userId: "" }), invalidRequest);

    const invalidResponse = createResponse();
    await createAdminUserRemoveHandler({
      settingsPort: createPort({ revoked: false }),
      authorizeAdmin: authorize(),
    })(request("POST", {}, { userId: "admin-2" }), invalidResponse);

    const failed = createResponse();
    await createAdminUserRemoveHandler({
      settingsPort: createPort(new Error("Nie możesz odebrać sobie dostępu")),
      authorizeAdmin: authorize(),
    })(request("POST", {}, { userId: "admin-2" }), failed);

    expect(invalidRequest.status).toHaveBeenCalledWith(400);
    expect(invalidResponse.status).toHaveBeenCalledWith(502);
    expect(failed.status).toHaveBeenCalledWith(503);
    expect(failed.json).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: "UPSTREAM_UNAVAILABLE",
        message: "Nie możesz odebrać sobie dostępu",
      },
    });
  });

  it("preserves the revoke RPC refusal code in the BFF envelope", async () => {
    const res = createResponse();
    const port: Pick<AdminSettingsPort, "removeAdminUser"> = {
      removeAdminUser: vi.fn().mockRejectedValue(
        Object.assign(new Error("At least one active human admin must remain."), { bffCode: "CONFLICT" }),
      ),
    };

    await createAdminUserRemoveHandler({
      settingsPort: port,
      authorizeAdmin: authorize(),
    })(request("POST", {}, { userId: "admin-2" }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: "CONFLICT",
        message: "At least one active human admin must remain.",
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
): Pick<
  AdminSettingsPort,
  "updateAdminUserRole" | "inviteAdminUser" | "removeAdminUser"
> {
  return {
    updateAdminUserRole: vi.fn().mockImplementation(async (request) => {
      if (result instanceof Error) throw result;
      return result ?? { userId: request.userId, role: request.role, saved: true };
    }),
    inviteAdminUser: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return result ?? { message: "Zaproszenie wysłane" };
    }),
    removeAdminUser: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return result ?? { revoked: true };
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
