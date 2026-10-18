import type { IdentityAdminActionsPort } from "./adminUserHandlers.js";
import type { runInviteAdminUserUseCase } from "./inviteAdminUserUseCase.js";
import type { runRemoveAdminUserUseCase } from "./removeAdminUserUseCase.js";
type AdminUserActionRuntimeEnv = Record<string, string | undefined>;
type AdminUserInviteRunner = (request: { accessToken: string | null; email: string; role: "admin" | "distributor" }, env?: AdminUserActionRuntimeEnv) => ReturnType<typeof runInviteAdminUserUseCase>;
type AdminUserRemoveRunner = (request: { accessToken: string | null; userId: string }, env?: AdminUserActionRuntimeEnv) => ReturnType<typeof runRemoveAdminUserUseCase>;
export function createAdminUserInvitePort(options: {
  accessToken: string | null;
  env?: AdminUserActionRuntimeEnv;
  runInviteAdminUser: AdminUserInviteRunner;
}): Pick<IdentityAdminActionsPort, "inviteAdminUser"> {
  const runInviteAdminUser = options.runInviteAdminUser;
  return {
    async inviteAdminUser(request) {
      const result = await runInviteAdminUser({
        accessToken: options.accessToken,
        email: request.email,
        role: request.role,
      }, options.env);
      if (result.status < 200 || result.status >= 300) {
        throw new Error(String(result.body.error ?? `invite_admin_user_http_${result.status}`));
      }
      if (result.body.error) throw new Error(result.body.error);

      return { message: result.body.message };
    },
  };
}

export function createAdminUserRemovePort(options: {
  accessToken: string | null;
  env?: AdminUserActionRuntimeEnv;
  runRemoveAdminUser: AdminUserRemoveRunner;
}): Pick<IdentityAdminActionsPort, "removeAdminUser"> {
  const runRemoveAdminUser = options.runRemoveAdminUser;
  return {
    async removeAdminUser(request) {
      const result = await runRemoveAdminUser({
        accessToken: options.accessToken,
        userId: request.userId,
      }, options.env);
      if (result.status < 200 || result.status >= 300) {
        throw removePortError(
          result.status,
          String(result.body.error ?? `remove_admin_user_http_${result.status}`),
        );
      }
      if (result.body.error) throw new Error(result.body.error);

      if (result.body.revoked !== true) {
        throw new Error("admin_revoke_admin_user returned an invalid response");
      }
      return { revoked: true };
    },
  };
}

function removePortError(status: number, message: string): Error {
  const bffCode = ({ 400: "BAD_REQUEST", 403: "FORBIDDEN", 409: "CONFLICT" } as const)[status]
    ?? "UPSTREAM_UNAVAILABLE";
  return Object.assign(new Error(message), { bffCode });
}

