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
const guardPath = 'db/platform/migrations/20261125000000_checkout_recovery_reminder_guard.sql';
const signatures = ['public.commerce_enqueue_abandoned_cart_reminders(integer)', 'public.commerce_enqueue_checkout_recovery_reminders(integer,jsonb,timestamptz)'];
const installation = { generation: 'qualified-v2', roleMode: 'installer-managed', migrationLogin: 'postgres',
  bootstrapLogin: 'postgres', runtimeLogin: 'starter_runtime', restoreLogin: 'starter_restore' } as const;
let resource: PostgresContainer | undefined, db: Pool;
let defaults: CheckoutRecoveryReminderSchedule;
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
  // Exact current preimages from the selected prefix, independent of the new implementation.
  const sources = ['db/platform/migrations/20260818120000_checkout_recovery_lifecycle.sql', 'db/platform/migrations/20261110100000_checkout_recovery_waves.sql'];
  const declarations = sources.map((source, i) => sqlStatements(readFileSync(source, 'utf8')).find(sql => sql.startsWith(`CREATE FUNCTION ${signatures[i]!.split('(')[0]}(${i ? 'p_limit integer,p_policy' : 'p_limit integer DEFAULT'}`))!);
  for (const [i, sql] of declarations.entries()) {
    await db.query(sql.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'));
    await db.query(sql.replace(signatures[i]!.split('(')[0]!, `public.k8_before_${i ? 'checkout' : 'abandoned'}`));
  }
  const before = await attributes();
  for (const sql of sqlStatements(readFileSync(path, 'utf8'))) if (sql.startsWith('CREATE OR REPLACE FUNCTION')) await db.query(sql);
  expect(await attributes()).toEqual(before);
  for (const sql of sqlStatements(readFileSync(guardPath, 'utf8'))) if (sql.startsWith('CREATE OR REPLACE FUNCTION')) await db.query(sql);
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
it('a separate runtime needs only the extra validator EXECUTE and no settings SELECT', async () => {
  await db.query('CREATE ROLE schedule_runtime NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS');
  // This is the complete preexisting invoker-producer privilege set; no policy-table access.
  await db.query(`GRANT USAGE ON SCHEMA public TO schedule_runtime;
    GRANT SELECT ON public.commerce_orders,public.clients,public.customer_communication_preferences,public.commerce_order_draft_receipts,
      public.commerce_settlement_intents,public.outbox_events TO schedule_runtime;
    GRANT INSERT ON public.outbox_events TO schedule_runtime;
    GRANT EXECUTE ON FUNCTION public.commerce_enqueue_abandoned_cart_reminders(integer),
      public.commerce_enqueue_checkout_recovery_reminders(integer,jsonb,timestamptz) TO schedule_runtime`);
  const runtime = await db.connect();
  try {
    await runtime.query('SET ROLE schedule_runtime');
    await expect(runtime.query('SELECT public.commerce_enqueue_abandoned_cart_reminders(1)')).rejects.toMatchObject({ code: '42501' });
    await runtime.query('RESET ROLE');
    await db.query('GRANT EXECUTE ON FUNCTION public.commerce_checkout_recovery_reminder_schedule() TO schedule_runtime');
    await runtime.query('SET ROLE schedule_runtime');
    expect((await runtime.query('SELECT public.commerce_checkout_recovery_reminder_schedule() AS result')).rows[0].result).toEqual(defaults);
    await expect(runtime.query('SELECT * FROM public.commerce_settings')).rejects.toMatchObject({ code: '42501' });
    await runtime.query('SELECT public.commerce_enqueue_abandoned_cart_reminders(1)');
    await runtime.query("SELECT public.commerce_enqueue_checkout_recovery_reminders(1,'{}',now())");
    await expect(installCheckoutRecoveryReminderSchedule(runtime, defaults)).rejects.toMatchObject({ code: '42501' });
    await runtime.query('RESET ROLE');
    await installCheckoutRecoveryReminderSchedule(db, { ...defaults, revision: 'restricted-48', abandonedCart: [{ stage: 'last', afterHours: 48 }] });
    await runtime.query('SET ROLE schedule_runtime');
    expect((await runtime.query('SELECT public.commerce_checkout_recovery_reminder_schedule() AS result')).rows[0].result.revision).toBe('restricted-48');
    await runtime.query('SELECT public.commerce_enqueue_abandoned_cart_reminders(1)');
  } finally { await runtime.query('RESET ROLE'); runtime.release(); }
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
  const [second, fraction = ''] = (await checkoutEvents(id))[0]!.payload.expiresAt.replace(/\+00:00$/, '').split('.');
  const message = `${blockedMessage} (1 blocking orders, latest window end: ${second}.${fraction.padEnd(6, '0')}Z)`;
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
    message: `${blockedMessage} (2 blocking orders, latest window end: unbounded)` });
  await forceSchedule(changed);
  await enqueue();
  expect((await events()).filter(row => [draft, recovery].includes(row.aggregate_id))).toEqual(before);
});

it('CF-R0 (4): absent to explicit defaults refuses for an old draft until its receipt is invalidated', async () => {
  const draft = await order(100, true);
  await priorAbandoned(draft);
  await enqueue();
  await expect(installCheckoutRecoveryReminderSchedule(db, defaults)).rejects.toMatchObject({ code: '55000',
    message: `${blockedMessage} (1 blocking orders, latest window end: unbounded)` });
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
  const stages = (await db.query(`SELECT public.commerce_checkout_recovery_event_stage(e) AS stage FROM public.outbox_events e
    WHERE aggregate_id=$1 AND event_type='commerce.checkout_recovery' ORDER BY idempotency_key`, [id])).rows;
  expect(stages).toEqual([{ stage: 'first' }, { stage: 'last' }]);
  await expect(installCheckoutRecoveryReminderSchedule(db, checkoutSchedule(2, 20))).rejects.toMatchObject({ code: '55000' });
  await forceSchedule(checkoutSchedule(2, 20));
  await enqueue();
  expect((await checkoutEvents(id)).map(row => row.idempotency_key)).toEqual([`checkout_recovery:1h:${id}`, `checkout_recovery:20h:${id}`]);
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
  const stages = (await db.query(`SELECT public.commerce_checkout_recovery_event_stage(e) AS stage FROM public.outbox_events e
    WHERE aggregate_id IN ($1,$2) ORDER BY idempotency_key`, [legacy, links])).rows;
  expect(stages).toEqual([{ stage: 'both' }, { stage: null }, { stage: null }]);
  await enqueue();
  expect(await checkoutEvents(legacy)).toHaveLength(1);
  expect((await checkoutEvents(links)).some(row => row.idempotency_key === `checkout_recovery:1h:${links}`)).toBe(true);
});

it('CF-R0: uses recorded host windows and allows a change after they elapse even if orders remain pending', async () => {
  await installCheckoutRecoveryReminderSchedule(db, defaults);
  const expired = await order(80), open = await order(48);
  await db.query(`INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload)
    SELECT 'commerce_order',id,'commerce.checkout_recovery','checkout_recovery:1h:'||id,
      jsonb_build_object('stage','first','expiresAt',created_at + interval '72 hours')
    FROM public.commerce_orders WHERE id=$1`, [expired]);
  const policy = JSON.stringify({ checkoutSeconds: 72 * 3600 });
  await enqueue(false, policy);
  expect(await checkoutEvents(expired)).toHaveLength(1);
  expect(await checkoutEvents(open)).toHaveLength(1);
  const changed = checkoutSchedule(1, 21);
  await expect(installCheckoutRecoveryReminderSchedule(db, changed)).rejects.toMatchObject({ code: '55000',
    message: expect.stringContaining(`${blockedMessage} (1 blocking orders, latest window end: `) });
  await db.query("UPDATE public.commerce_orders SET status='cancelled' WHERE id=$1", [open]);
  await installCheckoutRecoveryReminderSchedule(db, changed);
});

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
