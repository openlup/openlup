import { describe, expect, it, vi } from "vitest";
import { createInviteAdminUserGateway } from "../../src/identity/managedAdminUserGateways.js";
import { runInviteAdminUserUseCase } from "../../src/identity/inviteAdminUserUseCase.js";
import { parseOperatorInvitationTtl } from "../../src/identity/operatorInvitationLifecycle.js";

const ADMIN = "d4000000-0000-4000-8000-000000000001";
const TARGET = "d4000000-0000-4000-8000-000000000002";
function fixture(options: { newIdentity?: boolean } = {}) {
  const users = new Map(options.newIdentity ? [] : [[TARGET, { id: TARGET, email: "member@example.com" }]]);
  const members = new Map<string, { id: string; role: string; membership_state: string; is_machine_actor: boolean }>([
    [ADMIN, { id: ADMIN, role: "admin", membership_state: "active", is_machine_actor: false }],
  ]);
  const deleteUser = vi.fn();
  const updateUserById = vi.fn();
  const insert = vi.fn(async (row: { id: string; role: string; membership_state: "active" }) => {
    if (members.has(row.id)) return { error: { code: "23505", message: "duplicate" } };
    members.set(row.id, { ...row, is_machine_actor: false });
    return { error: null };
  });
  const inviteUserByEmail = vi.fn(async () => {
    const user = { id: TARGET, email: "member@example.com" };
    users.set(TARGET, user);
    return { data: { user: user as typeof user | null }, error: null as { message: string } | null };
  });
  const client = {
    auth: {
      getUser: async () => ({ data: { user: { id: ADMIN } }, error: null }),
      admin: { listUsers: vi.fn(async () => ({ data: { users: [...users.values()] }, error: null })), inviteUserByEmail, deleteUser, updateUserById },
    },
    from: () => ({
      select: () => ({ eq: (column: string, value: string) => ({ maybeSingle: async () => ({ data: column === "id" ? members.get(value) ?? null : null, error: null }) }) }),
      insert,
    }),
  };
  const gateway = createInviteAdminUserGateway(() => client);
  const notification = { sendRoleGranted: vi.fn(async () => ({ ok: true, providerMessageId: "synthetic-receipt", providerError: null, skipped: false, skipReason: null })) };
  const command = (role = "admin") => runInviteAdminUserUseCase({ accessToken: "verified", email: " Member@Example.COM ", role }, {
    gateway, activateMembership: gateway.activateMembership, roleNotificationPort: notification, siteUrl: "https://example.invalid",
  });
  return { users, members, client, gateway, notification, command, insert, inviteUserByEmail, deleteUser, updateUserById };
}

describe("managed immediate membership invitations", () => {
  it("inserts active membership immediately using the database machine default, without metadata or expiry", async () => {
    const f = fixture();
    expect(await f.command()).toEqual({ status: 200, body: {
      success: true, principalId: TARGET, role: "admin", membershipState: "active", code: "MEMBERSHIP_CREATED",
      message: "Operator membership active", deliveryReference: "synthetic-receipt", deliveryReferencePresent: true,
    } });
    expect(f.insert).toHaveBeenCalledExactlyOnceWith({ id: TARGET, email: "member@example.com", role: "admin",
      membership_state: "active", membership_provenance: "invitation", membership_accepted_at: expect.any(String) });
    expect(f.members.get(TARGET)).toMatchObject({ membership_state: "active", is_machine_actor: false });
    expect(f.updateUserById).not.toHaveBeenCalled();
    expect(f.notification.sendRoleGranted).toHaveBeenCalledExactlyOnceWith({ email: "member@example.com", authUserId: TARGET, role: "admin", locale: "en" });
  });
  it("identical repeat returns existing membership without mutation or another notification", async () => {
    const f = fixture(); await f.command();
    const membership = structuredClone(f.members.get(TARGET));
    expect(await f.command()).toMatchObject({ status: 200, body: { code: "ALREADY_ACTIVE", principalId: TARGET, membershipState: "active", role: "admin" } });
    expect(f.members.get(TARGET)).toEqual(membership);
    expect(f.insert).toHaveBeenCalledTimes(1);
    expect(f.notification.sendRoleGranted).toHaveBeenCalledTimes(1);
  });
  it("concurrent identical invites converge on one active membership and one notification", async () => {
    const f = fixture({ newIdentity: true });
    const responses = await Promise.all([f.command(), f.command()]);
    expect(responses.map(r => r.status)).toEqual([200, 200]);
    expect(responses.map(r => r.body.code).sort()).toEqual(["ALREADY_ACTIVE", "MEMBERSHIP_CREATED"]);
    expect(responses.map(r => r.body.principalId)).toEqual([TARGET, TARGET]);
    expect(f.insert).toHaveBeenCalledTimes(2);
    expect(f.notification.sendRoleGranted).toHaveBeenCalledTimes(1);
    expect(f.deleteUser).not.toHaveBeenCalled();
  });
  it("concurrent provider duplicate loser sends no Auth mail and only the membership winner notifies", async () => {
    const f = fixture({ newIdentity: true });
    // Both directory snapshots precede provider creation. The provider's unique
    // email constraint rejects the loser before its invitation mail is sent.
    let snapshots = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    f.client.auth.admin.listUsers.mockImplementation(async () => {
      const users = [...f.users.values()];
      if (++snapshots <= 2) {
        if (snapshots === 2) release();
        await ready;
      }
      return { data: { users }, error: null };
    });
    const authMail = vi.fn();
    f.inviteUserByEmail.mockImplementation(async () => {
      if (f.users.has(TARGET)) return { data: { user: null }, error: { message: "already registered" } };
      const user = { id: TARGET, email: "member@example.com" };
      f.users.set(TARGET, user);
      authMail();
      return { data: { user }, error: null };
    });
    const responses = await Promise.all([f.command(), f.command()]);
    expect(responses.map((r) => r.body.code).sort()).toEqual(["ALREADY_ACTIVE", "MEMBERSHIP_CREATED"]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(responses.map((r) => r.body.principalId)).toEqual([TARGET, TARGET]);
    expect(f.inviteUserByEmail).toHaveBeenCalledTimes(2);
    const providerResults = await Promise.all(f.inviteUserByEmail.mock.results.map((r) => r.value));
    expect(providerResults.filter((r) => !r.error)).toHaveLength(1);
    expect(providerResults.filter((r) => r.error?.message === "already registered")).toHaveLength(1);
    expect(authMail).toHaveBeenCalledTimes(1);
    expect(f.notification.sendRoleGranted).toHaveBeenCalledTimes(1);
    expect(f.members.get(TARGET)).toMatchObject({ membership_state: "active" });
    expect(f.users.size).toBe(1);
  });
  it("revoked managed membership refuses reinvitation without restoring access", async () => {
    const f = fixture(); await f.command();
    f.members.get(TARGET)!.membership_state = "revoked";
    expect(await f.command()).toMatchObject({ status: 409, body: { code: "MANAGED_REINVITE_UNSUPPORTED" } });
    expect(f.members.get(TARGET)!.membership_state).toBe("revoked");
    expect(f.insert).toHaveBeenCalledTimes(1);
    expect(f.notification.sendRoleGranted).toHaveBeenCalledTimes(1);
  });
  it("role differences conflict without replacing an active membership", async () => {
    const f = fixture(); await f.command();
    expect(await f.command("distributor")).toMatchObject({ status: 409, body: { code: "INVITATION_ROLE_CONFLICT" } });
    expect(f.members.get(TARGET)!.role).toBe("admin");
    expect(f.notification.sendRoleGranted).toHaveBeenCalledTimes(1);
  });
  it("failed insertion retains newly provisioned identity and retry reuses it", async () => {
    const f = fixture({ newIdentity: true });
    f.insert.mockResolvedValueOnce({ error: { code: "42501", message: "insert denied" } });
    expect(await f.command()).toMatchObject({ status: 503 });
    expect(f.users.has(TARGET)).toBe(true);
    expect(f.deleteUser).not.toHaveBeenCalled();
    expect(f.notification.sendRoleGranted).not.toHaveBeenCalled();
    expect(await f.command()).toMatchObject({ status: 200, body: { principalId: TARGET, membershipState: "active" } });
    expect(f.inviteUserByEmail).toHaveBeenCalledTimes(1);
  });
  it("provider duplicate race recovers the existing durable principal", async () => {
    const f = fixture({ newIdentity: true });
    f.inviteUserByEmail.mockImplementationOnce(async () => {
      f.users.set(TARGET, { id: TARGET, email: "member@example.com" });
      return { data: { user: { id: TARGET } as { id: string; email: string } }, error: { message: "already registered" } };
    });
    expect(await f.command()).toMatchObject({ status: 200, body: { principalId: TARGET } });
    expect(f.client.auth.admin.listUsers).toHaveBeenCalledTimes(2);
    expect(f.deleteUser).not.toHaveBeenCalled();
  });
  it("notification failure retains active membership and retry sends no second notification", async () => {
    const f = fixture();
    f.notification.sendRoleGranted.mockRejectedValueOnce(new Error("transport unavailable"));
    expect(await f.command()).toMatchObject({ status: 503, body: { code: "INVITATION_NOTIFICATION_FAILED", membershipState: "active", principalId: TARGET, error: "Membership active; notification unavailable" } });
    expect(f.members.get(TARGET)!.membership_state).toBe("active");
    expect(f.deleteUser).not.toHaveBeenCalled();
    expect(await f.command()).toMatchObject({ status: 200, body: { code: "ALREADY_ACTIVE" } });
    expect(f.notification.sendRoleGranted).toHaveBeenCalledTimes(1);
  });
  it.each(["revoked", "machine", "unknown-machine", "distributor"])("refuses %s caller before directory or write effects", async kind => {
    const f = fixture();
    Object.assign(f.members.get(ADMIN)!, kind === "revoked" ? { membership_state: "revoked" } : kind === "distributor" ? { role: "distributor" } : { is_machine_actor: kind === "machine" ? true : null });
    expect(await f.command()).toMatchObject({ status: 403 });
    expect(f.client.auth.admin.listUsers).not.toHaveBeenCalled();
    expect(f.insert).not.toHaveBeenCalled();
  });
  it.each(["unknown-role", "machine"])("refuses %s target without mutation", async kind => {
    const f = fixture();
    f.members.set(TARGET, { id: TARGET, role: kind === "unknown-role" ? "owner" : "admin", membership_state: "active", is_machine_actor: kind === "machine" });
    expect(await f.command()).toMatchObject({ status: 409 });
    expect(f.insert).not.toHaveBeenCalled(); expect(f.notification.sendRoleGranted).not.toHaveBeenCalled();
  });
});

it("direct invitation TTL retains its default, bounds and malformed-setting refusal", () => {
  expect(parseOperatorInvitationTtl()).toBe(604800);
  for (const raw of ["60", "2592000"]) expect(parseOperatorInvitationTtl(raw)).toBe(Number(raw));
  for (const raw of ["", "59", "2592001", "60.5", "6e2", " 60", "NaN"]) expect(() => parseOperatorInvitationTtl(raw)).toThrow("operator_invitation_ttl_invalid");
});
