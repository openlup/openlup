import type {
  PlatformJobRunLedgerPort,
} from "../../domains/platform/platformJobRunLedger.js";
import type { PgQueryExecutor } from "./queryBuilder.js";
import {
  readRuntimeProvenance,
  type RuntimeProvenanceEnv,
} from "../../_lib/observability/runtimeProvenance.js";
import {
  readHostedRuntimeCompatibility,
  type HostedRuntimeCompatibilityEnv,
} from "../vercel/runtimeProvenance.js";

const CLAIM_SQL = `
  SELECT acquired, run_id, reason
  FROM public.platform_claim_job_run_v3($1, $2, $3, $4, $5::jsonb)`;

const FINISH_SQL = `
  SELECT public.platform_finish_job_run_v3(
    $1, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb
  ) AS released`;

const BACKSTOP_SQL = `
  SELECT last_status, last_success_at
  FROM public.platform_job_controls
  WHERE job_name = $1`;

const LATEST_TERMINAL_METADATA_SQL = `
  SELECT metadata
  FROM public.platform_job_runs
  WHERE job_name = $1
    AND status IN ('success', 'failed')
    AND finished_at IS NOT NULL
  ORDER BY started_at DESC
  LIMIT 1`;

export type PostgresReleaseCorrelationEnv = Record<string, string | undefined> & RuntimeProvenanceEnv & HostedRuntimeCompatibilityEnv;

/** Direct PostgreSQL adapter for the public neutral-vocabulary job-control rail. */
export function createPostgresPlatformJobRunLedger(
  executor: PgQueryExecutor,
  env: PostgresReleaseCorrelationEnv = process.env,
): PlatformJobRunLedgerPort {
  return {
    async claimJobRun(jobName, invocation, leaseSeconds = 900) {
      const invocationSource = requiredInvocationSource(invocation.invocationSource);
      const result = await executor.query(CLAIM_SQL, [
        jobName,
        invocation.triggerKind,
        invocationSource,
        leaseSeconds,
        {
          triggerKind: invocation.triggerKind,
          invocationSource,
          ...releaseCorrelationMetadata(env),
        },
      ]);
      const row = plainRecord(result.rows[0]);
      return {
        acquired: row?.acquired === true,
        runId: typeof row?.run_id === "string" ? row.run_id : null,
        reason: typeof row?.reason === "string" ? row.reason : "unknown",
      };
    },

    async finishJobRun(jobName, runId, invocation, status, summary, extraMetadata) {
      const invocationSource = requiredInvocationSource(invocation.invocationSource);
      const result = await executor.query(FINISH_SQL, [
        jobName,
        runId,
        status,
        summary.checked,
        summary.updated,
        status === "failed" ? summary.reason ?? "accounting_job_failed" : null,
        null,
        {
          failures: summary.failures,
          skipped: summary.skipped,
          reason: summary.reason ?? null,
          ...releaseCorrelationMetadata(env),
          ...(extraMetadata ?? {}),
          triggerKind: invocation.triggerKind,
          invocationSource,
          driver: invocationSource,
        },
      ]);
      return plainRecord(result.rows[0])?.released === true;
    },

    async readJobBackstopState(jobName) {
      const result = await executor.query(BACKSTOP_SQL, [jobName]);
      const row = plainRecord(result.rows[0]);
      return row ? {
        lastStatus: typeof row.last_status === "string" ? row.last_status : null,
        lastSuccessAt: timestampString(row.last_success_at),
      } : null;
    },

    async readLatestTerminalRunMetadata(jobName) {
      const result = await executor.query(LATEST_TERMINAL_METADATA_SQL, [jobName]);
      return plainRecord(plainRecord(result.rows[0])?.metadata);
    },
  };
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return { ...(value as Record<string, unknown>) };
}

function timestampString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return null;
}

function releaseCorrelationMetadata(
  env: PostgresReleaseCorrelationEnv,
): Record<string, string | null> {
  return readRuntimeProvenance(env, readHostedRuntimeCompatibility(env));
}

function requiredInvocationSource(value: string): string {
  const source = value.trim();
  if (!source) throw new Error("platform_job_invocation_source_required");
  return source;
}
