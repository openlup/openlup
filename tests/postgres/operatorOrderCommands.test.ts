import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresCommerceOmsPort } from '@openlup/platform/commerce/server/postgres';
import { lifecycleInstallation, lifecycleProfiles, type LifecycleInstallation } from './subscriptionLifecycleClosureFixture.js';
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from '../helpers/postgresContainer.js';

const AT = '2026-11-10T12:00:00.000Z';
type Executor = Pool | PoolClient;
async function value(db: Executor, sql: string, args: unknown[] = []) {
  return (await db.query(sql, args)).rows[0].value;
}
// Source-pinned command witnesses: one audit, payment aggregate before status,
// exact reservation release, manual status-only refund and genuine refund duty.
for (const profile of lifecycleProfiles) describe(`operator order commands on ${profile}`, () => {
  let h: LifecycleInstallation;
  beforeAll(async () => { h = await lifecycleInstallation(profile); }, postgresSetupTimeoutMs);
  afterAll(() => h?.close(), postgresTeardownTimeoutMs);

  async function subject(status = 'pending_payment', linked = false) {
    const client = randomUUID(), order = randomUUID(), actor = randomUUID(), subscription = randomUUID(), cycle = randomUUID();
    await h.owner.query('INSERT INTO public.clients(id,email) VALUES($1,$2)', [client, `${client}@example.invalid`]);
    await h.owner.query("INSERT INTO public.commerce_operators(id,label) VALUES($1,'Operator')", [actor]);
    if (linked) {
      await h.owner.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES($1,$2,28,'2026-12-01T00:00:00Z')", [subscription, client]);
      await h.owner.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status) VALUES($1,$2,'2026-11-10T00:00:00Z','payment_pending')", [cycle, subscription]);
    }
    await h.owner.query(`WITH o AS (INSERT INTO public.commerce_orders(id,client_id,subscription_cycle_id,status,currency_code,total_amount_minor)
      VALUES($1,$2,$3,$4,'XTS',200) RETURNING id)
      INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)
      SELECT id,1,2,100,200 FROM o`, [order, client, linked ? cycle : null, status]);
    const intent = randomUUID();
    await h.owner.query("INSERT INTO public.commerce_settlement_intents(id,order_id,channel_key,amount_minor,currency_code,open_idempotency_key) VALUES($1,$2,'sandbox',200,'XTS',$3)", [intent, order, intent]);
    return { order, actor, intent, subscription: linked ? subscription : null };
  }
  type Subject = Awaited<ReturnType<typeof subject>>;
  const cancel = (f: Subject, key = randomUUID(), reason = 'buyer request') => value(h.runtime, 'SELECT public.oms_cancel_unpaid_order($1,$2,$3,$4) AS value', [key, f.order, reason, f.actor]);
  const mark = (f: Subject, key = randomUUID(), reason = 'external refund') => value(h.runtime, 'SELECT public.oms_mark_refunded($1,$2,$3,$4) AS value', [key, f.order, reason, f.actor]);
  const audit = async (f: Subject) => (await h.owner.query('SELECT operation_type,idempotency_key,payload FROM public.commerce_order_operations WHERE order_id=$1 ORDER BY id', [f.order])).rows;
  const events = async (f: Subject) => (await h.owner.query("SELECT event_type,payload,metadata FROM public.outbox_events WHERE aggregate_id=$1 AND event_type IN ('commerce.order.cancelled','commerce.order.refunded') ORDER BY id", [f.order])).rows;
  const snapshot = async (f: Subject) => (await h.owner.query(`SELECT to_jsonb(o) AS order_row,to_jsonb(i) AS intent_row,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM public.payment_simulator_attempts a WHERE a.settlement_intent_id=i.id) AS attempts,
    (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM public.payment_truth_events e WHERE e.settlement_intent_id=i.id) AS truth
    FROM public.commerce_orders o JOIN public.commerce_settlement_intents i ON i.order_id=o.id WHERE o.id=$1`, [f.order])).rows;
  const subscription = async (f: Subject) => (await h.owner.query('SELECT to_jsonb(s) AS row FROM public.subscriptions s WHERE id=$1', [f.subscription])).rows;
  const attempt = (f: Subject) => value(h.runtime, 'SELECT public.payment_simulator_begin_attempt($1,$2,$3,\'{}\',$4) AS value', [randomUUID(), f.intent, 'a'.repeat(64), AT]);
  const observe = (id: string, outcome: string, db: Executor = h.runtime) => value(db, 'SELECT public.payment_simulator_record_observation($1,$2,$3,$4,$5) AS value', [id, randomUUID(), 'b'.repeat(64), outcome, AT]);
  const capture = async (f: Subject, id: string, db: Executor = h.runtime) => {
    const e = await observe(id, 'captured', db);
    return value(db, `SELECT public.payment_truth_ingest_event($1,$2,$3,$4,'captured',200,'XTS',$5,NULL,NULL,$6,'payment_failed','/recover','payment_recovered') AS value`,
      [`sandbox:${e.id}`, 'c'.repeat(64), randomUUID(), f.intent, AT, { attemptRef: id, sourceReference: e.id, sourceKind: 'accepted_event', observedStatus: 'captured', observedAt: AT, payloadFingerprint: 'b'.repeat(64) }]);
  };

  it('keeps the actual runtime restricted and private attempts behind the owned command', async () => {
    if (profile === 'legacy') return;
    expect((await h.runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await expect(h.runtime.query('SELECT * FROM public.payment_simulator_attempts')).rejects.toMatchObject({ code: '42501' });
    await expect(h.runtime.query('SELECT * FROM public.fulfillment_purchase_reservation_receipts')).rejects.toMatchObject({ code: '42501' });
  });

  it.each(['dispatched', 'indeterminate', 'captured'] as const)('refuses %s attempts atomically', async state => {
    const f = await subject(), a = await attempt(f);
    if (state !== 'dispatched') await observe(a.id, state);
    const before = await snapshot(f);
    await expect(cancel(f)).rejects.toMatchObject({ code: '23505' });
    expect(await snapshot(f)).toEqual(before); expect(await audit(f)).toEqual([]); expect(await events(f)).toEqual([]);
  });

  it.each(['captured', 'indeterminate'] as const)('refuses independent %s truth even without an active attempt', async outcome => {
    const f = await subject();
    await h.owner.query(`INSERT INTO public.payment_truth_events(source_event_id,event_fingerprint,ingest_idempotency_key,settlement_intent_id,outcome,amount_minor,currency_code,source_evidence,occurred_at)
      VALUES($1,$2,$3,$4,$5,200,'XTS','{}',$6)`, [randomUUID(), 'c'.repeat(64), randomUUID(), f.intent, outcome, AT]);
    const before = await snapshot(f); await expect(cancel(f)).rejects.toMatchObject({ code: '23505' });
    expect(await snapshot(f)).toEqual(before); expect(await audit(f)).toEqual([]);
  });

  it('refuses settled payment despite a stale pending order status', async () => {
    const f = await subject();
    await h.owner.query("UPDATE public.commerce_settlement_intents SET status='settled',settled_at=$2 WHERE id=$1", [f.intent, AT]);
    await expect(cancel(f)).rejects.toMatchObject({ code: '23505' }); expect(await audit(f)).toEqual([]);
  });

  it('cancels only unpaid work with one audit, concurrent replay/conflicts and no subscription change', async () => {
    const f = await subject('pending_payment', true), before = await subscription(f), key = randomUUID();
    const a = await attempt(f); await observe(a.id, 'expired');
    const answers = await Promise.all([createPostgresCommerceOmsPort(h.runtime).cancelOrder({ idempotencyKey: key, orderId: f.order, actorUserId: f.actor, reason: 'buyer request' }), cancel(f, key)]);
    expect(answers.map(x => x.replayed).sort()).toEqual([false, true]);
    expect(await audit(f)).toEqual([{ operation_type: 'order_cancelled', idempotency_key: key, payload: { reason: 'buyer request' } }]);
    expect(await events(f)).toEqual([]); expect(await subscription(f)).toEqual(before);
    await expect(cancel(f, key, 'changed')).rejects.toMatchObject({ code: '23505' });
    const other = await subject(); await expect(cancel(other, key)).rejects.toMatchObject({ code: '23505' });
    expect(await cancel(f)).toMatchObject({ replayed: true }); expect(await audit(f)).toHaveLength(1);
    await expect(attempt(f)).rejects.toThrow('payment_simulator_order_not_payable');
  });

  it('releases exactly the selected purchase holds once, retaining other orders and terminal holds', async () => {
    const f = await subject(), other = await subject(), sku = randomUUID(), source = randomUUID();
    await h.owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1::uuid,$1::text,'Unit')", [sku]);
    await h.owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1::uuid,$1::uuid,$1::text,'Unit')", [sku]);
    await h.owner.query(`INSERT INTO public.fulfillment_stock_current(source_key,sku,total_quantity,for_sale_quantity,reserved_unavailable_quantity,inventory_class,last_synced_at,stale_after,sync_run_id,idempotency_key,operation_fingerprint)
      VALUES($1,$2,100,100,0,'sellable',$3,'2099-01-01T00:00:00Z',$1,$1,$4)`, [source, sku, AT, 'd'.repeat(64)]);
    const reserve = async (target: Subject) => {
      await h.owner.query('UPDATE public.commerce_order_items SET sku_id=$2 WHERE order_id=$1', [target.order, sku]);
      const item = (await h.owner.query('SELECT id FROM public.commerce_order_items WHERE order_id=$1', [target.order])).rows[0].id;
      const r = await value(h.runtime, `SELECT public.fulfillment_reserve_purchase_order_items($1,$2,$3,$4,'created','2099-01-01T00:00:00Z','{}',$5) AS value`, [randomUUID(), target.order, source, JSON.stringify([{ orderItemId: item, skuId: sku, quantity: 2 }]), AT]);
      return r.reservations[0].reservationId as string;
    };
    const one = await reserve(f), two = await reserve(f), foreign = await reserve(other);
    await value(h.runtime, "SELECT public.fulfillment_release_purchase_reservation($1,$2,'prior','{}',$3) AS value", [randomUUID(), two, AT]);
    const beforeTerminal = (await h.owner.query('SELECT to_jsonb(r) AS row FROM public.fulfillment_inventory_reservations r WHERE id=$1', [two])).rows;
    const key = randomUUID(); await cancel(f, key); await cancel(f, key);
    expect((await h.owner.query('SELECT id,status FROM public.fulfillment_inventory_reservations WHERE id=ANY($1) ORDER BY id', [[one, two, foreign]])).rows)
      .toEqual([{ id: one, status: 'released' }, { id: two, status: 'released' }, { id: foreign, status: 'held' }].sort((a, b) => a.id.localeCompare(b.id)));
    expect((await h.owner.query('SELECT to_jsonb(r) AS row FROM public.fulfillment_inventory_reservations r WHERE id=$1', [two])).rows).toEqual(beforeTerminal);
    const receipts = (await h.owner.query("SELECT idempotency_key,command,result FROM public.fulfillment_purchase_reservation_receipts WHERE command->'metadata'->>'operatorCancellationKey'=$1", [key])).rows;
    expect(receipts).toHaveLength(1); expect(receipts[0].command).toMatchObject({ reservationId: one, action: 'release' });
    expect(await value(h.runtime, "SELECT public.fulfillment_release_purchase_reservation($1,$2,'buyer request',$3,$4) AS value", [receipts[0].idempotency_key, one, { operatorCancellationKey: key }, AT])).toMatchObject({ replayed: true, status: 'released' });
  });

  async function blocked() {
    for (let i = 0; i < 200; i++) {
      if ((await h.owner.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%oms_cancel_unpaid_order%' AND pid<>pg_backend_pid()")).rowCount) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('cancellation did not reach the aggregate lock');
  }
  it('serializes concurrent capture before cancellation and refuses without an audit', async () => {
    const f = await subject(), a = await attempt(f), db = await h.owner.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await db.query('BEGIN'); await db.query('SELECT id FROM public.commerce_orders WHERE id=$1 FOR UPDATE', [f.order]);
      pending = cancel(f).then(result => ({ result }), error => ({ error }));
      await blocked(); await capture(f, a.id, db); await db.query('COMMIT');
      expect(await pending).toMatchObject({ error: { code: '23505' } }); expect(await audit(f)).toEqual([]);
    } finally { await db.query('ROLLBACK'); db.release(); await pending; }
  });
  it('lets a linked capture holding the order acquire its parent before cancellation refuses', async () => {
    const f = await subject('pending_payment', true), a = await attempt(f), db = await h.owner.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await db.query('BEGIN'); await db.query('SELECT id FROM public.commerce_orders WHERE id=$1 FOR UPDATE', [f.order]);
      pending = cancel(f).then(result => ({ result }), error => ({ error }));
      await blocked();
      // Payment settlement owns the order before asking for the subscription. A cancellation
      // waiting on that order must leave this parent available, rather than deadlock.
      expect((await db.query('SELECT id FROM public.subscriptions WHERE id=$1 FOR UPDATE NOWAIT', [f.subscription])).rowCount).toBe(1);
      await capture(f, a.id, db); await db.query('COMMIT');
      expect(await pending).toMatchObject({ error: { code: '23505' } }); expect(await audit(f)).toEqual([]);
    } finally { await db.query('ROLLBACK'); db.release(); await pending; }
  });
  it('finishes cancellation while the checkout owner holds the subscription parent', async () => {
    const f = await subject('pending_payment', true), before = await subscription(f);
    const parent = await h.owner.connect(), command = await h.runtime.connect();
    try {
      await parent.query('BEGIN'); await parent.query('SELECT id FROM public.subscriptions WHERE id=$1 FOR UPDATE', [f.subscription]);
      // Checkout compensation may own the parent before requesting the order mutex. The
      // completed cancellation must not need that parent at any later step.
      await command.query("BEGIN; SET LOCAL lock_timeout='2s'");
      expect(await value(command, 'SELECT public.oms_cancel_unpaid_order($1,$2,$3,$4) AS value', [randomUUID(), f.order, 'buyer request', f.actor]))
        .toMatchObject({ status: 'cancelled', replayed: false });
      await command.query('COMMIT'); await parent.query('ROLLBACK');
      expect(await subscription(f)).toEqual(before); expect(await audit(f)).toHaveLength(1);
    } finally { await command.query('ROLLBACK'); await parent.query('ROLLBACK'); command.release(); parent.release(); }
  });
  it('detects a changed subscription aggregate after waiting for the order lock', async () => {
    const f = await subject(), linked = await subject('pending_payment', true), db = await h.owner.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await db.query('BEGIN'); await db.query('SELECT id FROM public.commerce_orders WHERE id=$1 FOR UPDATE', [f.order]);
      pending = cancel(f).then(result => ({ result }), error => ({ error }));
      await blocked();
      const cycle = (await db.query('SELECT subscription_cycle_id FROM public.commerce_orders WHERE id=$1', [linked.order])).rows[0].subscription_cycle_id;
      await db.query('UPDATE public.commerce_orders SET subscription_cycle_id=$2 WHERE id=$1', [f.order, cycle]); await db.query('COMMIT');
      expect(await pending).toMatchObject({ error: { code: '55000' } }); expect(await audit(f)).toEqual([]);
    } finally { await db.query('ROLLBACK'); db.release(); await pending; }
  });
  it('retains a capture after accepted cancellation as review-required without settlement', async () => {
    const f = await subject(), a = await attempt(f); await observe(a.id, 'expired'); await cancel(f);
    const answer = await capture(f, a.id);
    expect(answer.event).toMatchObject({ state: 'open', outcome: 'captured', applicationStatus: 'review_required' });
    expect(answer.financial.orderStatus).toBe('cancelled'); expect(answer.effects.paymentResultRecorded).toBe(false);
    await expect(cancel(f)).rejects.toMatchObject({ code: '23505' }); expect(await audit(f)).toHaveLength(1);
  });

  it('replays a matching shared receipt with the stored current order status without a new refund', async () => {
    const f = await subject(), key = randomUUID();
    await cancel(f, key, 'external refund');
    const before = await snapshot(f);
    expect(await createPostgresCommerceOmsPort(h.runtime).markRefunded({ idempotencyKey: key, orderId: f.order, actorUserId: f.actor, reason: 'external refund' }))
      .toMatchObject({ status: 'cancelled', replayed: true });
    expect(await snapshot(f)).toEqual(before); expect(await audit(f)).toHaveLength(1); expect(await events(f)).toEqual([]);
    await expect(mark(f, key, 'changed')).rejects.toMatchObject({ code: '23505' });
  });

  it('manually marks only paid orders, inertly replays, and writes no refund notification/reversal event', async () => {
    const f = await subject('paid', true), before = await subscription(f), key = randomUUID();
    expect(await mark(f, key)).toMatchObject({ status: 'refunded', replayed: false });
    expect(await mark(f, key)).toMatchObject({ status: 'refunded', replayed: true });
    expect(await mark(f)).toMatchObject({ replayed: true });
    expect(await audit(f)).toHaveLength(1); expect(await events(f)).toEqual([]); expect(await subscription(f)).toEqual(before);
    await expect(mark(f, key, 'changed')).rejects.toMatchObject({ code: '23505' });
    const other = await subject('paid'); await expect(mark(other, key)).rejects.toMatchObject({ code: '23505' });
    for (const status of ['pending_payment', 'cancelled', 'fulfilled']) await expect(mark(await subject(status))).rejects.toThrow('oms_mark_refunded_invalid_status');
    await expect(mark(other, randomUUID(), '')).rejects.toThrow('oms_mark_refunded_invalid_input');
    // A genuine refund source keeps the same notification and reversal duty event,
    // including a provider-confirmed cancellation later settled by that source.
    for (const status of ['paid', 'cancelled']) {
      const genuine = await subject(status);
      await h.runtime.query("UPDATE public.commerce_orders SET status='refunded',refunded_at=$2,metadata=metadata||'{\"source\":\"payment.control.v0\"}'::jsonb WHERE id=$1", [genuine.order, AT]);
      expect(await events(genuine)).toEqual([expect.objectContaining({ event_type: 'commerce.order.refunded', payload: expect.objectContaining({ orderUuid: genuine.order }) })]);
    }
  });
});
