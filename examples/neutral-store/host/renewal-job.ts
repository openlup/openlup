import { findPackageJSON } from 'node:module';
import { readFileSync } from 'node:fs';
import { createSubscriptionContribution } from '@openlup/platform/composition';
import { createPostgresPlatformJobRunLedger } from '@openlup/platform/job-ledger';
import { createNativeSubscriptionBinding } from '@openlup/platform/subscriptions';
import { assertRenewalConfig, type RenewalConfig } from '../shared/renewal-config.ts';

type NativeInput = Parameters<typeof createNativeSubscriptionBinding>[0];
type Executor = NativeInput['executor'];
type WithSession = <T>(work: (db: Executor) => Promise<T>) => Promise<T>;

export function summarizeRenewalRun(value: unknown) {
  if (!value || typeof value !== 'object' || !('renewals' in value) || !('retries' in value)
    || !Array.isArray(value.renewals) || !Array.isArray(value.retries)) throw new Error('starter_renewal_result_invalid');
  const rows: unknown[] = [...value.renewals, ...value.retries];
  let updated = 0, failures = 0, deferred = 0, errors = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !('status' in row) || typeof row.status !== 'string') throw new Error('starter_renewal_result_invalid');
    if (row.status === 'succeeded') updated++;
    else if (row.status === 'refused') failures++;
    else if (['error', 'frozen_mandate_mismatch', 'failure_handoff_failed'].includes(row.status)) { failures++; errors++; }
    else if (['deferred', 'lease_active', 'awaiting_provider', 'pending'].includes(row.status)) deferred++;
    else if (row.status !== 'terminal_replay') throw new Error('starter_renewal_result_invalid');
  }
  return { checked: rows.length, updated, failures, deferred, errors };
}

/** A selected schedule, never a timer, browser action or another server. */
export function createRenewalJob(input: {
  config: RenewalConfig;
  native: Omit<NativeInput, 'enabled' | 'batchLimit' | 'population' | 'withRunLease'>;
  withSession: WithSession;
  /** Refresh server method/authorization facts only after acquiring the population. */
  beforeRun(): Promise<void>;
}) {
  assertRenewalConfig(input.config);
  const config = input.config;
  const metadata = findPackageJSON('@openlup/platform/composition', import.meta.url);
  if (!metadata) throw new Error('starter_renewal_artifact_unavailable');
  const version: unknown = JSON.parse(readFileSync(metadata, 'utf8')).version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('starter_renewal_artifact_unavailable');
  const jobName = `subscription-renewal:${config.population}`;
  const invocation = { triggerKind: 'scheduler' as const, invocationSource: 'starter-lifecycle' };
  const binding = createNativeSubscriptionBinding({ ...input.native,
    enabled: config.enabled, batchLimit: config.batchLimit, population: config.population,
    async withRunLease(population, work) {
      return input.withSession(async db => {
        // Keep a long-running callback excluded even when its durable lease time
        // passes. Process death releases this session; the ledger retains expiry.
        const key = `subscription-renewal:${population}`;
        if ((await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [key])).rows[0]?.acquired !== true) return null;
        try {
          const ledger = createPostgresPlatformJobRunLedger(db, {
            releaseCorrelation: () => ({ artifact: version, schema: input.native.catalogue.version }), defaultFailureReason: 'renewal_run_failed',
          });
          const claim = await ledger.claimJobRun(jobName, invocation, config.leaseSeconds);
          if (!claim.acquired || !claim.runId) return null;
          let value;
          try {
            await input.beforeRun();
            value = await work();
          } catch (error) {
            await ledger.finishJobRun(jobName, claim.runId, invocation, 'failed', {
              checked: 0, updated: 0, failures: 1, skipped: false, reason: 'renewal_run_unavailable',
            }, { deferred: 0, countsAvailable: false });
            throw error;
          }
          const counts = summarizeRenewalRun(value);
          if (!await ledger.finishJobRun(jobName, claim.runId, invocation, counts.errors ? 'failed' : 'success', {
            checked: counts.checked, updated: counts.updated, failures: counts.failures, skipped: false,
            ...(counts.errors ? { reason: 'renewal_row_error' } : {}),
          }, { deferred: counts.deferred, countsAvailable: true })) throw new Error('starter_renewal_lease_lost');
          return value;
        } finally { await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]); }
      });
    },
  });
  return { ...binding, ...createSubscriptionContribution({ version,
    requiredSchema: binding.schema, cadenceSeconds: config.cadenceSeconds, run: binding.services.run }) };
}

/** Probe before any native or job claim; missing installation is a refusal, never a grant workaround. */
export async function renewalLedgerReady(db: Executor): Promise<boolean> {
  const row = (await db.query(`SELECT
    to_regprocedure('public.platform_claim_job_run_v3(text,text,text,integer,jsonb)') IS NOT NULL
    AND to_regprocedure('public.platform_finish_job_run_v3(text,uuid,text,integer,integer,text,text,jsonb)') IS NOT NULL AS installed`)).rows[0];
  if (row?.installed !== true) return false;
  return (await db.query(`SELECT
    has_function_privilege(current_user,'public.platform_claim_job_run_v3(text,text,text,integer,jsonb)','EXECUTE')
    AND has_function_privilege(current_user,'public.platform_finish_job_run_v3(text,uuid,text,integer,integer,text,text,jsonb)','EXECUTE') AS allowed`)).rows[0]?.allowed === true;
}
