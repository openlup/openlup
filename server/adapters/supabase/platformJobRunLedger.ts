import type {
  PlatformJobBackstopState,
  PlatformJobFinishStatus,
  PlatformJobFinishSummary,
  PlatformJobInvocation,
  PlatformJobRunLedgerPort,
} from "../../domains/platform/platformJobRunLedger.js";
import {
  readRuntimeProvenance,
  type RuntimeProvenanceEnv,
} from "../../_lib/observability/runtimeProvenance.js";
import {
  readHostedRuntimeCompatibility,
  type HostedRuntimeCompatibilityEnv,
} from "../vercel/runtimeProvenance.js";

export type PlatformJobDriver = "manual_admin" | "pg_cron" | "vercel_cron" | "worker";

type RpcResult<T> = {
  data: T | null;
  error: { message?: string } | null;
};

type PlatformJobMetadataQuery = {
  select(columns: "metadata"): PlatformJobMetadataQuery;
  eq(column: "job_name", value: string): PlatformJobMetadataQuery;
  in(column: "status", values: readonly ["success", "failed"]): PlatformJobMetadataQuery;
  not(column: "finished_at", operator: "is", value: null): PlatformJobMetadataQuery;
  order(column: "started_at", options: { ascending: false }): PlatformJobMetadataQuery;
  limit(count: 1): PlatformJobMetadataQuery;
  maybeSingle(): PromiseLike<{
    data: { metadata?: unknown } | null;
    error: { message?: string } | null;
  }>;
};

type PlatformJobControlQuery = {
  select(columns: "last_status,last_success_at"): PlatformJobControlQuery;
  eq(column: "job_name", value: string): PlatformJobControlQuery;
  maybeSingle(): PromiseLike<{
    data: { last_status?: string | null; last_success_at?: string | null } | null;
    error: { message?: string } | null;
  }>;
};

export interface PlatformJobSupabaseClient {
  rpc<T = unknown>(name: string, args: Record<string, unknown>): PromiseLike<RpcResult<T>>;
  from(table: "platform_job_runs"): PlatformJobMetadataQuery;
  from(table: "platform_job_controls"): PlatformJobControlQuery;
}

/** Minimal compatibility client for the legacy free-function surface. */
export type PlatformJobClient = Pick<PlatformJobSupabaseClient, "rpc">;

/** SDK construction stays inside the named managed adapter, never in runtime composition. */
export const createPlatformJobManagedClient = createClient;
export type PlatformJobManagedClientFactory = typeof createClient;

export type ReleaseCorrelationEnv = RuntimeProvenanceEnv & HostedRuntimeCompatibilityEnv;

export function releaseCorrelationMetadata(
  env: ReleaseCorrelationEnv = process.env,
): Record<string, string | null> {
  return readRuntimeProvenance(env, readHostedRuntimeCompatibility(env));
}

function triggerSourceForDriver(driver: PlatformJobDriver): string {
  switch (driver) {
    case "vercel_cron": return "vercel_cron";
    case "pg_cron": return "pg_cron_scheduler";
    case "worker": return "worker";
    case "manual_admin": return "manual_admin";
  }
}

export function platformJobInvocationForDriver(driver: PlatformJobDriver): PlatformJobInvocation {
  switch (driver) {
    case "manual_admin": return { triggerKind: "operator", invocationSource: driver };
    case "pg_cron":
    case "vercel_cron": return { triggerKind: "scheduler", invocationSource: driver };
    case "worker": return { triggerKind: "worker", invocationSource: driver };
  }
}

function managedDriverForInvocation(invocation: PlatformJobInvocation): PlatformJobDriver {
  if (!(["worker", "scheduler", "operator"] as const).includes(invocation.triggerKind)) {
    throw new Error("platform_job_invalid_trigger_kind");
  }
  const source = invocation.invocationSource.trim();
  const driver = source as PlatformJobDriver;
  const expected = platformJobInvocationForDriver(driver);
  if (!expected || expected.triggerKind !== invocation.triggerKind) {
    throw new Error("platform_job_invalid_invocation");
  }
  return driver;
}

function claimResult(data: unknown): { acquired: boolean; runId: string | null; reason: string } {
  const row = Array.isArray(data) ? data[0] : data;
  const record = plainRecord(row);
  return {
    acquired: record?.acquired === true,
    runId: typeof record?.run_id === "string" ? record.run_id : null,
    reason: typeof record?.reason === "string" ? record.reason : "unknown",
  };
}

/** Compatibility surface for existing managed v2 consumers. */
export async function claimJobRun(
  client: PlatformJobClient,
  jobName: string,
  driver: PlatformJobDriver,
  leaseSeconds = 900,
) {
  const { data, error } = await client.rpc("platform_claim_job_run", {
    p_job_name: jobName,
    p_driver: driver,
    p_lease_seconds: leaseSeconds,
    p_metadata: {
      driver,
      triggerSource: driver === "vercel_cron" ? "vercel_cron_manual" : driver,
      ...releaseCorrelationMetadata(),
    },
  });
  if (error) throw new Error(error.message ?? "platform_claim_job_run failed");
  return claimResult(data);
}

/** Compatibility surface for existing managed v3 consumers. */
export async function claimJobRunV3(
  client: PlatformJobClient,
  jobName: string,
  invocation: PlatformJobInvocation,
  leaseSeconds = 900,
) {
  const invocationSource = invocation.invocationSource.trim();
  if (!invocationSource) throw new Error("platform_job_invocation_source_required");

  const { data, error } = await client.rpc("platform_claim_job_run_v3", {
    p_job_name: jobName,
    p_trigger_kind: invocation.triggerKind,
    p_invocation_source: invocationSource,
    p_lease_seconds: leaseSeconds,
    p_metadata: {
      triggerKind: invocation.triggerKind,
      invocationSource,
      ...releaseCorrelationMetadata(),
    },
  });
  if (error) throw new Error(error.message ?? "platform_claim_job_run_v3 failed");
  return claimResult(data);
}

/** Compatibility surface for existing managed v2 consumers. */
export async function finishJobRun(
  client: PlatformJobClient,
  jobName: string,
  runId: string,
  status: PlatformJobFinishStatus,
  result: PlatformJobFinishSummary,
  extraMetadata?: Record<string, unknown>,
) {
  const { data, error } = await client.rpc<boolean>("platform_finish_job_run_v2", {
    p_job_name: jobName,
    p_run_id: runId,
    p_status: status,
    p_checked: result.checked,
    p_updated: result.updated,
    p_error: status === "failed" ? result.reason ?? "accounting_job_failed" : null,
    p_support_code: null,
    p_metadata: {
      driver: "manual_admin",
      failures: result.failures,
      skipped: result.skipped,
      reason: result.reason ?? null,
      ...releaseCorrelationMetadata(),
      ...(extraMetadata ?? {}),
    },
  });
  if (error) throw new Error(error.message ?? "platform_finish_job_run_v2 failed");
  return data === true;
}

/** Compatibility surface for existing managed v3 consumers. */
export async function finishJobRunV3(
  client: PlatformJobClient,
  jobName: string,
  runId: string,
  status: PlatformJobFinishStatus,
  result: PlatformJobFinishSummary,
  extraMetadata?: Record<string, unknown>,
) {
  const { error } = await client.rpc("platform_finish_job_run_v3", {
    p_job_name: jobName,
    p_run_id: runId,
    p_status: status,
    p_checked: result.checked,
    p_updated: result.updated,
    p_error: status === "failed" ? result.reason ?? "accounting_job_failed" : null,
    p_support_code: null,
    p_metadata: {
      failures: result.failures,
      skipped: result.skipped,
      reason: result.reason ?? null,
      ...releaseCorrelationMetadata(),
      ...(extraMetadata ?? {}),
    },
  });
  if (error) throw new Error(error.message ?? "platform_finish_job_run_v3 failed");
}

/** Managed adapter for the semantic job-run port used by scheduled fulfillment. */
export function createSupabasePlatformJobRunLedger(
  client: PlatformJobSupabaseClient,
  env: ReleaseCorrelationEnv = process.env,
): PlatformJobRunLedgerPort {
  return {
    async claimJobRun(jobName, invocation, leaseSeconds = 900) {
      const driver = managedDriverForInvocation(invocation);
      const { data, error } = await client.rpc("platform_claim_job_run", {
        p_job_name: jobName,
        p_driver: driver,
        p_lease_seconds: leaseSeconds,
        p_metadata: {
          driver,
          triggerSource: triggerSourceForDriver(driver),
          ...releaseCorrelationMetadata(env),
        },
      });
      if (error) throw new Error(error.message ?? "platform_claim_job_run failed");
      return claimResult(data);
    },

    async finishJobRun(jobName, runId, invocation, status, result, extraMetadata) {
      const driver = managedDriverForInvocation(invocation);
      const { data, error } = await client.rpc<boolean>("platform_finish_job_run_v2", {
        p_job_name: jobName,
        p_run_id: runId,
        p_status: status,
        p_checked: result.checked,
        p_updated: result.updated,
        p_error: status === "failed" ? result.reason ?? "accounting_job_failed" : null,
        p_support_code: null,
        p_metadata: {
          failures: result.failures,
          skipped: result.skipped,
          reason: result.reason ?? null,
          ...releaseCorrelationMetadata(env),
          ...(extraMetadata ?? {}),
          driver,
        },
      });
      if (error) throw new Error(error.message ?? "platform_finish_job_run_v2 failed");
      return data === true;
    },

    async readJobBackstopState(jobName): Promise<PlatformJobBackstopState | null> {
      const { data, error } = await client
        .from("platform_job_controls")
        .select("last_status,last_success_at")
        .eq("job_name", jobName)
        .maybeSingle();
      if (error) throw new Error("omnipack_cron_backstop_read_failed");
      return data ? {
        lastStatus: data.last_status ?? null,
        lastSuccessAt: data.last_success_at ?? null,
      } : null;
    },

    async readLatestTerminalRunMetadata(jobName) {
      const { data, error } = await client
        .from("platform_job_runs")
        .select("metadata")
        .eq("job_name", jobName)
        .in("status", ["success", "failed"])
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error("omnipack_cron_checkpoint_read_failed");
      return plainRecord(data?.metadata);
    },
  };
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return { ...(value as Record<string, unknown>) };
}
import { createClient } from "@supabase/supabase-js";
