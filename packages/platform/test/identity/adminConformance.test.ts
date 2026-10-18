import { describe, expect, it, vi } from "vitest";
import { authorizeAdminWithUser } from "../../src/identity/adminAuthorization.js";
import { createAdminUserInviteHandler, createAdminUserRemoveHandler } from "../../src/identity/adminUserHandlers.js";
import { runInviteAdminUserUseCase, type InviteAdminUserGateway } from "../../src/identity/inviteAdminUserUseCase.js";
import type { ManagedIdentityClient } from "../../src/identity/managedClient.js";
import { createAdminBffPreflight } from "../../src/identity/adminPreflight.js";

function client(row: { role: string | null; membership_state: string; is_machine_actor?: boolean } | null): ManagedIdentityClient {
  const predicates: Record<string, unknown> = {};
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn((key, value) => { predicates[key] = value; return query; }),
    maybeSingle: vi.fn(async () => ({ data: row && row.membership_state === predicates.membership_state ? { id: "caller", ...row } : null, error: null })),
  };
  return { auth: { getUser: vi.fn(async () => ({ data: { user: { id: "caller" } }, error: null })) }, from: vi.fn(() => query) } as unknown as ManagedIdentityClient;
}
function response() {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn(), getHeader: vi.fn() };
  res.status.mockReturnValue(res); res.json.mockReturnValue(res);
  return res;
}

describe("W2 real membership authorizer at invite/remove HTTP gates", () => {
  it.each([
    ["revoked admin", { role: "admin", membership_state: "revoked" }, "token", 403],
    ["distributor", { role: "distributor", membership_state: "active" }, "token", 403],
    ["valid-token non-member", null, "token", 403],
    ["anonymous", null, null, 401],
  ] as const)("refuses %s before either action", async (_label, row, token, status) => {
    const settingsPort = { inviteAdminUser: vi.fn(), removeAdminUser: vi.fn() };
    const authorizeAdmin = () => authorizeAdminWithUser(client(row), token, { allowedRoles: ["admin"] });
    for (const create of [createAdminUserInviteHandler, createAdminUserRemoveHandler]) {
      const res = response();
      await create({ settingsPort, authorizeAdmin })({ method: "POST", body: { email: "new@example.invalid", role: "admin", userId: "target" } } as never, res as never);
      expect(res.status).toHaveBeenCalledWith(status);
    }
    expect(settingsPort.inviteAdminUser).not.toHaveBeenCalled();
    expect(settingsPort.removeAdminUser).not.toHaveBeenCalled();
  });

  it("retains the invite use case's role-only caller check regardless of membership state", async () => {
    const gateway: InviteAdminUserGateway = {
      getUser: vi.fn(async () => ({ user: { id: "caller" }, error: null })),
      findAdminUser: vi.fn(async () => ({ id: "caller", role: "admin", membership_state: "revoked" })),
      findAdminUserByEmail: vi.fn(async () => null), findAuthUserByEmail: vi.fn(async () => null),
      inviteAuthUser: vi.fn(async () => ({ user: { id: "target" }, error: null })),
      insertAdminUser: vi.fn(async () => ({ error: null })),
    };
    const result = await runInviteAdminUserUseCase({ accessToken: "token", email: "new@example.invalid", role: "admin" }, {
      gateway, roleNotificationPort: { sendRoleGranted: vi.fn() }, siteUrl: "https://app.example.invalid",
    });
    expect(result.status).toBe(200);
    expect(gateway.inviteAuthUser).toHaveBeenCalled();
  });
});

describe("W3 current role fallback", () => {
  it.each([null, "unknown-role"])("authorizes %s as admin today", async (role) => {
    await expect(authorizeAdminWithUser(client({ role, membership_state: "active", is_machine_actor: false }), "token", { allowedRoles: ["admin"] })).resolves.toEqual({ ok: true, userId: "caller", role: "admin", isMachineActor: false });
  });
});

describe("managed machine write fence", () => {
  it.each([
    ["node-supabase", "POST", "/api/bff/admin/action", false],
    ["node-supabase", undefined, "/api/bff/admin/action", false],
    ["node-supabase", "GET", "/api/bff/admin/action", true],
    ["node-supabase", "HEAD", "/api/bff/admin/action", true],
    ["node-supabase", "POST", "/api/bff/admin/proposal", true],
    ["node-postgres", "POST", "/api/bff/admin/action", true],
  ] as const)("%s %s %s -> %s", async (identity, method, route, allowed) => {
    const res = response();
    const preflight = createAdminBffPreflight({
      allowedRoles: () => ["admin"], machineWriteRoutes: ["/api/bff/admin/proposal"],
      resolveBinding: () => ({ binding: { identity, run: (_token, work) => work({ authorize: async () => ({ ok: true, principalId: "machine", role: "admin", isMachineActor: true }) }) } }),
    });
    expect(await preflight({ method, headers: { authorization: "Bearer token" } } as never, res as never, route)).toBe(allowed);
    if (!allowed) expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: "FORBIDDEN", details: { reason: "machine_actor_write_refused" } }) }));
  });
});
