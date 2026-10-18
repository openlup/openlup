import { describe, expect, it, vi } from "vitest";
import { createInviteAdminUserGateway, type InviteAdminUserClient } from "../../src/identity/managedAdminUserGateways.js";
import { runInviteAdminUserUseCase } from "../../src/identity/inviteAdminUserUseCase.js";

function fixture(pages: Record<number, { users: { id: string; email?: string | null }[]; nextPage?: number | null }>, error: unknown = null) {
  const events: string[] = [];
  const query = { select: vi.fn(() => query), eq: vi.fn(() => query), maybeSingle: vi.fn(async () => ({ data: null })), insert: vi.fn(async () => { events.push("insert"); return { error: null }; }) };
  const listUsers = vi.fn(async ({ page }: { page: number; perPage: number }) => { events.push(`page-${page}`); return { data: pages[page], error }; });
  const inviteUserByEmail = vi.fn(async () => { events.push("invite"); return { data: { user: { id: "new" } }, error: null }; });
  const client = { auth: { getUser: vi.fn(async () => ({ data: { user: { id: "caller" } }, error: null })), admin: { listUsers, inviteUserByEmail } }, from: () => query } as unknown as InviteAdminUserClient;
  const gateway = createInviteAdminUserGateway(() => client);
  gateway.findAdminUser = async () => ({ id: "caller", role: "admin" });
  return { gateway, listUsers, inviteUserByEmail, query, events };
}
function invite(gateway: ReturnType<typeof fixture>["gateway"], email = "  New@Example.Invalid ") {
  return runInviteAdminUserUseCase({ accessToken: "token", email, role: "admin" }, {
    gateway, siteUrl: "https://app.example.invalid", roleNotificationPort: { sendRoleGranted: async () => ({ ok: true, skipped: false, skipReason: null, providerMessageId: "receipt", providerError: null }) },
  });
}

describe("W4 bounded normalized invite lookup", () => {
  it("finds page 2 with a case/whitespace-different address and preserves request spelling for insertion", async () => {
    const f = fixture({ 1: { users: [{ id: "other", email: "other@example.invalid" }], nextPage: 2 }, 2: { users: [{ id: "existing", email: " NEW@example.invalid  " }] } });
    const result = await invite(f.gateway);
    expect(result.status).toBe(200);
    expect(f.listUsers.mock.calls).toEqual([[{ page: 1, perPage: 1000 }], [{ page: 2, perPage: 1000 }]]);
    expect(f.query.insert).toHaveBeenCalledWith({ id: "existing", email: "  New@Example.Invalid ", role: "admin" });
    expect(f.inviteUserByEmail).not.toHaveBeenCalled();
  });
  it("follows nextPage even after a short page before the new-invite branch", async () => {
    const f = fixture({ 1: { users: [], nextPage: 3 }, 3: { users: [] } });
    expect((await invite(f.gateway)).status).toBe(200);
    expect(f.events).toEqual(["page-1", "page-3", "invite", "insert"]);
    expect(f.inviteUserByEmail).toHaveBeenCalledWith("  New@Example.Invalid ", expect.objectContaining({ redirectTo: "https://app.example.invalid/admin/auth/callback" }));
  });
  it("refuses at the 5000-user cap rather than inviting", async () => {
    const pages = Object.fromEntries([1, 2, 3, 4, 5].map((page) => [page, { users: Array.from({ length: 1000 }, (_, index) => ({ id: `${page}-${index}`, email: "other@example.invalid" })), nextPage: page + 1 }]));
    const f = fixture(pages);
    await expect(f.gateway.findAuthUserByEmail("new@example.invalid")).rejects.toThrow("auth_user_lookup_cap_exceeded");
    expect(f.listUsers).toHaveBeenCalledTimes(5);
    expect(f.inviteUserByEmail).not.toHaveBeenCalled();
  });
  it("rethrows lookup errors and the use case reports failure without inviting", async () => {
    const failure = new Error("directory_unavailable");
    const f = fixture({}, failure);
    await expect(f.gateway.findAuthUserByEmail("new@example.invalid")).rejects.toBe(failure);
    expect(await invite(f.gateway)).toMatchObject({ status: 500, body: { code: "IDENTITY_ACTION_FAILED", error: "Error: directory_unavailable" } });
    expect(f.inviteUserByEmail).not.toHaveBeenCalled();
  });
});
