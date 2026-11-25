import pg from 'pg';
import { createPostgresGatewayTypeOverrides } from '@openlup/platform/data';
import { createPostgresPlatformJobRunLedger } from '@openlup/platform/job-ledger';
import { createPlatformControlPlanePort, runControlPlaneWatchdogTick } from '@openlup/platform/operations/server';
import { createPostgresPromotionClaimSweepPort } from '@openlup/platform/promotions';
import { runScheduledJob } from '@openlup/platform/scheduler';
import { configurations } from '../owned/store.config.ts';
import { isConfigurationId, type StoreConfig } from '../shared/config.ts';
import { assertRenewalConfig } from '../shared/renewal-config.ts';
import { demoIdentifier } from './editor-catalogue.ts';

const sweep = 'promotion-claim-sweep';
const watchdog = 'platform-watchdog';
const seconds = 300;
const schedule = '*/5 * * * *';
const invocation = { triggerKind: 'scheduler' as const, invocationSource: 'starter-catalogue' };
const empty = { checked: 0, updated: 0, failures: 0, skipped: false };
const wait = 'Wait for a scheduled tick or restart the database-backed host.';

export function catalogueWatchdogPrincipalId(config: StoreConfig): string {
  return demoIdentifier(config, 'control-plane-operator', watchdog);
}

export function catalogueFailedJobFilter() {
  const remedies = new Map<string, string | null>([[sweep, wait], [watchdog, wait]]);
  for (const [id, config] of Object.entries(configurations)) {
    if (!isConfigurationId(id) || id !== config?.id) continue;
    const command = (action: string) => `./lifecycle ${action} --configuration ${id} --database-url <runtime-url>`;
    remedies.set(`subscription-care:${id}`, command('care'));
    remedies.set(`starter-checkout:${id}`, command('checkout-recovery'));
    try { assertRenewalConfig(config.renewal, config.market.locales); } catch { continue; }
    const renewal = `subscription-renewal:${config.renewal.population}`;
    remedies.set(renewal, remedies.has(renewal) ? null : command('renewal'));
  }
  return (value: unknown): string[] => Array.isArray(value)
    ? [...new Set(value.filter((name): name is string => typeof name === 'string' && !!remedies.get(name)))].sort()
    : [];
}

const infrastructure = 'Verify the connection and TLS, PostgreSQL driver, runtime role and grants, and qualified migrations.';
const principalFix = 'Verify the starter catalogue watchdog control-plane principal using the installed starter guide.';
function diagnostic(code: string, observed: string, cause: string, fix: string) {
  process.stderr.write(`OPENLUP_E_STARTER_CATALOGUE_${code}\nObserved: ${observed}\nCause: ${cause}\nFix: ${fix}\nRecheck: ${wait} Verify the latest job evidence.\n`);
}
function skipped(job: 'SWEEP' | 'WATCHDOG', reason: string) {
  if (reason === 'job_disabled' || reason === 'inactive_driver')
    diagnostic(`${job}_${reason.toUpperCase()}`, 'The scheduled job was skipped.',
      reason === 'job_disabled' ? 'The job control is disabled.' : 'The active driver is different.',
      'Have the job owner verify ownership and lease state, then enable the control or assign scheduler.');
}

async function postgresNow(db: pg.PoolClient): Promise<string> {
  const at = (await db.query('SELECT clock_timestamp() AS at')).rows[0]?.at;
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) throw new Error('starter_catalogue_clock_unavailable');
  return at;
}

export function startCatalogueReadinessJobs(connectionString: string, principal: string) {
  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 2000, lock_timeout: 2000,
    statement_timeout: 4000, types: createPostgresGatewayTypeOverrides(pg.TypeOverrides) });
  const filterFailedJobs = catalogueFailedJobFilter();
  let stopped = false;
  let client: pg.PoolClient | undefined;
  let inFlight: Promise<void> | undefined;
  const unavailable = (job: 'SWEEP' | 'WATCHDOG') => diagnostic(`${job}_UNAVAILABLE`,
    'The readiness job did not finish.', 'The native job or its ledger failed.', infrastructure);
  pool.on('error', () => { if (!stopped) unavailable('WATCHDOG'); });

  async function tick() {
    const db = await pool.connect().catch(() => {
      if (!stopped) { unavailable('SWEEP'); unavailable('WATCHDOG'); }
    });
    if (!db) return;
    if (stopped) { db.release(true); return; }
    client = db;
    const ledger = createPostgresPlatformJobRunLedger(db, {
      releaseCorrelation: () => ({}), defaultFailureReason: 'starter_catalogue_job_failed',
    });
    try {
      try {
        const result = await runScheduledJob({ id: sweep, schedule, lease: { seconds },
          async run() {
            if (stopped) throw new Error('starter_catalogue_jobs_stopping');
            const counts = await createPostgresPromotionClaimSweepPort(db).sweep({
              now: await postgresNow(db), limit: 50, claimLeaseMinutes: 15, graceMinutes: 5,
            });
            return { ...empty, checked: counts.checked, updated: counts.cancelled };
          },
        }, { invocation, lease: ledger });
        if (result.status === 'skipped') skipped('SWEEP', result.reason);
      } catch { if (!stopped) unavailable('SWEEP'); }
      if (stopped) return;
      const { rows: [binding] } = await db.query(`SELECT
        (SELECT active FROM public.platform_control_operators WHERE principal_id=$1) AS active,
        EXISTS(SELECT 1 FROM public.platform_human_principals WHERE principal_id=$1) AS human`, [principal]);
      if (stopped) return;
      if (binding?.human === true || binding?.active !== true) {
        const cause = binding?.human === true ? 'CONFLICT' : binding?.active === false ? 'INACTIVE' : 'MISSING';
        diagnostic(`WATCHDOG_PRINCIPAL_${cause}`, 'The starter catalogue watchdog principal could not be used.',
          { CONFLICT: 'The identity belongs to a human principal.', INACTIVE: 'The control-plane operator is inactive.',
            MISSING: 'The control-plane operator is missing.' }[cause], principalFix);
        return;
      }
      await runScheduledJob({ id: watchdog, schedule, async run() {
        const claim = await ledger.claimJobRun(watchdog, invocation, seconds);
        if (!claim.acquired) { skipped('WATCHDOG', claim.reason); return; }
        if (!claim.runId) throw new Error('starter_catalogue_watchdog_claim_missing');
        try {
          if (stopped) throw new Error('starter_catalogue_jobs_stopping');
          await db.query('BEGIN');
          const tick = await runControlPlaneWatchdogTick(createPlatformControlPlanePort(db, principal), new Date(await postgresNow(db)), false);
          if (tick.body.heartbeatRecorded !== true || tick.body.replayed !== false
            || !await ledger.finishJobRun(watchdog, claim.runId, invocation, 'success', empty,
              { failedJobs: filterFailedJobs(tick.body.failedJobs) })) throw new Error('starter_catalogue_watchdog_finish_refused');
          await db.query('COMMIT');
        } catch (error) {
          await db.query('ROLLBACK').catch(() => {});
          await ledger.finishJobRun(watchdog, claim.runId, invocation, 'failed', { ...empty, failures: 1 });
          throw error;
        }
      } }, { invocation });
    } finally {
      if (client === db) { client = undefined; db.release(); }
    }
  }

  const queueTick = () => {
    if (stopped || inFlight) return;
    inFlight = tick().catch(() => { if (!stopped) unavailable('WATCHDOG'); }).finally(() => { inFlight = undefined; });
  };
  const initial = setImmediate(queueTick).unref();
  const timer = setInterval(queueTick, seconds * 1000).unref();

  return async function close() {
    if (stopped) return;
    stopped = true;
    clearImmediate(initial);
    clearInterval(timer);
    let deadline: NodeJS.Timeout | undefined;
    try {
      if (inFlight) await Promise.race([inFlight, new Promise<void>(resolve => { deadline = setTimeout(resolve, 5000); })]);
    } finally {
      clearTimeout(deadline);
      if (client) { const db = client; client = undefined; db.release(true); }
      void pool.end().catch(() => {});
    }
  };
}
