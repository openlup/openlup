import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { PlatformUserAuthenticationResult } from "./adminAuth.js";
import type { AdminPlatformPort } from "../../../src/domains/platform/ports.js";
import { createAdminPlatformMeHandler } from "./adminMeHandler.js";

describe("admin platform me handler", () => {
  it("returns the current admin role through the shared BFF envelope", async () => {
    const platformPort = createPort({ isAdmin: true, role: "distributor" });
    const res = createResponse();

    await createHandler({ platformPort })(request("GET"), res);

    expect(platformPort.getAdminMe).toHaveBeenCalledWith("user-1");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: { isAdmin: true, role: "distributor" },
    });
  });

  it("returns a non-admin result without treating it as forbidden", async () => {
    const res = createResponse();

    await createHandler({
      platformPort: createPort({ isAdmin: false, role: null }),
    })(request("GET"), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: { isAdmin: false, role: null },
    });
  });

  it("rejects unsupported methods, missing sessions, and invalid queries", async () => {
    const method = createResponse();
    await createHandler({ platformPort: createPort({ isAdmin: true, role: "admin" }) })(
      request("POST"),
      method,
    );

    const unauthorized = createResponse();
    await createHandler({
      platformPort: createPort({ isAdmin: true, role: "admin" }),
      auth: { ok: false, code: "UNAUTHORIZED", message: "Admin session required" },
    })(request("GET"), unauthorized);

    const invalid = createResponse();
    await createHandler({ platformPort: createPort({ isAdmin: true, role: "admin" }) })(
      request("GET", { unexpected: "1" }),
      invalid,
    );

    expect(method.setHeader).toHaveBeenCalledWith("Allow", "GET");
    expect(method.status).toHaveBeenCalledWith(405);
    expect(unauthorized.status).toHaveBeenCalledWith(401);
    expect(invalid.status).toHaveBeenCalledWith(400);
  });

  it("maps authentication, invalid output, and upstream failures to BFF errors", async () => {
    const authFailed = createResponse();
    await createHandler({
      platformPort: createPort({ isAdmin: true, role: "admin" }),
      auth: new Error("Auth unavailable"),
    })(request("GET"), authFailed);

    const invalid = createResponse();
    await createHandler({
      platformPort: createPort({ isAdmin: true, role: "owner" }),
    })(request("GET"), invalid);

    const failed = createResponse();
    await createHandler({
      platformPort: createPort(new Error("DB unavailable")),
    })(request("GET"), failed);

    expect(authFailed.status).toHaveBeenCalledWith(503);
    expect(invalid.status).toHaveBeenCalledWith(502);
    expect(failed.status).toHaveBeenCalledWith(503);
  });
});

function createHandler({
  platformPort,
  auth = { ok: true, userId: "user-1" },
}: {
  platformPort: AdminPlatformPort;
  auth?: PlatformUserAuthenticationResult | Error;
}) {
  return createAdminPlatformMeHandler({
    platformPort,
    authenticateUser: vi.fn().mockImplementation(async () => {
      if (auth instanceof Error) throw auth;
      return auth;
    }),
  });
}

function request(method: string, query: VercelRequest["query"] = {}): VercelRequest {
  return { method, query } as unknown as VercelRequest;
}

function createPort(result: unknown): AdminPlatformPort {
  return {
    checkAdminMagicLinkEligibility: vi.fn(),
    getAdminMe: vi.fn().mockImplementation(async () => {
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
