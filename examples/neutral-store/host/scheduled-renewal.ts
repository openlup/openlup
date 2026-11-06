import pg from 'pg';
import { createHash } from 'node:crypto';
import { buildSchemaObjectProbe } from '@openlup/core/readiness';
import { createNativeRenewalCodec, createPostgresRenewalSettlementPort } from '@openlup/platform/subscriptions';
import { createPostgresRenewalReservationPort } from '@openlup/platform/inventory';
import type { StoreConfig } from '../shared/config.ts';
import { assertRenewalConfig } from '../shared/renewal-config.ts';
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
      native: { executor: pool, withTransaction, codec, settlement: db => createPostgresRenewalSettlementPort(db, codec),
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
