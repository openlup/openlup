import { abandonedCartEmailContent } from '../../src/domains/commerce/emails/abandonedCart.js';
import { checkoutRecoveryEmailContent } from '../../src/domains/commerce/emails/checkoutRecovery.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { installCheckoutRecoveryReminderSchedule, readCheckoutRecoveryReminderSchedule } from '@openlup/platform/commerce/server';
import { installRenewalStockProtectionPolicy } from '@openlup/platform/inventory';
import type { CheckoutRecoveryReminderSchedule } from '@openlup/platform/commerce/contracts';
import { createPostgresMigrationRunner } from '../../server/adapters/postgres/migrationRunner.js';
import { qualifiedPostgresStartupOptions } from '../../server/adapters/postgres/qualifiedInstall.js';
import { assertNativeStoreForward, readReviewedForwardRegistry, sqlStatements } from '../../scripts/reviewed-platform-forward.js';
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from '../helpers/postgresContainer.js';
import { configurations } from '../../examples/neutral-store/owned/store.config.ts';
import { composeNativeBindings } from '../../examples/neutral-store/host/native-composition.ts';
import { createOriginPolicy } from '../../examples/neutral-store/host/origin-policy.ts';

const path = 'db/platform/migrations/20261123140000_checkout_recovery_reminder_schedule.sql';
const guardPath = 'db/platform/migrations/20261123141000_checkout_recovery_reminder_guard.sql';
const episodePath = 'db/platform/migrations/20261123148000_checkout_recovery_reminder_episode_pin.sql';
const cartHelper = 'public.commerce_enqueue_abandoned_cart_reminder_episodes';
const cartHelperSignature = `${cartHelper}(integer)`;
const signatures = ['public.commerce_enqueue_abandoned_cart_reminders(integer)', 'public.commerce_enqueue_checkout_recovery_reminders(integer,jsonb,timestamptz)'];
const installation = { generation: 'qualified-v2', roleMode: 'installer-managed', migrationLogin: 'postgres',
  bootstrapLogin: 'postgres', runtimeLogin: 'starter_runtime', restoreLogin: 'starter_restore' } as const;
let resource: PostgresContainer | undefined, db: Pool;
let defaults: CheckoutRecoveryReminderSchedule;
let installedCartProducer: string;
const cartProducerDefinition = async () => (await db.query('SELECT pg_get_functiondef($1::regprocedure) AS definition', [signatures[0]])).rows[0].definition;
const attributes = async () => (await db.query(`SELECT oid::regprocedure::text AS signature,proowner,proacl,prolang,provolatile,prosecdef,proconfig,prorettype,proargtypes
  FROM pg_proc WHERE oid=ANY($1::regprocedure[]) ORDER BY signature`, [signatures])).rows;
const events = async () => (await db.query(`SELECT aggregate_id,event_type,idempotency_key,payload,metadata FROM public.outbox_events
  WHERE event_type LIKE 'commerce.order_draft.abandoned.%' OR event_type='commerce.checkout_recovery' ORDER BY event_type,idempotency_key`)).rows;
const enqueue = async (before = false, policy = '{}', now?: string) => {
  await db.query(`SELECT public.${before ? 'k8_before_abandoned' : 'commerce_enqueue_abandoned_cart_reminders'}(1000)`);
  await db.query(`SELECT public.${before ? 'k8_before_checkout' : 'commerce_enqueue_checkout_recovery_reminders'}(1000,$1::jsonb,COALESCE($2::timestamptz,now()))`, [policy, now ?? null]);
};
async function order(hours: number, draft = false) {
  const id = randomUUID(), client = randomUUID(), principal = randomUUID();
  await db.query('INSERT INTO public.clients(id,email,principal_id) VALUES($1,$2,$3)', [client, `${client}@example.invalid`, principal]);
  await db.query("INSERT INTO public.commerce_orders(id,client_id,created_at,currency_code,total_amount_minor) VALUES($1,$2,now()-make_interval(hours=>$3),'XXX',0)", [id, client, hours]);
  if (draft) {
    await db.query('INSERT INTO public.customer_communication_preferences(principal_id,marketing_newsletter_consent) VALUES($1,true)', [principal]);
    await db.query("INSERT INTO public.commerce_order_draft_receipts(idempotency_key,request_fingerprint,order_id,response_payload) VALUES($1,repeat('a',32),$2,'{}')", [`draft:${id}`, id]);
  }
  return id;
}
async function priorAbandoned(id: string, hours = 24) {
  await db.query(`INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,status)
    VALUES('commerce_order',$1,$2,$3,'{}','processed')`, [id, `commerce.order_draft.abandoned.${hours}h`, `abandoned_${hours}h:${id}`]);
}
beforeAll(async () => {
  resource = await runPostgresContainer({ name: `reminder-schedule-${process.pid}`, password: 'synthetic-schedule' });
  if (!await waitForPostgresTcpReady(resource.connectionString)) throw new Error('schedule PostgreSQL unavailable');
  db = new Pool({ connectionString: resource.connectionString, options: qualifiedPostgresStartupOptions(installation) });
  await db.query("CREATE ROLE starter_runtime LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD 'synthetic-runtime'; CREATE ROLE starter_restore LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS");
  await createPostgresMigrationRunner({ connectionString: resource.connectionString }, { installation, poolFactory: () => db }).apply();
  installedCartProducer = await cartProducerDefinition();
  // Exact current preimages from the selected prefix, independent of the new implementation.
  const sources = ['db/platform/migrations/20260818120000_checkout_recovery_lifecycle.sql', 'db/platform/migrations/20261110100000_checkout_recovery_waves.sql'];
  const declarations = sources.map((source, i) => sqlStatements(readFileSync(source, 'utf8')).find(sql => sql.startsWith(`CREATE FUNCTION ${signatures[i]!.split('(')[0]}(${i ? 'p_limit integer,p_policy' : 'p_limit integer DEFAULT'}`))!);
  for (const [i, sql] of declarations.entries()) {
    await db.query(sql.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'));
    await db.query(sql.replace(signatures[i]!.split('(')[0]!, `public.k8_before_${i ? 'checkout' : 'abandoned'}`));
  }
  const before = await attributes();
  for (const sql of sqlStatements(readFileSync(path, 'utf8'))) {
    const i = signatures.findIndex(signature => sql.startsWith(`CREATE OR REPLACE FUNCTION ${signature.split('(')[0]}(`));
    if (i === -1) continue;
    await db.query(sql);
    await db.query(sql.replace(signatures[i]!.split('(')[0]!, `public.r0_before_${i ? 'checkout' : 'abandoned'}`));
  }
  expect(await attributes()).toEqual(before);
  // Exercise CF-R0's original producer and guard contracts on the installed schema.
  for (const sql of sqlStatements(readFileSync(guardPath, 'utf8'))) {
    if (sql.startsWith('CREATE OR REPLACE FUNCTION') || sql.startsWith('CREATE FUNCTION public.commerce_checkout_recovery_schedule_change_guard(')) {
      await db.query(sql.replace(/^CREATE FUNCTION/u, 'CREATE OR REPLACE FUNCTION'));
    }
  }
  expect(await attributes()).toEqual(before);
  defaults = await readCheckoutRecoveryReminderSchedule(db);
}, postgresSetupTimeoutMs);
beforeEach(async () => {
  await db.query("UPDATE public.commerce_orders SET status='cancelled' WHERE status='pending_payment'");
  await db.query("DELETE FROM public.commerce_settings WHERE key='checkout_recovery_reminders'");
});
afterAll(async () => { await closePostgres(resource, db); }, postgresTeardownTimeoutMs);
it('admits the exact forward against its whole native prefix', () => {
  const manifest = JSON.parse(readFileSync('config/platform-migration-manifest.json', 'utf8'));
  const prefix = [manifest.baseline, ...manifest.forward.filter((u: { file: string }) => u.file < path)]
    .map((u: { file: string }) => ({ path: u.file, bytes: readFileSync(u.file) }));
  expect(() => assertNativeStoreForward(readReviewedForwardRegistry(readFileSync('config/reviewed-platform-forwards.json')), path, readFileSync(path), prefix)).not.toThrow();
});
it('D: absent key preserves both historical payloads, metadata, keys, windows, counts and replay', async () => {
  const connection = await db.connect();
  // One pinned transaction instant makes strict boundary comparisons reproducible.
  await connection.query('BEGIN');
  const originalQuery = db.query.bind(db);
  db.query = connection.query.bind(connection) as typeof db.query;
  try {
    for (const age of [0, 1, 2, 24, 25, 72, 73]) { const id = await order(age, true); if (age >= 72) await priorAbandoned(id); }
    const recovery = await order(21);
    // Capture a confirmed first receipt before either final-wave run.
    await db.query('SELECT public.k8_before_checkout(1000,\'{}\',now())');
    const first = (await db.query("SELECT id FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.checkout_recovery'", [recovery])).rows[0];
    await db.query("SELECT public.commerce_checkout_recovery_record_sent($1,'capture','fixture:accepted')", [first.id]);
    await db.query('DELETE FROM public.commerce_checkout_recovery_tokens WHERE order_id<>$1', [recovery]);
    await db.query("DELETE FROM public.outbox_events WHERE event_type='commerce.checkout_recovery' AND aggregate_id<>$1", [recovery]);
    await db.query('SAVEPOINT compare');
    const countsBefore = (await db.query('SELECT public.k8_before_abandoned(1000) AS abandoned,public.k8_before_checkout(1000,\'{}\',now()) AS checkout')).rows;
    const historical = await events();
    await db.query('ROLLBACK TO compare');
    const countsAfter = (await db.query('SELECT public.commerce_enqueue_abandoned_cart_reminders(1000) AS abandoned,public.commerce_enqueue_checkout_recovery_reminders(1000,\'{}\',now()) AS checkout')).rows;
    const current = await events();
    const normalize = (rows: typeof current) => rows.map(row => {
      const { stage: _stage, recoveryToken: _randomToken, ...payload } = row.payload;
      return { ...row, payload };
    });
    expect(countsAfter).toEqual(countsBefore);
    expect(normalize(current)).toEqual(normalize(historical));
    expect(current.filter(row => row.payload.stage).map(row => row.payload.stage)).toEqual(expect.arrayContaining(['first', 'gentle', 'last']));
    expect(current.filter(row => row.event_type === 'commerce.checkout_recovery' && row.payload.stage).map(row => row.payload.stage))
      .toEqual(expect.arrayContaining(['first', 'last']));
    await enqueue(); expect(await events()).toEqual(current);
    expect((await db.query(`SELECT count(*)::int AS n FROM public.commerce_checkout_recovery_tokens t JOIN public.outbox_events e
      ON t.order_id=e.aggregate_id AND t.token_hash=encode(sha256(convert_to(e.payload->>'recoveryToken','UTF8')),'hex')`)).rows[0].n)
      .toBe(current.filter(row => row.event_type === 'commerce.checkout_recovery').length);
  } finally { db.query = originalQuery; await connection.query('ROLLBACK'); connection.release(); }
});
it('custom last at 48h keeps stage routes, derives keys from hours and requires prior acceptance', async () => {
  await installCheckoutRecoveryReminderSchedule(db, { ...defaults, revision: 'owned-48',
    abandonedCart: [{ stage: 'first', afterHours: 2 }, { stage: 'gentle', afterHours: 12 }, { stage: 'last', afterHours: 48 }],
    checkoutRecovery: [{ stage: 'first', afterHours: 2 }, { stage: 'last', afterHours: 48 }] });
  const abandoned = await order(49, true), checkout = await order(49), early = await order(21), tooYoung = await order(1);
  await priorAbandoned(abandoned); // legacy processed gentle route remains admissible
  const policy = JSON.stringify({ firstOffsetSeconds: 1, finalOffsetSeconds: 2, checkoutSeconds: 72 * 3600 });
  await enqueue(false, policy);
  let checkoutEvents = (await events()).filter(row => row.aggregate_id === checkout);
  expect(checkoutEvents).toHaveLength(1);
  const first = (await db.query("SELECT id FROM public.outbox_events WHERE aggregate_id=$1 AND idempotency_key=$2", [checkout, `checkout_recovery:2h:${checkout}`])).rows[0];
  await db.query("SELECT public.commerce_checkout_recovery_record_sent($1,'capture','fixture:custom-accepted')", [first.id]);
  const earlyFirst = (await db.query("SELECT id FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.checkout_recovery'", [early])).rows[0];
  await db.query("SELECT public.commerce_checkout_recovery_record_sent($1,'capture','fixture:early-accepted')", [earlyFirst.id]);
  await enqueue(false, policy);
  checkoutEvents = (await events()).filter(row => row.aggregate_id === checkout);
  expect((await events()).filter(row => row.aggregate_id === early)).toHaveLength(1);
  expect((await events()).filter(row => row.aggregate_id === tooYoung)).toHaveLength(0);
  expect(checkoutEvents.map(row => row.idempotency_key).sort()).toEqual([`checkout_recovery:2h:${checkout}`, `checkout_recovery:48h:${checkout}`].sort());
  for (const id of [abandoned, checkout]) expect((await events()).find(row => row.aggregate_id === id && row.payload.reminderHours === 48))
    .toMatchObject({ idempotency_key: id === abandoned ? `abandoned_48h:${id}` : `checkout_recovery:48h:${id}`, payload: { stage: 'last', reminderHours: 48 } });
  const vars = { firstName: null, brandName: 'Example', ctaUrl: 'https://example.invalid/cart',
    unsubscribeUrl: 'https://example.invalid/unsubscribe', recoveryUrl: 'https://example.invalid/recover', mode: 'one_time' as const };
  for (const locale of ['en', 'pl'] as const) {
    const abandonedPayload = (await events()).find(row => row.aggregate_id === abandoned && row.payload.stage === 'last')!.payload;
    const checkoutPayload = checkoutEvents.find(row => row.payload.stage === 'last')!.payload;
    expect(abandonedCartEmailContent(locale, { ...vars, reminderHours: abandonedPayload.reminderHours, stage: abandonedPayload.stage }, 'signature'))
      .toEqual(abandonedCartEmailContent(locale, { ...vars, reminderHours: 72 }, 'signature'));
    expect(checkoutRecoveryEmailContent(locale, { ...vars, reminderHours: checkoutPayload.reminderHours, stage: checkoutPayload.stage }, 'signature'))
      .toEqual(checkoutRecoveryEmailContent(locale, { ...vars, reminderHours: 20 }, 'signature'));
  }
  const before = await events(); await enqueue(false, policy); expect(await events()).toEqual(before);
});
it('accepts integral JSON numeric spellings consistently with TypeScript validation', async () => {
  const wire = JSON.stringify(defaults).replaceAll('"afterHours":1', '"afterHours":1.0').replace('"afterHours":20', '"afterHours":2e1');
  await db.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('checkout_recovery_reminders',$1)", [wire]);
  expect(await readCheckoutRecoveryReminderSchedule(db)).toEqual(defaults);
  expect((await db.query('SELECT public.commerce_checkout_recovery_reminder_schedule() AS result')).rows[0].result).toEqual(defaults);
  await enqueue();
});
it('names malformed installed data and rolls back before either producer writes', async () => {
  for (const raw of [null, '{bad', 'null', '[]', '{}', ...[
    { ...defaults, revision: '' }, { ...defaults, extra: true }, { ...defaults, checkoutRecovery: [] },
    ...[0, -1, 1.5, '20', null, 2147483648].map(afterHours => ({ ...defaults, checkoutRecovery: [{ stage: 'last', afterHours }] })),
    { ...defaults, abandonedCart: [{ stage: 'first', afterHours: 2 }, { stage: 'last', afterHours: 1 }] },
    { ...defaults, abandonedCart: [{ stage: 'last', afterHours: 1 }, { stage: 'last', afterHours: 2 }] },
    { ...defaults, checkoutRecovery: [{ stage: 'gentle', afterHours: 20 }] },
    { ...defaults, checkoutRecovery: [{ stage: 'first', afterHours: 20 }] },
    { ...defaults, checkoutRecovery: [null] },
  ].map(value => JSON.stringify(value))]) {
    await db.query("INSERT INTO public.commerce_settings(key,value_text) VALUES('checkout_recovery_reminders',$1) ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text", [raw]);
    const before = await events();
    for (const sql of ['SELECT public.commerce_enqueue_abandoned_cart_reminders(1000)', "SELECT public.commerce_enqueue_checkout_recovery_reminders(1000,'{}',now())"])
      await expect(db.query(sql)).rejects.toMatchObject({ code: '22023', message: 'checkout_recovery_reminder_schedule_invalid' });
    expect(await events()).toEqual(before);
    await expect(readCheckoutRecoveryReminderSchedule(db)).rejects.toThrow('checkout_recovery_reminder_schedule_invalid');
  }
});
it('tells a separate cart runtime which grant to apply before it can enqueue and pin a wave', async () => {
  await db.query('CREATE ROLE schedule_runtime NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS');
  // This fixture grants the old entry-point and relation privileges. It initially withholds both helper grants.
  await db.query(`GRANT USAGE ON SCHEMA public TO schedule_runtime;
    GRANT SELECT ON public.commerce_orders,public.clients,public.customer_communication_preferences,public.commerce_order_draft_receipts,
      public.commerce_settlement_intents,public.outbox_events TO schedule_runtime;
    GRANT INSERT ON public.outbox_events TO schedule_runtime;
    GRANT EXECUTE ON FUNCTION public.commerce_enqueue_abandoned_cart_reminders(integer),
      public.commerce_enqueue_checkout_recovery_reminders(integer,jsonb,timestamptz) TO schedule_runtime`);
  const id = await order(2, true);
  const pins = () => db.query('SELECT kind FROM public.commerce_reminder_episodes WHERE order_id=$1', [id]);
  const hint = `GRANT EXECUTE ON FUNCTION ${cartHelperSignature} TO schedule_runtime;`;
  const previousCartProducer = await cartProducerDefinition();
  const runtime = await db.connect();
  try {
    // Use the installed CF-R1 producer here. The historical witnesses use CF-R0.
    await db.query(installedCartProducer);
    await runtime.query('SET ROLE schedule_runtime');
    const enqueueCart = () => runtime.query('SELECT public.commerce_enqueue_abandoned_cart_reminders(1) AS result');
    const before = await events();
    await expect(enqueueCart()).rejects.toMatchObject({ code: '42501', message: 'checkout_recovery_cart_runtime_grant_required', hint });
    expect(await events()).toEqual(before);
    expect((await pins()).rows).toEqual([]);
    await db.query(hint);
    expect((await enqueueCart()).rows[0].result).toEqual({ enqueued_1h: 1, enqueued_24h: 0, enqueued_72h: 0 });
    expect((await events()).find(event => event.aggregate_id === id)?.idempotency_key).toBe(`abandoned_1h:${id}`);
    expect((await pins()).rows).toEqual([{ kind: 'abandoned_cart' }]);
    await runtime.query('RESET ROLE');
    await db.query('GRANT EXECUTE ON FUNCTION public.commerce_checkout_recovery_reminder_schedule() TO schedule_runtime');
    await runtime.query('SET ROLE schedule_runtime');
    expect((await runtime.query('SELECT public.commerce_checkout_recovery_reminder_schedule() AS result')).rows[0].result).toEqual(defaults);
    await expect(runtime.query('SELECT * FROM public.commerce_settings')).rejects.toMatchObject({ code: '42501' });
    await runtime.query("SELECT public.commerce_enqueue_checkout_recovery_reminders(1,'{}',now())");
    await expect(installCheckoutRecoveryReminderSchedule(runtime, defaults)).rejects.toMatchObject({ code: '42501' });
    await runtime.query('RESET ROLE');
    await db.query("UPDATE public.commerce_orders SET status='cancelled' WHERE id=$1", [id]);
    await installCheckoutRecoveryReminderSchedule(db, { ...defaults, revision: 'restricted-48', abandonedCart: [{ stage: 'last', afterHours: 48 }] });
    await runtime.query('SET ROLE schedule_runtime');
    expect((await runtime.query('SELECT public.commerce_checkout_recovery_reminder_schedule() AS result')).rows[0].result.revision).toBe('restricted-48');
    await runtime.query('SELECT public.commerce_enqueue_abandoned_cart_reminders(1)');
  } finally {
    try { await runtime.query('RESET ROLE'); } finally { runtime.release(); }
    await db.query(previousCartProducer);
  }
});
it('revokes cart helper execution from both browser roles under managed default grants', async () => {
  const defaultGrant = sqlStatements(readFileSync('tests/postgres/managed-compat/supabase.sql', 'utf8'))
    .find(sql => sql.startsWith('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS '))!;
  const statements = sqlStatements(readFileSync(episodePath, 'utf8'));
  const create = statements.find(sql => sql.startsWith(`CREATE FUNCTION ${cartHelper}(`))!;
  const privileges = statements.filter(sql => /^(REVOKE|DO)\b/u.test(sql) && sql.includes(`FUNCTION ${cartHelperSignature}`));
  const owner = await db.connect();
  try {
    await owner.query('BEGIN');
    // Recreate the exact helper in the installed schema using the managed default ACL.
    await owner.query(defaultGrant);
    await owner.query(`DROP FUNCTION ${cartHelperSignature}`);
    await owner.query(create);
    const browserRoles = ['anon', 'authenticated'];
    const grants = await owner.query(`SELECT r.rolname FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(p.proacl) acl JOIN pg_roles r ON r.oid=acl.grantee
      WHERE p.oid=$1::regprocedure AND r.rolname=ANY($2::name[]) AND acl.privilege_type='EXECUTE' ORDER BY r.rolname`,
    [cartHelperSignature, browserRoles]);
    expect(grants.rows.map(row => row.rolname)).toEqual(browserRoles);
    for (const sql of privileges) await owner.query(sql);
    for (const role of browserRoles) {
      await owner.query('SAVEPOINT call_helper');
      await owner.query(`SET LOCAL ROLE ${role}`);
      await expect(owner.query(`SELECT ${cartHelper}(1)`)).rejects.toMatchObject({
        code: '42501', message: 'permission denied for function commerce_enqueue_abandoned_cart_reminder_episodes',
      });
      await owner.query('ROLLBACK TO SAVEPOINT call_helper');
    }
  } finally { await owner.query('ROLLBACK'); owner.release(); }
});
it('startup reads only and refuses revision/hour/stage drift for an arbitrary configuration id', async () => {
  const config = structuredClone(Object.values(configurations)[0]!); config.id = 'schedule-startup-fixture';
  await installRenewalStockProtectionPolicy(db, config.inventory.renewalProtection);
  const url = new URL(resource!.connectionString); url.username = 'starter_runtime'; url.password = 'synthetic-runtime';
  for (const schedule of [defaults, { ...config.checkoutRecoveryReminders, revision: 'other' },
    { ...config.checkoutRecoveryReminders, checkoutRecovery: [{ stage: 'last' as const, afterHours: 48 }] }]) {
    await installCheckoutRecoveryReminderSchedule(db, schedule);
    const before = (await db.query('SELECT * FROM public.commerce_settings ORDER BY key')).rows;
    await expect(composeNativeBindings(url.toString(), createOriginPolicy(config, 4319), config)).rejects.toThrow('starter_installed_policy_drift');
    expect((await db.query('SELECT * FROM public.commerce_settings ORDER BY key')).rows).toEqual(before);
  }
  await installCheckoutRecoveryReminderSchedule(db, config.checkoutRecoveryReminders);
  const bindings = await composeNativeBindings(url.toString(), createOriginPolicy(config, 4319), config); await bindings.close();
});

const blockedMessage = 'checkout_recovery_schedule_change_blocked_open_episodes';
const checkoutSchedule = (first: number, last: number) => ({ ...defaults, checkoutRecovery: [
  { stage: 'first', afterHours: first }, { stage: 'last', afterHours: last },
] } satisfies CheckoutRecoveryReminderSchedule);
const checkoutEvents = async (id: string) => (await events()).filter(row => row.aggregate_id === id && row.event_type === 'commerce.checkout_recovery');
async function acceptFirstRecovery(id: string) {
  const event = (await db.query(`SELECT id FROM public.outbox_events
    WHERE aggregate_id=$1 AND event_type='commerce.checkout_recovery' AND payload->>'stage'='first'`, [id])).rows[0];
  await db.query("SELECT public.commerce_checkout_recovery_record_sent($1,'capture','fixture:accepted')", [event.id]);
}
async function forceSchedule(schedule: CheckoutRecoveryReminderSchedule) {
  await db.query("UPDATE public.commerce_settings SET value_text=$1 WHERE key='checkout_recovery_reminders'", [JSON.stringify(schedule)]);
}

it('CF-R0 (1, 2, 5): refuses between and after checkout waves, then installs after closure', async () => {
  await installCheckoutRecoveryReminderSchedule(db, defaults);
  const id = await order(22);
  const firstRun = (await db.query("SELECT created_at + interval '3 hours' AS at FROM public.commerce_orders WHERE id=$1", [id])).rows[0].at;
  await enqueue(false, '{}', firstRun);
  await acceptFirstRecovery(id);
  await installCheckoutRecoveryReminderSchedule(db, defaults);
  const message = `${blockedMessage} (1 blocking orders)`;
  await expect(installCheckoutRecoveryReminderSchedule(db, checkoutSchedule(2, 20))).rejects.toMatchObject({ code: '55000', message });
  expect((await checkoutEvents(id)).map(row => row.payload.stage)).toEqual(['first']);
  await enqueue();
  expect((await checkoutEvents(id)).map(row => row.idempotency_key)).toEqual([`checkout_recovery:1h:${id}`, `checkout_recovery:20h:${id}`]);

  const changed = checkoutSchedule(1, 21);
  await expect(installCheckoutRecoveryReminderSchedule(db, changed)).rejects.toMatchObject({ code: '55000', message });
  expect(await readCheckoutRecoveryReminderSchedule(db)).toEqual(defaults);
  await db.query("UPDATE public.commerce_orders SET status='cancelled' WHERE id=$1", [id]);
  await installCheckoutRecoveryReminderSchedule(db, changed);
  expect(await readCheckoutRecoveryReminderSchedule(db)).toEqual(changed);
});

it('CF-R0: an uncompacted last-only checkout wave blocks schedule changes until closure', async () => {
  const schedule = { ...defaults, checkoutRecovery: [{ stage: 'last', afterHours: 20 }] } as const;
  const changed = { ...schedule, checkoutRecovery: [{ stage: 'last', afterHours: 21 }] } as const;
  await installCheckoutRecoveryReminderSchedule(db, schedule);
  const id = await order(22);
  await enqueue();

  const waves = await checkoutEvents(id);
  expect(waves).toMatchObject([{ idempotency_key: `checkout_recovery:20h:${id}`, payload: { stage: 'last' } }]);
  expect(waves[0]?.metadata).not.toHaveProperty('retentionCompactedAt');
  const { rows } = await db.query(`SELECT public.commerce_checkout_recovery_event_stage(e, true) AS stage
    FROM public.outbox_events e WHERE aggregate_id=$1 AND event_type='commerce.checkout_recovery'`, [id]);
  expect(rows).toEqual([{ stage: 'last' }]);
  await expect(installCheckoutRecoveryReminderSchedule(db, changed)).rejects.toMatchObject({
    code: '55000', message: `${blockedMessage} (1 blocking orders)`,
  });
  expect(await readCheckoutRecoveryReminderSchedule(db)).toEqual(schedule);

  await db.query("UPDATE public.commerce_orders SET status='cancelled' WHERE id=$1", [id]);
  await installCheckoutRecoveryReminderSchedule(db, changed);
  expect(await readCheckoutRecoveryReminderSchedule(db)).toEqual(changed);
});

it('CF-R0 (3): both producers preserve one event per stage after an owner-only hour change', async () => {
  const schedule = { ...defaults, abandonedCart: [{ stage: 'first', afterHours: 1 }, { stage: 'last', afterHours: 20 }] } as const;
  const changed = { ...checkoutSchedule(1, 21), abandonedCart: [{ stage: 'first', afterHours: 1 }, { stage: 'last', afterHours: 21 }] } as const;
  await installCheckoutRecoveryReminderSchedule(db, schedule);
  const draft = await order(22, true), recovery = await order(22);
  await priorAbandoned(draft, 1);
  await enqueue();
  await acceptFirstRecovery(recovery);
  await enqueue();
  const before = (await events()).filter(row => [draft, recovery].includes(row.aggregate_id));
  expect(before.filter(row => row.aggregate_id === draft && row.event_type.startsWith('commerce.order_draft.abandoned.'))
    .map(row => row.idempotency_key)).toEqual([`abandoned_1h:${draft}`, `abandoned_20h:${draft}`]);
  expect((await checkoutEvents(recovery)).map(row => row.payload.stage)).toEqual(['first', 'last']);
  await expect(installCheckoutRecoveryReminderSchedule(db, changed)).rejects.toMatchObject({ code: '55000',
    message: `${blockedMessage} (2 blocking orders)` });
  await forceSchedule(changed);
  await enqueue();
  expect((await events()).filter(row => [draft, recovery].includes(row.aggregate_id))).toEqual(before);
});

it('CF-R0 (4): absent to explicit defaults refuses for an old draft until its receipt is invalidated', async () => {
  const draft = await order(100, true);
  await priorAbandoned(draft);
  await enqueue();
  await expect(installCheckoutRecoveryReminderSchedule(db, defaults)).rejects.toMatchObject({ code: '55000',
    message: `${blockedMessage} (1 blocking orders)` });
  expect((await db.query("SELECT 1 FROM public.commerce_settings WHERE key='checkout_recovery_reminders'")).rowCount).toBe(0);
  await db.query('UPDATE public.commerce_order_draft_receipts SET invalidated_at=now() WHERE order_id=$1', [draft]);
  await installCheckoutRecoveryReminderSchedule(db, defaults);
});

it('CF-R0 (4a): legacy checkout waves consume their stages after a forced first-hour change', async () => {
  await installCheckoutRecoveryReminderSchedule(db, defaults);
  const id = await order(22);
  await enqueue();
  await acceptFirstRecovery(id);
  await enqueue();
  await db.query("UPDATE public.outbox_events SET payload=payload-'stage' WHERE aggregate_id=$1 AND event_type='commerce.checkout_recovery'", [id]);
  const stages = (await db.query(`SELECT public.commerce_checkout_recovery_event_stage(e, true) AS stage FROM public.outbox_events e
    WHERE aggregate_id=$1 AND event_type='commerce.checkout_recovery' ORDER BY idempotency_key`, [id])).rows;
  expect(stages).toEqual([{ stage: 'first' }, { stage: 'last' }]);
  await expect(installCheckoutRecoveryReminderSchedule(db, checkoutSchedule(2, 20))).rejects.toMatchObject({ code: '55000' });
  await forceSchedule(checkoutSchedule(2, 20));
  await enqueue();
  expect((await checkoutEvents(id)).map(row => row.idempotency_key)).toEqual([`checkout_recovery:1h:${id}`, `checkout_recovery:20h:${id}`]);
});

it('CF-R0: payload-only legacy waves use numeric hours to identify their stages', async () => {
  const cases = [['20.0', 'last'], ['1.0', 'first'], ['2e1', 'last'], ['2.5', 'both'], ['"unknown"', 'both'], ['null', 'both']] as const;
  const orders: { id: string; stage: 'first' | 'last' | 'both' }[] = [];
  for (const [hours, stage] of cases) {
    const id = await order(3);
    const { rows } = await db.query(`INSERT INTO public.outbox_events AS wave
      (aggregate_type,aggregate_id,event_type,idempotency_key,payload)
      VALUES('commerce_order',$1,'commerce.checkout_recovery',$2,$3::jsonb)
      RETURNING public.commerce_checkout_recovery_event_stage(wave, false) AS stage`,
      [id, `legacy_payload:${id}`, `{"reminderHours":${hours}}`]);
    expect(rows).toEqual([{ stage }]);
    orders.push({ id, stage });
  }
  await enqueue();
  for (const { id, stage } of orders) {
    const keys = (await checkoutEvents(id)).map(row => row.idempotency_key);
    expect(keys).toEqual(stage === 'last' ? [`checkout_recovery:1h:${id}`, `legacy_payload:${id}`] : [`legacy_payload:${id}`]);
  }
});

it('CF-R0: an unlabeled nonhistorical wave consumes both stages and link events consume neither', async () => {
  const legacy = await order(22), links = await order(22);
  const fixtures = [
    [legacy, `checkout_recovery:2h:${legacy}`, { reminderHours: 2 }],
    [links, `checkout_recovery:operator:${links}`, { reminderHours: 1 }],
    [links, `checkout_recovery:buyer:${links}:1`, { stage: 'first' }],
  ] as const;
  for (const [id, key, payload] of fixtures) {
    await db.query(`INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload)
      VALUES('commerce_order',$1,'commerce.checkout_recovery',$2,$3)`, [id, key, payload]);
  }
  const stages = (await db.query(`SELECT public.commerce_checkout_recovery_event_stage(e, true) AS stage FROM public.outbox_events e
    WHERE aggregate_id IN ($1,$2) ORDER BY idempotency_key`, [legacy, links])).rows;
  expect(stages).toEqual([{ stage: 'both' }, { stage: null }, { stage: null }]);
  await enqueue();
  expect(await checkoutEvents(legacy)).toHaveLength(1);
  expect((await checkoutEvents(links)).some(row => row.idempotency_key === `checkout_recovery:1h:${links}`)).toBe(true);
});

it.each([
  ['abandoned', 'r0_before_abandoned(1)', 'commerce_enqueue_abandoned_cart_reminders(1)', { enqueued_1h: 0, enqueued_24h: 0, enqueued_72h: 0 }],
  ['checkout', "r0_before_checkout(1,'{}',now())", "commerce_enqueue_checkout_recovery_reminders(1,'{}',now())", { enqueued_1h: 0, enqueued_20h: 0 }],
] as const)('CF-R0: %s preserves the limit-one slot occupied by an existing stage', async (kind, before, after, zero) => {
  const oldest = await order(3, kind === 'abandoned');
  const youngest = await order(2, kind === 'abandoned');
  await db.query(`SELECT public.${before}`);
  const existing = (await events()).filter(row => row.aggregate_id === oldest);
  expect(existing).toHaveLength(1);

  for (const producer of [before, after]) {
    const { rows } = await db.query(`SELECT public.${producer} AS result`);
    expect(rows).toEqual([{ result: zero }]);
    expect((await events()).filter(row => [oldest, youngest].includes(row.aggregate_id))).toEqual(existing);
  }
});

it('CF-R0: removing a prior custom schedule does not enqueue another first wave for either producer', async () => {
  const schedule = { ...checkoutSchedule(2, 20), abandonedCart: [
    { stage: 'first', afterHours: 2 }, ...defaults.abandonedCart.slice(1),
  ] } satisfies CheckoutRecoveryReminderSchedule;
  await installCheckoutRecoveryReminderSchedule(db, schedule);
  const id = await order(3, true);
  await db.query("SELECT public.r0_before_abandoned(1), public.r0_before_checkout(1,'{}',now())");
  const before = (await events()).filter(row => row.aggregate_id === id);
  expect(before.map(row => [row.idempotency_key, row.payload.stage])).toEqual([
    [`checkout_recovery:2h:${id}`, 'first'], [`abandoned_2h:${id}`, 'first'],
  ]);
  const removed = await db.query("DELETE FROM public.commerce_settings WHERE key='checkout_recovery_reminders'");
  expect(removed.rowCount).toBe(1);

  const { rows } = await db.query(`SELECT public.commerce_enqueue_abandoned_cart_reminders(1) AS abandoned,
    public.commerce_enqueue_checkout_recovery_reminders(1,'{}',now()) AS checkout`);
  expect(rows).toEqual([{
    abandoned: { enqueued_1h: 0, enqueued_24h: 0, enqueued_72h: 0 },
    checkout: { enqueued_1h: 0, enqueued_20h: 0 },
  }]);
  expect((await events()).filter(row => row.aggregate_id === id)).toEqual(before);
});

it('CF-R0 (6): an old pending checkout wave blocks regardless of order age', async () => {
  await installCheckoutRecoveryReminderSchedule(db, defaults);
  const id = await order(30);
  await db.query(`INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload,metadata)
    SELECT 'commerce_order',id,'commerce.checkout_recovery','checkout_recovery:1h:'||id,
      jsonb_build_object('stage','first','expiresAt',created_at + interval '24 hours'),
      '{"deliveryProfile":"capture"}'
    FROM public.commerce_orders WHERE id=$1`, [id]);
  await acceptFirstRecovery(id);

  const changed = checkoutSchedule(2, 20);
  await expect(installCheckoutRecoveryReminderSchedule(db, changed)).rejects.toMatchObject({ code: '55000',
    message: `${blockedMessage} (1 blocking orders)` });
  await enqueue(false, JSON.stringify({ checkoutSeconds: 72 * 3600 }));
  expect((await checkoutEvents(id)).map(row => row.payload.stage)).toEqual(['first', 'last']);

  await db.query("UPDATE public.commerce_orders SET created_at=now()-interval '2147483648 seconds' WHERE id=$1", [id]);
  await expect(installCheckoutRecoveryReminderSchedule(db, changed)).rejects.toMatchObject({ code: '55000',
    message: `${blockedMessage} (1 blocking orders)` });
  await db.query("UPDATE public.commerce_orders SET status='cancelled' WHERE id=$1", [id]);
  await installCheckoutRecoveryReminderSchedule(db, changed);
  expect(await readCheckoutRecoveryReminderSchedule(db)).toEqual(changed);
});

async function compactCheckoutWave(id: string) {
  await db.query(`UPDATE public.outbox_events SET status='processed', processed_at=now()-interval '31 days'
    WHERE aggregate_id=$1 AND event_type='commerce.checkout_recovery'`, [id]);
  await db.query('SELECT public.commerce_outbox_compact_terminal(5000,now())');
}

it('CF-R0 (7): compaction of a last-only 1h wave consumes both installed checkout stages', async () => {
  const id = await order(35 * 24);
  const schedule = (afterHours: number) => ({ ...defaults, checkoutRecovery: [{ stage: 'last', afterHours }] } as const);
  const policy = JSON.stringify({ checkoutSeconds: 60 * 86400 });
  await installCheckoutRecoveryReminderSchedule(db, schedule(1));
  await enqueue(false, policy);
  expect((await checkoutEvents(id))[0]?.payload.stage).toBe('last');
  await compactCheckoutWave(id);
  const compacted = await checkoutEvents(id);
  expect(compacted).toMatchObject([{ payload: {}, metadata: { retentionCompactedAt: expect.any(String) } }]);
  expect(compacted[0]?.payload).toEqual({});
  const { rows } = await db.query(`SELECT public.commerce_checkout_recovery_event_stage(e, true) AS stage
    FROM public.outbox_events e WHERE aggregate_id=$1 AND event_type='commerce.checkout_recovery'`, [id]);
  expect(rows).toEqual([{ stage: 'both' }]);

  await expect(installCheckoutRecoveryReminderSchedule(db, schedule(2))).rejects.toMatchObject({ code: '55000' });
  for (const changed of [schedule(2), checkoutSchedule(2, 20)]) {
    await forceSchedule(changed);
    await enqueue(false, policy);
    expect(await checkoutEvents(id)).toEqual(compacted);
  }
});

it('CF-R0 (8): an accepted compacted first wave still gets its last wave with no installed schedule', async () => {
  const id = await order(35 * 24);
  const policy = JSON.stringify({ checkoutSeconds: 60 * 86400 });
  await db.query(`SELECT public.r0_before_checkout(1,$1::jsonb,created_at + interval '3 hours')
    FROM public.commerce_orders WHERE id=$2`, [policy, id]);
  await acceptFirstRecovery(id);
  await compactCheckoutWave(id);
  expect(await checkoutEvents(id)).toMatchObject([{
    idempotency_key: `checkout_recovery:1h:${id}`, payload: {}, metadata: { retentionCompactedAt: expect.any(String) },
  }]);
  await expect(installCheckoutRecoveryReminderSchedule(db, defaults)).rejects.toMatchObject({
    code: '55000', message: `${blockedMessage} (1 blocking orders)`,
  });
  expect((await db.query("SELECT 1 FROM public.commerce_settings WHERE key='checkout_recovery_reminders'")).rowCount).toBe(0);

  const connection = await db.connect();
  try {
    await connection.query('BEGIN');
    await connection.query('SAVEPOINT compare');
    const lastWave = async () => (await connection.query(`SELECT idempotency_key, payload - 'recoveryToken' AS payload, metadata
      FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.checkout_recovery'
        AND idempotency_key=$2`, [id, `checkout_recovery:20h:${id}`])).rows;
    const historical = await connection.query('SELECT public.r0_before_checkout(1,$1::jsonb,now()) AS result', [policy]);
    const historicalWave = await lastWave();
    expect(historical.rows).toEqual([{ result: { enqueued_1h: 0, enqueued_20h: 1 } }]);
    expect(historicalWave).toHaveLength(1);

    await connection.query('ROLLBACK TO compare');
    const current = await connection.query('SELECT public.commerce_enqueue_checkout_recovery_reminders(1,$1::jsonb,now()) AS result', [policy]);
    expect(current.rows).toEqual(historical.rows);
    expect(await lastWave()).toEqual(historicalWave);
    await connection.query('COMMIT');
  } finally {
    await connection.query('ROLLBACK');
    connection.release();
  }
  expect((await checkoutEvents(id)).map(row => row.idempotency_key))
    .toEqual([`checkout_recovery:1h:${id}`, `checkout_recovery:20h:${id}`]);
});

it('CF-R0: a compacted abandoned wave keeps its stage and a settlement intent closes its guard window', async () => {
  const id = await order(35 * 24, true);
  const schedule = (afterHours: number) => ({ ...defaults, abandonedCart: [{ stage: 'last', afterHours }] } as const);
  const produce = () => db.query('SELECT public.commerce_enqueue_abandoned_cart_reminders(1)');
  const draftEvents = async () => (await events()).filter(row => row.aggregate_id === id);
  await installCheckoutRecoveryReminderSchedule(db, schedule(1));
  await produce();
  await db.query(`UPDATE public.outbox_events SET status='processed', processed_at=now()-interval '31 days'
    WHERE aggregate_id=$1 AND event_type='commerce.order_draft.abandoned.72h'`, [id]);
  await db.query('SELECT public.commerce_outbox_compact_terminal(5000,now())');
  const compacted = await draftEvents();
  expect(compacted).toMatchObject([{ event_type: 'commerce.order_draft.abandoned.72h', metadata: { retentionCompactedAt: expect.any(String) } }]);
  expect(compacted[0]?.payload).toEqual({});
  await expect(installCheckoutRecoveryReminderSchedule(db, schedule(2))).rejects.toMatchObject({ code: '55000' });
  await forceSchedule(schedule(2));
  await produce();
  expect(await draftEvents()).toEqual(compacted);

  await db.query(`WITH priced AS (UPDATE public.commerce_orders SET total_amount_minor=1 WHERE id=$1 RETURNING id)
    INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)
    SELECT id,1,1,1,1 FROM priced`, [id]);
  await db.query(`INSERT INTO public.commerce_settlement_intents(order_id,channel_key,amount_minor,currency_code,open_idempotency_key)
    VALUES($1,'fixture',1,'XXX',$2)`, [id, `open:${id}`]);
  await installCheckoutRecoveryReminderSchedule(db, schedule(3));
  expect(await readCheckoutRecoveryReminderSchedule(db)).toEqual(schedule(3));
});

it('CF-R0: delegates installation through explicit function and settings grants', async () => {
  await db.query(`CREATE ROLE schedule_installer NOLOGIN;
    GRANT USAGE ON SCHEMA public TO schedule_installer;
    GRANT SELECT, INSERT, UPDATE ON public.commerce_settings TO schedule_installer;
    GRANT EXECUTE ON FUNCTION public.commerce_checkout_recovery_schedule_change_guard(jsonb,jsonb),
      public.commerce_checkout_recovery_reminder_schedule() TO schedule_installer`);
  const delegated = await db.connect();
  try {
    await delegated.query('SET ROLE schedule_installer');
    await expect(installCheckoutRecoveryReminderSchedule(delegated, defaults)).rejects.toMatchObject({ code: '42501' });
    await db.query(`GRANT EXECUTE ON FUNCTION public.commerce_install_checkout_recovery_reminder_schedule(text,jsonb)
      TO schedule_installer`);
    await installCheckoutRecoveryReminderSchedule(delegated, defaults);
    expect(await readCheckoutRecoveryReminderSchedule(delegated)).toEqual(defaults);
  } finally { await delegated.query('RESET ROLE'); delegated.release(); }
});

it.each(['READ UNCOMMITTED', 'READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'] as const)(
  'CF-R0: %s accepts identical schedule replay without writing', async isolation => {
    await installCheckoutRecoveryReminderSchedule(db, defaults);
    const connection = await db.connect();
    const stored = () => connection.query("SELECT xmin::text, value_text FROM public.commerce_settings WHERE key='checkout_recovery_reminders'");
    try {
      await connection.query(`BEGIN ISOLATION LEVEL ${isolation} READ ONLY`);
      const before = (await stored()).rows;
      await installCheckoutRecoveryReminderSchedule(connection, defaults);
      expect((await stored()).rows).toEqual(before);
    } finally { await connection.query('ROLLBACK'); connection.release(); }
  },
);

it.each(['REPEATABLE READ', 'SERIALIZABLE'] as const)(
  'CF-R0: %s refuses schedule changes and both producers with an absent setting', async isolation => {
    const connection = await db.connect();
    try {
      await connection.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const refusal = { code: '22023', message: 'checkout_recovery_schedule_isolation_unsupported' };
      await expect(installCheckoutRecoveryReminderSchedule(connection, defaults)).rejects.toMatchObject(refusal);
      for (const producer of ['commerce_enqueue_abandoned_cart_reminders(1)', "commerce_enqueue_checkout_recovery_reminders(1,'{}',now())"]) {
        await connection.query(`ROLLBACK; BEGIN ISOLATION LEVEL ${isolation}`);
        await expect(connection.query(`SELECT public.${producer}`)).rejects.toMatchObject(refusal);
      }
    } finally { await connection.query('ROLLBACK'); connection.release(); }
  },
);

it.each([
  ['checkout', "SELECT public.commerce_enqueue_checkout_recovery_reminders(1000,'{}',now())", 'checkout_recovery:2h:'],
  ['abandoned', 'SELECT public.commerce_enqueue_abandoned_cart_reminders(1000)', 'abandoned_2h:'],
] as const)('CF-R0: %s producer waits from guard check through the schedule write', async (kind, sql, keyPrefix) => {
  await installCheckoutRecoveryReminderSchedule(db, defaults);
  const id = await order(3, kind === 'abandoned');
  const changed = { ...checkoutSchedule(2, 20), abandonedCart: [{ stage: 'first', afterHours: 2 }, ...defaults.abandonedCart.slice(1)] } satisfies CheckoutRecoveryReminderSchedule;
  const installer = await db.connect(), producer = await db.connect();
  let wave: Promise<unknown> | undefined;
  try {
    const pid = (await producer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await installer.query('BEGIN');
    await installer.query('SELECT public.commerce_checkout_recovery_schedule_change_guard($1,$2)', [defaults, changed]);
    wave = producer.query(sql);
    void wave.catch(() => undefined);
    await expect.poll(async () => (await installer.query('SELECT pg_backend_pid() = ANY(pg_blocking_pids($1)) AS blocked', [pid])).rows[0].blocked).toBe(true);
    await installCheckoutRecoveryReminderSchedule(installer, changed);
    await installer.query('COMMIT');
    await wave;
    expect((await events()).filter(row => row.aggregate_id === id).map(row => row.idempotency_key)).toEqual([`${keyPrefix}${id}`]);
  } finally {
    await installer.query('ROLLBACK');
    await wave?.catch(() => undefined);
    installer.release();
    producer.release();
  }
});
