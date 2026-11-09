import { findPackageJSON } from 'node:module';
import { readFileSync } from 'node:fs';
import { createPostgresTransactionalDeliveryStore } from '@openlup/platform/communications';
import { createPostgresPlatformJobRunLedger } from '@openlup/platform/job-ledger';
import { createPrivateCapture, type PrivateCapture } from './private-capture.ts';
import { createLifecycleNoticeHost, createCareCapture } from './lifecycle-notices.ts';
import pg from 'pg';
import { createHash } from 'node:crypto';
import { buildSchemaObjectProbe } from '@openlup/core/readiness';
import { createNativeRenewalCodec, createPostgresRenewalSettlementPort, createPostgresSubscriptionAutoResume, createPostgresLifecycleMessages, createPostgresSubscriptionWinback } from '@openlup/platform/subscriptions';
import { createPostgresRenewalReservationPort } from '@openlup/platform/inventory';
import type { StoreConfig } from '../shared/config.ts';
import { assertRenewalConfig, assertSubscriptionCare } from '../shared/renewal-config.ts';
import { createRenewalJob, renewalLedgerReady } from './renewal-job.ts';
import { composeRenewalSandbox } from './renewal-sandbox.ts';
import { createPaidMailHost } from './paid-mail.ts';

/** One invocation from the existing lifecycle command; construction starts no scheduler. */
export async function runScheduledRenewal(connectionString: string, config: StoreConfig) {
  assertRenewalConfig(config.renewal);
  const pool = new pg.Pool({ connectionString, max: 4 });
  try {
    const role = (await pool.query(`SELECT session_user AS login,current_user AS role,rolsuper,rolbypassrls
      FROM pg_roles WHERE rolname=current_user`)).rows[0];
    if (role?.login !== 'starter_runtime' || role.role !== 'starter_runtime'
      || role.rolsuper !== false || role.rolbypassrls !== false) throw new Error('starter_runtime_connection_required');
    const paidMail = await createPaidMailHost({ executor: pool, config }).run();
    if (!config.renewal.enabled) return { kind: 'refused' as const, code: 'disabled', paidMail };
    const withSession = async <T>(work: (db: pg.PoolClient) => Promise<T>): Promise<T> => {
      const db = await pool.connect(); try { return await work(db); } finally { db.release(); }
    };
    const withTransaction = async <T>(work: (db: pg.PoolClient) => Promise<T>): Promise<T> => withSession(async db => {
      await db.query('BEGIN');
      try { const value = await work(db); await db.query('COMMIT'); return value; }
      catch (error) { await db.query('ROLLBACK'); throw error; }
    });
    async function installedHistory() {
      const rows = (await pool.query('SELECT catalog_path,sha256,position FROM public.platform_schema_migrations ORDER BY position')).rows;
      if (!rows.length) throw new Error('starter_renewal_schema_unavailable');
      return { version: createHash('sha256').update(JSON.stringify(rows)).digest('hex'), migration: String(rows.at(-1)!.catalog_path) };
    }
    const catalogue = await installedHistory(), codec = createNativeRenewalCodec();
    const sandbox = composeRenewalSandbox({ executor: pool, withTransaction, codec, config: config.renewal,
      now: () => new Date().toISOString(), failureTemplate: config.purchase.sandbox.dunningTemplateSlug,
      recoveredTemplate: config.purchase.sandbox.recoveryTemplateSlug, recoveryPath: config.purchase.sandbox.recoveryUrlPath });
    const binding = createRenewalJob({ config: config.renewal, withSession, beforeRun: sandbox.refresh,
      native: { executor: pool, withTransaction, codec, settlement: db => createPostgresRenewalSettlementPort(db, codec, withTransaction),
        inventory: createPostgresRenewalReservationPort(pool), paymentRails: sandbox.paymentRails,
        policy: sandbox.policy, retry: sandbox.retry, failureTemplate: config.purchase.sandbox.dunningTemplateSlug,
        recoveryPath: config.purchase.sandbox.recoveryUrlPath, workerId: `starter:${config.id}`,
        now: () => new Date().toISOString(), catalogue,
        async readiness(schema) {
          const history = await installedHistory();
          const present = await Promise.all(schema.objects.map(async object => {
            const query = buildSchemaObjectProbe(object);
            return (await pool.query(query.text, [...query.values])).rows[0]?.present === true;
          }));
          const ready = history.version === schema.version && present.every(Boolean) && await renewalLedgerReady(pool);
          return { state: ready ? 'ready' : 'unsatisfied',
            candidate: { artifact: 'local-candidate', configuration: config.id, environment: 'local-demonstration',
              database: String((await pool.query('SELECT current_database() AS name')).rows[0].name), schema: history.version },
            loadedPackages: [], issues: ready ? [] : [{ code: 'OPENLUP_E_SCHEMA_BEHIND', package: '@openlup/platform',
              subject: 'subscriptions', fix: 'Complete the selected installation with its installation command.' }] };
        },
      },
    });
    return { ...await binding.services.run(), paidMail };
  } finally { await pool.end(); }
}

/** One bounded local scheduled invocation. No timer, HTTP mutation or settings seed. */
export async function runScheduledCare(connectionString: string, config: StoreConfig, options: {
  publicOrigin?: string; now?: () => string; capture?: PrivateCapture;
} = {}) {
  assertSubscriptionCare(config.renewal.subscriptionCare);
  if (!config.renewal.subscriptionCare.enabled) return { kind: 'refused' as const, code: 'disabled' };
  const pool = new pg.Pool({ connectionString, max: 4 });
  const receipts = createPostgresTransactionalDeliveryStore({ connectionString });
  const capture = options.capture ?? createPrivateCapture();
  const withSession = async <T>(work: (db: pg.PoolClient) => Promise<T>) => {
    const db = await pool.connect(); try { return await work(db); } finally { db.release(); }
  };
  const withTransaction = async <T>(work: (db: pg.PoolClient) => Promise<T>) => withSession(async db => {
    try { await db.query('BEGIN'); const value = await work(db); await db.query('COMMIT'); return value; }
    catch (error) { await db.query('ROLLBACK'); throw error; }
  });
  try {
    const role = (await pool.query(`SELECT session_user AS login,current_user AS role,rolsuper,rolbypassrls
      FROM pg_roles WHERE rolname=current_user`)).rows[0];
    if (role?.login !== 'starter_runtime' || role.role !== 'starter_runtime' || role.rolsuper !== false || role.rolbypassrls !== false) throw new Error('starter_runtime_connection_required');
    if (!await renewalLedgerReady(pool)) throw new Error('starter_care_installation_required');
    const metadata = findPackageJSON('@openlup/platform/subscriptions', import.meta.url);
    if (!metadata) throw new Error('starter_care_artifact_required');
    const version: unknown = JSON.parse(readFileSync(metadata, 'utf8')).version;
    if (typeof version !== 'string') throw new Error('starter_care_artifact_required');
    const publicOrigin = config.publicOrigin ?? options.publicOrigin ?? 'http://127.0.0.1:4319';
    const local = createLifecycleNoticeHost({ config, publicOrigin, withTransaction, capture, receipts });
    const extra = createCareCapture({ config, publicOrigin, capture, receipts });
    const notices = createPostgresLifecycleMessages({ ...local, bindOperator: extra.bindOperator,
      delivery: {
        send: command => command.recipientReference.startsWith('operator:') ? extra.delivery.send(command) : local.delivery.send(command),
        async readReceipt(key) {
          const record = await capture.read(key);
          return record && typeof record === 'object' && !Array.isArray(record) && record.kind === 'operator_escalation'
            ? extra.delivery.readReceipt(key) : local.delivery.readReceipt(key);
        },
      }, withSession, dispatch: config.renewal.subscriptionCare.dispatch, recovered: config.renewal.subscriptionCare.recovered, notices: config.renewal.subscriptionCare.notices });
    const winback = createPostgresSubscriptionWinback({ withSession, bind: extra.bindWinback, delivery: extra.delivery });
    return await withSession(async db => {
      const name = `subscription-care:${config.id}`;
      if ((await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [name])).rows[0]?.acquired !== true) return { kind: 'refused' as const, code: 'busy' };
      try {
        const ledger = createPostgresPlatformJobRunLedger(db, { releaseCorrelation: () => ({ artifact: version }), defaultFailureReason: 'care_run_failed' });
        const invocation = { triggerKind: 'scheduler' as const, invocationSource: 'starter-lifecycle' };
        const claim = await ledger.claimJobRun(name, invocation, config.renewal.subscriptionCare.leaseSeconds);
        if (!claim.acquired || !claim.runId) return { kind: 'refused' as const, code: 'busy' };
        try {
          const autoResume = await createPostgresSubscriptionAutoResume(pool).run(config.renewal.subscriptionCare.batchLimit, options.now?.());
          const messages = await notices.run(config.renewal.subscriptionCare.batchLimit);
          const retention = await winback.run(config.renewal.subscriptionCare.batchLimit);
          const result = { autoResume, messages, retention };
          await capture.writeOnce(`subscription-care-run:${claim.runId}`, JSON.parse(JSON.stringify(result)));
          if (!await ledger.finishJobRun(name, claim.runId, invocation, autoResume.failed || messages.failed || retention.failed ? 'failed' : 'success', {
            checked: autoResume.scanned + retention.scanned, updated: autoResume.resumed + messages.sent + retention.sent,
            failures: autoResume.failed + messages.failed + retention.failed, skipped: false,
          }, { countsAvailable: true })) throw new Error('starter_care_lease_lost');
          return result;
        } catch (error) {
          await ledger.finishJobRun(name, claim.runId, invocation, 'failed', { checked: 0, updated: 0, failures: 1, skipped: false, reason: 'care_run_failed' }, { countsAvailable: false });
          throw error;
        }
      } finally { await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [name]); }
    });
  } finally { await receipts.close(); await pool.end(); }
}
