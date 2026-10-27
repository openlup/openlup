import type {
  AdminPipelineDhlTrackingRefreshRequest,
  AdminPipelineDhlTrackingRefreshResponse,
  AdminPipelineReadRequest,
  AdminPipelineReadResponse,
  AdminPlatformMeResponse,
  AdminSettingsReadRequest,
  AdminSettingsReadResponse,
  AdminSettingsUpdateRequest,
  AdminSettingsUpdateResponse,
  AdminUserInviteRequest,
  AdminUserInviteResponse,
  AdminUserRemoveRequest,
  AdminUserRemoveResponse,
  AdminUserRoleUpdateRequest,
  AdminUserRoleUpdateResponse,
} from "./contracts.js";

export type AdminMagicLinkEligibility =
  | "eligible"
  | "not_allowlisted"
  | "role_not_allowed";

export interface AdminPlatformPort {
  getAdminMe(userId: string): Promise<AdminPlatformMeResponse>;
  checkAdminMagicLinkEligibility(email: string): Promise<AdminMagicLinkEligibility>;
}

export interface AdminPipelinePort {
  readPipeline(request: AdminPipelineReadRequest): Promise<AdminPipelineReadResponse>;
  refreshDhlTracking(
    request: AdminPipelineDhlTrackingRefreshRequest,
  ): Promise<AdminPipelineDhlTrackingRefreshResponse>;
}

export interface AdminSettingsPort {
  readSettings(request: AdminSettingsReadRequest): Promise<AdminSettingsReadResponse>;
  updateSetting(
    request: AdminSettingsUpdateRequest,
  ): Promise<AdminSettingsUpdateResponse>;
  updateAdminUserRole(
    request: AdminUserRoleUpdateRequest,
  ): Promise<AdminUserRoleUpdateResponse>;
  inviteAdminUser(request: AdminUserInviteRequest): Promise<AdminUserInviteResponse>;
  removeAdminUser(request: AdminUserRemoveRequest): Promise<AdminUserRemoveResponse>;
}

export type { PlatformControlPlanePort } from "@openlup/platform/operations/contracts";
export { PlatformControlPlaneConflictError, PlatformControlPlaneUnavailableError } from "@openlup/platform/operations";
