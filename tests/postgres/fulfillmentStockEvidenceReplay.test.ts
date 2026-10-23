import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FULFILLMENT_MIGRATIONS, createPostgresFulfillmentStockSyncPort } from '@openlup/platform/fulfillment';
import { createPostgresMigrationRunner } from '../../server/adapters/postgres/migrationRunner.js';
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from '../../server/adapters/postgres/selectedCatalogProjection.js';
import { dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from '../helpers/postgresContainer.js';
import { executor, manifest, units } from '../helpers/fulfillmentNative.js';

// Operational dependency: PR #315's existing PG16 mirror, never an anonymous tag.
const image = 'ghcr.io/openlup/library/postgres@sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97';
const file = 'db/platform/migrations/20261022165000_fulfillment_stock_evidence_replay_reopen.sql';
const signature = 'public.fulfillment_record_stock_evidence(text,text,text,text,text,text,integer,integer)';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
let container: PostgresContainer | undefined;
let pool: Pool;
const port = (db: Pool | PoolClient = pool) => createPostgresFulfillmentStockSyncPort(executor(db), {
  sourceKey: 'fixture-stock-replay', async readLocalInventoryStock() { return []; },
});
const evidence = (key: string) => ({ requestKey: key, skuRef: `sku-${key}`, thresholdKind: 'safety_stock' as const,
  severity: 'warning' as const, providerForSaleQuantity: 3, localAvailableQuantity: 4, syncRunId: 'run-first' });
const row = async (key: string, db = pool) => (await db.query(
  'SELECT to_jsonb(e) AS value FROM public.fulfillment_stock_evidence e WHERE idempotency_key=$1', [key],
)).rows[0].value;
const resolve = (value: ReturnType<typeof evidence>, syncRunId: string, db: Pool | PoolClient = pool) =>
  port(db).resolveLowStockEvidence({ skuRef: value.skuRef, activeThresholdKinds: [], syncRunId });
const runner = (db: Pool, root = process.cwd()) => createPostgresMigrationRunner(
  { connectionString: container!.connectionString }, { root, poolFactory: () => db },
);
async function inventory(db: Pool | PoolClient) {
  const client = db instanceof Pool ? await db.connect() : db;
  try { return hash(selectedCatalogProjectionPayload(await readSelectedCatalogProjection(client))); }
  finally { if (db instanceof Pool) client.release(); }
}
beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error('Stock evidence replay proof requires Docker PostgreSQL');
  const started = Date.now();
  container = await runPostgresContainer({ name: `m08-stock-replay-${process.pid}`, password: 'synthetic-conformance', image });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error('Stock evidence PostgreSQL unavailable');
  pool = new Pool({ connectionString: container.connectionString });
  await runner(pool).apply();
  console.log(`M08 stock replay image=${image}; full-chain setup ms=${Date.now() - started}`);
}, 120_000);
afterAll(async () => { if (pool && !pool.ended) await pool.end(); await container?.remove(); });

it('inserts, refreshes observations with stable identity, resolves, reopens and resolves exactly once again', async () => {
  const value = evidence('lifecycle');
  expect(await port().recordLowStockEvidence(value)).toEqual({ replayed: false });
  const first = await row(value.requestKey);
  const changed = { ...value, severity: 'critical' as const, providerForSaleQuantity: 1, localAvailableQuantity: 2, syncRunId: 'run-next' };
  expect(await port().recordLowStockEvidence(changed)).toEqual({ replayed: true });
  const refreshed = await row(value.requestKey);
  expect(refreshed).toMatchObject({ id: first.id, first_seen_at: first.first_seen_at, operation_fingerprint: first.operation_fingerprint,
    status: 'open', severity: 'critical', provider_for_sale_quantity: 1, local_available_quantity: 2 });
  expect((await pool.query('SELECT $1::timestamptz > $2::timestamptz AS later', [refreshed.last_seen_at, first.last_seen_at])).rows[0].later).toBe(true);
  expect(await resolve(value, 'run-resolved')).toEqual({ resolved: 1 });
  expect(await row(value.requestKey)).toMatchObject({ status: 'resolved', resolved_at: expect.any(String), last_sync_run_id: 'run-resolved' });
  expect(await port().recordLowStockEvidence({ ...changed, severity: 'info', providerForSaleQuantity: 7, localAvailableQuantity: 8 })).toEqual({ replayed: true });
  expect(await row(value.requestKey)).toMatchObject({ id: first.id, first_seen_at: first.first_seen_at, status: 'open', resolved_at: null,
    severity: 'info', provider_for_sale_quantity: 7, local_available_quantity: 8, last_sync_run_id: 'run-resolved' });
  expect(await resolve(value, 'run-resolved-again')).toEqual({ resolved: 1 });
  expect(await resolve(value, 'run-repeat')).toEqual({ resolved: 0 });
  expect(await row(value.requestKey)).toMatchObject({ status: 'resolved', last_sync_run_id: 'run-resolved-again' });
});

it('reopens acknowledged evidence, clears nullable quantities and exempts active thresholds from resolution', async () => {
  const value = evidence('acknowledged');
  await port().recordLowStockEvidence(value);
  await pool.query("UPDATE public.fulfillment_stock_evidence SET status='acknowledged' WHERE idempotency_key=$1", [value.requestKey]);
  const before = await row(value.requestKey);
  // The SQL contract admits NULL; the package's observation input requires numbers.
  expect((await pool.query('SELECT public.fulfillment_record_stock_evidence($1,$2,$3,$4,$5,$6,NULL,NULL) AS value',
    [before.source_key, value.requestKey, before.operation_fingerprint, value.skuRef, value.thresholdKind, 'info'])).rows[0].value).toEqual({ replayed: true });
  const reopened = await row(value.requestKey);
  expect(reopened).toMatchObject({ id: before.id, first_seen_at: before.first_seen_at, status: 'open', severity: 'info',
    resolved_at: null, provider_for_sale_quantity: null, local_available_quantity: null });
  expect(await port().resolveLowStockEvidence({ skuRef: value.skuRef, activeThresholdKinds: ['safety_stock'], syncRunId: 'run-exempt' })).toEqual({ resolved: 0 });
  expect(await row(value.requestKey)).toEqual(reopened);
  expect(await resolve(value, 'run-inactive')).toEqual({ resolved: 1 });
});

it('refuses changed identity or opaque fingerprint with 23505 and preserves the entire row', async () => {
  const value = evidence('conflict');
  await port().recordLowStockEvidence(value);
  await resolve(value, 'run-resolved');
  const before = await row(value.requestKey);
  for (const changed of [{ ...value, skuRef: 'sku-other' }, { ...value, thresholdKind: 'reservation_coverage' as const }]) {
    await expect(port().recordLowStockEvidence(changed)).rejects.toMatchObject({ code: '23505' });
    expect(await row(value.requestKey)).toEqual(before);
  }
  await expect(pool.query('SELECT public.fulfillment_record_stock_evidence($1,$2,$3,$4,$5,$6,$7,$8)',
    [before.source_key, value.requestKey, 'f'.repeat(64), value.skuRef, value.thresholdKind, 'critical', 0, 0])).rejects.toMatchObject({ code: '23505' });
  expect(await row(value.requestKey)).toEqual(before);
});

it('refuses the legacy whole-input fingerprint under the PR1 identity without rewriting resolved history', async () => {
  const value = evidence('legacy');
  const legacy = hash(JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))));
  await pool.query('SELECT public.fulfillment_record_stock_evidence($1,$2,$3,$4,$5,$6,$7,$8)',
    ['fixture-stock-replay', value.requestKey, legacy, value.skuRef, value.thresholdKind, value.severity, value.providerForSaleQuantity, value.localAvailableQuantity]);
  await resolve(value, 'legacy-resolved');
  const before = await row(value.requestKey);
  await expect(port().recordLowStockEvidence(value)).rejects.toMatchObject({ code: '23505' });
  expect(await row(value.requestKey)).toEqual(before);
  expect(before.operation_fingerprint).toBe(legacy);
});

it('serializes existing-row replays and resolver races in lock acquisition order', async () => {
  const value = evidence('concurrent');
  await port().recordLowStockEvidence(value);
  const a = await pool.connect(), b = await pool.connect();
  async function blocked(pid: number, blocker: number) {
    // Observe the server lock, rather than assuming a timed delay proves blocking.
    await expect.poll(async () => (await pool.query('SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked', [pid, blocker])).rows[0].blocked,
      { timeout: 3_000, interval: 10 }).toBe(true);
  }
  try {
    for (const client of [a, b]) await client.query("SET lock_timeout='5s'; SET statement_timeout='8s'");
    const pidA = (await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const pidB = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await a.query('BEGIN');
    await port(a).recordLowStockEvidence({ ...value, providerForSaleQuantity: 11 });
    const replay = port(b).recordLowStockEvidence({ ...value, providerForSaleQuantity: 22, severity: 'critical' });
    await blocked(pidB, pidA);
    await a.query('COMMIT');
    expect(await replay).toEqual({ replayed: true });
    expect(await row(value.requestKey)).toMatchObject({ provider_for_sale_quantity: 22, severity: 'critical' });
    await a.query('BEGIN');
    expect(await resolve(value, 'race-resolver-first', a)).toEqual({ resolved: 1 });
    const reopen = port(b).recordLowStockEvidence({ ...value, localAvailableQuantity: 33 });
    await blocked(pidB, pidA);
    await a.query('COMMIT');
    expect(await reopen).toEqual({ replayed: true });
    expect(await row(value.requestKey)).toMatchObject({ status: 'open', resolved_at: null, local_available_quantity: 33, last_sync_run_id: 'race-resolver-first' });
    await a.query('BEGIN');
    await port(a).recordLowStockEvidence({ ...value, localAvailableQuantity: 44 });
    const resolution = resolve(value, 'race-replay-first', b);
    await blocked(pidB, pidA);
    await a.query('COMMIT');
    expect(await resolution).toEqual({ resolved: 1 });
    expect(await row(value.requestKey)).toMatchObject({ status: 'resolved', local_available_quantity: 44, last_sync_run_id: 'race-replay-first' });
  } finally {
    await a.query('ROLLBACK'); await b.query('ROLLBACK');
    await a.query('RESET lock_timeout; RESET statement_timeout'); await b.query('RESET lock_timeout; RESET statement_timeout');
    a.release(); b.release();
  }
}, 30_000);

it('binds fresh and exact-predecessor runner histories, package bytes, live inventory and unchanged function header/ACL', async () => {
  const projection = FULFILLMENT_MIGRATIONS.find(unit => unit.catalogPath === file)!;
  expect(projection.catalogPath).toBe(file);
  expect(units[projection.position]).toEqual({ file, sha256: projection.sha256 });
  // Upgrade only the prefix ending at this forward, even after later units land.
  const prefix = units.slice(0, projection.position + 1);
  const predecessor = prefix.slice(0, -1);
  expect(readFileSync(projection.url)).toEqual(readFileSync(file));
  expect(hash(readFileSync(file))).toBe('6d132dec2820047f4e337bcf752b3d884600ccc12de03887fe6d6aa5575bc1db');
  const history = (await pool.query('SELECT * FROM public.platform_schema_migrations ORDER BY position')).rows;
  expect(history.map(({ catalog_path, sha256, position }) => ({ file: catalog_path, sha256, position })))
    .toEqual(units.map((unit, position) => ({ ...unit, position })));
  expect(await runner(pool).apply()).toEqual({ applied: [] });
  expect((await pool.query('SELECT * FROM public.platform_schema_migrations ORDER BY position')).rows).toEqual(history);
  expect(await inventory(pool)).toBe(manifest.objectInventorySha256);
  // Roles belong to the cluster: a second database would collide with the
  // complete prefix's CREATE ROLE statements. Keep one owned container at a time.
  await pool.end(); await container!.remove(); container = undefined;
  container = await runPostgresContainer({ name: `m08-stock-prefix-${process.pid}`, password: 'synthetic-conformance', image });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error('Stock evidence predecessor PostgreSQL unavailable');
  const upgrade = new Pool({ connectionString: container.connectionString });
  pool = upgrade;
  const root = mkdtempSync(join(tmpdir(), 'm08-stock-prefix-'));
  try {
    const tx = await upgrade.connect();
    let predecessorInventory: string, forwardInventory: string;
    try {
      await tx.query('BEGIN');
      for (const unit of predecessor) await tx.query(readFileSync(unit.file, 'utf8'));
      predecessorInventory = await inventory(tx);
      await tx.query(readFileSync(file, 'utf8'));
      forwardInventory = await inventory(tx);
    } finally { await tx.query('ROLLBACK'); tx.release(); }
    for (const unit of predecessor) {
      const target = join(root, unit.file); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, readFileSync(unit.file));
    }
    mkdirSync(join(root, 'config'));
    writeFileSync(join(root, 'config/platform-migration-manifest.json'), JSON.stringify({ ...manifest,
      forward: manifest.forward.slice(0, projection.position - 1), objectInventorySha256: predecessorInventory }));
    await runner(upgrade, root).apply();
    const before = (await upgrade.query('SELECT * FROM public.platform_schema_migrations ORDER BY position')).rows;
    const value = evidence('upgrade');
    await port(upgrade).recordLowStockEvidence(value); await resolve(value, 'upgrade-resolved', upgrade);
    const stored = await row(value.requestKey, upgrade);
    const attributes = `SELECT oid,proowner,proacl::text,prolang,prorettype,proargtypes::text,proargnames,prosecdef,proconfig,provolatile,proparallel,proisstrict,proretset,procost,prorows
      FROM pg_proc WHERE oid=$1::regprocedure`;
    const header = (await upgrade.query(attributes, [signature])).rows;
    const acl = (await upgrade.query("SELECT oid,proacl::text FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY oid")).rows;
    writeFileSync(join(root, file), readFileSync(file));
    writeFileSync(join(root, 'config/platform-migration-manifest.json'), JSON.stringify({ ...manifest,
      forward: manifest.forward.slice(0, projection.position), objectInventorySha256: forwardInventory }));
    expect((await runner(upgrade, root).apply()).applied).toEqual([file]);
    expect((await upgrade.query('SELECT * FROM public.platform_schema_migrations ORDER BY position')).rows.slice(0, -1)).toEqual(before);
    expect(await row(value.requestKey, upgrade)).toEqual(stored);
    expect((await upgrade.query(attributes, [signature])).rows).toEqual(header);
    expect((await upgrade.query("SELECT oid,proacl::text FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY oid")).rows).toEqual(acl);
    expect(await port(upgrade).recordLowStockEvidence({ ...value, severity: 'critical' })).toEqual({ replayed: true });
    expect(await row(value.requestKey, upgrade)).toMatchObject({ status: 'open', resolved_at: null, severity: 'critical', last_sync_run_id: 'upgrade-resolved' });
    expect(await runner(upgrade, root).apply()).toEqual({ applied: [] });
    expect((await runner(upgrade, root).status()).pending).toEqual([]);
    expect(await inventory(upgrade)).toBe(forwardInventory);
  } finally { await upgrade.end(); rmSync(root, { recursive: true, force: true }); }
}, 60_000);
