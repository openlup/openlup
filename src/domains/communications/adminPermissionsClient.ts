import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  adminCommunicationPermissionsReadResponseSchema,
  updateAdminCommunicationPermissionResponseSchema,
  type AdminCommunicationPermissionsReadResponse,
  type UpdateAdminCommunicationPermissionRequest,
  type UpdateAdminCommunicationPermissionResponse,
} from "./contracts";

const PATH = "/api/bff/admin/communications/permissions";

export function getAdminCommunicationPermissions(
  accessToken: string,
  email: string,
  options: BffRequestOptions = {},
): Promise<AdminCommunicationPermissionsReadResponse> {
  return requestBff(
    `${PATH}?${new URLSearchParams({ email }).toString()}`,
    adminCommunicationPermissionsReadResponseSchema,
    {
      ...options,
      method: "GET",
      headers: authHeaders(accessToken, options),
    },
  );
}

export function updateAdminCommunicationPermission(
  accessToken: string,
  request: UpdateAdminCommunicationPermissionRequest,
  options: BffRequestOptions = {},
): Promise<UpdateAdminCommunicationPermissionResponse> {
  return requestBff(PATH, updateAdminCommunicationPermissionResponseSchema, {
    ...options,
    method: "PATCH",
    headers: authHeaders(accessToken, options),
    body: request,
  });
}

function authHeaders(accessToken: string, options: BffRequestOptions): Headers {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}
