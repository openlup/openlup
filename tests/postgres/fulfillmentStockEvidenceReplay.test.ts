import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FULFILLMENT_MIGRATIONS, createPostgresFulfillmentStockSyncPort } from '@openlup/platform/fulfillment';
import * as fulfillment from '@openlup/platform/fulfillment';
import { createPostgresMigrationRunner } from '../../server/adapters/postgres/migrationRunner.js';
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from '../../server/adapters/postgres/selectedCatalogProjection.js';
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from '../helpers/postgresContainer.js';
import { executor, manifest, units } from '../helpers/fulfillmentNative.js';

// The shared helper's pinned PostgreSQL 16 image.
const image = 'ghcr.io/openlup/library/postgres@sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97';
const file = 'db/platform/migrations/20261022165000_fulfillment_stock_evidence_replay_reopen.sql';
const signature = 'public.fulfillment_record_stock_evidence(text,text,text,text,text,text,integer,integer)';
const stockForward = 'db/platform/migrations/20261125130000_fulfillment_stock_seed_outcome.sql';
const reminderForward = 'db/platform/migrations/20261125140000_checkout_recovery_reminder_install_outcome.sql';
const stockConflict = 'fulfillment_stock_current_idempotency_conflict';
const stockDetail = 'openlup:stock_current:replay_conflict';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
let container: PostgresContainer | undefined;
let pool: Pool;
let prefixContainer: PostgresContainer, prefixPool: Pool;
const ownedContainers: PostgresContainer[] = [], ownedPools: Pool[] = [];
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
async function currentInput(db: Pool | PoolClient, sku: string, quantity = 1) {
  const { synced, stale } = (await db.query("SELECT now() AS synced, now()+interval '1 day' AS stale")).rows[0];
  const lastSyncedAt = synced.toISOString();
  return { requestKey: `current:${sku}`, inventoryClass: 'sellable' as const, lastSyncedAt, staleAfter: stale.toISOString(),
    snapshot: { providerRef: 'fixture', collectedAt: lastSyncedAt, sourceRevision: null, revisionSource: 'collection' as const,
      quantityKind: 'snapshot' as const, skuRef: sku, totalQuantity: quantity, forSaleQuantity: quantity,
      reservedOrUnavailableQuantity: 0, syncRunId: 'fixture-current' } };
}
const changedCurrent = (value: Awaited<ReturnType<typeof currentInput>>) => ({
  ...value, snapshot: { ...value.snapshot, totalQuantity: value.snapshot.totalQuantity + 1 },
});
async function currentState(db: Pool | PoolClient) {
  const stock = await db.query('SELECT * FROM public.fulfillment_stock_current ORDER BY source_key,sku');
  const operations = await db.query('SELECT * FROM public.fulfillment_stock_operations ORDER BY idempotency_key');
  return { stock: stock.rows, operations: operations.rows };
}
beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error('Stock evidence replay proof requires Docker PostgreSQL');
  const started = Date.now();
  container = await runPostgresContainer({ name: `m08-stock-replay-${process.pid}`, password: 'synthetic-conformance', image });
  ownedContainers.push(container);
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error('Stock evidence PostgreSQL unavailable');
  pool = new Pool({ connectionString: container.connectionString });
  ownedPools.push(pool);
  prefixContainer = await runPostgresContainer({ name: `m08-stock-prefix-${process.pid}`, password: 'synthetic-conformance', image });
  ownedContainers.push(prefixContainer);
  if (!await waitForPostgresTcpReady(prefixContainer.connectionString)) throw new Error('Stock evidence predecessor PostgreSQL unavailable');
  prefixPool = new Pool({ connectionString: prefixContainer.connectionString });
  ownedPools.push(prefixPool);
  await runner(pool).apply();
  console.log(`M08 stock replay image=${image}; full-chain setup ms=${Date.now() - started}`);
}, postgresSetupTimeoutMs);
afterAll(async () => { await closePostgres(ownedContainers, ownedPools); }, postgresTeardownTimeoutMs);

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

it('observes the first batch insert before the later conflict rolls back stock and operations', async () => {
  const { rows } = await pool.query("SELECT sku FROM unnest(ARRAY['batch-a','batch-z']) AS sku ORDER BY sku");
  const earlier = await currentInput(pool, rows[0].sku);
  const later = await currentInput(pool, rows[1].sku);
  const client = await pool.connect();
  const notices: string[] = [];
  const notice = ({ message }: { message?: string }) => { if (message) notices.push(message); };
  client.on('notice', notice);
  try {
    const writer = port(client);
    await writer.recordProviderStockCurrent(later);
    await client.query(`CREATE FUNCTION public.fixture_current_inserted() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE NOTICE 'inserted stock for %', NEW.sku; RETURN NEW; END $$;
      CREATE TRIGGER fixture_current_inserted AFTER INSERT ON public.fulfillment_stock_current
        FOR EACH ROW EXECUTE FUNCTION public.fixture_current_inserted()`);
    const before = await currentState(client);
    expect(before.stock.some(row => row.sku === earlier.snapshot.skuRef)).toBe(false);
    const batch = writer.recordProviderStockCurrentBatch!;
    // Submit out of order to prove the statement's SQL-side ordering.
    const rejection = await batch([changedCurrent(later), earlier]).catch((error: unknown) => error);
    expect(rejection).toMatchObject({ code: '23505', message: stockConflict });
    expect(notices).toContain(`inserted stock for ${earlier.snapshot.skuRef}`);
    expect(await currentState(client)).toEqual(before);
    expect(await batch([later, earlier])).toEqual([{ replayed: true, readBack: true }, { replayed: false, readBack: true }]);
    expect(await currentState(client)).toMatchObject({
      stock: expect.arrayContaining([expect.objectContaining({ sku: earlier.snapshot.skuRef })]),
      operations: expect.arrayContaining([expect.objectContaining({ idempotency_key: earlier.requestKey })]),
    });
    expect(rejection).toHaveProperty('detail', stockDetail);
  } finally {
    await client.query('DROP TRIGGER IF EXISTS fixture_current_inserted ON public.fulfillment_stock_current; DROP FUNCTION IF EXISTS public.fixture_current_inserted()');
    client.off('notice', notice);
    client.release();
  }
});

it('preserves the PostgreSQL quantity and timestamp boundaries and does not classify invalid writes as replays', async () => {
  const value = await currentInput(pool, 'current-boundary', 2147483647);
  await expect(port().recordProviderStockCurrent(value)).resolves.toEqual({ replayed: false, readBack: true });
  await expect(port().recordProviderStockCurrent(await currentInput(pool, 'current-zero', 0))).resolves.toEqual({ replayed: false, readBack: true });
  for (const [invalid, code] of [
    [await currentInput(pool, 'current-overflow', 2147483648), '22003'],
    [await currentInput(pool, 'current-negative', -1), '23514'],
    [{ ...value, requestKey: 'bad-date', lastSyncedAt: 'invalid timestamp' }, '22007'],
    [{ ...value, requestKey: 'bad-window', staleAfter: value.lastSyncedAt }, '23514'],
  ] as const) {
    await expect(port().recordProviderStockCurrent(invalid)).rejects.toMatchObject({ code });
  }
});

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
  // Roles belong to the cluster: use the separately owned prefix cluster,
  // acquired before the test body, rather than a second database in this one.
  await closePostgres(container, pool);
  container = prefixContainer;
  const upgrade = prefixPool;
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

    const prior = JSON.parse(execFileSync('git', ['show', 'b79e94360:config/platform-migration-manifest.json'], { encoding: 'utf8' }));
    const previousUnits = prior.forward.slice(projection.position);
    for (const { file: path } of previousUnits) writeFileSync(join(root, path), readFileSync(path));
    writeFileSync(join(root, 'config/platform-migration-manifest.json'), JSON.stringify({
      ...manifest, forward: prior.forward, objectInventorySha256: prior.objectInventorySha256,
    }));
    expect((await runner(upgrade, root).apply()).applied).toEqual(previousUnits.map(({ file: path }: { file: string }) => path));
    const stockHistory = (await upgrade.query('SELECT * FROM public.platform_schema_migrations ORDER BY position')).rows;
    const current = await currentInput(upgrade, 'current-upgrade');
    let driver: unknown;
    const writer = createPostgresFulfillmentStockSyncPort({ async query(sql, values) {
      try { return await upgrade.query(sql, values); }
      catch (error) { driver = error; throw error; }
    } }, { sourceKey: 'fixture-stock-replay', async readLocalInventoryStock() { return []; } });
    expect(await writer.recordProviderStockCurrent(current)).toEqual({ replayed: false, readBack: true });
    const later = await currentInput(upgrade, current.snapshot.skuRef, 4);
    expect(await writer.recordProviderStockCurrent({ ...later, requestKey: 'current-upgrade-later' })).toEqual({ replayed: false, readBack: true });
    const changed = changedCurrent(current);
    const raw = await writer.recordProviderStockCurrent(changed).catch((error: unknown) => error);
    expect(raw).toBe(driver);
    expect(raw).toMatchObject({ code: '23505', message: stockConflict });
    expect((raw as { detail?: string }).detail).toBeUndefined();
    const replaced = 'public.fulfillment_record_stock_current(text,text,text,text,integer,integer,integer,text,timestamptz,timestamptz,text)';
    const stockHeader = (await upgrade.query(attributes, [replaced])).rows;
    const stockBefore = await currentState(upgrade);
    const fresh = runner(upgrade);
    const expectedForwards = [stockForward, reminderForward];
    expect((await fresh.apply()).applied).toEqual(manifest.forward.map(unit => unit.file).filter(path => path > prior.forward.at(-1).file));
    expect((await upgrade.query('SELECT * FROM public.platform_schema_migrations ORDER BY position')).rows.slice(0, stockHistory.length)).toEqual(stockHistory);
    expect((await upgrade.query(attributes, [replaced])).rows).toEqual(stockHeader);
    const nominal = await writer.recordProviderStockCurrent(changed).catch((error: unknown) => error);
    expect(nominal).toMatchObject({ name: 'FulfillmentStockReplayConflictError', message: stockConflict });
    expect(nominal).toBeInstanceOf(Reflect.get(fulfillment, 'FulfillmentStockReplayConflictError'));
    expect((nominal as Error).cause).toBe(driver);
    expect(driver).toMatchObject({ code: '23505', message: stockConflict, detail: stockDetail });
    const invalid = { ...current, requestKey: 'invalid-current-upgrade', staleAfter: current.lastSyncedAt };
    const operational = await writer.recordProviderStockCurrent(invalid).catch((error: unknown) => error);
    expect(operational).toBe(driver);
    expect(operational).toMatchObject({ code: '23514' });
    expect(await writer.recordProviderStockCurrent(current)).toEqual({ replayed: true, readBack: true });
    expect(await currentState(upgrade)).toEqual(stockBefore);
    const session = await upgrade.connect();
    try {
      await session.query('BEGIN');
      await expect(port(session).recordProviderStockCurrent(changed)).rejects.toBeInstanceOf(Reflect.get(fulfillment, 'FulfillmentStockReplayConflictError'));
      await expect(session.query('SELECT 1')).rejects.toMatchObject({ code: '25P02' });
    } finally { await session.query('ROLLBACK'); session.release(); }
    expect(manifest.forward.slice(stockHistory.length - 1).map(unit => unit.file).slice(0, 2)).toEqual(expectedForwards);
    expect(await fresh.apply()).toEqual({ applied: [] });
  } finally { await closePostgres(undefined, upgrade); rmSync(root, { recursive: true, force: true }); }
}, 120_000);
