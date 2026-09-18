import { describe, expect, it, vi } from "vitest";

import {
  authenticateSupabasePlatformUser,
  createSupabaseAdminPlatformPort,
} from "./adminPlatformPort.js";

describe("createSupabaseAdminPlatformPort", () => {
  it("returns admin role state for a known admin user", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { role: "distributor" }, error: null });
    const query = { eq: vi.fn(), maybeSingle };
    query.eq.mockReturnValue(query);
    const client = {
      from: vi.fn(() => ({
        select: vi.fn(() => query),
      })),
    };

    await expect(createSupabaseAdminPlatformPort(client as never).getAdminMe("admin-1")).resolves.toEqual({
      isAdmin: true,
      role: "distributor",
    });
    expect(query.eq).toHaveBeenCalledWith("membership_state", "active");
  });

  it("returns non-admin state when the admin row is absent", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const query = { eq: vi.fn(), maybeSingle };
    query.eq.mockReturnValue(query);
    const client = {
      from: vi.fn(() => ({
        select: vi.fn(() => query),
      })),
    };

    await expect(createSupabaseAdminPlatformPort(client as never).getAdminMe("user-1")).resolves.toEqual({
      isAdmin: false,
      role: null,
    });
  });

  it.each([
    ["admin", "eligible"],
    ["distributor", "eligible"],
    [null, "eligible"],
    ["support", "role_not_allowed"],
  ] as const)("checks admin magic-link eligibility for role %s", async (role, expected) => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { id: "admin-1", role }, error: null });
    const query = { eq: vi.fn(), maybeSingle };
    query.eq.mockReturnValue(query);
    const select = vi.fn(() => query);
    const client = {
      from: vi.fn(() => ({ select })),
    };

    await expect(
      createSupabaseAdminPlatformPort(client as never).checkAdminMagicLinkEligibility("admin@example.com"),
    ).resolves.toBe(expected);
    expect(client.from).toHaveBeenCalledWith("admin_users");
    expect(select).toHaveBeenCalledWith("id, role");
    expect(query.eq).toHaveBeenCalledWith("email", "admin@example.com");
    expect(query.eq).toHaveBeenCalledWith("membership_state", "active");
  });

  it("returns not_allowlisted for missing admin magic-link rows", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const query = { eq: vi.fn(), maybeSingle };
    query.eq.mockReturnValue(query);
    const client = {
      from: vi.fn(() => ({
        select: vi.fn(() => query),
      })),
    };

    await expect(
      createSupabaseAdminPlatformPort(client as never).checkAdminMagicLinkEligibility("missing@example.com"),
    ).resolves.toBe("not_allowlisted");
    expect(query.eq).toHaveBeenCalledWith("membership_state", "active");
  });
});

describe("authenticateSupabasePlatformUser", () => {
  it("authenticates the bearer token through Supabase Auth", async () => {
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    const client = { auth: { getUser } };

    await expect(authenticateSupabasePlatformUser(client as never, "jwt")).resolves.toEqual({
      ok: true,
      userId: "user-1",
    });
    expect(getUser).toHaveBeenCalledWith("jwt");
  });

  it("fails closed without a bearer token", async () => {
    const client = { auth: { getUser: vi.fn() } };

    await expect(authenticateSupabasePlatformUser(client as never, null)).resolves.toEqual({
      ok: false,
      code: "UNAUTHORIZED",
      message: "Admin session required",
    });
  });
});
