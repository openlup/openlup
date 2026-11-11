import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresFulfillmentShipmentCommandPort, createPostgresFulfillmentCommerceReadPort } from '@openlup/platform/fulfillment/native';
import { createPostgresPaidFulfillmentHandoffStore, createPostgresFulfillmentShipmentSpinePort } from '@openlup/platform/fulfillment';
import { withAccountingInvoiceShadowTrigger } from '@openlup/platform/invoicing';
import { createPostgresDestinationPort } from '@openlup/platform/commerce/server/destinations';
import { evaluateCommerceFulfillmentEligibility } from '@openlup/platform/commerce';
import { fixture, openCase, replacement } from '../helpers/fulfillmentNative.js';
import { lifecycleInstallation, lifecycleProfiles, type LifecycleInstallation } from './subscriptionLifecycleClosureFixture.js';
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from '../helpers/postgresContainer.js';
const at = '2026-11-10T12:00:00.000Z';
for (const profile of lifecycleProfiles) describe(`operator shipment commands on ${profile}`, () => {
  let h: LifecycleInstallation;
  beforeAll(async () => { h = await lifecycleInstallation(profile); }, postgresSetupTimeoutMs);
  afterAll(async () => { await h?.close(); }, postgresTeardownTimeoutMs);
  const port = () => createPostgresFulfillmentShipmentCommandPort(h.runtime);
  async function subject() {
    const f = await fixture(h.owner), actor = randomUUID();
    await h.owner.query('INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)', [actor, `${actor}@example.invalid`]);
    return { ...f, actor: String(actor) };
  }
  type Subject = Awaited<ReturnType<typeof subject>>;
  const label = (f: Omit<Subject, 'shipment'> & { shipment: string }, key: string = randomUUID(), tracking: string = randomUUID(), provider = 'carrier-a') => port().recordCommerceFulfillmentLabel({
    idempotencyKey: key, fulfillmentOrderId: f.shipment, actorUserId: f.actor, providerKind: provider, providerTrackingId: tracking,
    labelUrl: 'https://labels.example.invalid/unit', deliveryEstimateDays: 3, rawProviderPayload: { captured: 'private evidence' }, metadata: { note: 'operator' },
  });
  const handoff = (f: Subject, key: string = randomUUID()) => port().handOffCommerceFulfillmentOrder({ idempotencyKey: key, fulfillmentOrderId: f.shipment, actorUserId: f.actor });
  const track = (f: Subject, key: string, status: 'in_transit' | 'delivered' | 'exception', occurredAt?: string, providerTrackingId?: string) => port().recordCommerceFulfillmentTrackingEvent({
    idempotencyKey: key, fulfillmentOrderId: f.shipment, actorUserId: f.actor, status, providerTrackingId, rawEvent: { occurredAt, captured: 'private event' },
  });
  async function census() {
    const result: Record<string, unknown> = {};
    for (const table of ['fulfillment_shipments', 'shipment_external_refs', 'fulfillment_shipment_operations', 'fulfillment_operator_receipts', 'fulfillment_inventory_reservations',
      'subscription_delivery_alignment_arrivals', 'subscription_delivery_alignment_cases', 'subscriptions', 'outbox_events', 'commerce_order_holds']) {
      result[table] = (await h.owner.query(`SELECT to_jsonb(t) AS row,xmin::text AS version FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows;
    }
    return result;
  }
  async function stockSubject(renewal: boolean, historical = false) {
    const f = await subject(), source = randomUUID(), product = randomUUID(), skuId = randomUUID(), sku = `UNIT-${randomUUID()}`;
    if (!historical) await h.owner.query('DELETE FROM public.fulfillment_shipments WHERE id=$1', [f.shipment]);
    await h.owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Unit')", [product, product]);
    await h.owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$2,$3,'Unit')", [skuId, product, sku]);
    await h.owner.query("UPDATE public.commerce_orders SET metadata=$2 WHERE id=$1", [f.order, { orderDraftSnapshot: { context: { mode: renewal ? 'subscription_cycle' : 'one_time' }, lines: [{ sku, quantity: 1, title: 'Unit' }] } }]);
    await h.owner.query('UPDATE public.commerce_order_items SET sku_id=$2 WHERE order_id=$1', [f.order, skuId]);
    await h.owner.query("INSERT INTO public.fulfillment_stock_current(source_key,sku,total_quantity,for_sale_quantity,reserved_unavailable_quantity,inventory_class,last_synced_at,stale_after,sync_run_id,idempotency_key,operation_fingerprint) VALUES($1,$2,100,100,0,'sellable',$3,'2099-01-01T00:00:00Z',$1,$1,repeat('a',64))", [source, sku, at]);
    let reservation: string;
    if (renewal) {
      await h.owner.query("UPDATE public.commerce_orders SET renewal_operation_id=$2,renewal_operation_fingerprint=repeat('a',64) WHERE id=$1", [f.order, f.operation]);
      await h.owner.query("UPDATE public.subscription_renewal_operations SET state='claimed',terminal_outcome=NULL,terminal_at=NULL,cycle_snapshot=$2,lease_expires_at='2099-01-01T00:00:00Z' WHERE id=$1", [f.operation, { stockSourceKey: source, lines: [{ sku, quantity: 1 }] }]);
      reservation = (await h.runtime.query('SELECT public.fulfillment_reserve_subscription_renewal($1,$2,900,$3) AS value', [f.operation, f.token, at])).rows[0].value.reservationId;
    } else {
      const item = (await h.owner.query('SELECT id FROM public.commerce_order_items WHERE order_id=$1', [f.order])).rows[0].id;
      reservation = (await h.runtime.query("SELECT public.fulfillment_reserve_purchase_order_items($1,$2,$3,$4,'succeeded','2099-01-01T00:00:00Z','{}',$5) AS value",
        [randomUUID(), f.order, source, JSON.stringify([{ orderItemId: item, skuId, quantity: 1 }]), at])).rows[0].value.reservations[0].reservationId;
    }
    const store = createPostgresPaidFulfillmentHandoffStore(h.runtime, 'fixture-port');
    const obligation = await store.ensureObligation({ requestKey: `paid-${f.order}`, orderRef: f.order, paidFactRef: `paid-fact:${f.order}` });
    f.shipment = obligation.fulfillmentRef as typeof f.shipment;
    await store.acknowledge({ requestKey: `paid-${f.order}`, fulfillmentRef: f.shipment });
    return { ...f, reservation, source, sku, skuId };
  }
  it('commits one label snapshot, private full attempt, actor and safe convertible operation', async () => {
    const f = await subject(), key = randomUUID(), tracking = randomUUID();
    const result = await label(f, key, tracking);
    expect(result).toMatchObject({ fulfillmentOrderId: f.shipment, orderId: f.order, status: 'label_created', replayed: false });
    const op = (await h.owner.query('SELECT * FROM public.fulfillment_shipment_operations WHERE idempotency_key=$1', [`${key}:operation`])).rows[0];
    expect(op).toMatchObject({ actor_user_id: f.actor, payload: { toStatus: 'label_created', providerKind: 'carrier-a', providerTrackingId: tracking } });
    expect(JSON.stringify(op.payload)).not.toContain('private evidence');
    const receipt = (await h.owner.query("SELECT * FROM public.fulfillment_operator_receipts WHERE kind='label' AND idempotency_key=$1", [key])).rows[0];
    expect(receipt.command).toMatchObject({ actorUserId: f.actor, attemptStatus: 'succeeded', request: { rawProviderPayload: { captured: 'private evidence' }, deliveryEstimateDays: 3 } });
    const other = await subject();
    expect(await label(other, key, 'changed', 'carrier-b')).toEqual({ ...result, replayed: true });
    expect((await h.owner.query('SELECT status FROM public.fulfillment_shipments WHERE id=$1', [other.shipment])).rows[0].status).toBe('created');
  });
  it('retains deferred tracking evidence without inventing a reference', async () => {
    const f = await subject(), key = randomUUID();
    const result = (await h.runtime.query('SELECT public.fulfillment_operator_record_label($1,$2,$3,$4) AS value',
      [key, f.shipment, { providerKind: 'carrier-a', providerTrackingId: null, rawProviderPayload: {} }, f.actor])).rows[0].value;
    expect(result).toMatchObject({ status: 'label_created', replayed: false });
    expect((await h.owner.query('SELECT * FROM public.shipment_external_refs WHERE shipment_id=$1', [f.shipment])).rows).toEqual([]);
    expect((await h.owner.query('SELECT payload FROM public.fulfillment_shipment_operations WHERE idempotency_key=$1', [`${key}:operation`])).rows[0].payload.customerTrackingDeferred).toBe(true);
  });
  it('rolls back references, snapshot and status when the final label audit cannot be inserted', async () => {
    const f = await subject(), key = randomUUID();
    await h.owner.query("INSERT INTO public.fulfillment_shipment_operations(shipment_id,order_id,operation_type,idempotency_key,payload) VALUES($1,$2,'evidence_recorded',$3,'{}')", [f.shipment, f.order, `${key}:operation`]);
    const before = await census();
    await expect(label(f, key)).rejects.toMatchObject({ code: '23505' });
    expect(await census()).toEqual(before);
  });
  it('refuses unattributed cross-order history unchanged and exposes only its order reference', async () => {
    const one = await subject(), two = await subject(), tracking = randomUUID();
    // Historical, pre-namespace evidence is seeded through the owner, never the current writer.
    await h.owner.query("INSERT INTO public.shipment_external_refs(shipment_id,ref_role,external_id,recorded_at) VALUES($1,'tracking',$2,$3)", [one.shipment, tracking, at]);
    const before = await census(), key = randomUUID();
    for (let i = 0; i < 2; i++) {
      await expect(label(two, key, tracking)).rejects.toMatchObject({ details: { code: 'tracking_reference_unattributed', conflictingOrderId: one.order } });
      expect(await census()).toEqual(before);
    }
    await expect(h.runtime.query("SELECT public.fulfillment_record_evidence($1,$2,'push','tracking',$3,$4,$5)", [randomUUID(), two.shipment, tracking, { providerKind: 'carrier-a' }, at]))
      .rejects.toMatchObject({ code: '23505', message: 'commerce_fulfillment_tracking_reference_unattributed', detail: expect.stringContaining(one.order) });
    expect(await census()).toEqual(before);
  });
  it('attributes same-order history, reassigns its parcel and keeps the displaced reference in its receipt', async () => {
    const f = await subject(), sibling = await replacement(h.owner, f), tracking = randomUUID(), key = randomUUID();
    // Preserve historical NULL attribution without using a fresh production write.
    await h.owner.query("INSERT INTO public.shipment_external_refs(shipment_id,ref_role,external_id,recorded_at) VALUES($1,'tracking',$2,$3)", [f.shipment, tracking, at]);
    const old = (await h.owner.query('SELECT * FROM public.shipment_external_refs WHERE external_id=$1', [tracking])).rows;
    await label({ ...f, shipment: sibling }, key, tracking);
    expect((await h.owner.query('SELECT shipment_id,provider_kind FROM public.shipment_external_refs WHERE external_id=$1', [tracking])).rows).toEqual([{ shipment_id: sibling, provider_kind: 'carrier-a' }]);
    const previous = (await h.owner.query("SELECT command->'previousReferences' AS refs FROM public.fulfillment_operator_receipts WHERE kind='label' AND idempotency_key=$1", [key])).rows[0].refs;
    expect(previous[0]).toMatchObject({ id: old[0].id, shipment_id: f.shipment, provider_kind: null });
    expect(await label(f, key, tracking)).toMatchObject({ fulfillmentOrderId: sibling, replayed: true });
  });
  it('uses provider-scoped conflicts, permits another provider, and serializes concurrent owners', async () => {
    const one = await subject(), two = await subject(), three = await subject(), tracking = randomUUID();
    await label(one, randomUUID(), tracking, 'carrier-a');
    await expect(label(two, randomUUID(), tracking, 'carrier-a')).rejects.toMatchObject({ details: { code: 'tracking_ref_conflict' } });
    await label(two, randomUUID(), tracking, 'carrier-b');
    // One parcel can retain this number in two provider namespaces.
    await label(two, randomUUID(), tracking, 'carrier-c');
    expect((await h.owner.query('SELECT provider_kind FROM public.shipment_external_refs WHERE shipment_id=$1 ORDER BY provider_kind', [two.shipment])).rows).toEqual([{ provider_kind: 'carrier-b' }, { provider_kind: 'carrier-c' }]);
    const concurrent = randomUUID();
    const results = await Promise.allSettled([label(two, randomUUID(), concurrent), label(three, randomUUID(), concurrent)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  });
  it.each(['REPEATABLE READ', 'SERIALIZABLE'] as const)('refuses %s before operator or shared tracking writes', async isolation => {
    const f = await subject(), before = await census();
    const commands: [string, unknown[]][] = [
      ['SELECT public.fulfillment_operator_record_label($1,$2,$3,$4)', [randomUUID(), f.shipment, { providerKind: 'carrier-a', providerTrackingId: randomUUID() }, f.actor]],
      ['SELECT public.fulfillment_operator_hand_off($1,$2,$3,$4)', [randomUUID(), f.shipment, f.actor, {}]],
      ['SELECT public.fulfillment_operator_record_tracking($1,$2,$3,$4)', [randomUUID(), f.shipment, { status: 'exception' }, f.actor]],
      ["SELECT public.fulfillment_record_evidence($1,$2,'push','tracking',$3,$4,$5)", [randomUUID(), f.shipment, randomUUID(), { providerKind: 'carrier-a' }, at]],
    ];
    const db = await h.runtime.connect();
    try {
      for (const [sql, values] of commands) {
        await db.query('BEGIN ISOLATION LEVEL ' + isolation);
        await db.query('SELECT count(*) FROM public.shipment_external_refs');
        await expect(db.query(sql, values)).rejects.toMatchObject({ code: '22023', message: 'inventory_admission_isolation_unsupported' });
        await db.query('ROLLBACK');
        expect(await census()).toEqual(before);
      }
    } finally { await db.query('ROLLBACK'); db.release(); }
  });
  it('fences the shared writer and permits same-order spine replay with an explicit namespace', async () => {
    const one = await subject(), two = await subject(), tracking = randomUUID();
    await label(one, randomUUID(), tracking); await handoff(one);
    const spine = createPostgresFulfillmentShipmentSpinePort(h.runtime, { portKey: 'fixture-port', evidenceChannel: 'push' });
    const before = await census();
    await expect(h.runtime.query("SELECT public.fulfillment_record_evidence($1,$2,'push','tracking',$3,'{}',$4)", [randomUUID(), two.shipment, tracking, at]))
      .rejects.toMatchObject({ code: '22023', message: 'fulfillment_record_evidence_provider_kind_required' });
    expect(await census()).toEqual(before);
    await expect(spine.recordTracking({ idempotencyKey: randomUUID(), shipmentId: two.shipment, status: 'in_transit', externalRef: tracking, metadata: { providerKind: 'carrier-a' } }))
      .rejects.toThrow('Fulfillment shipment spine conflict');
    expect(await census()).toEqual(before);
    const request = { idempotencyKey: randomUUID(), shipmentId: one.shipment, status: 'in_transit' as const, externalRef: tracking, metadata: { providerKind: 'carrier-a' } };
    expect(await spine.recordTracking(request)).toMatchObject({ shipmentId: one.shipment, status: 'in_transit', replayed: false });
    const recorded = await census();
    expect(await spine.recordTracking(request)).toMatchObject({ shipmentId: one.shipment, status: 'in_transit', replayed: true });
    expect(await census()).toEqual(recorded);
    expect((await h.owner.query("SELECT provider_kind FROM public.shipment_external_refs WHERE ref_role='tracking' AND external_id=$1", [tracking])).rows).toEqual([{ provider_kind: 'carrier-a' }]);
    // Another provider's same number remains admissible, without inventing a status transition.
    await h.runtime.query("SELECT public.fulfillment_record_evidence($1,$2,'push','tracking',$3,$4,$5)", [randomUUID(), two.shipment, tracking, { providerKind: 'carrier-b' }, at]);
    expect((await h.owner.query('SELECT provider_kind FROM public.shipment_external_refs WHERE shipment_id=$1', [two.shipment])).rows).toEqual([{ provider_kind: 'carrier-b' }]);
  });
  it('serializes READ COMMITTED label and evidence writers with snapshots preceding the label', async () => {
    const one = await subject(), two = await subject(), tracking = randomUUID();
    const winner = await h.runtime.connect(), loser = await h.runtime.connect();
    let pending: Promise<{ error?: unknown; value?: unknown }> | undefined;
    try {
      for (const db of [winner, loser]) { await db.query('BEGIN ISOLATION LEVEL READ COMMITTED'); await db.query('SELECT count(*) FROM public.shipment_external_refs'); }
      await createPostgresFulfillmentShipmentCommandPort(winner).recordCommerceFulfillmentLabel({ idempotencyKey: randomUUID(), fulfillmentOrderId: one.shipment, actorUserId: one.actor, providerKind: 'carrier-a', providerTrackingId: tracking });
      const blocker = (await winner.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const waiter = (await loser.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pending = loser.query("SELECT public.fulfillment_record_evidence($1,$2,'push','tracking',$3,$4,$5)", [randomUUID(), two.shipment, tracking, { providerKind: 'carrier-a' }, at])
        .then(value => ({ value }), error => ({ error }));
      let blocked = false; const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if ((await h.owner.query('SELECT $1::int=ANY(pg_blocking_pids($2)) AS blocked', [blocker, waiter])).rows[0].blocked) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true); await winner.query('COMMIT');
      const committed = await census();
      expect(await pending).toMatchObject({ error: { code: '23505', message: 'commerce_fulfillment_tracking_ref_conflict' } });
      await loser.query('ROLLBACK'); expect(await census()).toEqual(committed);
      expect((await h.owner.query('SELECT shipment_id,provider_kind FROM public.shipment_external_refs WHERE external_id=$1', [tracking])).rows).toEqual([{ shipment_id: one.shipment, provider_kind: 'carrier-a' }]);
    } finally { await winner.query('ROLLBACK'); await loser.query('ROLLBACK'); if (pending) await pending; winner.release(); loser.release(); }
  });
  it.each(['dispatch', 'label'])('preserves non-tracking %s evidence at stronger isolation', async role => {
    const f = await subject(), db = await h.runtime.connect(), external = randomUUID(), key = randomUUID();
    try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const input = [key, f.shipment, role, external, { note: 'retained' }, at];
      const sql = "SELECT public.fulfillment_record_evidence($1,$2,'push',$3,$4,$5,$6) AS result";
      expect((await db.query(sql, input)).rows[0].result.replayed).toBe(false);
      expect((await db.query(sql, input)).rows[0].result.replayed).toBe(true);
      await db.query('COMMIT');
      expect((await h.owner.query('SELECT ref_role,provider_kind FROM public.shipment_external_refs WHERE shipment_id=$1', [f.shipment])).rows).toEqual([{ ref_role: role, provider_kind: null }]);
      expect((await h.owner.query('SELECT payload FROM public.fulfillment_shipment_operations WHERE idempotency_key=$1', [key])).rows[0].payload).toEqual({ channel: 'push', refRole: role, externalId: external });
    } finally { await db.query('ROLLBACK'); db.release(); }
  });
  it('hands off missing historical reservations with the named zero-consumption result and inert replay', async () => {
    const f = await stockSubject(false, true); await label(f); const key = randomUUID();
    const result = await handoff(f, key);
    expect(result).toMatchObject({ status: 'handed_over', consumedReservationCount: 0, reservationDisposition: 'reservations_not_recorded', replayed: false });
    expect((await h.owner.query('SELECT status FROM public.fulfillment_inventory_reservations WHERE id=$1', [f.reservation])).rows).toEqual([{ status: 'held' }]);
    expect((await h.owner.query("SELECT count(*)::int n FROM public.outbox_events WHERE event_type='commerce.fulfillment.handed_over' AND aggregate_id=$1", [f.order])).rows[0].n).toBe(1);
    const before = await census();
    expect(await handoff(f, key)).toEqual({ ...result, replayed: true });
    expect(await handoff(f)).toEqual({ ...result, replayed: true });
    expect(await census()).toEqual(before);
  });
  it.each([false, true])('consumes exactly the recorded purchase/renewal set once (renewal=%s)', async renewal => {
    const f = await stockSubject(renewal); await label(f);
    const recorded = (await h.owner.query('SELECT reservation_id FROM public.fulfillment_parcel_line_reservations a JOIN public.fulfillment_parcel_lines l ON l.id=a.line_id WHERE l.shipment_id=$1', [f.shipment])).rows;
    expect(recorded).toEqual([{ reservation_id: f.reservation }]);
    const unrelated = randomUUID();
    await h.owner.query("INSERT INTO public.fulfillment_inventory_reservations(id,purchase_order_id,operation_fingerprint,source_key,status,expires_at) VALUES($1,$2,repeat('a',64),$3,'held','2099-01-01T00:00:00Z')", [unrelated, f.order, f.source]);
    const results = await Promise.all([handoff(f), handoff(f)]);
    expect(results.map(r => r.replayed).sort()).toEqual([false, true]);
    expect(results.every(r => r.consumedReservationCount === 1 && r.reservationDisposition === 'recorded')).toBe(true);
    expect((await h.owner.query('SELECT id,status FROM public.fulfillment_inventory_reservations WHERE id=ANY($1::uuid[]) ORDER BY id', [[f.reservation, unrelated]])).rows).toEqual([
      { id: f.reservation, status: 'consumed' }, { id: unrelated, status: 'held' },
    ].sort((a, b) => a.id.localeCompare(b.id)));
  });
  it('takes the exact consumer key before the parcel while a concurrent consumer resumes', async () => {
    const f = await stockSubject(false); await label(f); const key = randomUUID();
    const consumer = await h.runtime.connect(), handoffDb = await h.runtime.connect();
    const consumeKey = "jsonb_build_array('operator-handoff',$1::text,$2::uuid)::text";
    let pending: Promise<{ value?: unknown; error?: unknown }> | undefined;
    try {
      await consumer.query('BEGIN');
      await consumer.query(`SELECT pg_advisory_xact_lock(hashtextextended('parcel-consume-key|'||${consumeKey},0))`, [key, f.shipment]);
      const blocker = (await consumer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const waiter = (await handoffDb.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pending = createPostgresFulfillmentShipmentCommandPort(handoffDb).handOffCommerceFulfillmentOrder({ idempotencyKey: key, fulfillmentOrderId: f.shipment, actorUserId: f.actor })
        .then(value => ({ value }), error => ({ error }));
      let blocked = false; const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if ((await h.owner.query('SELECT $1::int=ANY(pg_blocking_pids($2)) AS blocked', [blocker, waiter])).rows[0].blocked) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      // Resuming the actual consumer must not wait for a parcel held by handoff.
      await consumer.query(`SELECT public.fulfillment_consume_parcel_reservations(${consumeKey},$2::uuid)`, [key, f.shipment]);
      const stock = (await consumer.query('SELECT status,xmin::text AS version FROM public.fulfillment_inventory_reservations WHERE id=$1', [f.reservation])).rows;
      await consumer.query('COMMIT');
      expect(await pending).toMatchObject({ value: { status: 'handed_over', consumedReservationCount: 1 } });
      expect((await h.owner.query('SELECT status,xmin::text AS version FROM public.fulfillment_inventory_reservations WHERE id=$1', [f.reservation])).rows).toEqual(stock);
    } finally { await consumer.query('ROLLBACK'); if (pending) await pending; consumer.release(); handoffDb.release(); }
  });
  it('replays each recorded handoff result after an exception and another label/handoff', async () => {
    const f = await stockSubject(false), firstKey = randomUUID(), nextKey = randomUUID();
    await label(f); const first = await handoff(f, firstKey);
    expect(first.consumedReservationCount).toBe(1);
    await track(f, randomUUID(), 'exception'); await label(f);
    const relabelled = await census();
    expect(await handoff(f, firstKey)).toEqual({ ...first, status: 'label_created', replayed: true });
    expect(await census()).toEqual(relabelled);
    const next = await handoff(f, nextKey); expect(next.consumedReservationCount).toBe(0);
    expect(await handoff(f, firstKey)).toEqual({ ...first, replayed: true });
    expect(await handoff(f, nextKey)).toEqual({ ...next, replayed: true });
  });
  it('rolls back consumption and handoff when actor audit fails', async () => {
    const f = await stockSubject(false); await label(f); const key = randomUUID();
    const before = await census();
    await expect(port().handOffCommerceFulfillmentOrder({ idempotencyKey: key, fulfillmentOrderId: f.shipment, actorUserId: randomUUID() })).rejects.toMatchObject({ code: '23503' });
    expect(await census()).toEqual(before);
  });
  it('records delivery only after handoff, validates same-order tracking and refuses terminal regressions', async () => {
    const f = await subject(), other = await subject(), tracking = randomUUID();
    await expect(track(f, randomUUID(), 'delivered', at)).rejects.toMatchObject({ details: { code: 'tracking_before_handoff_forbidden' } });
    await label(f, randomUUID(), tracking); await label(other); await handoff(f);
    const before = await census();
    await expect(track(f, randomUUID(), 'in_transit', undefined, 'unknown')).rejects.toMatchObject({ details: { code: 'tracking_ref_not_active' } });
    expect(await census()).toEqual(before);
    await track(f, randomUUID(), 'in_transit', at, tracking);
    expect((await h.owner.query('SELECT delivered_at FROM public.fulfillment_shipments WHERE id=$1', [f.shipment])).rows[0].delivered_at).toBeNull();
    await track(f, randomUUID(), 'delivered', at, tracking);
    await expect(track(f, randomUUID(), 'in_transit')).rejects.toMatchObject({ details: { code: 'tracking_after_delivered_forbidden' } });
    await expect(label(f)).rejects.toMatchObject({ details: { code: 'label_invalid_status' } });
  });
  it('rolls back arrival, alignment and schedule when the delivery actor audit fails', async () => {
    const f = await subject(); await openCase(h.owner, f); await label(f); await handoff(f);
    const before = await census();
    await expect(port().recordCommerceFulfillmentTrackingEvent({ idempotencyKey: randomUUID(), fulfillmentOrderId: f.shipment,
      actorUserId: randomUUID(), status: 'delivered', rawEvent: { occurredAt: '2026-09-04T12:00:00Z' } })).rejects.toMatchObject({ code: '23503' });
    expect(await census()).toEqual(before);
  });
  it('repairs explicit-zone arrival earlier on same/new key without replacing original evidence or side effects', async () => {
    const f = await subject(), key = randomUUID(); await label(f); await handoff(f);
    await track(f, key, 'delivered', '2026-11-10T14:00:00+02:00');
    const opBefore = (await h.owner.query('SELECT * FROM public.fulfillment_shipment_operations WHERE idempotency_key=$1', [key])).rows;
    const receiptsBefore = (await h.owner.query("SELECT * FROM public.fulfillment_operator_receipts WHERE kind='tracking' AND idempotency_key=$1", [key])).rows;
    await track(f, key, 'delivered', '2026-11-10T11:00:00Z');
    await Promise.all([track(f, randomUUID(), 'delivered', '2026-11-10T10:00:00Z'), track(f, randomUUID(), 'delivered', '2026-11-10T10:30:00Z')]);
    const before = await census();
    await track(f, key, 'delivered', '2026-11-11T10:00:00Z');
    expect(await census()).toEqual(before);
    expect((await h.owner.query('SELECT delivered_at FROM public.fulfillment_shipments WHERE id=$1', [f.shipment])).rows[0].delivered_at.toISOString()).toBe('2026-11-10T10:00:00.000Z');
    expect((await h.owner.query('SELECT * FROM public.fulfillment_shipment_operations WHERE idempotency_key=$1', [key])).rows).toEqual(opBefore);
    expect((await h.owner.query("SELECT * FROM public.fulfillment_operator_receipts WHERE kind='tracking' AND idempotency_key=$1", [key])).rows).toEqual(receiptsBefore);
    expect((await h.owner.query('SELECT count(*)::int n FROM public.subscription_delivery_alignment_arrivals WHERE shipment_id=$1', [f.shipment])).rows[0].n).toBe(1);
    await expect(track(f, key, 'exception')).rejects.toMatchObject({ details: { code: 'tracking_idempotency_conflict' } });
  });
  it.each(['2026-11-10T01:00:00', '2026-99-99T01:00:00Z', 'invalid'])('falls back for non-explicit or invalid chronology %s', async raw => {
    const f = await subject(); await label(f); await handoff(f);
    const before = new Date((await h.owner.query('SELECT now() AS t')).rows[0].t);
    await track(f, randomUUID(), 'delivered', raw);
    const arrival = (await h.owner.query('SELECT delivered_at FROM public.fulfillment_shipments WHERE id=$1', [f.shipment])).rows[0].delivered_at;
    expect(arrival.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });
  it('serializes the same tracking key across parcels and keeps the losing parcel unchanged', async () => {
    const one = await subject(), two = await subject(); await label(one); await label(two); await handoff(one); await handoff(two);
    const key = randomUUID(), results = await Promise.allSettled([track(one, key, 'delivered', at), track(two, key, 'delivered', at)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect((await h.owner.query("SELECT status FROM public.fulfillment_shipments WHERE id=ANY($1::uuid[]) ORDER BY status", [[one.shipment, two.shipment]])).rows).toEqual([{ status: 'delivered' }, { status: 'handed_over' }]);
  });
  it('extends a late cycle once, waits for actual replacement arrival and never moves the cycle earlier', async () => {
    const f = await subject(), sibling = await replacement(h.owner, f); await openCase(h.owner, f);
    const next = async () => (await h.owner.query('SELECT status,next_cycle_at FROM public.subscriptions WHERE id=$1', [f.subscription])).rows[0];
    const before = await next(); await label(f); await handoff(f); await track(f, randomUUID(), 'delivered', '2026-09-04T12:00:00Z');
    expect(await next()).toEqual(before);
    const current = { ...f, shipment: sibling }; await label(current); await handoff(current);
    expect((await h.owner.query('SELECT delivered_at FROM public.fulfillment_shipments WHERE id=$1', [sibling])).rows[0].delivered_at).toBeNull();
    expect(await next()).toEqual(before);
    const key = randomUUID(); await track(current, key, 'delivered', '2026-09-08T12:00:00Z');
    expect(await next()).toEqual({ status: 'active', next_cycle_at: new Date('2026-10-06T12:00:00Z') });
    await track(current, key, 'delivered', '2026-09-01T12:00:00Z');
    await track(current, randomUUID(), 'delivered', '2026-10-01T12:00:00Z');
    expect(await next()).toEqual({ status: 'active', next_cycle_at: new Date('2026-10-06T12:00:00Z') });
    expect((await h.owner.query('SELECT * FROM public.subscription_pause_windows WHERE subscription_id=$1', [f.subscription])).rows).toEqual([]);
  });
  it('keeps captured document failure fail-soft after another connection observes committed handoff', async () => {
    const f = await stockSubject(false); await label(f); const observed: { parcel: string; reservation: string }[] = [];
    const wrapped = withAccountingInvoiceShadowTrigger(port(), { providerKind: 'captured', keys: { shadow: key => `${key}:document`, paid: key => key, handoff: key => key },
      invoicePolicyReader: { async readOrderInvoicePolicy(lookup) { expect(lookup).toEqual({ by: 'fulfillmentOrder', fulfillmentOrderId: f.shipment }); return 'issue'; } },
      accountingPort: { async requestInvoiceIssueFromFulfillmentHandoff() {
        observed.push({ parcel: (await h.owner.query('SELECT status FROM public.fulfillment_shipments WHERE id=$1', [f.shipment])).rows[0].status,
          reservation: (await h.owner.query('SELECT status FROM public.fulfillment_inventory_reservations WHERE id=$1', [f.reservation])).rows[0].status });
        throw new Error('Captured document refusal');
      } } });
    const request = { idempotencyKey: randomUUID(), fulfillmentOrderId: f.shipment, actorUserId: f.actor };
    expect(await wrapped.handOffCommerceFulfillmentOrder(request)).toMatchObject({ status: 'handed_over', replayed: false });
    expect(await wrapped.handOffCommerceFulfillmentOrder(request)).toMatchObject({ status: 'handed_over', replayed: true });
    expect(observed).toEqual([{ parcel: 'handed_over', reservation: 'consumed' }, { parcel: 'handed_over', reservation: 'consumed' }]);
  });
  it('keeps latest-operation conversion, server actor and current-parcel tracking compatible', async () => {
    const f = await stockSubject(false), sibling = await replacement(h.owner, f), tracking = randomUUID();
    await createPostgresDestinationPort(h.runtime).registerOrder({ idempotencyKey: randomUUID(), orderId: f.order, address: { recipientName: 'Unit', line1: 'Street', city: 'Example', postalCode: '00000', country: 'ZZ' }, now: at });
    await h.owner.query("UPDATE public.commerce_orders SET metadata=$2 WHERE id=$1", [f.order, { orderDraftSnapshot: { context: { mode: 'one_time' }, lines: [{ sku: 'UNIT', quantity: 1, title: 'Unit' }] } }]);
    await h.owner.query("INSERT INTO public.commerce_settlement_intents(order_id,channel_key,status,amount_minor,currency_code,open_idempotency_key,settled_at) VALUES($1,'sandbox','settled',900,'XXX',$2,'2026-11-10T12:00:00Z')", [f.order, randomUUID()]);
    await label(f, randomUUID(), tracking); await label({ ...f, shipment: sibling }, randomUUID(), tracking);
    const reads = createPostgresFulfillmentCommerceReadPort({ executor: h.runtime, policy: { evaluateCommerceFulfillmentEligibility }, orderMode: () => 'one_time' });
    const current = await reads.getCommerceFulfillmentOrderDetail({ fulfillmentOrderId: sibling.toUpperCase() });
    if (!current || !('order' in current)) throw new Error('Expected native shipment detail');
    expect(current.order.latestOperation).toMatchObject({ type: 'label_created', actorUserId: f.actor });
    expect(JSON.stringify(current)).not.toContain('private evidence');
    // The old sibling no longer presents the tracking number reattributed to this parcel.
    const original = await reads.getCommerceFulfillmentOrderDetail({ fulfillmentOrderId: f.shipment });
    if (!original || !('order' in original)) throw new Error('Expected original shipment detail');
    expect(original.order.providerTrackingId).toBeNull();
    await track({ ...f, shipment: sibling }, randomUUID(), 'exception');
    const exception = await reads.getCommerceFulfillmentOrderDetail({ fulfillmentOrderId: sibling });
    if (!exception || !('order' in exception)) throw new Error('Expected exception shipment detail');
    expect(exception.order.latestOperation).toMatchObject({ type: 'tracking_event_recorded' });
  });
  it('canonicalizes UUID values and preserves strict replay for ordinary arrival keys', async () => {
    const f = await subject(), key = randomUUID(); await label({ ...f, shipment: f.shipment.toUpperCase(), actor: f.actor.toUpperCase() }, key);
    expect(await label(f, key)).toMatchObject({ fulfillmentOrderId: f.shipment, replayed: true });
    const ordinary = randomUUID();
    await h.runtime.query('SELECT public.fulfillment_record_alignment_arrival($1,$2,$3,$4)', [ordinary, f.shipment, at, 'evidence:ordinary']);
    await expect(h.runtime.query('SELECT public.fulfillment_record_alignment_arrival($1,$2,$3,$4)', [ordinary, f.shipment, '2026-11-09T12:00:00Z', 'evidence:ordinary'])).rejects.toMatchObject({ code: '23505' });
    await h.owner.query('UPDATE public.fulfillment_shipments SET delivered_at=NULL WHERE id=$1', [f.shipment]);
    const before = await census();
    await h.runtime.query('SELECT public.fulfillment_record_alignment_arrival($1,$2,$3,$4)', [ordinary, f.shipment, at, 'evidence:ordinary']);
    expect(await census()).toEqual(before);
  });
});
