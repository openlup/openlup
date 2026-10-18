import { identityMessages, type IdentityMessages } from "./messages.js";
export type AdminUserInviteRole = "admin" | "distributor";
export const ADMIN_ROLE_NOTIFICATION_LOCALE = "en" as const;
export type AdminRoleNotificationSkipReason = "admin_disabled" | "egress_suppressed";

export type InviteAdminUserResponse = {
  [key: string]: unknown;
  success?: boolean;
  message?: string;
  error?: string;
  code?: string;
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
  findAuthUserByEmail: (email: string) => Promise<{ id: string; email?: string | null } | null>;
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
    locale: "pl" | "en";
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
    messages?: IdentityMessages;
    notificationLocale?: "pl" | "en";
  },
): Promise<{ status: number; body: InviteAdminUserResponse }> {
  const messages = deps.messages ?? identityMessages.en;
  try {
    if (!request.accessToken) {
      return { status: 401, body: { code: "UNAUTHORIZED", error: messages.unauthorized } };
    }

    const { user, error: authError } = await deps.gateway.getUser(request.accessToken);
    if (authError || !user) {
      return { status: 401, body: { code: "INVALID_TOKEN", error: messages.invalidToken } };
    }

    const callerAdmin = await deps.gateway.findAdminUser(user.id);
    if (!callerAdmin || callerAdmin.role !== "admin") {
      return { status: 403, body: { code: "INVITE_FORBIDDEN", error: messages.inviteForbidden } };
    }

    if (!request.email) {
      return { status: 400, body: { code: "EMAIL_REQUIRED", error: messages.emailRequired } };
    }

    if (!isInviteRole(request.role)) {
      return { status: 400, body: { code: "INVALID_ROLE", error: messages.invalidRole } };
    }
    const role = request.role;

    const existingAdmin = await deps.gateway.findAdminUserByEmail(request.email);
    if (existingAdmin) {
      return { status: 400, body: { code: "ALREADY_ADDED", error: messages.alreadyAdded } };
    }

    const existingAuthUser = await deps.gateway.findAuthUserByEmail(request.email.trim().toLowerCase());
    if (existingAuthUser) {
      const { error: insertError } = await deps.gateway.insertAdminUser({
        id: existingAuthUser.id,
        email: request.email,
        role,
      });
      if (insertError) {
        return { status: 500, body: { code: "ADMIN_INSERT_FAILED", error: messages.addFailed(insertError.message) } };
      }

      const notification = await deps.roleNotificationPort.sendRoleGranted({
        email: request.email,
        authUserId: existingAuthUser.id,
        role,
        locale: deps.notificationLocale ?? ADMIN_ROLE_NOTIFICATION_LOCALE,
      });
      if (!notification.ok) {
        return {
          status: 502,
          body: {
            code: "ROLE_NOTIFICATION_FAILED", error: messages.notificationFailed(notification.providerError ?? "unknown_error"),
          },
        };
      }

      return {
        status: 200,
        body: {
          success: true,
          message: notification.skipReason === "admin_disabled"
            ? messages.roleAddedDisabled(request.email, role)
            : notification.skipReason === "egress_suppressed"
              ? messages.roleAddedSuppressed(request.email, role)
              : messages.roleAdded(request.email, role),
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
      return { status: 500, body: { code: "INVITATION_FAILED", error: messages.inviteFailed(invite.error.message) } };
    }

    const { error: insertError } = await deps.gateway.insertAdminUser({
      id: invite.user!.id,
      email: request.email,
      role,
    });
    if (insertError) {
      return {
        status: 500,
        body: { code: "ROLE_INSERT_FAILED", error: messages.roleInsertFailed(insertError.message) },
      };
    }

    return {
      status: 200,
      body: { success: true, message: messages.invited(request.email, role) },
    };
  } catch (err) {
    return { status: 500, body: { code: "IDENTITY_ACTION_FAILED", error: String(err) } };
  }
}

function isInviteRole(value: string): value is AdminUserInviteRole {
  return value === "admin" || value === "distributor";
}
