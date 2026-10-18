import { expect, expectTypeOf, it, vi } from "vitest";
import { createAdminUserInvitePort } from "../../src/identity/adminUserActionPorts.js";
import type { IdentityAdminActionsPort } from "../../src/identity/adminUserHandlers.js";
import type { OperatorInviteResult } from "../../src/identity/contracts/operatorInvitations.js";
import { z } from "zod";
import { createAdminMagicLinkHandler } from "../../src/identity/adminMagicLinkHandler.js";
import { createAdminUserInviteHandler } from "../../src/identity/adminUserHandlers.js";
import { createAdminPlatformMeHandler } from "../../src/identity/adminMeHandler.js";
import { authorizeAdminWithUser } from "../../src/identity/adminAuthorization.js";
import { createSupabaseAdminAuth } from "../../src/identity/managedAdminAuthVerifier.js";
import { managedOperatorMagicLinkEligibility } from "../../src/identity/managedAdminUserGateways.js";

const invitation = { principalId: "d4000000-0000-4000-8000-000000000002", invitationId: "d4000000-0000-4000-8000-000000000003", role: "admin" as const, membershipState: "invited" as const, invitedAt: "2026-10-18T12:00:00.000Z", expiresAt: "2026-10-25T12:00:00.000Z", code: "INVITATION_CREATED" as const };
function response() {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn(), getHeader: vi.fn() };
  res.status.mockReturnValue(res); res.json.mockReturnValue(res); return res;
}
it("HTTP preserves lifecycle fields through action port and BFF schema", async () => {
  const port = createAdminUserInvitePort({ accessToken: "verified", runInviteAdminUser: async () => ({ status: 200, body: invitation }) });
  const res = response();
  await createAdminUserInviteHandler({ settingsPort: port, authorizeAdmin: async () => ({ ok: true }) })({ method: "POST", body: { email: "member@example.com", role: "admin" } } as never, res as never);
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: invitation }));
});
it.each(["MEMBERSHIP_ALREADY_ACTIVE", "INVITATION_ROLE_CONFLICT", "IDENTITY_CONFLICT", "MANAGED_REINVITE_UNSUPPORTED"])("HTTP 409 retains %s identity reason", async (code) => {
  const port = createAdminUserInvitePort({ accessToken: "verified", runInviteAdminUser: async () => ({ status: 409, body: { code, error: code } }) });
  const res = response();
  await createAdminUserInviteHandler({ settingsPort: port, authorizeAdmin: async () => ({ ok: true }) })({ method: "POST", body: { email: "member@example.com", role: "admin" } } as never, res as never);
  expect(res.status).toHaveBeenCalledWith(409);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: "CONFLICT", details: expect.objectContaining({ identityCode: code }) }) }));
});
it("public me activates only authenticated self, ignoring browser target and role", async () => {
  const order: string[] = [];
  const acceptOperatorInvitation = vi.fn(async () => { order.push("accept"); return { code: "ACTIVATED" as const, role: "admin" as const }; });
  const getAdminMe = vi.fn(async () => { order.push("read"); return { isAdmin: true, role: "admin" as const }; });
  const res = response();
  await createAdminPlatformMeHandler({ invitationStore: { acceptOperatorInvitation }, authenticateUser: async () => ({ ok: true, userId: invitation.principalId }), platformPort: { getAdminMe } })({ method: "GET", query: {}, body: { principalId: "other", role: "admin" } } as never, res as never);
  expect(order).toEqual(["accept", "read"]); expect(acceptOperatorInvitation).toHaveBeenCalledExactlyOnceWith(invitation.principalId);
});
it("public me refuses expired invitation before reading membership", async () => {
  const getAdminMe = vi.fn(); const res = response();
  await createAdminPlatformMeHandler({ invitationStore: { acceptOperatorInvitation: async () => ({ code: "INVITATION_EXPIRED" }) }, authenticateUser: async () => ({ ok: true, userId: invitation.principalId }), platformPort: { getAdminMe } })({ method: "GET", query: {} } as never, res as never);
  expect(getAdminMe).not.toHaveBeenCalled(); expect(res.status).toHaveBeenCalledWith(403);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ details: { identityCode: "INVITATION_EXPIRED" } }) }));
});
it("managed gate reads membership without activation and fails closed on missing membership", async () => {
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: null, error: null }) };
  const client = { auth: { getUser: async () => ({ data: { user: { id: invitation.principalId } }, error: null }) }, from: () => query };
  expect(await createSupabaseAdminAuth(client).authorize("verified-token")).toMatchObject({ ok: false, code: "FORBIDDEN" });
  expect(await authorizeAdminWithUser(client, null)).toMatchObject({ ok: false });
});
it("HTTP preserves immediate managed membership through action port and BFF schema", async () => {
  const membership = { principalId: invitation.principalId, role: "admin" as const, membershipState: "active" as const, code: "MEMBERSHIP_CREATED" as const };
  const port = createAdminUserInvitePort({ accessToken: "verified", runInviteAdminUser: async () => ({ status: 200, body: membership }) });
  const res = response();
  await createAdminUserInviteHandler({ settingsPort: port, authorizeAdmin: async () => ({ ok: true }) })({ method: "POST", body: { email: "member@example.com", role: "admin" } } as never, res as never);
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: membership }));
});

it("action port requires the complete lifecycle result", () => {
  expectTypeOf<Awaited<ReturnType<IdentityAdminActionsPort["inviteAdminUser"]>>>().toEqualTypeOf<OperatorInviteResult>();
});
it("missing managed membership keeps the anonymous magic-link envelope without directory lookup", async () => {
  const send = vi.fn(async () => ({ error: null }));
  const quota = vi.fn(async () => ({ allowed: true }));
  const pad = vi.fn(async () => {});
  const listUsers = vi.fn();
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: null, error: null }) };
  const client = { from: () => query, auth: { admin: { listUsers } } };
  const rateLimitClient = { rpc: vi.fn(async () => ({ data: null, error: null })) };
  const handler = createAdminMagicLinkHandler({
    requestSchema: z.object({ email: z.string().trim().toLowerCase() }),
    responseSchema: z.object({ accepted: z.literal(true) }),
    readEnvironment: () => ({ url: "https://auth.example.com", anonKey: "synthetic", serviceRoleKey: "synthetic" }),
    createRuntime: () => ({ authClient: { auth: { signInWithOtp: send } }, rateLimitClient,
      platformPort: { checkAdminMagicLinkEligibility: (email) => managedOperatorMagicLinkEligibility(client, email) } }),
    checkAttempt: quota, extractClientIp: () => "192.0.2.1", padResponseTime: pad,
    resolveOrigin: () => "https://example.com", callbackPath: "/auth/callback",
  });
  const envelopes: unknown[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = response();
    await handler({ method: "POST", headers: {}, body: { email: " MEMBER@Example.COM " } } as never, res as never);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledExactlyOnceWith({ ok: true, data: { accepted: true } });
    envelopes.push(res.json.mock.calls[0][0]);
  }
  expect(envelopes[0]).toEqual(envelopes[1]);
  expect(listUsers).not.toHaveBeenCalled();
  expect(quota).toHaveBeenCalledTimes(2);
  expect(quota).toHaveBeenNthCalledWith(2, { client: rateLimitClient, ip: "192.0.2.1", email: "member@example.com" });
  expect(pad).toHaveBeenCalledTimes(2); expect(pad).toHaveBeenCalledWith(expect.any(Number), 400);
  expect(send).not.toHaveBeenCalled();
});

it.each(["admin", "distributor"] as const)("HTTP preserves active %s membership when notification fails", async (role) => {
  const port = createAdminUserInvitePort({ accessToken: "verified", runInviteAdminUser: async () => ({
    status: 503, body: { code: "INVITATION_NOTIFICATION_FAILED", error: "Membership active; notification unavailable",
      principalId: invitation.principalId, membershipState: "active", role },
  }) });
  const res = response();
  await createAdminUserInviteHandler({ settingsPort: port, authorizeAdmin: async () => ({ ok: true }) })(
    { method: "POST", body: { email: "member@example.com", role } } as never, res as never);
  expect(res.status).toHaveBeenCalledWith(503);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({
    code: "UPSTREAM_UNAVAILABLE", message: "Membership active; notification unavailable",
    details: { identityCode: "INVITATION_NOTIFICATION_FAILED", principalId: invitation.principalId, membershipState: "active", role },
  }) }));
});
