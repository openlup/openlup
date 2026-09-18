import { afterEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../types/vercel.js";
import {
  allowedAdminRolesForBffRoute,
  authorizeAdminBooleanWithUser,
  authorizeAdminWithUser,
  authorizeCommerceAdminWithUser,
  createAdminAuthClient,
  createServiceRoleClient,
  readBearerToken,
  readSupabaseAdminCommerceEnv,
  readSupabaseAdminServiceEnv,
  resolveSupabaseAdminAuthEnv,
  resolveSupabaseServiceRoleEnv,
  resolveAdmin,
} from "./auth.js";

function req(authorization?: string): VercelRequest {
  return { headers: authorization ? { authorization } : {} } as unknown as VercelRequest;
}

function response(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

/** Minimal chainable mock of the user-scoped Supabase client. */
function authClient(opts: {
  user?: { id: string } | null;
  userError?: boolean;
  adminRow?: { id: string; role?: string | null; is_machine_actor?: boolean } | null;
  selectError?: boolean;
}) {
  const maybeSingle = vi.fn().mockResolvedValue({
    data: opts.adminRow ?? null,
    error: opts.selectError ? new Error("db down") : null,
  });
  const query = {
    eq: vi.fn(),
    maybeSingle,
  };
  query.eq.mockReturnValue(query);

  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: opts.userError ? null : opts.user ?? null },
        error: opts.userError ? new Error("bad token") : null,
      }),
    },
    from: () => ({
      select: () => query,
    }),
  } as never;
}

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("readBearerToken", () => {
  it("extracts a bearer token, case-insensitively, trimmed", () => {
    expect(readBearerToken(req("Bearer  abc123 "))).toBe("abc123");
    expect(readBearerToken(req("bearer xyz"))).toBe("xyz");
  });
  it("returns null without a bearer token", () => {
    expect(readBearerToken(req())).toBeNull();
    expect(readBearerToken(req("Basic abc"))).toBeNull();
  });
});

describe("readSupabaseAdminServiceEnv", () => {
  it("resolves supplied auth and service-role environment values", () => {
    const env = {
      VITE_SUPABASE_URL: "https://x.supabase.co",
      VITE_SUPABASE_PUBLISHABLE_KEY: "anon",
      SUPABASE_SERVICE_ROLE_KEY: "service",
    };
    expect(resolveSupabaseAdminAuthEnv(env)).toEqual({ url: "https://x.supabase.co", anonKey: "anon" });
    expect(resolveSupabaseServiceRoleEnv(env)).toEqual({
      url: "https://x.supabase.co",
      serviceRoleKey: "service",
    });
  });

  it("returns the trio when all present", () => {
    process.env.SUPABASE_URL = "https://x.supabase.co";
    process.env.VITE_SUPABASE_ANON_KEY = "anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    expect(readSupabaseAdminServiceEnv()).toEqual({
      url: "https://x.supabase.co",
      anonKey: "anon",
      serviceRoleKey: "service",
    });
    expect(readSupabaseAdminCommerceEnv()).toEqual(readSupabaseAdminServiceEnv());
  });
  it("returns null when the service-role key is missing", () => {
    process.env.SUPABASE_URL = "https://x.supabase.co";
    process.env.VITE_SUPABASE_ANON_KEY = "anon";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(readSupabaseAdminServiceEnv()).toBeNull();
    expect(readSupabaseAdminCommerceEnv()).toBeNull();
  });
});

describe("supabase client factories", () => {
  const env = { url: "https://x.supabase.co", anonKey: "anon", serviceRoleKey: "service" };
  it("construct clients without throwing", () => {
    expect(createAdminAuthClient(env, "tok")).toBeTruthy();
    expect(createAdminAuthClient(env, null)).toBeTruthy();
    expect(createServiceRoleClient(env)).toBeTruthy();
  });
});

describe("authorizeCommerceAdminWithUser", () => {
  it("is UNAUTHORIZED without a token", async () => {
    expect(await authorizeCommerceAdminWithUser(authClient({}), null)).toEqual({
      ok: false,
      code: "UNAUTHORIZED",
      message: "Admin session required",
    });
  });
  it("is UNAUTHORIZED when the token does not resolve a user", async () => {
    const out = await authorizeCommerceAdminWithUser(authClient({ userError: true }), "t");
    expect(out).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
  });
  it("is FORBIDDEN when the user is not an admin", async () => {
    const out = await authorizeCommerceAdminWithUser(
      authClient({ user: { id: "u1" }, adminRow: null }),
      "t",
    );
    expect(out).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });
  it("resolves a human admin (is_machine_actor false)", async () => {
    const out = await authorizeCommerceAdminWithUser(
      authClient({ user: { id: "u1" }, adminRow: { id: "u1", role: "admin", is_machine_actor: false } }),
      "t",
    );
    expect(out).toEqual({ ok: true, userId: "u1", role: "admin", isMachineActor: false });
  });
  it("resolves a machine admin (is_machine_actor true)", async () => {
    const out = await authorizeCommerceAdminWithUser(
      authClient({
        user: { id: "agent" },
        adminRow: { id: "agent", role: "admin", is_machine_actor: true },
      }),
      "t",
    );
    expect(out).toEqual({ ok: true, userId: "agent", role: "admin", isMachineActor: true });
  });
  it("fails closed: a missing is_machine_actor resolves as a machine actor", async () => {
    // Mirrors the activate RPC's COALESCE(is_machine_actor, true): unknown → machine.
    const out = await authorizeCommerceAdminWithUser(
      authClient({ user: { id: "u1" }, adminRow: { id: "u1", role: "admin" } }),
      "t",
    );
    expect(out).toEqual({ ok: true, userId: "u1", role: "admin", isMachineActor: true });
  });
  it("rejects distributor rows on full-admin commerce helpers", async () => {
    const out = await authorizeCommerceAdminWithUser(
      authClient({ user: { id: "u1" }, adminRow: { id: "u1", role: "distributor" } }),
      "t",
    );
    expect(out).toEqual({ ok: false, code: "FORBIDDEN", message: "Admin role required" });
  });
});

describe("authorizeAdminWithUser", () => {
  it("denies a session whose membership is no longer active", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const query = { eq: vi.fn(), maybeSingle };
    query.eq.mockReturnValue(query);
    const client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "revoked-user" } }, error: null }) },
      from: vi.fn(() => ({ select: vi.fn(() => query) })),
    } as never;

    await expect(authorizeAdminWithUser(client, "t")).resolves.toEqual({
      ok: false,
      code: "FORBIDDEN",
      message: "Admin role required",
    });
    expect(query.eq).toHaveBeenCalledWith("membership_state", "active");
  });

  it("allows a distributor only when the caller explicitly allows that role", async () => {
    const out = await authorizeAdminWithUser(
      authClient({
        user: { id: "shipper-1" },
        adminRow: { id: "shipper-1", role: "distributor", is_machine_actor: false },
      }),
      "t",
      { allowedRoles: ["admin", "distributor"] },
    );
    expect(out).toEqual({
      ok: true,
      userId: "shipper-1",
      role: "distributor",
      isMachineActor: false,
    });
  });
  it("rethrows a lookup error", async () => {
    await expect(
      authorizeCommerceAdminWithUser(authClient({ user: { id: "u1" }, selectError: true }), "t"),
    ).rejects.toThrow();
  });
});

describe("authorizeAdminBooleanWithUser", () => {
  it("keeps legacy boolean handlers role-aware", async () => {
    await expect(
      authorizeAdminBooleanWithUser(
        authClient({ user: { id: "admin-1" }, adminRow: { id: "admin-1", role: "admin" } }),
        "t",
        { allowedRoles: ["admin"] },
      ),
    ).resolves.toBe(true);

    await expect(
      authorizeAdminBooleanWithUser(
        authClient({ user: { id: "shipper-1" }, adminRow: { id: "shipper-1", role: "distributor" } }),
        "t",
        { allowedRoles: ["admin"] },
      ),
    ).resolves.toBe(false);

    await expect(
      authorizeAdminBooleanWithUser(
        authClient({ user: { id: "shipper-1" }, adminRow: { id: "shipper-1", role: "distributor" } }),
        "t",
        { allowedRoles: ["admin", "distributor"] },
      ),
    ).resolves.toBe(true);
  });
});

describe("allowedAdminRolesForBffRoute", () => {
  it("keeps platform/me as introspection and non-admin routes ungated", () => {
    expect(allowedAdminRolesForBffRoute("/api/bff/admin/platform/me")).toBeNull();
    expect(allowedAdminRolesForBffRoute("/api/bff/health")).toBeNull();
  });

  it("allows distributor only on shipment/distribution routes", () => {
    expect(allowedAdminRolesForBffRoute("/api/bff/admin/fulfillment/shipments-overview"))
      .toEqual(["admin", "distributor"]);
    expect(allowedAdminRolesForBffRoute("/api/bff/admin/tester-program/status"))
      .toEqual(["admin", "distributor"]);
    expect(allowedAdminRolesForBffRoute("/api/bff/admin/communications/send-email"))
      .toEqual(["admin"]);
    expect(allowedAdminRolesForBffRoute("/api/bff/admin/clients/testers/update"))
      .toEqual(["admin"]);
    expect(allowedAdminRolesForBffRoute("/api/bff/admin/fulfillment/commerce-orders"))
      .toEqual(["admin"]);
    expect(allowedAdminRolesForBffRoute("/api/bff/admin/fulfillment/dhl-repair-courier-pickup"))
      .toEqual(["admin"]);
  });
});

describe("resolveAdmin", () => {
  it("returns the userId and actor kind on success", async () => {
    const res = response();
    expect(
      await resolveAdmin(
        async () => ({ ok: true, userId: "u1", role: "admin", isMachineActor: false }),
        res,
      ),
    ).toEqual({ userId: "u1", role: "admin", isMachineActor: false });
  });
  it("sends the denial envelope and returns null", async () => {
    const res = response();
    const out = await resolveAdmin(
      async () => ({ ok: false, code: "FORBIDDEN", message: "no" }),
      res,
    );
    expect(out).toBeNull();
    expect(res.status).toHaveBeenCalledWith(403);
  });
  it("maps a thrown authorizer to UPSTREAM_UNAVAILABLE", async () => {
    const res = response();
    const out = await resolveAdmin(async () => {
      throw new Error("boom");
    }, res);
    expect(out).toBeNull();
    expect(res.status).toHaveBeenCalledWith(503);
  });
});
