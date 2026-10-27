/** DTOs for the existing operational settings, pipeline and control-plane surfaces. */
export type AdminPipelineTester = { id: string; status: string; email_sequence_step: number | null; email_sequence_paused: boolean | null };
export type AdminPipelineEmailTemplate = { id: string; name: string; sequence_order: number | null };
export type AdminPipelineEmailEvent = { event_type: string };
export type AdminPipelineReadRequest = Record<string, never>;
export type AdminPipelineReadResponse = { testers: AdminPipelineTester[]; templates: AdminPipelineEmailTemplate[]; emailSendCount: number; emailEvents: AdminPipelineEmailEvent[] };
export type AdminPipelineDhlTrackingRefreshRequest = Record<string, never>;
export type AdminPipelineDhlTrackingRefreshResponse = { checked: number; updated: number };
export type AdminSettingsAdminUser = { id: string; email: string | null; role: string | null };
export type AdminSettingsReadRequest = Record<string, never>;
export type AdminSettingsReadResponse = { settings: Record<string, unknown>; adminUsers: AdminSettingsAdminUser[] };
export type AdminSettingWriteValue = string | number | boolean | null;
export type AdminSettingsUpdateRequest = { key: string; value: AdminSettingWriteValue };
export type AdminSettingsUpdateResponse = { key: string; saved: true };
export type PlatformControlPlaneReadRequest = Record<string, never>;
export type PlatformControlPlaneReadResponse = {
  controls: { controlKey: string; enabled: boolean; revision: number; updatedAt: string }[];
  jobs: { jobName: string; enabled: boolean; activeDriver: "worker" | "scheduler" | "operator"; lastStatus: "running" | "success" | "failed" | "skipped" | null; lastStartedAt: string | null; lastFinishedAt: string | null; lastSuccessAt: string | null }[];
  alerts: { dedupeKey: string; severity: "p0" | "p1" | "p2" | "p3"; status: "open" | "acknowledged" | "resolved"; owner: string; title: string; firstSeenAt: string; lastSeenAt: string; resolvedAt: string | null }[];
};
export type PlatformControlPlaneMutation =
  | { action: "set-control"; idempotencyKey: string; controlKey: string; enabled: boolean }
  | { action: "record-heartbeat"; idempotencyKey: string; health: "healthy" | "degraded" | "failed"; firingCount: number; maxSeverity: "p0" | "p1" | "p2" | "p3" | null; promotionReady: boolean };
export type PlatformControlPlaneMutationResponse = { action: "set-control" | "record-heartbeat"; replayed: boolean; revision: number | null; recordedAt: string };
