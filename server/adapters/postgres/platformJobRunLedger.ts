// Reference-application binding: this path keeps its importers while the implementation lives in
// @openlup/platform. It binds this application's release-correlation readers and the failure
// reason recorded when a failed run reports none.

import { createPostgresPlatformJobRunLedger as createPlatformJobRunLedger } from "@openlup/platform/job-ledger";
import type { PlatformJobRunLedgerPort } from "../../domains/platform/platformJobRunLedger.js";
import type { PgQueryExecutor } from "./queryBuilder.js";
import {
  readRuntimeProvenance,
  type RuntimeProvenanceEnv,
} from "../../_lib/observability/runtimeProvenance.js";
import {
  readHostedRuntimeCompatibility,
  type HostedRuntimeCompatibilityEnv,
} from "../vercel/runtimeProvenance.js";

export type PostgresReleaseCorrelationEnv = Record<string, string | undefined> & RuntimeProvenanceEnv & HostedRuntimeCompatibilityEnv;

/** Direct PostgreSQL adapter for the public neutral-vocabulary job-control rail. */
export function createPostgresPlatformJobRunLedger(
  executor: PgQueryExecutor,
  env: PostgresReleaseCorrelationEnv = process.env,
): PlatformJobRunLedgerPort {
  return createPlatformJobRunLedger(executor, {
    releaseCorrelation: () => readRuntimeProvenance(env, readHostedRuntimeCompatibility(env)),
    defaultFailureReason: "accounting_job_failed",
  });
}
