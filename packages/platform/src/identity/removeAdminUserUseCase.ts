import type { OperatorInvitationStore } from "./operatorInvitationPorts.js";
import { identityMessages, type IdentityMessages } from "./messages.js";
export type RemoveAdminUserResponse = {
  revoked?: true;
  error?: string;
  code?: string;
};

export interface RemoveAdminUserGateway {
  getUser: (accessToken: string) => Promise<{
    user: { id: string } | null;
    error: unknown;
  }>;
  findAdminUser: (userId: string) => Promise<{ id: string; role: string } | null>;
  revokeAdminUser: (userId: string) => Promise<{ error: { message: string } | null }>;
}

export async function runRemoveAdminUserUseCase(
  request: { accessToken: string | null; userId: string },
  gateway: RemoveAdminUserGateway,
  messages: IdentityMessages = identityMessages.en,
  invitationStore?: Pick<OperatorInvitationStore, "remove">,
): Promise<{ status: number; body: RemoveAdminUserResponse }> {
  try {
    if (!request.accessToken) {
      return { status: 401, body: { code: "UNAUTHORIZED", error: messages.unauthorized } };
    }

    const { user, error: authError } = await gateway.getUser(request.accessToken);
    if (authError || !user) {
      return { status: 401, body: { code: "INVALID_TOKEN", error: messages.invalidToken } };
    }

    const callerAdmin = await gateway.findAdminUser(user.id);
    if (!callerAdmin || callerAdmin.role !== "admin") {
      return { status: 403, body: { code: "REMOVE_FORBIDDEN", error: messages.removeForbidden } };
    }

    if (!request.userId) {
      return { status: 400, body: { code: "USER_ID_REQUIRED", error: messages.userIdRequired } };
    }

    if (request.userId === user.id) {
      return { status: 403, body: { code: "SELF_REVOKE_FORBIDDEN", error: messages.selfRemoveForbidden } };
    }

    if (invitationStore) {
      try {
        await invitationStore.remove({ actorPrincipalId: user.id, targetPrincipalId: request.userId });
        return { status: 200, body: { revoked: true } };
      } catch (error) {
        const failure = error as { identityCode?: string; bffCode?: string; message?: string };
        if (failure.identityCode) return { status: failure.bffCode === "FORBIDDEN" ? 403 : failure.bffCode === "BAD_REQUEST" ? 400 : 409, body: { code: failure.identityCode, error: failure.identityCode } };
        return mapRevokeError(failure.message ?? "revoke_failed", messages);
      }
    }
    const { error: revokeError } = await gateway.revokeAdminUser(request.userId);
    if (revokeError) {
      return mapRevokeError(revokeError.message, messages);
    }

    return { status: 200, body: { revoked: true } };
  } catch (err) {
    return { status: 500, body: { code: "IDENTITY_ACTION_FAILED", error: String(err) } };
  }
}

function mapRevokeError(message: string, messages: IdentityMessages): { status: number; body: RemoveAdminUserResponse } {
  if (message.includes("last_active_human_admin") || message.includes("last_admin_lockout")) {
    return { status: 409, body: { code: "LAST_ACTIVE_HUMAN_ADMIN", error: messages.lastAdmin } };
  }
  if (message.includes("self_revoke_forbidden")) {
    return { status: 403, body: { code: "SELF_REVOKE_FORBIDDEN", error: messages.selfRevoke } };
  }
  if (message.includes("machine_actor_revoke_forbidden")) {
    return { status: 403, body: { code: "MACHINE_ACTOR_REVOKE_FORBIDDEN", error: messages.machineRevoke } };
  }
  if (message.includes("target_not_found") || message.includes("target_not_active")) {
    return { status: 400, body: { code: "ADMIN_NOT_FOUND", error: messages.adminNotFound } };
  }
  if (message.includes("forbidden")) {
    return { status: 403, body: { code: "ADMIN_REQUIRED", error: messages.adminRequired } };
  }
  return { status: 500, body: { code: "REVOKE_FAILED", error: messages.revokeFailed(message) } };
}
