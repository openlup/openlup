/** Operator projection; persistence and read authority remain host-owned. */
export type AdminAlertSeverity = "p0" | "p1" | "p2" | "p3";
export type AdminAlertLane = "commerce" | "platform";
export type AdminAlertHealth = "ok" | "degraded" | "down" | "unknown";
export type AdminAlert = {
  id: string; dedupeKey: string; lane: AdminAlertLane; owner: string;
  severity: AdminAlertSeverity; status: "open" | "acknowledged"; pageable: boolean;
  title: string; message: string; supportCode: string | null; runbookUrl: string | null;
  firstSeenAt: string; lastSeenAt: string; snoozedUntil: string | null;
};
export type AdminAlertsHeartbeat = { lastSuccessAt: string | null; staleAfterSeconds: number; stale: boolean };
export type AdminAlertsSummary = { commercePageableCount: number; commerceTotalCount: number; platformPageableCount: number; snoozedCount: number; maxOpenSeverity: AdminAlertSeverity | null };
export type AdminAlertsOverviewResponse = { health: AdminAlertHealth; summary: AdminAlertsSummary; heartbeat: AdminAlertsHeartbeat; alerts: AdminAlert[]; snoozedAlerts: AdminAlert[]; generatedAt: string };
