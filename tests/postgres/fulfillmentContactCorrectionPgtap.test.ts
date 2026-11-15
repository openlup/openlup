import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runManagedCompatPostgres } from '../helpers/managedCompatPostgres.js';
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from '../helpers/postgresContainer.js';
let container: PostgresContainer | undefined, pool: Pool, db: PoolClient;
beforeAll(async () => {
  container = await runManagedCompatPostgres({ name: `contact-correction-pgtap-${process.pid}`, password: 'synthetic-conformance' });
  pool = new Pool({ connectionString: container.connectionString.replace('postgres://postgres:', 'postgres://supabase_admin:') });
  db = await pool.connect();
  await db.query('DROP SCHEMA auth CASCADE; DROP OWNED BY anon,authenticated,service_role CASCADE; DROP ROLE anon,authenticated,service_role; CREATE ROLE service_role');
  const manifest = JSON.parse(readFileSync('config/platform-migration-manifest.json', 'utf8'));
  for (const unit of [manifest.baseline, ...manifest.forward]) await db.query(readFileSync(unit.file, 'utf8'));
  await db.query('CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions; SET search_path=public,extensions');
}, postgresSetupTimeoutMs);
afterAll(async () => { db?.release(); await closePostgres(container, pool); }, postgresTeardownTimeoutMs);
it('runs contact correction, digest, retained replay and erasure pgTAP through the required test aggregate', async () => {
  try {
    const response = await db.query(readFileSync('tests/postgres/fixtures/fulfillmentContactCorrection.sql', 'utf8'));
    const lines = (Array.isArray(response) ? response : [response]).flatMap(result => result.rows.flatMap((row: Record<string, unknown>) => Object.values(row).filter((value): value is string => typeof value === 'string')));
    expect(lines.filter(line => /^(?:not ok|# Looks like)/u.test(line))).toEqual([]);
    expect(lines.filter(line => /^(?:ok|not ok) \d+/u.test(line))).toHaveLength(15);
  } finally { await db.query('ROLLBACK'); }
});
