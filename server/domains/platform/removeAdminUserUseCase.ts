export type RemoveAdminUserResponse = {
  revoked?: true;
  error?: string;
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
): Promise<{ status: number; body: RemoveAdminUserResponse }> {
  try {
    if (!request.accessToken) {
      return { status: 401, body: { error: "Unauthorized" } };
    }

    const { user, error: authError } = await gateway.getUser(request.accessToken);
    if (authError || !user) {
      return { status: 401, body: { error: "Invalid token" } };
    }

    const callerAdmin = await gateway.findAdminUser(user.id);
    if (!callerAdmin || callerAdmin.role !== "admin") {
      return { status: 403, body: { error: "Tylko administratorzy mogą odbierać dostęp użytkownikom" } };
    }

    if (!request.userId) {
      return { status: 400, body: { error: "Brak ID użytkownika" } };
    }

    if (request.userId === user.id) {
      return { status: 403, body: { error: "Nie możesz odebrać sobie dostępu" } };
    }

    const { error: revokeError } = await gateway.revokeAdminUser(request.userId);
    if (revokeError) {
      return mapRevokeError(revokeError.message);
    }

    return { status: 200, body: { revoked: true } };
  } catch (err) {
    return { status: 500, body: { error: String(err) } };
  }
}

function mapRevokeError(message: string): { status: number; body: RemoveAdminUserResponse } {
  if (message.includes("last_active_human_admin") || message.includes("last_admin_lockout")) {
    return { status: 409, body: { error: "At least one active human admin must remain." } };
  }
  if (message.includes("self_revoke_forbidden")) {
    return { status: 403, body: { error: "You cannot revoke your own access." } };
  }
  if (message.includes("machine_actor_revoke_forbidden")) {
    return { status: 403, body: { error: "Machine actors cannot be revoked through this route." } };
  }
  if (message.includes("target_not_found") || message.includes("target_not_active")) {
    return { status: 400, body: { error: "Admin user not found." } };
  }
  if (message.includes("forbidden")) {
    return { status: 403, body: { error: "Admin role required." } };
  }
  return { status: 500, body: { error: `Admin access revoke failed: ${message}` } };
}
