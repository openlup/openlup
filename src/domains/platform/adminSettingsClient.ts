import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  adminSettingsReadResponseSchema,
  adminSettingsUpdateResponseSchema,
  adminUserInviteResponseSchema,
  adminUserRemoveResponseSchema,
  adminUserRoleUpdateResponseSchema,
  type AdminUserInviteRequest,
  type AdminUserInviteResponse,
  type AdminUserRemoveRequest,
  type AdminUserRemoveResponse,
  type AdminSettingsReadResponse,
  type AdminSettingsUpdateRequest,
  type AdminSettingsUpdateResponse,
  type AdminUserRoleUpdateRequest,
  type AdminUserRoleUpdateResponse,
} from "./contracts";

const READ_PATH = "/api/bff/admin/platform/settings";
const UPDATE_PATH = "/api/bff/admin/platform/settings/update";
const ROLE_UPDATE_PATH = "/api/bff/admin/platform/admin-users/role";
const INVITE_PATH = "/api/bff/admin/platform/admin-users/invite";
const REMOVE_PATH = "/api/bff/admin/platform/admin-users/remove";

export function getAdminSettings(
  accessToken: string,
  options: BffRequestOptions = {},
): Promise<AdminSettingsReadResponse> {
  return requestBff(READ_PATH, adminSettingsReadResponseSchema, {
    ...options,
    method: "GET",
    headers: authHeaders(accessToken, options),
  });
}

export function updateAdminSetting(
  accessToken: string,
  request: AdminSettingsUpdateRequest,
  options: BffRequestOptions = {},
): Promise<AdminSettingsUpdateResponse> {
  return requestBff(UPDATE_PATH, adminSettingsUpdateResponseSchema, {
    ...options,
    method: "POST",
    headers: authHeaders(accessToken, options),
    body: request,
  });
}

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
