import { createOperationsClients } from "@openlup/platform/operations";
import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  adminUserInviteResponseSchema,
  adminUserRemoveResponseSchema,
  adminUserRoleUpdateResponseSchema,
  type AdminUserInviteRequest,
  type AdminUserInviteResponse,
  type AdminUserRemoveRequest,
  type AdminUserRemoveResponse,
  type AdminUserRoleUpdateRequest,
  type AdminUserRoleUpdateResponse,
} from "./contracts";

const ROLE_UPDATE_PATH = "/api/bff/admin/platform/admin-users/role";
const INVITE_PATH = "/api/bff/admin/platform/admin-users/invite";
const REMOVE_PATH = "/api/bff/admin/platform/admin-users/remove";

const operations = createOperationsClients(requestBff);
export const getAdminSettings = operations.getAdminSettings;
export const updateAdminSetting = operations.updateAdminSetting;

export function updateAdminUserRole(
  accessToken: string,
  request: AdminUserRoleUpdateRequest,
  options: BffRequestOptions = {},
): Promise<AdminUserRoleUpdateResponse> {
  return requestBff(ROLE_UPDATE_PATH, adminUserRoleUpdateResponseSchema, {
    ...options,
    method: "POST",
    headers: authHeaders(accessToken, options),
    body: request,
  });
}

export function inviteAdminUser(
  accessToken: string,
  request: AdminUserInviteRequest,
  options: BffRequestOptions = {},
): Promise<AdminUserInviteResponse> {
  return requestBff(INVITE_PATH, adminUserInviteResponseSchema, {
    ...options,
    method: "POST",
    headers: authHeaders(accessToken, options),
    body: request,
  });
}

export function removeAdminUser(
  accessToken: string,
  request: AdminUserRemoveRequest,
  options: BffRequestOptions = {},
): Promise<AdminUserRemoveResponse> {
  return requestBff(REMOVE_PATH, adminUserRemoveResponseSchema, {
    ...options,
    method: "POST",
    headers: authHeaders(accessToken, options),
    body: request,
  });
}

function authHeaders(accessToken: string, options: BffRequestOptions): Headers {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}
