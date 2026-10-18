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
  gateway.findAdminUser = async () => ({ id: "caller", role: "admin", membership_state: "active", is_machine_actor: false });
  const issue = vi.fn(async (input) => { events.push("issue"); return { principalId: input.targetPrincipalId, invitationId: "d4000000-0000-4000-8000-000000000003", membershipState: "invited", role: input.role, code: "INVITATION_CREATED", invitedAt: "2026-10-18T12:00:00Z", expiresAt: "2026-10-25T12:00:00Z" }; });
  return { gateway, listUsers, inviteUserByEmail, query, events, issue };
}
function invite(f: ReturnType<typeof fixture>, email = "  New@Example.Invalid ") {
  return runInviteAdminUserUseCase({ accessToken: "token", email, role: "admin" }, {
    gateway: f.gateway, ttlSeconds: 60, invitationStore: { issue: f.issue } as never, siteUrl: "https://app.example.invalid", roleNotificationPort: { sendRoleGranted: async () => ({ ok: true, skipped: false, skipReason: null, providerMessageId: "receipt", providerError: null }) },
  });
}

describe("W4 bounded normalized invite lookup", () => {
  it("finds page 2 with a case/whitespace-different address and uses its stable identity for pending issuance", async () => {
    const f = fixture({ 1: { users: [{ id: "other", email: "other@example.invalid" }], nextPage: 2 }, 2: { users: [{ id: "existing", email: " NEW@example.invalid  " }] } });
    const result = await invite(f);
    expect(result.status).toBe(200);
    expect(f.listUsers.mock.calls).toEqual([[{ page: 1, perPage: 1000 }], [{ page: 2, perPage: 1000 }]]);
    expect(f.query.insert).not.toHaveBeenCalled();
    expect(f.issue).toHaveBeenCalledWith(expect.objectContaining({ targetPrincipalId: "existing", email: "new@example.invalid", role: "admin" }));
    expect(f.inviteUserByEmail).not.toHaveBeenCalled();
  });
  it("follows nextPage even after a short page before the new-invite branch", async () => {
    const f = fixture({ 1: { users: [], nextPage: 3 }, 3: { users: [] } });
    expect((await invite(f)).status).toBe(200);
    expect(f.events).toEqual(["page-1", "page-3", "invite", "issue"]);
    expect(f.inviteUserByEmail).toHaveBeenCalledWith("new@example.invalid", expect.objectContaining({ redirectTo: "https://app.example.invalid/admin/auth/callback" }));
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
    expect(await invite(f)).toMatchObject({ status: 503, body: { code: "IDENTITY_ACTION_FAILED", error: "Error: directory_unavailable" } });
    expect(f.inviteUserByEmail).not.toHaveBeenCalled();
  });
});
