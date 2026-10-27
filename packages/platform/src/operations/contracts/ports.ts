import type {
  AdminPipelineReadRequest, AdminPipelineReadResponse,
  AdminSettingsReadRequest, AdminSettingsReadResponse,
  AdminSettingsUpdateRequest, AdminSettingsUpdateResponse,
  PlatformControlPlaneReadRequest, PlatformControlPlaneReadResponse,
  PlatformControlPlaneMutation, PlatformControlPlaneMutationResponse,
} from "./admin.js";

export interface AdminPipelineReadPort {
  readPipeline(request: AdminPipelineReadRequest): Promise<AdminPipelineReadResponse>;
}
export interface AdminSettingsOperationsPort {
  readSettings(request: AdminSettingsReadRequest): Promise<AdminSettingsReadResponse>;
  updateSetting(request: AdminSettingsUpdateRequest): Promise<AdminSettingsUpdateResponse>;
}
export interface PlatformControlPlanePort {
  readControlPlane(request: PlatformControlPlaneReadRequest): Promise<PlatformControlPlaneReadResponse>;
  mutateControlPlane(request: PlatformControlPlaneMutation): Promise<PlatformControlPlaneMutationResponse>;
}
export type OperationsAuthorizationResult =
  | { ok: true }
  | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string };
