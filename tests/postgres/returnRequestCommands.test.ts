import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresCommerceReturnsPort } from '@openlup/platform/commerce/server/postgres';
import { createPostgresMigrationRunner } from '../../server/adapters/postgres/migrationRunner.js';
import { qualifiedPostgresStartupOptions, qualifiedAdminPostgresStartupOptions,
  type QualifiedPostgresInstallation, type QualifiedAdminPostgresInstallation } from '../../server/adapters/postgres/qualifiedInstall.js';
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, postgresTeardownTimeoutMs,
  type PostgresContainer } from '../helpers/postgresContainer.js';

import { renewal, prepareOriginal } from './subscriptionNativeFixture.js';

const BASE = '3b430212deb3bf8f1b096a179f2b45992dbe29ff';
type Executor = Pool | PoolClient;
type Subject = { principal: string; client: string; order: string; actor: string; items: string[]; lines: { orderItemId: string; quantity: number }[] };
const call = async (db: Executor, sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows[0].value;
for (const profile of ['legacy', 'qualified-v2', 'qualified-admin'] as const) describe(`return request commands on ${profile}`, () => {
  let container: PostgresContainer, owner: Pool, runtime: Pool;
  const pools: Pool[] = [];
  let historical: Awaited<ReturnType<typeof subject>>, historicalResult: { returnRequestId: string }, historicalRows: unknown;
  const upgrade: Record<string, { f: Subject; key: string; id: string }> = {};
  const historicalKey = randomUUID(), historicalDecisionKey = randomUUID();
  let historicalDecision: { returnRequestId: string };
  beforeAll(async () => {
    container = await runPostgresContainer({ name: `return-commands-${profile}-${process.pid}`, password: 'synthetic-conformance' });
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error('Return PostgreSQL unavailable');
    const password = randomUUID();
    const pool = (url: string, options?: string) => { const db = new Pool({ connectionString: url, options: `${options ?? ''} -c timezone=UTC` }); pools.push(db); return db; };
    const bootstrap = pool(container.connectionString);
    const login = (name: string) => { const url = new URL(container.connectionString); url.username = name; if (name !== 'postgres') url.password = password; return url.toString(); };
    if (profile === 'qualified-admin') await bootstrap.query(`CREATE ROLE returns_m LOGIN NOINHERIT NOSUPERUSER CREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'; ALTER DATABASE postgres OWNER TO returns_m`);
    if (profile !== 'legacy') for (const role of ['returns_r', 'returns_s']) await bootstrap.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    const installation: { generation: 'legacy' } | QualifiedPostgresInstallation | QualifiedAdminPostgresInstallation = profile === 'legacy' ? { generation: 'legacy' }
      : { generation: profile, roleMode: 'installer-managed', bootstrapLogin: 'postgres', migrationLogin: profile === 'qualified-admin' ? 'returns_m' : 'postgres', runtimeLogin: 'returns_r', restoreLogin: 'returns_s' };
    owner = pool(login(installation.generation === 'legacy' ? 'postgres' : installation.migrationLogin),
      installation.generation === 'qualified-v2' ? qualifiedPostgresStartupOptions(installation) : installation.generation === 'qualified-admin' ? qualifiedAdminPostgresStartupOptions(installation) : undefined);
    const prefix = JSON.parse(execFileSync('git', ['show', `${BASE}:config/platform-migration-manifest.json`], { encoding: 'utf8' }));
    const root = resolve(`.context/scratch/c35r/prefix-${profile}`);
    for (const plan of [prefix, prefix.qualified, prefix.qualifiedAdmin]) for (const unit of [plan.baseline, ...plan.forward]) {
      const target = resolve(root, unit.file); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, readFileSync(unit.file));
    }
    mkdirSync(resolve(root, 'config'), { recursive: true }); writeFileSync(resolve(root, 'config/platform-migration-manifest.json'), JSON.stringify(prefix));
    const runner = (sourceRoot = process.cwd()) => createPostgresMigrationRunner({ connectionString: 'injected' }, { root: sourceRoot, installation, poolFactory: () => owner });
    await runner(root).apply();
    runtime = profile === 'legacy' ? owner : pool(login('returns_r'), '-c role=service_role');
    historical = await subject();
    historicalResult = await request(historical, historicalKey, historical.lines);
    historicalDecision = await request(historical, randomUUID());
    await approve(historical, historicalDecision.returnRequestId, historicalDecisionKey, 'full', null, 'old note');
    for (const label of ['plain', 'padded', 'same', 'different', 'approved', 'rejected']) {
      const f = await subject(), key = randomUUID();
      const raw = ['padded', 'different'].includes(label) ? ` ${key} ` : ['approved', 'rejected'].includes(label) ? `${key}:${label}` : key;
      const result = await request(f, raw, f.lines, 'legacy');
      upgrade[label] = { f, key, id: result.returnRequestId };
    }
    historicalRows = await rows();
    expect((await owner.query("SELECT 1 FROM pg_attribute WHERE attrelid='public.commerce_return_lines'::regclass AND attname='sku'")).rows).toEqual([]);
    await runner().apply();
    expect(await runner().apply()).toEqual({ applied: [] });
  }, postgresSetupTimeoutMs);
  afterAll(() => closePostgres(container, pools), postgresTeardownTimeoutMs);

  async function subject(status = 'paid'): Promise<Subject> {
    const principal = randomUUID(), client = randomUUID(), order = randomUUID(), actor = randomUUID(), items = [randomUUID(), randomUUID()];
    await owner.query('INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)', [principal, `${principal}@example.invalid`]);
    await owner.query('INSERT INTO public.clients(id,email,principal_id) VALUES($1,$2,$3)', [client, `${client}@example.invalid`, principal]);
    await owner.query("INSERT INTO public.commerce_operators(id,label) VALUES($1,'Operator')", [actor]);
    await owner.query(`WITH o AS (INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor,metadata)
      VALUES($1,$2,$3,'XTS',400,'{"orderDraftSnapshot":{"lines":[{"sku":"snapshot-sku"},{}]}}'::jsonb) RETURNING id)
      INSERT INTO public.commerce_order_items(id,order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)
      SELECT $4::uuid,id,1,2,100,200 FROM o UNION ALL SELECT $5::uuid,id,2,2,100,200 FROM o`, [order, client, status, ...items]);
    return { principal, client, order, actor, items, lines: items.map(orderItemId => ({ orderItemId, quantity: 1 })) };
  }
  const request = (f: Subject, key: string = randomUUID(), lines: unknown = f.lines, note: string | null = null, db: Executor = runtime, reason: string | null = 'other') => call(db,
    'SELECT public.commerce_return_request_create($1,$2,$3,$4,$5,$6) AS value', [key, f.order, JSON.stringify(lines), reason, note, f.principal]);
  const approve = (f: Subject, id: string, key: string = randomUUID(), mode = 'full', amount: number | null = null, note: string | null = null, db: Executor = runtime) => call(db,
    'SELECT public.commerce_return_approve($1,$2,$3,$4,$5,$6) AS value', [key, id, f.actor, mode, amount, note]);
  const reject = (f: Subject, id: string, key: string = randomUUID(), note: string | null = null) => call(runtime,
    'SELECT public.commerce_return_reject($1,$2,$3,$4) AS value', [key, id, f.actor, note]);
  const rows = async () => (await owner.query(`SELECT 'requests' AS kind,to_jsonb(t) AS row,xmin::text AS version FROM public.commerce_return_requests t
    UNION ALL SELECT 'lines',to_jsonb(t)-'sku',xmin::text FROM public.commerce_return_lines t
    UNION ALL SELECT 'operations',to_jsonb(t),xmin::text FROM public.commerce_return_operations t ORDER BY kind,row`)).rows;
  const events = async (id: string) => (await owner.query('SELECT event_type,idempotency_key,payload,metadata FROM public.outbox_events WHERE aggregate_id=$1 ORDER BY event_type', [id])).rows;
  const effects = async () => {
    const output: Record<string, unknown> = {};
    for (const table of ['commerce_orders', 'commerce_order_items', 'commerce_settlement_intents', 'payment_truth_events', 'subscriptions', 'fulfillment_inventory_reservations'])
      output[table] = (await owner.query(`SELECT to_jsonb(t) AS row,xmin::text AS version FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows;
    return output;
  };

  it('retains actual pre-forward receipts without recording historical SKU or rewriting rows', async () => {
    expect(await rows()).toEqual(historicalRows);
    expect((await owner.query('SELECT sku FROM public.commerce_return_lines')).rows.every(row => row.sku === null)).toBe(true);
    await owner.query("UPDATE public.commerce_orders SET status='fulfillment_pending' WHERE id=$1", [historical.order]);
    expect(await request(historical, historicalKey, historical.lines)).toEqual({ ...historicalResult, replayed: true });
    expect(await rows()).toEqual(historicalRows);
    await expect(request(historical, historicalKey, historical.lines.map(line => ({ ...line, sku: 'unrecorded' })))).rejects.toThrow('order_not_found');
    expect(await approve(historical, historicalDecision.returnRequestId, historicalDecisionKey, 'full', null, 'changed note')).toMatchObject({ replayed: true, status: 'approved' });
    expect(await rows()).toEqual(historicalRows); expect(await events(historicalDecision.returnRequestId)).toEqual([]);
  });

  it.each(['plain', 'padded'])('resolves the %s historical key alias before any new request', async label => {
    const { f, key, id } = upgrade[label], before = await rows();
    for (const spelling of [key, ` ${key} `]) expect(await request(f, spelling, f.lines, 'legacy')).toEqual({ returnRequestId: id, status: 'requested', replayed: true });
    expect(await rows()).toEqual(before);
    expect((await owner.query('SELECT count(*)::int AS n FROM public.commerce_return_requests WHERE order_id=$1', [f.order])).rows).toEqual([{ n: 1 }]);
  });

  it('resolves unique historical/canonical matches and uniformly refuses ambiguous upgrade receipts', async () => {
    const current = (await owner.query("SELECT pg_get_functiondef('public.commerce_return_request_create_owned(text,uuid,jsonb,text,text,uuid)'::regprocedure) AS definition")).rows[0].definition;
    const pushed = execFileSync('git', ['show', 'f14e2503b648674b446d87cdfc98f894814f4c28:db/platform/migrations/20261110210000_return_request_decisions.sql'], { encoding: 'utf8' });
    const previous = pushed.match(/CREATE FUNCTION public\.commerce_return_request_create_owned\([\s\S]*?\n\$\$;/)![0].replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
    let same: { returnRequestId: string }, different: { returnRequestId: string };
    try {
      // Reproduce both upgrade sequences using the exact pushed writer, then restore the repair.
      await owner.query(previous);
      same = await request(upgrade.same.f, ` ${upgrade.same.key} `, upgrade.same.f.lines, 'legacy');
      different = await request(upgrade.different.f, upgrade.different.key, upgrade.different.f.lines, 'canonical');
    } finally { await owner.query(current); }
    expect(same.returnRequestId).not.toBe(upgrade.same.id);
    expect(different.returnRequestId).not.toBe(upgrade.different.id);
    const before = await rows();
    for (const spelling of [upgrade.same.key, ` ${upgrade.same.key} `])
      await expect(request(upgrade.same.f, spelling, upgrade.same.f.lines, 'legacy')).rejects.toMatchObject({ code: '22023', message: 'commerce_return_request_create_order_not_found' });
    for (const spelling of [upgrade.different.key, ` ${upgrade.different.key} `]) {
      expect(await request(upgrade.different.f, spelling, upgrade.different.f.lines, 'legacy')).toMatchObject({ returnRequestId: upgrade.different.id, replayed: true });
      expect(await request(upgrade.different.f, spelling, upgrade.different.f.lines, 'canonical')).toMatchObject({ returnRequestId: different.returnRequestId, replayed: true });
      await expect(request(upgrade.different.f, spelling, upgrade.different.f.lines, 'changed')).rejects.toMatchObject({ code: '22023', message: 'commerce_return_request_create_order_not_found' });
    }
    expect(await rows()).toEqual(before);
    for (const label of ['same', 'different']) expect((await owner.query('SELECT count(*)::int AS n FROM public.commerce_return_requests WHERE order_id=$1', [upgrade[label].f.order])).rows).toEqual([{ n: 2 }]);
  });

  it.each(['approved', 'rejected'])('never replays a historical request as an %s decision', async kind => {
    const { f, key } = upgrade[kind], target = await request(f), before = await rows();
    const decide = (commandKey: string) => kind === 'approved' ? approve(f, target.returnRequestId, commandKey) : reject(f, target.returnRequestId, commandKey);
    await expect(decide(key)).rejects.toMatchObject({ code: '22023', message: `commerce_return_${kind === 'approved' ? 'approve' : 'reject'}_not_found` });
    expect(await rows()).toEqual(before); expect(await events(target.returnRequestId)).toEqual([]);
    const valid = randomUUID(); expect(await decide(valid)).toMatchObject({ status: kind, replayed: false });
    expect(await decide(valid)).toMatchObject({ status: kind, replayed: true });
    expect(await events(target.returnRequestId)).toHaveLength(1);
    expect((await events(target.returnRequestId))[0].event_type).toBe(`commerce.return.${kind}`);
  });

  it('keeps qualified runtime restricted, including INSERT-only return lines and owner-only emitter', async () => {
    if (profile === 'legacy') return;
    expect((await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await expect(runtime.query('SELECT * FROM public.commerce_return_lines')).rejects.toMatchObject({ code: '42501' });
    expect((await runtime.query("SELECT has_function_privilege(current_user,'public.commerce_emit_return_outbox()','EXECUTE') AS allowed")).rows).toEqual([{ allowed: false }]);
  });

  it('refuses unowned or missing orders before waiting for a foreign order or command key', async () => {
    const f = await subject(), foreign = await subject(), key = randomUUID();
    await request(foreign, key);
    const db = await owner.connect();
    try {
      await db.query('BEGIN'); await db.query('SELECT id FROM public.commerce_orders WHERE id=$1 FOR UPDATE', [foreign.order]);
      const errors: { code: string; message: string }[] = [];
      for (const order of [randomUUID(), foreign.order, f.order]) {
        const caller = await runtime.connect();
        try { await caller.query("SET statement_timeout='1500ms'"); await request({ ...f, order }, key, f.lines, null, caller); }
        catch (error) { errors.push({ code: (error as { code: string }).code, message: (error as Error).message }); }
        finally { await caller.query('SET statement_timeout=0'); caller.release(); }
      }
      expect(errors).toEqual(Array.from({ length: 3 }, () => ({ code: '22023', message: 'commerce_return_request_create_order_not_found' })));
    } finally { await db.query('ROLLBACK'); db.release(); }
  });

  it('refuses duplicate UUID identities, foreign lines and quantity bounds without inserting rows', async () => {
    const f = await subject(), foreign = await subject(), before = await rows();
    await expect(request(f, randomUUID(), [f.lines[0], { ...f.lines[0], orderItemId: f.items[0].toUpperCase() }])).rejects.toThrow('commerce_return_request_create_duplicate_line');
    await expect(request(f, randomUUID(), [{ quantity: 1 }, { quantity: 1 }])).rejects.toThrow('commerce_return_request_create_invalid_input');
    for (const [line, message] of [[{ orderItemId: foreign.items[0], quantity: 1 }, 'line_not_in_order'],
      [{ orderItemId: f.items[0], quantity: 0 }, 'invalid_input'], [{ orderItemId: f.items[0], quantity: 3 }, 'quantity_exceeds_ordered']] as const)
      await expect(request(f, randomUUID(), [line])).rejects.toThrow(message);
    expect(await rows()).toEqual(before);
    expect(await request(f, randomUUID(), f.lines.map(line => ({ ...line, quantity: 2 })))).toMatchObject({ status: 'requested' });
    const key: string = randomUUID(), accepted = await request(f, key);
    expect(await request(f, key)).toEqual({ ...accepted, replayed: true });
    expect((await owner.query('SELECT count(*)::int AS n FROM public.commerce_return_lines WHERE return_request_id=$1', [accepted.returnRequestId])).rows).toEqual([{ n: 2 }]);
  });

  it('canonicalizes key, note, UUID casing, line order, SKU and disposition defaults', async () => {
    const f = await subject(), key: string = randomUUID(), before = await effects();
    const made = await request(f, ` ${key} `, [{ ...f.lines[0], sku: ' supplied ', restockDisposition: ' quarantine ' }, f.lines[1]], ' note ');
    const accepted = await rows();
    expect((await owner.query('SELECT order_item_id,sku,restock_disposition FROM public.commerce_return_lines WHERE return_request_id=$1 ORDER BY order_item_id', [made.returnRequestId])).rows)
      .toEqual(expect.arrayContaining([{ order_item_id: f.items[0], sku: 'supplied', restock_disposition: 'quarantine' }, { order_item_id: f.items[1], sku: 'unknown', restock_disposition: 'restock' }]));
    expect(await request({ ...f, order: f.order.toUpperCase(), principal: f.principal.toUpperCase() }, key, [{ ...f.lines[1], orderItemId: f.items[1].toUpperCase(), sku: 'unknown', restockDisposition: 'restock' },
      { ...f.lines[0], orderItemId: f.items[0].toUpperCase(), sku: 'supplied', restockDisposition: 'quarantine' }], 'note')).toEqual({ ...made, replayed: true });
    for (const changed of [{ lines: f.lines, note: 'note' }, { lines: [{ ...f.lines[0], sku: 'supplied', restockDisposition: 'quarantine' }, f.lines[1]], note: 'changed' }])
      await expect(request(f, key, changed.lines, changed.note)).rejects.toThrow('order_not_found');
    expect(await rows()).toEqual(accepted); expect(await effects()).toEqual(before); expect(await events(made.returnRequestId)).toEqual([]);
    const defaultsKey = randomUUID(), snapshot = await request(f, defaultsKey);
    expect(await request(f, ` ${defaultsKey} `, f.lines.map(line => ({ ...line, sku: ' ', restockDisposition: ' ' })), ' ')).toEqual({ ...snapshot, replayed: true });
    expect((await owner.query('SELECT sku FROM public.commerce_return_lines WHERE return_request_id=$1 AND order_item_id=$2', [snapshot.returnRequestId, f.items[0]])).rows).toEqual([{ sku: 'snapshot-sku' }]);
  });

  it('uses frozen source-line ordinals and renewal snapshots rather than live catalogue values', async () => {
    const f = await subject();
    await owner.query("UPDATE public.commerce_order_items SET source_line_ordinal=2,catalog_unit_amount_minor=100,catalog_line_amount_minor=200,promotion_discount_allocated_minor=0,promotion_allocation_fingerprint=repeat('a',64) WHERE id=$1", [f.items[0]]);
    await owner.query(`UPDATE public.commerce_orders SET metadata=jsonb_set(metadata,'{orderDraftSnapshot,lines}','[{"sku":"other-source"},{"sku":"frozen-source"}]') WHERE id=$1`, [f.order]);
    const made = await request(f);
    expect((await owner.query('SELECT sku FROM public.commerce_return_lines WHERE return_request_id=$1 AND order_item_id=$2', [made.returnRequestId, f.items[0]])).rows).toEqual([{ sku: 'frozen-source' }]);
    const seed = await renewal(owner), original = await prepareOriginal(owner, seed), principal = randomUUID(), actor = randomUUID();
    await owner.query('INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)', [principal, `${principal}@example.invalid`]);
    await owner.query('UPDATE public.clients SET principal_id=$2 WHERE id=$1', [seed.client, principal]);
    await owner.query("INSERT INTO public.commerce_operators(id,label) VALUES($1,'Operator')", [actor]);
    await owner.query("UPDATE public.commerce_orders SET status='paid' WHERE id=$1", [original.orderId]);
    const items = (await owner.query('SELECT id FROM public.commerce_order_items WHERE order_id=$1 ORDER BY line_ordinal', [original.orderId])).rows.map(row => String(row.id));
    await owner.query("UPDATE public.catalog_skus SET sku=sku||'-changed' WHERE id IN(SELECT sku_id FROM public.commerce_order_items WHERE order_id=$1)", [original.orderId]);
    const renewed = await request({ principal, client: seed.client, actor, order: original.orderId, items, lines: items.map(orderItemId => ({ orderItemId, quantity: 1 })) });
    expect((await owner.query('SELECT sku FROM public.commerce_return_lines WHERE return_request_id=$1 AND order_item_id=$2', [renewed.returnRequestId, items[0]])).rows).toEqual([{ sku: seed.snapshot.lines[0].sku }]);
  });

  it('accepts paid/fulfilled only, preserves the fixed reason set and cleanly refuses unknown reasons', async () => {
    for (const status of ['pending_payment', 'fulfillment_pending', 'cancelled', 'refunded']) await expect(request(await subject(status))).rejects.toThrow('not_returnable');
    const f = await subject('fulfilled'), before = await rows();
    for (const reason of ['outside-stored-set', null]) await expect(request(f, randomUUID(), f.lines, null, runtime, reason)).rejects.toThrow('invalid_input');
    expect(await rows()).toEqual(before);
    expect(await request(f, randomUUID(), f.lines, null, runtime, 'pet_refused')).toMatchObject({ status: 'requested' });
  });

  it('serializes concurrent same-customer replay and refuses a foreign in-flight global key without waiting', async () => {
    const f = await subject(), other = await subject(), key: string = randomUUID(), db = await runtime.connect();
    try {
      await db.query('BEGIN'); const first = await request(f, key, f.lines, null, db);
      const replay = request(f, key);
      const foreign = await runtime.connect();
      try { await foreign.query("SET statement_timeout='1500ms'"); await expect(request(other, key, other.lines, null, foreign)).rejects.toThrow('order_not_found'); }
      finally { await foreign.query('SET statement_timeout=0'); foreign.release(); }
      await db.query('COMMIT'); expect(await replay).toEqual({ ...first, replayed: true });
    } finally { await db.query('ROLLBACK'); db.release(); }
  });

  it('requires an amount for partial approval and emits exactly one decision with no financial or stock effect', async () => {
    const f = await subject(), made = await request(f), key: string = randomUUID(), before = await effects(), requested = await rows();
    for (const amount of [null, -1]) await expect(approve(f, made.returnRequestId, key, 'partial', amount)).rejects.toThrow('invalid_input');
    expect(await rows()).toEqual(requested); expect(await events(made.returnRequestId)).toEqual([]);
    expect(await approve(f, made.returnRequestId, key, 'partial', 0, ' note ')).toMatchObject({ status: 'approved', replayed: false });
    const decided = await rows();
    expect(await approve(f, made.returnRequestId, ` ${key} `, 'full', null, 'changed')).toMatchObject({ status: 'approved', replayed: true });
    expect(await rows()).toEqual(decided);
    expect(await events(made.returnRequestId)).toEqual([{ event_type: 'commerce.return.approved', idempotency_key: `return_approved:${made.returnRequestId}`,
      payload: expect.objectContaining({ returnRequestId: made.returnRequestId, orderUuid: f.order, orderId: `order_${f.order}`, status: 'approved', refundMode: 'partial', refundAmountCents: 0, occurredAt: expect.any(String) }), metadata: { source: 'commerce_emit_return_outbox' } }]);
    expect(await effects()).toEqual(before);
    await expect(reject(f, made.returnRequestId)).rejects.toThrow('invalid_state');
  });

  it('retains prior amounts for full/none, normalizes notes and replays decisions using stored current status', async () => {
    const f = await subject(), before = await effects();
    for (const mode of ['full', 'none']) {
      const made = await request(f);
      await owner.query("UPDATE public.commerce_return_requests SET refund_amount_minor=17,admin_note='old' WHERE id=$1", [made.returnRequestId]);
      await approve(f, made.returnRequestId, randomUUID(), mode, -1, '  ');
      expect((await owner.query('SELECT refund_mode,refund_amount_minor,admin_note FROM public.commerce_return_requests WHERE id=$1', [made.returnRequestId])).rows)
        .toEqual([{ refund_mode: mode, refund_amount_minor: '17', admin_note: 'old' }]);
    }
    const made = await request(f), key = randomUUID(); await reject(f, made.returnRequestId, key, ' reject ');
    const decided = await rows(); expect(await reject(f, made.returnRequestId, key, 'changed')).toMatchObject({ status: 'rejected', replayed: true });
    expect(await rows()).toEqual(decided); expect(await events(made.returnRequestId)).toHaveLength(1);
    expect((await events(made.returnRequestId))[0]).toMatchObject({ event_type: 'commerce.return.rejected', payload: { status: 'rejected' } });
    await owner.query("UPDATE public.commerce_return_requests SET status='approved' WHERE id=$1", [made.returnRequestId]);
    expect(await reject(f, made.returnRequestId, key)).toMatchObject({ status: 'approved', replayed: true });
    expect(await events(made.returnRequestId)).toHaveLength(2); expect(await effects()).toEqual(before);
  });

  it('covers direct INSERT/UPDATE writers under invoker privileges, deduplicates and rolls back failed decisions', async () => {
    const f = await subject(), made = await request(f), before = await effects();
    expect(await events(made.returnRequestId)).toEqual([]);
    await runtime.query("UPDATE public.commerce_return_requests SET status='rejected' WHERE id=$1", [made.returnRequestId]);
    await runtime.query("UPDATE public.commerce_return_requests SET status=status WHERE id=$1", [made.returnRequestId]);
    await runtime.query("UPDATE public.commerce_return_requests SET status='requested' WHERE id=$1", [made.returnRequestId]);
    await runtime.query("UPDATE public.commerce_return_requests SET status='rejected' WHERE id=$1", [made.returnRequestId]);
    expect(await events(made.returnRequestId)).toHaveLength(1);
    const inserted = (await runtime.query("INSERT INTO public.commerce_return_requests(order_id,requested_by,reason_code,status) VALUES($1,$2,'other','approved') RETURNING id", [f.order, f.client])).rows[0].id;
    expect(await events(inserted)).toHaveLength(1);
    const pending = await request(f), key: string = randomUUID(), db = await runtime.connect(), original = await rows();
    try { await db.query('BEGIN'); await approve(f, pending.returnRequestId, key, 'full', null, null, db); await db.query('ROLLBACK'); }
    finally { db.release(); }
    expect(await rows()).toEqual(original); expect(await events(pending.returnRequestId)).toEqual([]); expect(await effects()).toEqual(before);
    expect((await owner.query("SELECT prosecdef FROM pg_proc WHERE oid='public.commerce_emit_return_outbox()'::regprocedure")).rows).toEqual([{ prosecdef: false }]);
  });

  it('retains the public PostgreSQL adapter contract for request and decisions', async () => {
    const f = await subject(), port = createPostgresCommerceReturnsPort(runtime), key = randomUUID();
    const input = { idempotencyKey: key, orderId: f.order, requestedBy: f.principal, reasonCode: 'other', lines: f.lines };
    const made = await port.createRequest(input); expect(await port.createRequest(input)).toEqual({ ...made, replayed: true });
    expect(await port.approve({ idempotencyKey: randomUUID(), returnRequestId: made.returnRequestId, actorUserId: f.actor, refundMode: 'partial', refundAmountCents: 1 })).toMatchObject({ status: 'approved' });
  });
});
