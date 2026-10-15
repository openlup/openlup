// Persistence-neutral scheduled-job lease and attempt ledger port.
//
// The claim and finish contract is core's `JobLeasePort`. A job-run ledger adds the two reads a
// scheduled job uses for its backstop and checkpoint. Invocation is deployment evidence supplied by
// the composition root; a job never sees a database client, SDK query, RPC name, vendor driver or
// environment configuration.

import type { JobLeasePort } from "@openlup/core/platform-runtime";

export type {
  PlatformJobClaim,
  PlatformJobFinishStatus,
  PlatformJobFinishSummary,
  PlatformJobInvocation,
  PlatformJobTriggerKind,
} from "@openlup/core/platform-runtime";

export type PlatformJobBackstopState = {
  lastStatus: string | null;
  lastSuccessAt: string | null;
};

export interface PlatformJobRunLedgerPort extends JobLeasePort {
  readJobBackstopState(jobName: string): Promise<PlatformJobBackstopState | null>;

  readLatestTerminalRunMetadata(jobName: string): Promise<Record<string, unknown> | null>;
}
