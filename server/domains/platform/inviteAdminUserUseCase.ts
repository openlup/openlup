export type AdminUserInviteRole = "admin" | "distributor";
export const ADMIN_ROLE_NOTIFICATION_LOCALE = "pl" as const;
export type AdminRoleNotificationSkipReason = "admin_disabled" | "egress_suppressed";

export type InviteAdminUserResponse = {
  [key: string]: unknown;
  success?: boolean;
  message?: string;
  error?: string;
  deliveryReference?: string | null;
  deliveryReferencePresent?: boolean;
};

export interface InviteAdminUserGateway {
  getUser: (accessToken: string) => Promise<{
    user: { id: string } | null;
    error: unknown;
  }>;
  findAdminUser: (userId: string) => Promise<{ id: string; role: string } | null>;
  findAdminUserByEmail: (email: string) => Promise<{ id: string } | null>;
  listAuthUsers: () => Promise<Array<{ id: string; email?: string | null }>>;
  insertAdminUser: (input: {
    id: string;
    email: string;
    role: AdminUserInviteRole;
  }) => Promise<{ error: { message: string } | null }>;
  inviteAuthUser: (input: {
    email: string;
    redirectTo: string;
    role: AdminUserInviteRole;
  }) => Promise<{
    user: { id: string } | null;
    error: { message: string } | null;
  }>;
}

export interface AdminRoleNotificationPort {
  sendRoleGranted: (input: {
    email: string;
    authUserId: string;
    role: AdminUserInviteRole;
    locale: typeof ADMIN_ROLE_NOTIFICATION_LOCALE;
  }) => Promise<{
    ok: boolean;
    providerMessageId: string | null;
    providerError: string | null;
    skipped: boolean;
    skipReason: AdminRoleNotificationSkipReason | null;
  }>;
}

export async function runInviteAdminUserUseCase(
  request: { accessToken: string | null; email: string; role: string },
  deps: {
    gateway: InviteAdminUserGateway;
    roleNotificationPort: AdminRoleNotificationPort;
    siteUrl: string;
  },
): Promise<{ status: number; body: InviteAdminUserResponse }> {
  try {
    if (!request.accessToken) {
      return { status: 401, body: { error: "Unauthorized" } };
    }

    const { user, error: authError } = await deps.gateway.getUser(request.accessToken);
    if (authError || !user) {
      return { status: 401, body: { error: "Invalid token" } };
    }

    const callerAdmin = await deps.gateway.findAdminUser(user.id);
    if (!callerAdmin || callerAdmin.role !== "admin") {
      return { status: 403, body: { error: "Tylko admini mogą zapraszać użytkowników" } };
    }

    if (!request.email) {
      return { status: 400, body: { error: "Brak emaila" } };
    }

    if (!isInviteRole(request.role)) {
      return { status: 400, body: { error: "Nieprawidłowa rola" } };
    }
    const role = request.role;

    const existingAdmin = await deps.gateway.findAdminUserByEmail(request.email);
    if (existingAdmin) {
      return { status: 400, body: { error: "Ten użytkownik jest już dodany" } };
    }

    const existingAuthUser = (await deps.gateway.listAuthUsers())
      .find((authUser) => authUser.email === request.email);
    if (existingAuthUser) {
      const { error: insertError } = await deps.gateway.insertAdminUser({
        id: existingAuthUser.id,
        email: request.email,
        role,
      });
      if (insertError) {
        return { status: 500, body: { error: `Błąd dodawania: ${insertError.message}` } };
      }

      const notification = await deps.roleNotificationPort.sendRoleGranted({
        email: request.email,
        authUserId: existingAuthUser.id,
        role,
        locale: ADMIN_ROLE_NOTIFICATION_LOCALE,
      });
      if (!notification.ok) {
        return {
          status: 502,
          body: {
            error: `Rola dodana, ale nie udało się wysłać powiadomienia: ${notification.providerError ?? "unknown_error"}`,
          },
        };
      }

      return {
        status: 200,
        body: {
          success: true,
          message: notification.skipReason === "admin_disabled"
            ? `Użytkownik ${request.email} już miał konto — dodano rolę ${localizedRoleName(role)}, ale powiadomienie było wyłączone i nie zostało wysłane.`
            : notification.skipReason === "egress_suppressed"
              ? `Użytkownik ${request.email} już miał konto — dodano rolę ${localizedRoleName(role)}, ale wysłanie powiadomienia zostało zablokowane i nie zostało wysłane.`
              : `Użytkownik ${request.email} już miał konto — dodano rolę ${localizedRoleName(role)} i wysłano powiadomienie.`,
          deliveryReference: notification.skipped ? null : notification.providerMessageId,
          deliveryReferencePresent: !notification.skipped && Boolean(notification.providerMessageId),
        },
      };
    }

    const invite = await deps.gateway.inviteAuthUser({
      email: request.email,
      redirectTo: new URL("/admin/auth/callback", deps.siteUrl).toString(),
      role,
    });
    if (invite.error) {
      return { status: 500, body: { error: `Błąd zaproszenia: ${invite.error.message}` } };
    }

    const { error: insertError } = await deps.gateway.insertAdminUser({
      id: invite.user!.id,
      email: request.email,
      role,
    });
    if (insertError) {
      return {
        status: 500,
        body: { error: `Konto utworzone, ale błąd dodawania roli: ${insertError.message}` },
      };
    }

    return {
      status: 200,
      body: { success: true, message: `Zaproszenie z rolą ${localizedRoleName(role)} wysłane na ${request.email}` },
    };
  } catch (err) {
    return { status: 500, body: { error: String(err) } };
  }
}

function isInviteRole(value: string): value is AdminUserInviteRole {
  return value === "admin" || value === "distributor";
}

function localizedRoleName(role: AdminUserInviteRole): string {
  return role === "admin" ? "Admin" : "Dystrybutor";
}
