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
      body: { message: "sent" },
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
    })).resolves.toEqual({ message: "sent" });

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

  it("returns 400 for a duplicate admin row before inspecting Auth", async () => {
    const fixture = inviteAdminClient({ duplicateAdmin: { id: "existing-1" } });
    const notification = roleNotification(undefined, fixture.events);

    await expect(runInvite(fixture, notification)).resolves.toEqual({
      status: 400,
      body: { error: "Ten użytkownik jest już dodany" },
    });
    expect(fixture.listUsers).not.toHaveBeenCalled();
    expect(notification.sendRoleGranted).not.toHaveBeenCalled();
  });

  it("inserts an existing Auth user role before sending the role-grant notification", async () => {
    const fixture = inviteAdminClient({ authUsers: [{ id: "auth-1", email: "jan@example.com" }] });
    const notification = roleNotification(undefined, fixture.events);

    await expect(runInvite(fixture, notification, { role: "distributor" })).resolves.toEqual({
      status: 200,
      body: {
        success: true,
        message: "Użytkownik jan@example.com już miał konto — dodano rolę Dystrybutor i wysłano powiadomienie.",
        deliveryReference: "role-mail-1",
        deliveryReferencePresent: true,
      },
    });
    expect(fixture.insertAdminUser).toHaveBeenCalledWith({
      id: "auth-1",
      email: "jan@example.com",
      role: "distributor",
    });
    expect(notification.sendRoleGranted).toHaveBeenCalledWith({
      authUserId: "auth-1",
      email: "jan@example.com",
      role: "distributor",
      locale: ADMIN_ROLE_NOTIFICATION_LOCALE,
    });
    expect(fixture.events).toEqual(["insert", "notify"]);
    expect(fixture.inviteAuthUser).not.toHaveBeenCalled();
  });

  it("prevents notification when existing-user role insertion fails", async () => {
    const fixture = inviteAdminClient({
      authUsers: [{ id: "auth-1", email: "jan@example.com" }],
      insertError: { message: "insert failed" },
    });
    const notification = roleNotification();

    await expect(runInvite(fixture, notification)).resolves.toEqual({
      status: 500,
      body: { error: "Błąd dodawania: insert failed" },
    });
    expect(notification.sendRoleGranted).not.toHaveBeenCalled();
    expect(fixture.inviteAuthUser).not.toHaveBeenCalled();
  });

  it("returns the exact 502 after an existing-user role insert when the provider rejects notification", async () => {
    const fixture = inviteAdminClient({ authUsers: [{ id: "auth-1", email: "jan@example.com" }] });
    const notification = roleNotification({
      ok: false,
      providerMessageId: null,
      providerError: "provider rejected",
      skipped: false,
      skipReason: null,
    }, fixture.events);

    await expect(runInvite(fixture, notification)).resolves.toEqual({
      status: 502,
      body: { error: "Rola dodana, ale nie udało się wysłać powiadomienia: provider rejected" },
    });
    expect(fixture.events).toEqual(["insert", "notify"]);
  });

  it("reports an operator-disabled existing-user notification truthfully without claiming a receipt", async () => {
    const fixture = inviteAdminClient({ authUsers: [{ id: "auth-1", email: "jan@example.com" }] });
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
        success: true,
        message: "Użytkownik jan@example.com już miał konto — dodano rolę Dystrybutor, ale powiadomienie było wyłączone i nie zostało wysłane.",
        deliveryReference: null,
        deliveryReferencePresent: false,
      },
    });
    expect(fixture.events).toEqual(["insert", "notify"]);
  });

  it("reports an egress-suppressed existing-user notification without claiming it was sent", async () => {
    const fixture = inviteAdminClient({ authUsers: [{ id: "auth-1", email: "jan@example.com" }] });
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
        success: true,
        message: "Użytkownik jan@example.com już miał konto — dodano rolę Admin, ale wysłanie powiadomienia zostało zablokowane i nie zostało wysłane.",
        deliveryReference: null,
        deliveryReferencePresent: false,
      },
    });
    expect(fixture.events).toEqual(["insert", "notify"]);
  });

  it("does not persist a role when the new Auth invite provider fails", async () => {
    const fixture = inviteAdminClient({ inviteError: { message: "invite failed" } });

    await expect(runInvite(fixture, roleNotification())).resolves.toEqual({
      status: 500,
      body: { error: "Błąd zaproszenia: invite failed" },
    });
    expect(fixture.insertAdminUser).not.toHaveBeenCalled();
    expect(fixture.events).toEqual(["invite"]);
  });

  it("returns the exact 500 when role persistence fails after a new Auth invite", async () => {
    const fixture = inviteAdminClient({ insertError: { message: "role insert failed" } });

    await expect(runInvite(fixture, roleNotification())).resolves.toEqual({
      status: 500,
      body: { error: "Konto utworzone, ale błąd dodawania roli: role insert failed" },
    });
    expect(fixture.events).toEqual(["invite", "insert"]);
  });

  it("invites a new Auth user before persisting the role and returns the unchanged success message", async () => {
    const fixture = inviteAdminClient();

    await expect(runInvite(fixture, roleNotification())).resolves.toEqual({
      status: 200,
      body: { success: true, message: "Zaproszenie z rolą Admin wysłane na jan@example.com" },
    });
    expect(fixture.inviteAuthUser).toHaveBeenCalledWith("jan@example.com", {
      redirectTo: "https://admin-preview.example.test/admin/auth/callback",
      data: { admin_invite_role: "admin" },
    });
    expect(fixture.events).toEqual(["invite", "insert"]);
  });

  it("fails closed for a hidden preview without an explicit non-production email origin before effects", async () => {
    const env = {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      HIDDEN_SANDBOX_PREVIEW_ENABLED: "true",
    };
    await expect(runInviteAdminUserHandler({
      accessToken: "admin-token",
      email: "jan@example.com",
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
    email: "jan@example.com",
    role: "admin",
    ...request,
  }, {
    gateway: createInviteAdminUserGateway(fixture.clientFactory),
    roleNotificationPort: notification,
    siteUrl: "https://admin-preview.example.test",
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
  insertError?: { message: string } | null;
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
    ? { id: "admin-1", role: "admin" }
    : options.callerAdmin;
  const duplicateAdmin = options.duplicateAdmin ?? null;
  const queryByColumn = vi.fn((column: string) => ({
    maybeSingle: vi.fn(async () => ({
      data: column === "id" ? callerAdmin : duplicateAdmin,
    })),
  }));
  const insertAdminUser = vi.fn(async () => {
    events.push("insert");
    return { error: options.insertError ?? null };
  });
  const listUsers = vi.fn(async () => ({ data: { users: options.authUsers ?? [] } }));
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
