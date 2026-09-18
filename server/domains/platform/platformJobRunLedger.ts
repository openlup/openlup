export type PlatformJobTriggerKind = "worker" | "scheduler" | "operator";

export type PlatformJobInvocation = {
  triggerKind: PlatformJobTriggerKind;
  /** Observational adapter evidence; it never grants execution authority. */
  invocationSource: string;
};

export type PlatformJobClaim = {
  acquired: boolean;
  runId: string | null;
  reason: string;
};

export type PlatformJobFinishStatus = "success" | "failed";

export type PlatformJobFinishSummary = {
  checked: number;
  updated: number;
  failures: number;
  skipped: boolean;
  reason?: string;
};

export type PlatformJobBackstopState = {
  lastStatus: string | null;
  lastSuccessAt: string | null;
};

/**
 * Persistence-neutral scheduled-job lease and attempt ledger.
 *
 * Invocation is deployment evidence supplied by the composition root. The
 * domain never sees a database client, SDK query, RPC name, vendor driver or
 * environment configuration.
 */
export interface PlatformJobRunLedgerPort {
  claimJobRun(
    jobName: string,
    invocation: PlatformJobInvocation,
    leaseSeconds?: number,
  ): Promise<PlatformJobClaim>;

  finishJobRun(
    jobName: string,
    runId: string,
    invocation: PlatformJobInvocation,
    status: PlatformJobFinishStatus,
    result: PlatformJobFinishSummary,
    extraMetadata?: Record<string, unknown>,
  ): Promise<boolean>;

  readJobBackstopState(jobName: string): Promise<PlatformJobBackstopState | null>;

  readLatestTerminalRunMetadata(jobName: string): Promise<Record<string, unknown> | null>;
}
