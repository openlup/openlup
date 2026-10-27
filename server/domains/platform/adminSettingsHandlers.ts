import { readObservedResponseContext } from "../../_lib/observability/requestContext.js";
export type { AdminUserRoleUpdateDeps, AdminUserInviteDeps, AdminUserRemoveDeps } from "@openlup/platform/identity";
import { createAdminUserRemoveHandler as createAdminUserRemoveHandlerFromIdentity, type AdminUserRemoveDeps } from "@openlup/platform/identity";
import { createAdminUserInviteHandler as createAdminUserInviteHandlerFromIdentity, type AdminUserInviteDeps } from "@openlup/platform/identity";
import { createAdminUserRoleUpdateHandler as createAdminUserRoleUpdateHandlerFromIdentity, type AdminUserRoleUpdateDeps } from "@openlup/platform/identity";
import { createAdminSettingsReadHandler as createRead, createAdminSettingsUpdateHandler as createUpdate } from "@openlup/platform/operations/server";
export type { AdminSettingsReadDeps, AdminSettingsUpdateDeps } from "@openlup/platform/operations/server";
export function createAdminSettingsReadHandler(deps: Parameters<typeof createRead>[0]) {
  return createRead({ ...deps, responseRequestId: deps.responseRequestId ?? ((res) => readObservedResponseContext(res)?.requestId) });
}
export function createAdminSettingsUpdateHandler(deps: Parameters<typeof createUpdate>[0]) {
  return createUpdate({ ...deps, responseRequestId: deps.responseRequestId ?? ((res) => readObservedResponseContext(res)?.requestId) });
}

export function createAdminUserRoleUpdateHandler(deps: AdminUserRoleUpdateDeps) {
  return createAdminUserRoleUpdateHandlerFromIdentity({ ...deps, responseRequestId: deps.responseRequestId ?? ((res) => readObservedResponseContext(res)?.requestId) });
}

export function createAdminUserInviteHandler(deps: AdminUserInviteDeps) {
  return createAdminUserInviteHandlerFromIdentity({ ...deps, responseRequestId: deps.responseRequestId ?? ((res) => readObservedResponseContext(res)?.requestId) });
}

export function createAdminUserRemoveHandler(deps: AdminUserRemoveDeps) {
  return createAdminUserRemoveHandlerFromIdentity({ ...deps, responseRequestId: deps.responseRequestId ?? ((res) => readObservedResponseContext(res)?.requestId) });
}
