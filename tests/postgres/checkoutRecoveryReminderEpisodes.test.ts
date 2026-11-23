import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { installCheckoutRecoveryReminderSchedule, readCheckoutRecoveryReminderSchedule } from '@openlup/platform/commerce/server';
import * as commerceServer from '@openlup/platform/commerce/server';
import { createPlatformPostgresMigrationRunner } from '@openlup/platform/migrations';
import type { CheckoutRecoveryReminderSchedule } from '@openlup/platform/commerce/contracts';
import { createPostgresMigrationRunner } from '../../server/adapters/postgres/migrationRunner.js';
import { qualifiedPostgresStartupOptions } from '../../server/adapters/postgres/qualifiedInstall.js';
import { readPlatformMigrations } from '../../scripts/platform-migration-manifest.js';
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from '../helpers/postgresContainer.js';

const installation = { generation: 'qualified-v2', roleMode: 'installer-managed', migrationLogin: 'postgres',
  bootstrapLogin: 'postgres', runtimeLogin: 'episode_runtime', restoreLogin: 'episode_restore' } as const;
const blockedCode = 'checkout_recovery_schedule_change_blocked_open_episodes';
const blocked = { code: '55000', message: `${blockedCode} (1 blocking orders)`,
  hint: 'The current schedule stays in effect. Retry after the blocking orders are paid, cancelled, or their carts are no longer eligible.' };
const detail = 'openlup:reminder_schedule:blocking_orders=1';
const createRoles = (connection: Pool) => connection.query('CREATE ROLE episode_runtime LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS; CREATE ROLE episode_restore LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS');
let resource: PostgresContainer | undefined, db: Pool;
let defaults: CheckoutRecoveryReminderSchedule;

beforeAll(async () => {
  resource = await runPostgresContainer({ name: `reminder-episodes-${process.pid}`, password: 'synthetic-episodes' });
  if (!await waitForPostgresTcpReady(resource.connectionString)) throw new Error('Reminder episode PostgreSQL unavailable');
  db = new Pool({ connectionString: resource.connectionString, options: qualifiedPostgresStartupOptions(installation) });
  await createRoles(db);
  await createPostgresMigrationRunner({ connectionString: resource.connectionString }, { installation, poolFactory: () => db }).apply();
  defaults = await readCheckoutRecoveryReminderSchedule(db);
}, postgresSetupTimeoutMs);

beforeEach(async () => {
  await db.query("UPDATE public.commerce_orders SET status='cancelled' WHERE status='pending_payment'");
  await db.query("DELETE FROM public.commerce_settings WHERE key='checkout_recovery_reminders'");
});
afterAll(async () => { await closePostgres(resource, db); }, postgresTeardownTimeoutMs);

function schedule(first: number, last: number): CheckoutRecoveryReminderSchedule {
  const waves = [{ stage: 'first', afterHours: first }, { stage: 'last', afterHours: last }] as const;
  return { ...defaults, revision: `fixture-${first}-${last}`, checkoutRecovery: waves, abandonedCart: waves };
}

async function order(age: number, draft = false, connection = db) {
  const id = randomUUID(), client = randomUUID();
  await connection.query('INSERT INTO public.clients(id,email,principal_id) VALUES($1,$2,$1)', [client, `${client}@example.invalid`]);
  await connection.query("INSERT INTO public.commerce_orders(id,client_id,created_at,currency_code,total_amount_minor) VALUES($1,$2,now()-make_interval(hours=>$3),'XXX',0)",
    [id, client, age]);
  if (draft) {
    await connection.query('INSERT INTO public.customer_communication_preferences(principal_id,marketing_newsletter_consent) VALUES($1,true)', [client]);
    await draftReceipt(id, `draft:${id}`, connection);
  }
  return id;
}
const draftReceipt = (id: string, key: string, connection = db) => connection.query(
  "INSERT INTO public.commerce_order_draft_receipts(idempotency_key,request_fingerprint,order_id,response_payload) VALUES($1,repeat('a',32),$2,'{}')", [key, id]);
const legacyCheckout = (id: string, connection = db) => connection.query(
  `INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload)
   VALUES('commerce_order',$1,'commerce.checkout_recovery',$2,'{"stage":"first"}')`, [id, `checkout_recovery:1h:${id}`]);
const legacyCart = (id: string) => db.query(
  `INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload)
   VALUES('commerce_order',$1,'commerce.order_draft.abandoned.1h',$2,'{}')`, [id, `abandoned_1h:${id}`]);
const invalidateDraft = (id: string) => db.query('UPDATE public.commerce_order_draft_receipts SET invalidated_at=now() WHERE order_id=$1', [id]);

function expectBlocked(error: unknown) {
  expect(error).toMatchObject({ name: 'CheckoutRecoveryScheduleChangeBlockedError', message: blockedCode, blockingOrders: '1' });
  expect(error).toBeInstanceOf(Reflect.get(commerceServer, 'CheckoutRecoveryScheduleChangeBlockedError'));
  expect((error as Error).cause).toMatchObject({ ...blocked, detail });
}

const checkout = (id: string, hours: number, client: Pool | PoolClient = db, policy: object = {}) => client.query(
  'SELECT public.commerce_enqueue_checkout_recovery_reminders(1000,$2,created_at+make_interval(hours=>$3)) AS result FROM public.commerce_orders WHERE id=$1',
  [id, policy, hours]);
const cart = (client: Pool | PoolClient = db) => client.query('SELECT public.commerce_enqueue_abandoned_cart_reminders(1000) AS result');
const accept = (waveId: string) => db.query("SELECT public.commerce_checkout_recovery_record_sent($1,'capture','fixture:accepted')", [waveId]);
const waves = (id: string, client: Pool | PoolClient = db) => client.query(
  'SELECT id,idempotency_key,payload FROM public.outbox_events WHERE aggregate_id=$1 ORDER BY idempotency_key', [id]);
const pins = (id: string, client: Pool | PoolClient = db) => client.query(
  'SELECT kind,schedule FROM public.commerce_reminder_episodes WHERE order_id=$1 ORDER BY kind', [id]);
const tokens = (id: string, client: Pool | PoolClient = db) => client.query('SELECT 1 FROM public.commerce_checkout_recovery_tokens WHERE order_id=$1', [id]);
const keys = async (id: string) => (await waves(id)).rows.map(wave => wave.idempotency_key);

it('keeps the pinned checkout follow-up and starts new orders on the changed schedule', async () => {
  await installCheckoutRecoveryReminderSchedule(db, schedule(1, 8));
  const opened = await order(3);
  await checkout(opened, 3);
  await accept((await waves(opened)).rows[0].id);
  await installCheckoutRecoveryReminderSchedule(db, schedule(2, 12));
  const fresh = await order(3);
  await checkout(opened, 7);
  expect(await keys(opened)).toEqual([`checkout_recovery:1h:${opened}`]);
  await checkout(opened, 9);
  expect(await keys(opened)).toEqual([`checkout_recovery:1h:${opened}`, `checkout_recovery:8h:${opened}`]);
  expect(await keys(fresh)).toEqual([`checkout_recovery:2h:${fresh}`]);
  expect((await pins(fresh)).rows[0].schedule[1].offsetSeconds).toBe(12 * 3600);
});

it('keeps the cart predecessor and timing when every open episode is pinned', async () => {
  await installCheckoutRecoveryReminderSchedule(db, schedule(1, 8));
  const opened = await order(3, true);
  const runtime = await db.connect();
  try {
    await runtime.query('SET ROLE episode_runtime');
    await cart(runtime);
    await expect(runtime.query('SELECT * FROM public.commerce_reminder_episodes')).rejects.toMatchObject({ code: '42501' });
  } finally { await runtime.query('RESET ROLE'); runtime.release(); }
  expect(await keys(opened)).toEqual([`abandoned_1h:${opened}`]);
  await installCheckoutRecoveryReminderSchedule(db, schedule(2, 12));
  // Age the fixture relative to the database clock instead of waiting for the next window.
  await db.query("UPDATE public.commerce_orders SET created_at=now()-interval '9 hours' WHERE id=$1", [opened]);
  await cart();
  expect(await keys(opened)).toEqual([`abandoned_1h:${opened}`]);
  await db.query("UPDATE public.outbox_events SET status='processed',processed_at=now() WHERE aggregate_id=$1", [opened]);
  await cart();
  expect(await keys(opened)).toEqual([`abandoned_1h:${opened}`, `abandoned_8h:${opened}`]);
});

it('pins effective absent-row checkout offsets and preserves nominal hourly keys', async () => {
  const opened = await order(3);
  await checkout(opened, 3, db, { firstOffsetSeconds: 7200, finalOffsetSeconds: 21600 });
  expect((await pins(opened)).rows).toEqual([{ kind: 'checkout_recovery', schedule: [
    { stage: 'first', afterHours: 1, offsetSeconds: 7200 }, { stage: 'last', afterHours: 20, offsetSeconds: 21600 },
  ] }]);
  await accept((await waves(opened)).rows[0].id);
  await installCheckoutRecoveryReminderSchedule(db, schedule(2, 12));
  await checkout(opened, 7);
  expect(await keys(opened)).toEqual([`checkout_recovery:1h:${opened}`, `checkout_recovery:20h:${opened}`]);
});

it('blocks a legacy episode of either kind even when the other kind is pinned', async () => {
  const opened = await order(3, true);
  await cart();
  expect((await pins(opened)).rows.map(pin => pin.kind)).toEqual(['abandoned_cart']);
  await legacyCheckout(opened);
  expectBlocked(await installCheckoutRecoveryReminderSchedule(db, schedule(2, 12)).catch((error: unknown) => error));
  await db.query("UPDATE public.commerce_orders SET status='cancelled' WHERE id=$1", [opened]);
  const other = await order(3, true);
  await checkout(other, 3);
  await legacyCart(other);
  expectBlocked(await installCheckoutRecoveryReminderSchedule(db, schedule(2, 12)).catch((error: unknown) => error));
});

it('drains a legacy episode on CF-R0 terms and fences it until the order closes', async () => {
  const opened = await order(3);
  const first = await db.query(`INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
    VALUES('commerce_order',$1,'commerce.checkout_recovery',$2,'{"reminderHours":1}','{"deliveryProfile":"capture"}') RETURNING id`,
  [opened, `checkout_recovery:1h:${opened}`]);
  await accept(first.rows[0].id);
  await checkout(opened, 21);
  expect(await keys(opened)).toEqual([`checkout_recovery:1h:${opened}`, `checkout_recovery:20h:${opened}`]);
  expect((await pins(opened)).rows).toEqual([]);
  expectBlocked(await installCheckoutRecoveryReminderSchedule(db, schedule(2, 12)).catch((error: unknown) => error));
  await db.query("UPDATE public.commerce_orders SET status='cancelled' WHERE id=$1", [opened]);
  await installCheckoutRecoveryReminderSchedule(db, schedule(2, 12));
});

it('keeps the checkout blocker after invalidating the cart receipt on the same order', async () => {
  const first = schedule(1, 8), second = schedule(2, 12);
  await installCheckoutRecoveryReminderSchedule(db, first);
  const opened = await order(3, true);
  await legacyCart(opened);
  const observed: unknown[] = [];
  const guard = (target: CheckoutRecoveryReminderSchedule) =>
    installCheckoutRecoveryReminderSchedule(db, target).catch((error: unknown) => { observed.push(error); return error; });
  await guard(second);
  expect(await readCheckoutRecoveryReminderSchedule(db)).toEqual(first);
  await invalidateDraft(opened);
  await expect(installCheckoutRecoveryReminderSchedule(db, second)).resolves.toBeUndefined();

  await db.query('DELETE FROM public.commerce_order_draft_receipts WHERE order_id=$1', [opened]);
  await draftReceipt(opened, `replacement:${opened}`);
  await legacyCheckout(opened);
  const beforeWaves = (await waves(opened)).rows;
  const beforePins = (await pins(opened)).rows;
  expect(beforeWaves).toHaveLength(2);
  expect(beforePins).toEqual([]);
  await guard(first);
  await invalidateDraft(opened);
  await guard(first);
  expect(await readCheckoutRecoveryReminderSchedule(db)).toEqual(second);
  expect((await waves(opened)).rows).toEqual(beforeWaves);
  expect((await pins(opened)).rows).toEqual(beforePins);
  await db.query("UPDATE public.commerce_orders SET status='cancelled' WHERE id=$1", [opened]);
  await expect(installCheckoutRecoveryReminderSchedule(db, first)).resolves.toBeUndefined();
  expect(await readCheckoutRecoveryReminderSchedule(db)).toEqual(first);
  expect(observed).toHaveLength(3);
  observed.forEach(expectBlocked);
});

it('locks the installer before reading the previous schedule', async () => {
  const original = schedule(1, 8);
  await installCheckoutRecoveryReminderSchedule(db, original);
  const first = await db.connect(), second = await db.connect();
  let waiting: Promise<unknown> | undefined;
  try {
    await first.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await installCheckoutRecoveryReminderSchedule(first, schedule(2, 12));
    const pid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    waiting = installCheckoutRecoveryReminderSchedule(second, original);
    void waiting.catch(() => undefined);
    await expect.poll(async () => (await first.query('SELECT pg_backend_pid()=ANY(pg_blocking_pids($1)) AS blocked', [pid])).rows[0].blocked).toBe(true);
    await first.query('COMMIT');
    await expect(waiting).resolves.toBeUndefined();
    expect(await readCheckoutRecoveryReminderSchedule(db)).toEqual(original);
  } finally { await first.query('ROLLBACK'); await waiting?.catch(() => undefined); first.release(); second.release(); }
});

it('preserves predecessor driver identity and returns the nominal refusal after upgrading its qualified chain', async () => {
  const predecessor = JSON.parse(execFileSync('git', ['show', 'b79e94360:config/platform-migration-manifest.json'], { encoding: 'utf8' }));
  const paths = new Set([predecessor, predecessor.qualified, predecessor.qualifiedAdmin]
    .flatMap(plan => [plan.baseline, ...plan.forward]).map(unit => unit.file));
  const all = readPlatformMigrations(process.cwd());
  const qualified = await runPostgresContainer({ name: `reminder-predecessor-${process.pid}`, password: 'synthetic-predecessor' });
  const previous = new Pool({ connectionString: qualified.connectionString, options: qualifiedPostgresStartupOptions(installation) });
  try {
    if (!await waitForPostgresTcpReady(qualified.connectionString)) throw new Error('Reminder predecessor PostgreSQL unavailable');
    await createRoles(previous);
    const prior = createPlatformPostgresMigrationRunner({ connectionString: qualified.connectionString }, { installation, poolFactory: () => previous,
      catalog: { readManifest: () => predecessor, readMigrations: () => ({ ...all, migrations: all.migrations.filter(unit => paths.has(unit.file)) }) } });
    await prior.apply();
    const history = (await previous.query('SELECT * FROM public.platform_schema_migrations ORDER BY position')).rows;
    const opened = await order(3, false, previous);
    const current = schedule(1, 8), changed = schedule(2, 12);
    await installCheckoutRecoveryReminderSchedule(previous, current);
    await legacyCheckout(opened, previous);
    let driver: unknown;
    const session = await previous.connect();
    const transport = { async query(sql: string, values?: unknown[]) {
      try { return await session.query(sql, values); }
      catch (error) { driver = error; throw error; }
    } };
    try {
      const raw = await installCheckoutRecoveryReminderSchedule(transport, changed).catch((error: unknown) => error);
      expect(raw).toBe(driver);
      expect(raw).toMatchObject(blocked);
      expect((raw as { detail?: string }).detail).toBeUndefined();
      const upgrade = createPostgresMigrationRunner({ connectionString: qualified.connectionString }, { installation, poolFactory: () => previous });
      await upgrade.apply();
      expect((await previous.query('SELECT * FROM public.platform_schema_migrations ORDER BY position')).rows.slice(0, history.length)).toEqual(history);
      expect(await upgrade.apply()).toEqual({ applied: [] });

      await session.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await expect(installCheckoutRecoveryReminderSchedule(transport, current)).resolves.toBeUndefined();
      const isolation = await installCheckoutRecoveryReminderSchedule(transport, changed).catch((error: unknown) => error);
      expect(isolation).toBe(driver);
      expect(isolation).toMatchObject({ code: '22023', message: 'checkout_recovery_schedule_isolation_unsupported' });
      await session.query('ROLLBACK');
      await session.query('BEGIN');
      const nominal = await installCheckoutRecoveryReminderSchedule(transport, changed).catch((error: unknown) => error);
      await expect(session.query('SELECT 1')).rejects.toMatchObject({ code: '25P02' });
      await session.query('ROLLBACK');
      await previous.query("UPDATE public.commerce_orders SET status='cancelled' WHERE id=$1", [opened]);
      await expect(installCheckoutRecoveryReminderSchedule(previous, changed)).resolves.toBeUndefined();
      expect(await readCheckoutRecoveryReminderSchedule(previous)).toEqual(changed);
      expectBlocked(nominal);
      expect((nominal as Error).cause).toBe(driver);
    } finally { await session.query('ROLLBACK'); session.release(); }
  } finally { await closePostgres(qualified, previous); }
}, postgresSetupTimeoutMs);

it('uses the existing producer lock to commit one wave and pin from two sessions', async () => {
  const opened = await order(3);
  const first = await db.connect(), second = await db.connect();
  let waiting: Promise<unknown> | undefined;
  try {
    await first.query('BEGIN');
    await checkout(opened, 3, first);
    const pid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    waiting = checkout(opened, 3, second);
    void waiting.catch(() => undefined);
    await expect.poll(async () => (await first.query('SELECT pg_backend_pid()=ANY(pg_blocking_pids($1)) AS blocked', [pid])).rows[0].blocked).toBe(true);
    await first.query('COMMIT');
    await waiting;
    expect((await pins(opened)).rows).toHaveLength(1);
    expect(await keys(opened)).toEqual([`checkout_recovery:1h:${opened}`]);
  } finally { await first.query('ROLLBACK'); await waiting?.catch(() => undefined); first.release(); second.release(); }
});

it('rolls back the wave, pin and checkout token together', async () => {
  const opened = await order(3);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await checkout(opened, 3, client);
    expect((await waves(opened, client)).rowCount).toBe(1);
    expect((await pins(opened, client)).rowCount).toBe(1);
    expect((await tokens(opened, client)).rowCount).toBe(1);
  } finally { await client.query('ROLLBACK'); client.release(); }
  expect((await waves(opened)).rows).toEqual([]);
  expect((await pins(opened)).rows).toEqual([]);
  expect((await tokens(opened)).rows).toEqual([]);
});
