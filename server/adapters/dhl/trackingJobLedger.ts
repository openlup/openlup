export const TRACKING_JOB_NAME = "check-dhl-tracking";
export const SCHEDULED_CRON_DRIVER = "vercel_cron";
const TRACKING_LEASE_SECONDS = 20 * 60;
const TRACKING_DRIVERS = ["pg_cron", SCHEDULED_CRON_DRIVER, "manual_admin"] as const;

type RpcError = { message?: string } | null;
type RawLeaseRow = {
  acquired?: boolean;
  run_id?: string | null;
  reason?: string | null;
  lease_until?: string | null;
  lease_expires_at?: string | null;
};

export type TrackingDriver = (typeof TRACKING_DRIVERS)[number];
export type TrackingLedgerClient = {
  rpc: <T = unknown>(name: string, params: Record<string, unknown>) =>
    Promise<{ data: T | null; error?: RpcError }>;
};
export type TrackingLease = {
  acquired: boolean;
  runId: string | null;
  reason: string;
  leaseExpiresAt: string | null;
};

export function parseTrackingDriver(value: unknown): TrackingDriver | null {
  if (typeof value !== "string") return null;
  const driver = value.trim();
  return (TRACKING_DRIVERS as readonly string[]).includes(driver)
    ? driver as TrackingDriver
    : null;
}

export async function beginTrackingJobRun(
  client: TrackingLedgerClient,
  driver: TrackingDriver,
  metadata: Record<string, unknown> = {},
): Promise<TrackingLease> {
  const { data, error } = await client.rpc<RawLeaseRow[] | RawLeaseRow>("platform_claim_job_run", {
    p_job_name: TRACKING_JOB_NAME,
    p_driver: driver,
    p_lease_seconds: TRACKING_LEASE_SECONDS,
    p_metadata: { driver, ...metadata },
  });
  if (error) throw new Error(error.message ?? "platform_claim_job_run failed");
  const row = Array.isArray(data) ? data[0] ?? null : data;
  if (!row) throw new Error("platform_claim_job_run returned no lease row");
  return {
    acquired: row.acquired === true,
    runId: row.run_id ?? null,
    reason: row.reason ?? "unknown",
    leaseExpiresAt: row.lease_until ?? row.lease_expires_at ?? null,
  };
}

export async function finishTrackingJobRun(
  client: TrackingLedgerClient,
  runId: string,
  status: "success" | "failed",
  driver: TrackingDriver,
  checked: number | null,
  updated: number | null,
  errorMessage?: string,
  supportCode?: string,
  metadata: Record<string, unknown> = {},
): Promise<boolean> {
  const { data, error } = await client.rpc<boolean>("platform_finish_job_run_v2", {
    p_job_name: TRACKING_JOB_NAME,
    p_run_id: runId,
    p_status: status,
    p_checked: checked,
    p_updated: updated,
    p_error: errorMessage ?? null,
    p_support_code: supportCode ?? null,
    p_metadata: { driver, ...metadata },
  });
  if (error) throw new Error(error.message ?? "platform_finish_job_run_v2 failed");
  return data === true;
}
