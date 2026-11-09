import { authorizeCron } from '../scheduler/index.js';
import type { HttpRequest } from '../http/index.js';
import type { PlatformJobInvocation, PlatformJobRunLedgerPort } from '../job-ledger/index.js';

/** Authenticated host invocation; disabled exits before constructing persistence or claiming a lease. */
export function createCheckoutRecoveryWaveJob(options: {
  enabled(): boolean;
  jobName: string;
  leaseSeconds: number;
  batchSize: number;
  bind(): Promise<{
    ledger: Pick<PlatformJobRunLedgerPort, 'claimJobRun' | 'finishJobRun'>;
    enqueue(limit: number, now: string): Promise<{ enqueued_1h: number; enqueued_20h: number }>;
  }>;
}) {
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 1000
    || !Number.isInteger(options.leaseSeconds) || options.leaseSeconds < 1) throw new Error('checkout_recovery_job_options_invalid');
  return async (invocation: PlatformJobInvocation, now: string) => {
    if (!options.enabled()) return { ok: true, skipped: true, reason: 'checkout_recovery_disabled' };
    const context = await options.bind();
    const lease = await context.ledger.claimJobRun(options.jobName, invocation, options.leaseSeconds);
    if (!lease.acquired || !lease.runId) return { ok: true, skipped: true, reason: lease.reason };
    let ok = true;
    let result = { enqueued_1h: 0, enqueued_20h: 0 };
    try { result = await context.enqueue(options.batchSize, now); }
    catch { ok = false; }
    const count = result.enqueued_1h + result.enqueued_20h;
    // Finishing cannot change the enqueue result; lease expiry remains the recovery route.
    try {
      await context.ledger.finishJobRun(options.jobName, lease.runId, invocation, ok ? 'success' : 'failed',
        { checked: count, updated: count, failures: ok ? 0 : 1, skipped: false,
          ...(ok ? {} : { reason: 'checkout_recovery_enqueue_failed' }) }, result);
    } catch { /* The bounded lease remains durable. */ }
    return { ok, ...result };
  };
}

/** Method/bearer guard precedes the job's flag and every persistence operation. */
export function createCheckoutRecoveryWaveHttpEntry(
  job: ReturnType<typeof createCheckoutRecoveryWaveJob>,
  host: { secret(): string | undefined; invocationSource: string; now(): string },
) {
  return async (request: HttpRequest) => {
    const denied = authorizeCron(request, { CRON_SECRET: host.secret() });
    if (denied) return denied;
    const body = await job({ triggerKind: 'scheduler', invocationSource: host.invocationSource }, host.now());
    return { status: body.ok ? 200 : 502, body };
  };
}
