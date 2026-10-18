import { runInviteAdminUserUseCase as run, identityMessages } from "@openlup/platform/identity";
export type { AdminUserInviteRole, InviteAdminUserResponse, InviteAdminUserGateway, AdminRoleNotificationPort, AdminRoleNotificationSkipReason } from "@openlup/platform/identity";
export const ADMIN_ROLE_NOTIFICATION_LOCALE = "pl" as const;
export async function runInviteAdminUserUseCase(request: Parameters<typeof run>[0], deps: Parameters<typeof run>[1]) {
  const result = await run(request, { ...deps, messages: identityMessages.pl, notificationLocale: "pl" });
  const { code: _code, ...body } = result.body;
  return { ...result, body };
}
