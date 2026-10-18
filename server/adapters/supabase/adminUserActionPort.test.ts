import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  createSupabaseAdminUserInvitePort as createInvitePort,
  createSupabaseAdminUserRemovePort as createRemovePort,
  createInviteAdminUserGateway,
  createRemoveAdminUserGateway,
  DEFAULT_ADMIN_ROLE_FROM_EMAIL,
  resolveInviteAdminEmailOrigin,
  resolveInviteAdminFromEmail,
  runInviteAdminUserHandler,
  runRemoveAdminUserHandler,
  toInviteAdminWireResult,
} from "./adminUserActionPort.js";
import {
  ADMIN_ROLE_NOTIFICATION_LOCALE,
  runInviteAdminUserUseCase,
  type AdminRoleNotificationPort,
} from "../../domains/platform/inviteAdminUserUseCase.js";
import { runRemoveAdminUserUseCase } from "../../domains/platform/removeAdminUserUseCase.js";
import { APP_SITE_ORIGIN } from "../../../src/lib/brand/appBrand.js";
import { APPLICATION_ENVIRONMENT_KEY } from "../../_lib/observability/environment.js";

describe("admin user action adapter", () => {
  it("maps invite and remove requests through injected local runners", async () => {
    const runInviteAdminUser = vi.fn().mockResolvedValue({
      status: 200,
      body: pendingInvite(),
    });
    const runRemoveAdminUser = vi.fn().mockResolvedValue({
      status: 200,
      body: { revoked: true },
    });

    await expect(createInvitePort({
      accessToken: "admin-token",
      runInviteAdminUser,
    }).inviteAdminUser({
      email: "admin@example.com",
      role: "admin",
    })).resolves.toEqual(pendingInvite());

    await expect(createRemovePort({
      accessToken: "admin-token",
      runRemoveAdminUser,
    }).removeAdminUser({
      userId: "user-1",
    })).resolves.toEqual({ revoked: true });

    expect(runInviteAdminUser).toHaveBeenCalledWith({
      accessToken: "admin-token",
      email: "admin@example.com",
      role: "admin",
    }, undefined);
    expect(runRemoveAdminUser).toHaveBeenCalledWith({
      accessToken: "admin-token",
      userId: "user-1",
    }, undefined);
  });

  it("keeps the hosted invite receipt keys at the managed adapter boundary", () => {
    expect(toInviteAdminWireResult({
      status: 200,
      body: { deliveryReference: "role-mail-1", deliveryReferencePresent: true },
    })).toEqual({
      status: 200,
      body: { resendId: "role-mail-1", resendIdPresent: true },
    });
  });

  it("surfaces local handler errors without claiming success", async () => {
    await expect(createInvitePort({
      accessToken: "admin-token",
      runInviteAdminUser: vi.fn().mockResolvedValue({
        status: 200,
        body: { error: "Ten użytkownik jest już dodany" },
      }),
    }).inviteAdminUser({
      email: "admin@example.com",
      role: "admin",
    })).rejects.toThrow("Ten użytkownik jest już dodany");

    await expect(createRemovePort({
      accessToken: "admin-token",
      runRemoveAdminUser: vi.fn().mockResolvedValue({
        status: 403,
        body: { error: "Tylko administratorzy mogą odbierać dostęp użytkownikom" },
      }),
    }).removeAdminUser({
      userId: "user-1",
    })).rejects.toThrow("Tylko administratorzy mogą odbierać dostęp użytkownikom");
  });

  it("fails closed before loading handlers when the required client environment is missing", async () => {
    await expect(runInviteAdminUserHandler({
      accessToken: "admin-token",
      email: "admin@example.com",
      role: "admin",
    }, {})).resolves.toEqual({
      status: 500,
      body: { error: "supabase_service_role_not_configured" },
    });

    await expect(runRemoveAdminUserHandler({
      accessToken: "admin-token",
      userId: "user-1",
    }, { SUPABASE_URL: "https://example.supabase.co" })).resolves.toEqual({
      status: 500,
      body: { error: "supabase_user_auth_not_configured" },
    });
  });

  it("keeps the Node remove-admin execution independent of the Edge handler", async () => {
    const source = await readFile(new URL("./adminUserActionPort.ts", import.meta.url), "utf8");

    expect(source).toContain("runRemoveAdminUserUseCase");
    expect(source).not.toContain("remove-admin-user/handler.ts");
    expect(source).not.toContain("deleteUser");
    expect(source).not.toContain("deleteAdminUser");
  });

  it("returns 401 for missing and invalid authentication without revoking anything", async () => {
    const missingAuth = removeAdminClient();
    await expect(runRemoveAdminUserUseCase({
      accessToken: null,
      userId: "user-2",
    }, createRemoveAdminUserGateway(missingAuth.clientFactory))).resolves.toEqual({
      status: 401,
      body: { error: "Unauthorized" },
    });
    expect(missingAuth.clientFactory).not.toHaveBeenCalled();
    expect(missingAuth.getUser).not.toHaveBeenCalled();
    expect(missingAuth.revokeAdminUser).not.toHaveBeenCalled();

    const invalidAuth = removeAdminClient({ authError: { message: "expired" } });
    await expect(runRemoveAdminUserUseCase({
      accessToken: "invalid-token",
      userId: "user-2",
    }, createRemoveAdminUserGateway(invalidAuth.clientFactory))).resolves.toEqual({
      status: 401,
      body: { error: "Invalid token" },
    });
    expect(invalidAuth.getUser).toHaveBeenCalledWith("invalid-token");
    expect(invalidAuth.revokeAdminUser).not.toHaveBeenCalled();

    const missingUser = removeAdminClient({ authenticatedUser: null });
    await expect(runRemoveAdminUserUseCase({
      accessToken: "invalid-token",
      userId: "user-2",
    }, createRemoveAdminUserGateway(missingUser.clientFactory))).resolves.toEqual({
      status: 401,
      body: { error: "Invalid token" },
    });
  });

  it("returns 403 when the authenticated caller is not an admin", async () => {
    const fixture = removeAdminClient({
      callerAdmin: { id: "admin-1", role: "distributor" },
    });

    await expect(runRemoveAdminUserUseCase({
      accessToken: "admin-token",
      userId: "user-2",
    }, createRemoveAdminUserGateway(fixture.clientFactory))).resolves.toEqual({
      status: 403,
      body: { error: "Tylko administratorzy mogą odbierać dostęp użytkownikom" },
    });
    expect(fixture.revokeAdminUser).not.toHaveBeenCalled();
  });

  it("returns a refusal for a missing target and self-revoke", async () => {
    const missingTarget = removeAdminClient();
    await expect(runRemoveAdminUserUseCase({
      accessToken: "admin-token",
      userId: "",
    }, createRemoveAdminUserGateway(missingTarget.clientFactory))).resolves.toEqual({
      status: 400,
      body: { error: "Brak ID użytkownika" },
    });

    const selfRemoval = removeAdminClient();
    await expect(runRemoveAdminUserUseCase({
      accessToken: "admin-token",
      userId: "admin-1",
    }, createRemoveAdminUserGateway(selfRemoval.clientFactory))).resolves.toEqual({
      status: 403,
      body: { error: "Nie możesz odebrać sobie dostępu" },
    });
    expect(missingTarget.revokeAdminUser).not.toHaveBeenCalled();
    expect(selfRemoval.revokeAdminUser).not.toHaveBeenCalled();
  });

  it("maps the atomic last-active-human guard without revoking identity", async () => {
    const fixture = removeAdminClient({ revokeError: { message: "last_active_human_admin" } });

    await expect(runRemoveAdminUserUseCase({
      accessToken: "admin-token",
      userId: "user-2",
    }, createRemoveAdminUserGateway(fixture.clientFactory))).resolves.toEqual({
      status: 409,
      body: { error: "At least one active human admin must remain." },
    });
    expect(fixture.revokeAdminUser).toHaveBeenCalledWith("admin_revoke_admin_user", {
      p_target: "user-2",
      p_reason: null,
    });
  });

  it("returns a truthful revoked response from the single RPC", async () => {
    const fixture = removeAdminClient();

    await expect(runRemoveAdminUserUseCase({
      accessToken: "admin-token",
      userId: "user-2",
    }, createRemoveAdminUserGateway(fixture.clientFactory))).resolves.toEqual({
      status: 200,
      body: { revoked: true },
    });
    expect(fixture.getUser).toHaveBeenCalledWith("admin-token");
    expect(fixture.revokeAdminUser).toHaveBeenCalledWith("admin_revoke_admin_user", {
      p_target: "user-2",
      p_reason: null,
    });
  });

  it("preserves the Edge-compatible 500 mapping for unexpected gateway failures", async () => {
    const fixture = removeAdminClient({ getUserError: new Error("upstream failed") });

    await expect(runRemoveAdminUserUseCase({
      accessToken: "admin-token",
      userId: "user-2",
    }, createRemoveAdminUserGateway(fixture.clientFactory))).resolves.toEqual({
      status: 500,
      body: { error: "Error: upstream failed" },
    });
    expect(fixture.revokeAdminUser).not.toHaveBeenCalled();
  });
});

describe("Node invite-admin use case", () => {
  it("does not dynamically import the Edge handler and composes the canonical Node mail rail", async () => {
    const source = await readFile(new URL("./adminUserActionPort.ts", import.meta.url), "utf8");

    expect(source).toContain("runInviteAdminUserUseCase");
    expect(source).toContain("env.FROM_EMAIL");
    expect(source).toContain("createEmailTransport");
    expect(source).toContain('createEmailTransport({ apiKey: env.RESEND_API_KEY ?? "", env })');
    expect(source).toContain("resolveInviteAdminEmailOrigin");
    expect(source).not.toContain("invite-admin-user/handler.ts");
  });

  it("returns 401 for missing or invalid authentication before constructing the service client", async () => {
    const missingAuth = inviteAdminClient();
    await expect(runInvite(missingAuth, roleNotification(), { accessToken: null })).resolves.toEqual({
      status: 401,
      body: { error: "Unauthorized" },
    });
    expect(missingAuth.clientFactory).not.toHaveBeenCalled();

    const invalidAuth = inviteAdminClient({ authError: { message: "expired" } });
    await expect(runInvite(invalidAuth, roleNotification(), { accessToken: "invalid-token" })).resolves.toEqual({
      status: 401,
      body: { error: "Invalid token" },
    });
    expect(invalidAuth.getUser).toHaveBeenCalledWith("invalid-token");

    const missingUser = inviteAdminClient({ authenticatedUser: null });
    await expect(runInvite(missingUser, roleNotification(), { accessToken: "invalid-token" })).resolves.toEqual({
      status: 401,
      body: { error: "Invalid token" },
    });
  });

  it("rejects non-admin callers and invalid invite payloads", async () => {
    const forbidden = inviteAdminClient({ callerAdmin: { id: "admin-1", role: "distributor" } });
    await expect(runInvite(forbidden, roleNotification())).resolves.toEqual({
      status: 403,
      body: { error: "Tylko admini mogą zapraszać użytkowników" },
    });

    const missingEmail = inviteAdminClient();
    await expect(runInvite(missingEmail, roleNotification(), { email: "" })).resolves.toEqual({
      status: 400,
      body: { error: "Brak emaila" },
    });

    const invalidRole = inviteAdminClient();
    await expect(runInvite(invalidRole, roleNotification(), { role: "owner" })).resolves.toEqual({
      status: 400,
      body: { error: "Nieprawidłowa rola" },
    });
  });

  it("returns existing active membership after resolving Auth without notification", async () => {
    const fixture = inviteAdminClient({ duplicateAdmin: { id: "auth-1" }, authUsers: [{ id: "auth-1", email: "invitee@example.com" }] });
    const notification = roleNotification(undefined, fixture.events);

    await expect(runInvite(fixture, notification)).resolves.toEqual({
      status: 200,
      body: { ...activeInvite("auth-1", "admin"), success: true },
    });
    expect(fixture.listUsers).toHaveBeenCalledOnce();
    expect(notification.sendRoleGranted).not.toHaveBeenCalled();
  });

  it("activates an existing Auth user before notifying", async () => {
    const fixture = inviteAdminClient({ authUsers: [{ id: "auth-1", email: "invitee@example.com" }] });
    const notification = roleNotification(undefined, fixture.events);

    await expect(runInvite(fixture, notification, { role: "distributor" })).resolves.toEqual({
      status: 200,
      body: {
        ...activeInvite("auth-1", "distributor"),
        success: true,
        deliveryReference: "role-mail-1",
        deliveryReferencePresent: true,
      },
    });
    expect(fixture.insertAdminUser).toHaveBeenCalledWith(expect.objectContaining({
      id: "auth-1", email: "invitee@example.com", role: "distributor", membership_state: "active",
    }));
    expect(notification.sendRoleGranted).toHaveBeenCalledWith({
      authUserId: "auth-1",
      email: "invitee@example.com",
      role: "distributor",
      locale: ADMIN_ROLE_NOTIFICATION_LOCALE,
    });
    expect(fixture.events).toEqual(["insert", "notify"]);
    expect(fixture.inviteAuthUser).not.toHaveBeenCalled();
  });

  it("prevents notification when existing-user invitation persistence fails", async () => {
    const fixture = inviteAdminClient({
      authUsers: [{ id: "auth-1", email: "invitee@example.com" }],
      invitationError: { message: "insert failed" },
    });
    const notification = roleNotification();

    await expect(runInvite(fixture, notification)).resolves.toEqual({
      status: 503,
      body: { error: "Error: insert failed" },
    });
    expect(notification.sendRoleGranted).not.toHaveBeenCalled();
    expect(fixture.inviteAuthUser).not.toHaveBeenCalled();
  });

  it("returns 503 with the persisted invitation when notification fails", async () => {
    const fixture = inviteAdminClient({ authUsers: [{ id: "auth-1", email: "invitee@example.com" }] });
    const notification = roleNotification({
      ok: false,
      providerMessageId: null,
      providerError: "provider rejected",
      skipped: false,
      skipReason: null,
    }, fixture.events);

    await expect(runInvite(fixture, notification)).resolves.toEqual({
      status: 503,
      body: { principalId: "auth-1", membershipState: "active", role: "admin", error: "Membership active; notification unavailable" },
    });
    expect(fixture.events).toEqual(["insert", "notify"]);
  });

  it("reports an operator-disabled existing-user notification truthfully without claiming a receipt", async () => {
    const fixture = inviteAdminClient({ authUsers: [{ id: "auth-1", email: "invitee@example.com" }] });
    const notification = roleNotification({
      ok: true,
      providerMessageId: null,
      providerError: null,
      skipped: true,
      skipReason: "admin_disabled",
    }, fixture.events);

    await expect(runInvite(fixture, notification, { role: "distributor" })).resolves.toEqual({
      status: 200,
      body: {
        ...activeInvite("auth-1", "distributor"),
        success: true,
        deliveryReference: null,
        deliveryReferencePresent: false,
      },
    });
    expect(fixture.events).toEqual(["insert", "notify"]);
  });

  it("reports an egress-suppressed existing-user notification without claiming it was sent", async () => {
    const fixture = inviteAdminClient({ authUsers: [{ id: "auth-1", email: "invitee@example.com" }] });
    const notification = roleNotification({
      ok: true,
      providerMessageId: null,
      providerError: null,
      skipped: true,
      skipReason: "egress_suppressed",
    }, fixture.events);

    await expect(runInvite(fixture, notification)).resolves.toEqual({
      status: 200,
      body: {
        ...activeInvite("auth-1", "admin"),
        success: true,
        deliveryReference: null,
        deliveryReferencePresent: false,
      },
    });
    expect(fixture.events).toEqual(["insert", "notify"]);
  });

  it("does not persist an invitation when the new Auth invite provider fails", async () => {
    const fixture = inviteAdminClient({ inviteError: { message: "invite failed" } });

    await expect(runInvite(fixture, roleNotification())).resolves.toEqual({
      status: 503,
      body: { error: "Error: operator_identity_creation_failed" },
    });
    expect(fixture.events).toEqual(["invite"]);
  });

  it("returns 503 when invitation persistence fails after a new Auth invite", async () => {
    const fixture = inviteAdminClient({ invitationError: { message: "role insert failed" } });

    await expect(runInvite(fixture, roleNotification())).resolves.toEqual({
      status: 503,
      body: { error: "Error: role insert failed" },
    });
    expect(fixture.events).toEqual(["invite", "insert"]);
  });

  it("invites a new Auth user before activating membership and notifying", async () => {
    const fixture = inviteAdminClient();

    await expect(runInvite(fixture, roleNotification(undefined, fixture.events))).resolves.toEqual({
      status: 200,
      body: { ...activeInvite("new-auth-1", "admin"), success: true, deliveryReference: "role-mail-1", deliveryReferencePresent: true },
    });
    expect(fixture.inviteAuthUser).toHaveBeenCalledWith("invitee@example.com", {
      redirectTo: "https://admin-preview.example.test/admin/auth/callback",
    });
    expect(fixture.events).toEqual(["invite", "insert", "notify"]);
  });

  it("fails closed for a hidden preview without an explicit non-production email origin before effects", async () => {
    const env = {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      HIDDEN_SANDBOX_PREVIEW_ENABLED: "true",
    };
    await expect(runInviteAdminUserHandler({
      accessToken: "admin-token",
      email: "invitee@example.com",
      role: "admin",
    }, env)).rejects.toThrow("invite-admin-user email origin policy failed: hidden_preview_origin_required");
    expect(resolveInviteAdminEmailOrigin(env)).toEqual({
      ok: false,
      error: "hidden_preview_origin_required",
    });
  });

  it("rejects a production origin for a hidden-preview invite", () => {
    expect(resolveInviteAdminEmailOrigin({
      HIDDEN_SANDBOX_PREVIEW_ENABLED: "true",
      APP_BASE_URL: APP_SITE_ORIGIN,
    })).toEqual({
      ok: false,
      error: "hidden_preview_origin_must_not_be_production",
    });
  });

  it("uses a configurable default email origin and the hosted sender fallback exactly", () => {
    expect(resolveInviteAdminEmailOrigin({
      EMAIL_DEFAULT_ORIGIN: "https://tenant.example.test",
      EMAIL_PRODUCTION_ORIGIN_HOSTS: "tenant.example.test",
    })).toMatchObject({
      ok: true,
      origin: "https://tenant.example.test",
      source: "default",
      resolved: {
        environment: "production_or_default",
        production: true,
      },
    });
    expect(resolveInviteAdminFromEmail({ FROM_EMAIL: "" })).toBe(DEFAULT_ADMIN_ROLE_FROM_EMAIL);
    expect(resolveInviteAdminFromEmail({ FROM_EMAIL: "From <admin@example.test>" })).toBe("From <admin@example.test>");
  });

  it("uses the shared origin source order, preferring an application base URL", () => {
    expect(resolveInviteAdminEmailOrigin({
      [APPLICATION_ENVIRONMENT_KEY]: "staging",
      APP_BASE_URL: " https://app.example.test/path ",
      CUSTOMER_AUTH_REDIRECT_ORIGIN: "https://customer.example.test",
      SITE_URL: "https://site.example.test",
    })).toMatchObject({
      ok: true,
      origin: "https://app.example.test",
      source: "explicit",
      resolved: { environment: "staging", production: false },
    });
    expect(resolveInviteAdminEmailOrigin({
      CUSTOMER_AUTH_REDIRECT_ORIGIN: "https://customer.example.test",
      SITE_URL: "https://site.example.test",
    })).toMatchObject({ ok: true, origin: "https://customer.example.test", source: "explicit" });
  });
});

function removeAdminClient(options: {
  authError?: unknown;
  authenticatedUser?: { id: string } | null;
  callerAdmin?: { id: string; role: string } | null;
  revokeError?: { message: string } | null;
  getUserError?: Error;
} = {}) {
  const getUser = options.getUserError
    ? vi.fn().mockRejectedValue(options.getUserError)
    : vi.fn().mockResolvedValue({
      data: {
        user: options.authenticatedUser === undefined
          ? { id: "admin-1" }
          : options.authenticatedUser,
      },
      error: options.authError ?? null,
    });
  const findCallerAdmin = vi.fn().mockResolvedValue({
    data: options.callerAdmin === undefined
      ? { id: "admin-1", role: "admin" }
      : options.callerAdmin,
    error: null,
  });
  const query = { eq: vi.fn(), maybeSingle: findCallerAdmin };
  query.eq.mockReturnValue(query);
  const revokeAdminUser = vi.fn().mockResolvedValue({ error: options.revokeError ?? null });

  const client = {
    auth: {
      getUser,
    },
    from: vi.fn(() => ({
      select: vi.fn(() => query),
    })),
    rpc: revokeAdminUser,
  };

  return {
    client,
    clientFactory: vi.fn(() => client),
    getUser,
    findCallerAdmin,
    revokeAdminUser,
  };
}

function runInvite(
  fixture: ReturnType<typeof inviteAdminClient>,
  notification: ReturnType<typeof roleNotification>,
  request: Partial<{ accessToken: string | null; email: string; role: string }> = {},
) {
  return runInviteAdminUserUseCase({
    accessToken: "admin-token",
    email: "invitee@example.com",
    role: "admin",
    ...request,
  }, {
    gateway: createInviteAdminUserGateway(fixture.clientFactory),
    roleNotificationPort: notification,
    siteUrl: "https://admin-preview.example.test",
    activateMembership: createInviteAdminUserGateway(fixture.clientFactory).activateMembership,
  });
}

function roleNotification(
  result: Awaited<ReturnType<AdminRoleNotificationPort["sendRoleGranted"]>> = {
    ok: true,
    providerMessageId: "role-mail-1",
    providerError: null,
    skipped: false,
    skipReason: null,
  },
  events?: string[],
) {
  const sendRoleGranted = vi.fn(async () => {
    events?.push("notify");
    return result;
  });
  return { sendRoleGranted };
}

function inviteAdminClient(options: {
  authError?: unknown;
  authenticatedUser?: { id: string } | null;
  callerAdmin?: { id: string; role: string } | null;
  duplicateAdmin?: { id: string } | null;
  authUsers?: Array<{ id: string; email?: string | null }>;
  invitationError?: { message: string } | null;
  inviteError?: { message: string } | null;
} = {}) {
  const events: string[] = [];
  const getUser = vi.fn().mockResolvedValue({
    data: {
      user: options.authenticatedUser === undefined
        ? { id: "admin-1" }
        : options.authenticatedUser,
    },
    error: options.authError ?? null,
  });
  const callerAdmin = options.callerAdmin === undefined
    ? { id: "admin-1", role: "admin", membership_state: "active", is_machine_actor: false }
    : options.callerAdmin && { ...options.callerAdmin, membership_state: "active", is_machine_actor: false };
  const duplicateAdmin = options.duplicateAdmin ?? null;
  const memberships = new Map<string, { id: string; role: string; membership_state: string; is_machine_actor: boolean }>();
  if (callerAdmin) memberships.set(callerAdmin.id, callerAdmin);
  if (duplicateAdmin) memberships.set(duplicateAdmin.id, { ...duplicateAdmin, role: "admin", membership_state: "active", is_machine_actor: false });
  const queryByColumn = vi.fn((column: string, value: string) => ({
    maybeSingle: vi.fn(async () => ({ data: column === "id" ? memberships.get(value) ?? null : duplicateAdmin, error: null })),
  }));
  const insertAdminUser = vi.fn(async (row: { id: string; role: string; membership_state: string }) => {
    events.push("insert");
    if (options.invitationError) return { error: new Error(options.invitationError.message) };
    memberships.set(row.id, { ...row, is_machine_actor: false });
    return { error: null };
  });
  const listUsers = vi.fn(async () => ({ data: { users: options.authUsers ?? [] }, error: null }));
  const inviteAuthUser = vi.fn(async () => {
    events.push("invite");
    return {
      data: { user: { id: "new-auth-1" } },
      error: options.inviteError ?? null,
    };
  });
  const client = {
    auth: {
      getUser,
      admin: { listUsers, inviteUserByEmail: inviteAuthUser },
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: queryByColumn })),
      insert: insertAdminUser,
    })),
  };
  const clientFactory = vi.fn(() => client);
  return {
    clientFactory,
    events,
    getUser,
    listUsers,
    insertAdminUser,
    inviteAuthUser,
  };
}

const INVITATION_ID = "10000000-0000-4000-8000-000000000001";
const DEADLINE = "2030-01-01T00:01:00.000Z";
function pendingInvite(principalId = "auth-1", role: "admin" | "distributor" = "admin", withCode = true) {
  return { principalId, invitationId: INVITATION_ID, membershipState: "invited", role,
    invitedAt: "2030-01-01T00:00:00.000Z", expiresAt: DEADLINE,
    ...(withCode ? { code: "INVITATION_CREATED" } : {}), message: `Invitation pending until ${DEADLINE}` };
}

function activeInvite(principalId: string, role: "admin" | "distributor") {
  return { principalId, membershipState: "active", role, message: "Operator membership active" };
}
