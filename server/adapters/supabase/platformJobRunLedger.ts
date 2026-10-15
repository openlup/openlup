// Reference-application binding: this path keeps its importers while the managed job-run ledger
// lives in @openlup/platform. It binds this application's release-correlation readers, the
// failure reason recorded when a failed run reports none, its two read-failure messages and the
// real supabase-js `createClient` as the managed client factory.

import { createClient } from "@supabase/supabase-js";
import {
  createManagedJobRunCalls,
  createSupabasePlatformJobRunLedger as createPlatformSupabaseJobRunLedger,
  type PlatformJobSupabaseClient,
} from "@openlup/platform/job-ledger";
import type { PlatformJobRunLedgerPort } from "../../domains/platform/platformJobRunLedger.js";
import {
  readRuntimeProvenance,
  type RuntimeProvenanceEnv,
} from "../../_lib/observability/runtimeProvenance.js";
import {
  readHostedRuntimeCompatibility,
  type HostedRuntimeCompatibilityEnv,
} from "../vercel/runtimeProvenance.js";

export {
  platformJobInvocationForDriver,
  type PlatformJobClient,
  type PlatformJobDriver,
  type PlatformJobSupabaseClient,
} from "@openlup/platform/job-ledger";

/** SDK construction stays inside the named managed adapter, never in runtime composition. */
export const createPlatformJobManagedClient = createClient;
export type PlatformJobManagedClientFactory = typeof createClient;

export type ReleaseCorrelationEnv = RuntimeProvenanceEnv & HostedRuntimeCompatibilityEnv;

const DEFAULT_FAILURE_REASON = "accounting_job_failed";

export function releaseCorrelationMetadata(
  env: ReleaseCorrelationEnv = process.env,
): Record<string, string | null> {
  return readRuntimeProvenance(env, readHostedRuntimeCompatibility(env));
}

const managed = createManagedJobRunCalls({
  releaseCorrelation: () => releaseCorrelationMetadata(),
  defaultFailureReason: DEFAULT_FAILURE_REASON,
});

/** Compatibility surface for existing managed v2/v3 consumers. */
export const { claimJobRun, claimJobRunV3, finishJobRun, finishJobRunV3 } = managed;

/** Managed adapter for the semantic job-run port used by scheduled fulfillment. */
export function createSupabasePlatformJobRunLedger(
  client: PlatformJobSupabaseClient,
  env: ReleaseCorrelationEnv = process.env,
): PlatformJobRunLedgerPort {
  return createPlatformSupabaseJobRunLedger(client, {
    releaseCorrelation: () => releaseCorrelationMetadata(env),
    defaultFailureReason: DEFAULT_FAILURE_REASON,
    backstopReadError: "omnipack_cron_backstop_read_failed",
    checkpointReadError: "omnipack_cron_checkpoint_read_failed",
  });
}
