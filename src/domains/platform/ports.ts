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
  PlatformControlPlaneMutation,
  PlatformControlPlaneMutationResponse,
  PlatformControlPlaneReadRequest,
  PlatformControlPlaneReadResponse,
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

export interface PlatformControlPlanePort {
  readControlPlane(
    request: PlatformControlPlaneReadRequest,
  ): Promise<PlatformControlPlaneReadResponse>;
  mutateControlPlane(
    request: PlatformControlPlaneMutation,
  ): Promise<PlatformControlPlaneMutationResponse>;
}

export class PlatformControlPlaneConflictError extends Error {
  override readonly name = "PlatformControlPlaneConflictError";
}

export class PlatformControlPlaneUnavailableError extends Error {
  override readonly name = "PlatformControlPlaneUnavailableError";
}
