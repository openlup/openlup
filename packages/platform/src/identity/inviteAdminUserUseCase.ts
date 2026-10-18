import type { ManagedOperatorMembershipResult, OperatorInvitationConflict } from "./contracts/operatorInvitations.js";
import type { OperatorInvitationStore } from "./operatorInvitationPorts.js";
import { assertOperatorInvitationTtl } from "./operatorInvitationLifecycle.js";
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
  findAdminUser: (userId: string) => Promise<{ id: string; role: string; membership_state: string; is_machine_actor: boolean } | null>;
  findAdminUserByEmail: (email: string) => Promise<{ id: string } | null>;
  findAuthUserByEmail: (email: string) => Promise<{ id: string; email?: string | null } | null>;
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
    invitationId?: string;
    expiresAt?: string;
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
  } & (
    | { invitationStore: OperatorInvitationStore; ttlSeconds: number }
    | { activateMembership: (input: { principalId: string; email: string; role: AdminUserInviteRole }) => Promise<ManagedOperatorMembershipResult | { code: OperatorInvitationConflict }> }
  ),
): Promise<{ status: number; body: InviteAdminUserResponse }> {
  const messages = deps.messages ?? identityMessages.en;
  try {
    if ("invitationStore" in deps) assertOperatorInvitationTtl(deps.ttlSeconds);
    if (!request.accessToken) {
      return { status: 401, body: { code: "UNAUTHORIZED", error: messages.unauthorized } };
    }

    const { user, error: authError } = await deps.gateway.getUser(request.accessToken);
    if (authError || !user) {
      return { status: 401, body: { code: "INVALID_TOKEN", error: messages.invalidToken } };
    }

    const callerAdmin = await deps.gateway.findAdminUser(user.id);
    if (!callerAdmin || callerAdmin.role !== "admin" || callerAdmin.membership_state !== "active" || callerAdmin.is_machine_actor !== false) {
      return { status: 403, body: { code: "INVITE_FORBIDDEN", error: messages.inviteForbidden } };
    }

    if (!request.email) {
      return { status: 400, body: { code: "EMAIL_REQUIRED", error: messages.emailRequired } };
    }

    if (!isInviteRole(request.role)) {
      return { status: 400, body: { code: "INVALID_ROLE", error: messages.invalidRole } };
    }
    const role = request.role;

    const email = request.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: 400, body: { code: "INVALID_EMAIL", error: "Invalid email" } };
    const existingMembership = await deps.gateway.findAdminUserByEmail(email);
    let principal = await deps.gateway.findAuthUserByEmail(email);
    if (existingMembership && existingMembership.id !== principal?.id) return { status: 409, body: { code: "IDENTITY_CONFLICT", error: "IDENTITY_CONFLICT" } };
    if (!principal) {
      const invite = await deps.gateway.inviteAuthUser({ email, role, redirectTo: new URL("/admin/auth/callback", deps.siteUrl).toString() });
      if (invite.error || !invite.user) {
        // A provider duplicate race reuses the durable identity. Never delete it.
        principal = await deps.gateway.findAuthUserByEmail(email);
        if (!principal) throw new Error("operator_identity_creation_failed");
      } else principal = invite.user;
    }
    const issued = "invitationStore" in deps
      ? await deps.invitationStore.issue({ actorPrincipalId: user.id, targetPrincipalId: principal.id, email, role, ttlSeconds: deps.ttlSeconds })
      : await deps.activateMembership({ principalId: principal.id, email, role });
    if (!("membershipState" in issued)) return { status: 409, body: { code: issued.code, error: issued.code } };
    let delivery: Pick<InviteAdminUserResponse, "deliveryReference" | "deliveryReferencePresent"> = {};
    if (issued.code !== "ALREADY_INVITED" && issued.code !== "ALREADY_ACTIVE") {
      try {
        const notification = await deps.roleNotificationPort.sendRoleGranted({ email, authUserId: principal.id, role, locale: deps.notificationLocale ?? ADMIN_ROLE_NOTIFICATION_LOCALE, ...(issued.membershipState === "invited" ? { invitationId: issued.invitationId, expiresAt: issued.expiresAt } : {}) });
        if (!notification.ok) throw new Error("operator_invitation_notification_failed");
        delivery = { deliveryReference: notification.skipped ? null : notification.providerMessageId, deliveryReferencePresent: !notification.skipped && Boolean(notification.providerMessageId) };
      } catch {
        return { status: 503, body: issued.membershipState === "invited"
          ? { code: "INVITATION_NOTIFICATION_FAILED", error: "Invitation persisted; notification unavailable", invitationId: issued.invitationId }
          : { ...issued, code: "INVITATION_NOTIFICATION_FAILED", error: "Membership active; notification unavailable" } };
      }
    }
    return { status: 200, body: { success: true, ...issued, ...delivery, message: issued.membershipState === "invited" ? `Invitation pending until ${issued.expiresAt}` : "Operator membership active" } };

  } catch (err) {
    const failure = err as { identityCode?: string; bffCode?: string };
    if (failure.identityCode) return { status: failure.bffCode === "FORBIDDEN" ? 403 : 409, body: { code: failure.identityCode, error: failure.identityCode } };
    return { status: 503, body: { code: "IDENTITY_ACTION_FAILED", error: String(err) } };
  }
}

function isInviteRole(value: string): value is AdminUserInviteRole {
  return value === "admin" || value === "distributor";
}
