import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runManagedCompatPostgres } from '../helpers/managedCompatPostgres.js';
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from '../helpers/postgresContainer.js';

let container: PostgresContainer | undefined;
let pool: Pool;
beforeAll(async () => {
  container = await runManagedCompatPostgres({ name: `fulfillment-outcomes-pgtap-${process.pid}`, password: 'synthetic-conformance' });
  pool = new Pool({ connectionString: container.connectionString });
  await pool.query('DROP SCHEMA auth CASCADE; DROP OWNED BY anon,authenticated,service_role CASCADE; DROP ROLE anon,authenticated,service_role');
  const manifest = JSON.parse(readFileSync('config/platform-migration-manifest.json', 'utf8'));
  for (const unit of [manifest.baseline, ...manifest.forward]) await pool.query(readFileSync(unit.file, 'utf8'));
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions');
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(container, pool), postgresTeardownTimeoutMs);
it('retains neutral failure diagnostics and customer-role refusals through native SQL', async () => {
  const db = await pool.connect();
  try {
    await db.query('SET search_path=public,extensions');
    const response = await db.query(readFileSync('tests/postgres/fixtures/fulfillmentDispatch/outcomes.sql', 'utf8'));
    const results = Array.isArray(response) ? response : [response];
    const lines = results.flatMap(result => result.rows.flatMap((row: Record<string, unknown>) => Object.values(row).filter((v): v is string => typeof v === 'string')));
    expect(lines.filter(line => /^(?:not ok|# Looks like)/u.test(line))).toEqual([]);
    expect(lines.filter(line => /^ok \d+/u.test(line))).toHaveLength(8);
  } finally { await db.query('ROLLBACK'); db.release(); }
});
