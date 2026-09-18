import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import * as adminAuth from "../../../_lib/admin-domain/auth.js";
import {
  authorizeFulfillmentAdmin,
  createFulfillmentAdminAuthContext,
  refuseRetiredDirectDhlAction,
} from "./shared.js";

describe("fulfillment admin BFF shared auth helpers", () => {
  const previousEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...previousEnv };
    vi.restoreAllMocks();
  });

  it("fails closed when Supabase auth env is absent", () => {
    delete process.env.SUPABASE_URL;
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    delete process.env.VITE_SUPABASE_ANON_KEY;
    delete process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

    expect(createFulfillmentAdminAuthContext({ headers: {} } as never)).toBeNull();
  });

  it("exposes the authorization helper", () => {
    expect(authorizeFulfillmentAdmin).toBeTypeOf("function");
  });

  it("rejects methods and missing auth configuration before retirement disclosure", async () => {
    const methodResponse = response();
    await refuseRetiredDirectDhlAction(
      { method: "GET", headers: {} } as never,
      methodResponse as never,
      { allowedRoles: ["admin"], reason: "retired", message: "Retired" },
    );
    expect(methodResponse.status).toHaveBeenCalledWith(405);

    delete process.env.SUPABASE_URL;
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    delete process.env.VITE_SUPABASE_ANON_KEY;
    delete process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    const missingEnvResponse = response();
    await refuseRetiredDirectDhlAction(
      { method: "POST", headers: {} } as never,
      missingEnvResponse as never,
      { allowedRoles: ["admin"], reason: "retired", message: "Retired" },
    );
    expect(missingEnvResponse.status).toHaveBeenCalledWith(500);
  });

  it("returns terminal 404 after a successful admin authorization", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "test-anon-key";
    vi.spyOn(adminAuth, "authorizeAdminBooleanWithUser").mockResolvedValue(true);
    const authorizedResponse = response();

    await refuseRetiredDirectDhlAction(
      { method: "POST", headers: { authorization: "Bearer test-token" } } as never,
      authorizedResponse as never,
      { allowedRoles: ["admin", "distributor"], reason: "direct_dhl_new_intake_retired", message: "Retired" },
    );

    expect(adminAuth.authorizeAdminBooleanWithUser).toHaveBeenCalledWith(
      expect.anything(),
      "test-token",
      { allowedRoles: ["admin", "distributor"] },
    );
    expect(authorizedResponse.status).toHaveBeenCalledWith(404);
    expect(authorizedResponse.json).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "Retired",
        details: { reason: "direct_dhl_new_intake_retired" },
      },
    });
  });
});

function response() {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}
