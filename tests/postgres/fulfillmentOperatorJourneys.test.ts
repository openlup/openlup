import { createAdminCommerceFulfillmentCancelOrderHandler } from '@openlup/platform/fulfillment';
import { createBffResponder } from '@openlup/platform/bff';
import type { HttpResponse } from '@openlup/platform/http';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresFulfillmentOperatorPort, createPostgresParcelReservationConsumption, createNativeFulfillmentBinding } from '@openlup/platform/fulfillment/native';
import type { FulfillmentDispatchRequest, FulfillmentCapabilityDescriptor } from '@openlup/platform/fulfillment/contracts';
import { createPostgresDestinationPort } from '@openlup/platform/commerce/server/destinations';
import { createPostgresCommerceOmsControlPlane, createPostgresCommerceOmsPort } from '@openlup/platform/commerce/server/postgres';
import { fixture as renewalFixture } from '../helpers/fulfillmentNative.js';
import { lifecycleInstallation, lifecycleProfiles, type LifecycleInstallation } from './subscriptionLifecycleClosureFixture.js';
import { captureStoreJourney, storeJourneyResources, journeySelection } from '../helpers/storeJourney.js';
import { restoreConnectedNativeStore } from '../../server/adapters/postgres/connectedStoreRestore.js';
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from '../helpers/postgresContainer.js';

function responseFixture() {
  let output: unknown;
  const response = { setHeader() {}, status() { return this; }, json(value: unknown) { output = value; return this; } } as unknown as HttpResponse;
  return { response, output: () => output };
}
const contact = () => ({ schemaVersion: 1, source: 'contact', revision: 1, recipientName: 'Frozen recipient',
  contactEmail: 'frozen@example.test', contactPhone: '+000001', line1: 'Frozen street', line2: null, city: 'Example', postalCode: '00000', country: 'ZZ',
  deliveryInstructions: null, courierInstructions: null, selectedDelivery: { providerKind: 'warehouse', carrierKind: 'carrier', service: 'service', deliveryKind: 'courier' } });
async function subject(db: Pool, legacy = true) {
  const client = randomUUID(), order = randomUUID(), actor = randomUUID(), product = randomUUID(), skuId = randomUUID(), item = randomUUID(), source = randomUUID(), sku = randomUUID();
  await db.query('INSERT INTO public.clients(id,email) VALUES($1,$2)', [client, `${client}@example.invalid`]);
  await db.query("INSERT INTO public.commerce_operators(id,label) VALUES($1,'Fixture operator')", [actor]);
  await db.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1::uuid,$1::text,'Unit')", [product]);
  await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$2,$3,'Unit')", [skuId, product, sku]);
  const connection = await db.connect();
  try {
    await connection.query('BEGIN');
    await connection.query("INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor,paid_at,metadata) VALUES($1,$2,'paid','XTS',200,'2026-11-01T00:00:00Z',$3)", [order, client, { orderDraftSnapshot: { context: { mode: 'one_time' }, lines: [{ sku, title: 'Unit', quantity: 2 }] } }]);
    await connection.query('INSERT INTO public.commerce_order_items(id,order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,$2,$3,1,2,100,200)', [item, order, skuId]);
    await connection.query('COMMIT');
  } catch (error) { await connection.query('ROLLBACK'); throw error; } finally { connection.release(); }
  await db.query("INSERT INTO public.commerce_settlement_intents(order_id,channel_key,status,amount_minor,currency_code,open_idempotency_key,settled_at) VALUES($1,'sandbox','settled',200,'XTS',$2,'2026-11-01T00:00:00Z')", [order, order]);
  await db.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES('operator-fixture','3pl',true) ON CONFLICT DO NOTHING");
  await db.query("INSERT INTO public.fulfillment_stock_current(source_key,sku,total_quantity,for_sale_quantity,reserved_unavailable_quantity,inventory_class,last_synced_at,stale_after,sync_run_id,idempotency_key,operation_fingerprint) VALUES($1,$2,100,100,0,'sellable','2026-11-01T00:00:00Z','2099-01-01T00:00:00Z',$1,$1,repeat('a',64))", [source, sku]);
  await createPostgresDestinationPort(db).registerOrder({ idempotencyKey: `destination-${order}`, orderId: order,
    address: { recipientName: 'Frozen recipient', line1: 'Frozen street', city: 'Example', postalCode: '00000', country: 'ZZ', contactPhone: '+000001' }, now: '2026-11-01T00:00:00Z' });
  let shipment: string | null = null;
  if (legacy) {
    shipment = randomUUID();
    await db.query("INSERT INTO public.fulfillment_shipments(id,order_id,port_key,provider_type,create_idempotency_key) VALUES($1,$2,'operator-fixture','3pl',$3)", [shipment, order, shipment]);
    await db.query('SELECT public.commerce_read_destination(\'shipment\',$1)', [shipment]);
    await db.query('SELECT public.fulfillment_capture_parcel_contact($1,$2)', [shipment, contact()]);
  }
  return { client, order, actor, skuId, sku, item, shipment, source };
}
type Subject = Awaited<ReturnType<typeof subject>>;
async function reserve(db: Pool, f: Subject, orderItemId: string = f.item) {
  const { rows } = await db.query('SELECT public.fulfillment_reserve_purchase_order_items($1,$2,$3,$4,\'succeeded\',\'2099-01-01T00:00:00Z\',\'{}\',\'2026-11-01T00:00:00Z\') AS value',
    [`reserve-${randomUUID()}`, f.order, f.source, JSON.stringify([{ orderItemId, skuId: f.skuId, quantity: 2 }])]);
  return rows[0].value.reservations[0].reservationId as string;
}
for (const generation of lifecycleProfiles) describe(`operator parcel journeys on ${generation}`, () => {
  let h: LifecycleInstallation;
  beforeAll(async () => { h = await lifecycleInstallation(generation); }, postgresSetupTimeoutMs);
  afterAll(async () => { await h?.close(); }, postgresTeardownTimeoutMs);
  const port = (f: Subject) => createPostgresFulfillmentOperatorPort(h.runtime, { providerRef: 'warehouse', stockSourceKey: f.source });
  const replace = (f: Subject, key = `replace-${randomUUID()}`) => port(f).requestReplacementShipment({ idempotencyKey: key, actorUserId: f.actor, orderId: f.order, reason: 'lost' });
  const cancel = (f: Subject, parcel = f.shipment!, key = `cancel-${randomUUID()}`, reason = 'operator cancellation') => port(f).cancelCommerceFulfillmentOrder({ idempotencyKey: key, actorUserId: f.actor, fulfillmentOrderId: parcel, reason });
  const stock = async (f: Subject) => (await h.owner.query('SELECT id,status,expires_at,updated_at FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=$1 ORDER BY id', [f.order])).rows;
  async function evidence(f: Subject, status: string, occurredAt: string | null, key = `evidence-${randomUUID()}`) {
    await h.runtime.query('SELECT public.fulfillment_record_observation($1,$2,$3,\'2026-11-10T12:00:00Z\')', [key, f.shipment, { providerStatus: { primary: status }, fact: { occurredAt }, correlation: { fulfillmentRef: f.shipment } }]);
    await h.runtime.query('SELECT public.fulfillment_record_operator_status_evidence($1,$2)', [key, f.shipment]); return key;
  }
  it('cancels an empty legacy record with a named zero-release result and idempotent concurrent replay', async () => {
    const f = await subject(h.owner), reservation = await reserve(h.runtime, f), before = await stock(f), key = `cancel-${randomUUID()}`;
    await h.owner.query("UPDATE public.commerce_orders SET metadata=metadata#-'{orderDraftSnapshot,context,mode}' WHERE id=$1", [f.order]);
    const results = await Promise.all([cancel(f, f.shipment!, key), cancel(f, f.shipment!, key)]);
    for (const result of results) {
      expect(result).toMatchObject({ status: 'cancelled', releasedReservationCount: 0, reservationDisposition: 'reservations_not_recorded' });
    }
    expect(results.map(r => 'replayed' in r && r.replayed).sort()).toEqual([false, true]);
    const res = responseFixture();
    const handler = createAdminCommerceFulfillmentCancelOrderHandler({ fulfillmentPort: port(f), respond: createBffResponder(), authorizeAdmin: async () => ({ ok: true, userId: f.actor }) });
    await handler({ method: 'POST', query: {}, body: { fulfillmentOrderId: f.shipment, idempotencyKey: key, reason: 'operator cancellation' } }, res.response);
    expect(res.output()).toMatchObject({ ok: true, data: { replayed: true, releasedReservationCount: 0, reservationDisposition: 'reservations_not_recorded' } });
    expect(await stock(f)).toEqual(before); expect(before[0].id).toBe(reservation);
    expect(await cancel(f)).toMatchObject({ replayed: true, releasedReservationCount: 0, reservationDisposition: 'reservations_not_recorded' });
    await expect(cancel(f, f.shipment!, key, 'changed')).rejects.toMatchObject({ code: '23505' });
    await expect(h.runtime.query('SELECT public.fulfillment_capture_new_parcel_reservations($1,$2)', [f.shipment, f.shipment])).rejects.toThrow('capture_not_new');
  });
  it('atomically records new original lines and releases precisely their IDs, leaving later order reservations untouched', async () => {
    const f = await subject(h.owner, false), captured = await reserve(h.runtime, f, `{${f.item.toUpperCase()}}`), key = `create-${randomUUID()}`;
    const create = async () => (await h.runtime.query("SELECT public.fulfillment_create_shipment($1,$2,'operator-fixture') AS value", [key, f.order])).rows[0].value;
    const opened = await create(); f.shipment = opened.shipment.id;
    expect(f.shipment).toBeTypeOf('string');
    expect(await create()).toMatchObject({ replayed: true });
    const later = await reserve(h.runtime, f);
    const rows = (await h.owner.query('SELECT a.reservation_id FROM public.fulfillment_parcel_line_reservations a JOIN public.fulfillment_parcel_lines l ON l.id=a.line_id WHERE l.shipment_id=$1', [f.shipment])).rows;
    expect(rows).toEqual([{ reservation_id: captured }]);
    expect(await cancel(f)).toMatchObject({ releasedReservationCount: 1, reservationDisposition: 'recorded', replayed: false });
    expect(await cancel(f)).toMatchObject({ releasedReservationCount: 1, replayed: true });
    expect(await stock(f)).toEqual(expect.arrayContaining([expect.objectContaining({ id: captured, status: 'released' }), expect.objectContaining({ id: later, status: 'held' })]));
    const empty = await subject(h.owner, false);
    const emptyCreated = (await h.runtime.query("SELECT public.fulfillment_create_shipment($1,$2,'operator-fixture') AS value", [`create-${randomUUID()}`, empty.order])).rows[0].value;
    expect(await cancel(empty, emptyCreated.shipment.id)).toMatchObject({ releasedReservationCount: 0, reservationDisposition: 'recorded' });
  });
  it('allocates a fresh counted generation with copied private contact and destination, preserving consumed original stock and delivery alignment', async () => {
    const f = await subject(h.owner), original = await reserve(h.runtime, f);
    await h.owner.query("UPDATE public.fulfillment_inventory_reservations SET status='consumed',expires_at=NULL WHERE id=$1", [original]);
    await h.owner.query("UPDATE public.fulfillment_shipments SET status='in_transit' WHERE id=$1", [f.shipment]);
    await h.owner.query("INSERT INTO public.commerce_order_holds(order_id,reason,status,idempotency_key) VALUES($1,'fulfillment_exception','active',$2)", [f.order, f.order]);
    const originalBefore = (await stock(f))[0], alignmentBefore = (await h.owner.query('SELECT * FROM public.subscription_delivery_alignment_cases WHERE predecessor_order_id=$1', [f.order])).rows;
    await h.owner.query("UPDATE public.clients SET email='changed@example.test',phone='+99999',first_name='Changed' WHERE id=$1", [f.client]);
    const key = `replace-${randomUUID()}`, responses = await Promise.all([replace(f, key), replace(f, key)]);
    if (!('replacement' in responses[0])) throw new Error('Expected a bound native result');
    const result = responses[0], parcel = result.replacement.fulfillmentOrderId;
    expect(responses.map(r => 'replayed' in r && r.replayed).sort()).toEqual([false, true]);
    expect(result.replacement).toMatchObject({ sequenceNo: 1, replacesFulfillmentOrderId: f.shipment, status: 'created' });
    const oms = createPostgresCommerceOmsPort(h.runtime, port(f));
    expect(await oms.requestReplacementShipment({ idempotencyKey: key, actorUserId: f.actor, orderId: f.order, reason: 'lost' })).toEqual({ ...result, replayed: true });
    await expect(oms.requestReplacementShipment({ idempotencyKey: `replace-${randomUUID()}`, actorUserId: f.actor, orderId: f.order, reason: 'lost' }))
      .rejects.toMatchObject({ details: { reason: 'undispatched_replacement_exists' } });
    const snapshots = (await h.owner.query('SELECT shipment_id,contact FROM public.fulfillment_parcel_contacts WHERE shipment_id=ANY($1::uuid[])', [[f.shipment, parcel]])).rows;
    expect(snapshots).toHaveLength(2); for (const row of snapshots) expect(row.contact).toEqual(contact());
    const destinations = (await h.owner.query('SELECT destination_id FROM public.commerce_destination_bindings WHERE shipment_id=ANY($1::uuid[])', [[f.shipment, parcel]])).rows;
    expect(destinations).toHaveLength(2); expect(destinations[0]).toEqual(destinations[1]);
    const after = await stock(f), fresh = after.find(r => r.id !== original)!;
    expect(after.find(r => r.id === original)).toEqual(originalBefore); expect(fresh).toMatchObject({ status: 'committed', expires_at: null });
    expect((await h.runtime.query('SELECT public.inventory_available_to_promise($1,$2,now(),false) AS value', [f.source, f.sku])).rows[0].value).toMatchObject({ hard_hold_quantity: 2, available_quantity: 98 });
    expect((await h.owner.query('SELECT * FROM public.subscription_delivery_alignment_cases WHERE predecessor_order_id=$1', [f.order])).rows).toEqual(alignmentBefore);
    expect((await h.owner.query('SELECT delivered_at FROM public.fulfillment_shipments WHERE id=$1', [parcel])).rows).toEqual([{ delivered_at: null }]);
    await expect(replace(f)).rejects.toThrow('undispatched_replacement_exists');
    await expect(port(f).requestReplacementShipment({ idempotencyKey: key, actorUserId: f.actor, orderId: f.order, reason: 'other' })).rejects.toMatchObject({ code: '23505' });
    expect(await cancel(f, parcel)).toMatchObject({ releasedReservationCount: 1, reservationDisposition: 'recorded' });
    expect((await stock(f)).find(r => r.id === fresh.id)).toMatchObject({ status: 'released' });
    expect((await stock(f)).find(r => r.id === original)).toEqual(originalBefore);
  });
  it('consumes only the replacement association and never rewrites original consumed stock', async () => {
    const f = await subject(h.owner), original = await reserve(h.runtime, f);
    await h.owner.query("UPDATE public.fulfillment_inventory_reservations SET status='consumed',expires_at=NULL WHERE id=$1", [original]);
    const before = (await stock(f))[0], result = await replace(f);
    if (!('replacement' in result)) throw new Error('Expected replacement');
    const consume = createPostgresParcelReservationConsumption(h.runtime), input = { idempotencyKey: `consume-${randomUUID()}`, fulfillmentOrderId: result.replacement.fulfillmentOrderId };
    const consumed = await consume(input); expect(consumed.consumedReservationIds).toHaveLength(1); expect(consumed.consumedReservationIds).not.toContain(original);
    expect(await consume(input)).toEqual({ ...consumed, replayed: true });
    expect((await stock(f)).find(r => r.id === original)).toEqual(before);
  });
  it('refuses every live provider dispatch before stock release and refuses exception without latest cancellation proof', async () => {
    const f = await subject(h.owner), reservation = await reserve(h.runtime, f), before = await stock(f);
    // The draft is a real native provider ownership fence too.
    await h.runtime.query('INSERT INTO public.fulfillment_dispatch_contexts(shipment_id,contact_revision,provider_ref,withheld) VALUES($1,$2,\'warehouse\',false)', [f.shipment, { schemaVersion: 1, source: 'contact', revision: 1 }]);
    await h.owner.query("INSERT INTO public.fulfillment_dispatch_refs(request_key,shipment_id,order_id,mode,evidence) VALUES($1,$2,$3,'live',$4)", [`dispatch-${f.shipment}`, f.shipment, f.order, {}]);
    await expect(cancel(f)).rejects.toThrow('provider_dispatch_active'); expect(await stock(f)).toEqual(before);
    await h.owner.query("UPDATE public.fulfillment_dispatch_refs SET status='cancelled' WHERE shipment_id=$1", [f.shipment]);
    await h.owner.query("UPDATE public.fulfillment_shipments SET status='exception' WHERE id=$1", [f.shipment]);
    await expect(cancel(f)).rejects.toThrow('after_label_forbidden');
    await evidence(f, 'CANCELLED', '2026-11-01T00:00:00Z'); await evidence(f, 'PROCESSING', '2026-11-02T00:00:00Z');
    await expect(cancel(f)).rejects.toThrow('after_label_forbidden'); expect((await stock(f))[0].id).toBe(reservation); expect(await stock(f)).toEqual(before);
  });
  it('confirms paid provider cancellation internally, releasing order-wide holds while preserving the issued document and payment facts', async () => {
    const f = await subject(h.owner), one = await reserve(h.runtime, f), two = await reserve(h.runtime, f);
    const consumed = await reserve(h.runtime, f);
    await h.owner.query("UPDATE public.fulfillment_inventory_reservations SET status='consumed',expires_at=NULL WHERE id=$1", [consumed]);
    await h.owner.query("UPDATE public.fulfillment_shipments SET status='exception' WHERE id=$1", [f.shipment]);
    await h.owner.query("WITH doc AS (INSERT INTO public.accounting_documents(order_id,document_ref,status,total_gross_minor,issued_at,provider_reference) VALUES($1::uuid,$1::text,'issued',200,'2026-11-01T00:00:00Z','issued-fixture') RETURNING id) INSERT INTO public.accounting_document_positions(document_id,position_ordinal,description,quantity,unit_gross_minor,total_gross_minor) SELECT id,1,'Unit',2,100,200 FROM doc", [f.order]);
    const money = async () => (await h.owner.query('SELECT to_jsonb(i) value FROM public.commerce_settlement_intents i WHERE order_id=$1', [f.order])).rows;
    const accounting = async () => (await h.owner.query(`SELECT (SELECT jsonb_agg(to_jsonb(d)) FROM public.accounting_documents d WHERE order_id=$1) documents,
      (SELECT jsonb_agg(to_jsonb(r)) FROM public.accounting_document_requests r JOIN public.accounting_documents d ON d.id=r.document_id WHERE d.order_id=$1) requests,
      (SELECT jsonb_agg(to_jsonb(d)) FROM public.invoicing_duties d WHERE order_id=$1) duties,
      (SELECT jsonb_agg(to_jsonb(r)) FROM public.invoicing_effect_receipts r JOIN public.invoicing_duties d ON d.id=r.duty_id WHERE d.order_id=$1) effects`, [f.order])).rows;
    const beforeMoney = await money(), beforeAccounting = await accounting();
    const eventKey = await evidence(f, ' CANCELLED ', '2026-11-03T00:00:00Z');
    const proof = (await h.owner.query('SELECT * FROM public.fulfillment_operator_status_evidence WHERE event_key=$1', [eventKey])).rows;
    await h.runtime.query('SELECT public.fulfillment_record_operator_status_evidence($1,$2)', [eventKey, f.shipment]);
    expect((await h.owner.query('SELECT * FROM public.fulfillment_operator_status_evidence WHERE event_key=$1', [eventKey])).rows).toEqual(proof);
    const key = `cancel-${randomUUID()}`;
    expect(await cancel(f, f.shipment!, key)).toMatchObject({ status: 'cancelled', releasedReservationCount: 0 });
    expect(await cancel(f, f.shipment!, key)).toMatchObject({ replayed: true, releasedReservationCount: 0 });
    expect((await h.owner.query('SELECT status,metadata FROM public.commerce_orders WHERE id=$1', [f.order])).rows[0]).toMatchObject({ status: 'cancelled', metadata: { suppressOrderCanceledEmail: true } });
    const rows = await stock(f); for (const id of [one, two]) expect(rows.find(r => r.id === id)?.status).toBe('released'); expect(rows.find(r => r.id === consumed)?.status).toBe('consumed');
    expect(await money()).toEqual(beforeMoney); expect(await accounting()).toEqual(beforeAccounting);
    expect((await h.owner.query("SELECT * FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.order.cancelled'", [f.order])).rows).toEqual([]);
    expect((await h.owner.query("SELECT count(*)::int n FROM public.commerce_order_operations WHERE order_id=$1 AND operation_type='order_cancelled'", [f.order])).rows[0].n).toBe(1);
    const ordinary = await subject(h.owner); await h.owner.query("UPDATE public.commerce_orders SET status='cancelled' WHERE id=$1", [ordinary.order]);
    expect((await h.owner.query("SELECT count(*)::int n FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.order.cancelled'", [ordinary.order])).rows[0].n).toBe(1);
    const unpaid = await subject(h.owner); await h.owner.query("UPDATE public.commerce_orders SET status='pending_payment',paid_at=NULL WHERE id=$1", [unpaid.order]);
    await h.runtime.query("SELECT public.oms_cancel_unpaid_order($1,$2,'unpaid',$3)", [`unpaid-${randomUUID()}`, unpaid.order, unpaid.actor]);
    expect((await h.owner.query("SELECT * FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='commerce.order.cancelled'", [unpaid.order])).rows).toEqual([]);
  });
  it('uses only recorded mode for provider-confirmed paid cancellation, with atomic named refusal and replay', async () => {
    for (const mode of [null, 'subscription', 'one_time']) {
      const f = await subject(h.owner); await reserve(h.runtime, f);
      await h.owner.query("UPDATE public.fulfillment_shipments SET status='exception' WHERE id=$1", [f.shipment]);
      await h.owner.query("UPDATE public.commerce_orders SET metadata=jsonb_set(metadata,'{orderDraftSnapshot,context}',$2) WHERE id=$1", [f.order, mode === null ? {} : { mode }]);
      await evidence(f, 'CANCELLED', '2026-11-03T00:00:00Z');
      const state = async () => (await h.owner.query(`SELECT
        (SELECT to_jsonb(o) FROM public.commerce_orders o WHERE id=$1) purchase,
        (SELECT jsonb_agg(to_jsonb(s)) FROM public.fulfillment_shipments s WHERE order_id=$1) parcels,
        (SELECT jsonb_agg(to_jsonb(r)) FROM public.fulfillment_inventory_reservations r WHERE purchase_order_id=$1) reservations,
        (SELECT jsonb_agg(to_jsonb(o)) FROM public.commerce_order_operations o WHERE order_id=$1) operations,
        (SELECT jsonb_agg(to_jsonb(o)) FROM public.fulfillment_shipment_operations o WHERE order_id=$1) parcel_operations,
        (SELECT jsonb_agg(to_jsonb(e)) FROM public.outbox_events e WHERE aggregate_id=$1) events,
        (SELECT jsonb_agg(to_jsonb(r)) FROM public.fulfillment_operator_receipts r) receipts`, [f.order])).rows;
      const before = await state(), key = `mode-cancel-${randomUUID()}`;
      if (mode !== 'one_time') {
        await expect(cancel(f, f.shipment!, key)).rejects.toThrow(mode === null ? 'order_mode_unproven' : 'provider_cancel_order_ineligible');
        expect(await state()).toEqual(before);
        if (mode === null) {
          const res = responseFixture();
          const handler = createAdminCommerceFulfillmentCancelOrderHandler({ fulfillmentPort: port(f), respond: createBffResponder(), authorizeAdmin: async () => ({ ok: true, userId: f.actor }) });
          await handler({ method: 'POST', query: {}, body: { fulfillmentOrderId: f.shipment, idempotencyKey: key, reason: 'operator cancellation' } }, res.response);
          expect(res.output()).toMatchObject({ error: { code: 'CONFLICT', details: { code: 'order_mode_unproven' } } });
          expect(await state()).toEqual(before);
        }
        // A refused key has no receipt or side effect; repeating it keeps the same refusal.
        await expect(cancel(f, f.shipment!, key)).rejects.toThrow(mode === null ? 'order_mode_unproven' : 'provider_cancel_order_ineligible');
        expect(await state()).toEqual(before);
      } else {
        expect(await cancel(f, f.shipment!, key)).toMatchObject({ status: 'cancelled', replayed: false });
        const after = await state(); expect(await cancel(f, f.shipment!, key)).toMatchObject({ replayed: true });
        expect(await state()).toEqual(after);
      }
    }
  });
  it('prepares replacement dispatch from frozen contact and line facts and erasure refuses without a new generation', async () => {
    const f = await subject(h.owner), result = await replace(f);
    if (!('replacement' in result)) throw new Error('Expected replacement');
    const parcel = result.replacement.fulfillmentOrderId;
    const candidate: FulfillmentDispatchRequest = { requestKey: `dispatch-${parcel}`, fulfillmentRef: parcel, orderRef: f.order, orderNumber: null, parcelRef: null,
      contactRevision: { schemaVersion: 1, source: 'changed', revision: 2 },
      recipient: { name: 'Changed', email: 'changed@example.test', phone: '+999', line1: 'Changed street', line2: null, city: 'Changed', postalCode: '99999', country: 'ZZ', deliveryInstructions: null, courierInstructions: null },
      lines: [{ skuRef: 'CHANGED', title: null, quantity: 99, productRef: null, packRef: null }],
      selection: { providerRef: 'warehouse', carrierRef: 'changed', serviceRef: 'changed', deliveryKind: 'courier', pickupPoint: null } };
    const operations = Object.fromEntries(['dispatch','readback','exactAbsence','verifyObservation','syncStock','syncProducts','labelCreate','labelRead','labelVoid','cancel','pickupPoint','courierPickup']
      .map(key => [key, { supported: false, reason: 'not_exposed' }])) as FulfillmentCapabilityDescriptor['operations'];
    const capability: FulfillmentCapabilityDescriptor = { providerRef: 'warehouse', role: 'warehouse', defaultOff: true, selected: true, readiness: { ready: true },
      operations: { ...operations, dispatch: { supported: true } }, authentication: 'token', freshness: 'not_available', ownsDeliveredNotification: true,
      stockAuthority: 'external_stock_master_with_local_reservations', labelReadOwner: 'none', actionPolicy: { providerSpecificAdminActions: false, genericAdminActions: false, mutationSurface: 'provider_adapter' } };
    const seen: FulfillmentDispatchRequest[] = [];
    const binding = createNativeFulfillmentBinding({ enabled: true, transactions: {
      async run(work) { const db = await h.runtime.connect(); try { await db.query('BEGIN'); const value = await work(db); await db.query('COMMIT'); return value; }
        catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); } }, async close() {} },
      preparation: { async readAuthoritative() { return { candidate, withheld: false }; } },
      services: { selection: candidate.selection, capability, readiness: async () => ({ ready: true }), listCandidates: async () => [candidate],
        provider: { async prepare(request) { seen.push(request); return { kind: 'refused', refusal: { reason: 'unsupported', phase: 'prepare', retryable: false } }; }, async dispatch() { throw new Error('No external dispatch selected'); } },
        keys: { request: request => request.requestKey, mappedAttempt: key => key, acceptance: ref => ({ providerAttemptKey: ref, labelKey: ref }) }, config: { mode: 'live', batchLimit: 1 } },
      version: 'fixture', requiredSchema: { version: 'fixture', migration: 'fixture', objects: [] } });
    expect(await binding.prepare(parcel)).toEqual({ disposition: 'ready', contactRevision: 1 });
    await binding.services.runDispatch();
    expect(seen).toHaveLength(1); expect(seen[0]).toMatchObject({ recipient: { name: 'Frozen recipient', email: 'frozen@example.test', line1: 'Frozen street' },
      selection: { carrierRef: 'carrier', serviceRef: 'service' }, lines: [{ skuRef: f.sku, quantity: 2 }] });
    const visible = (await h.owner.query("SELECT public.fulfillment_shipment_response(s,'read',false) AS value FROM public.fulfillment_shipments s WHERE id=$1", [parcel])).rows;
    expect(JSON.stringify(visible)).not.toContain('frozen@example.test');
    await h.owner.query("UPDATE public.fulfillment_shipments SET status='packed' WHERE id=$1", [parcel]);
    await h.runtime.query('SELECT public.fulfillment_erase_parcel_contacts($1)', [f.client]);
    const before = await stock(f);
    await expect(replace(f)).rejects.toThrow('delivery_contact_invalid'); expect(await stock(f)).toEqual(before);
    await expect(binding.prepare(parcel)).rejects.toThrow('delivery_contact_invalid');
  });
  it('preserves a consumed renewal reservation while allocating a dedicated replacement generation', async () => {
    const f = await subject(h.owner), original = await renewalFixture(h.owner);
    const item = (await h.owner.query('SELECT id FROM public.commerce_order_items WHERE order_id=$1', [original.order])).rows[0].id;
    await h.owner.query('UPDATE public.commerce_order_items SET sku_id=$2 WHERE id=$1', [item, f.skuId]);
    await createPostgresDestinationPort(h.runtime).registerOrder({ idempotencyKey: `destination-${original.order}`, orderId: original.order,
      address: { recipientName: 'Frozen recipient', line1: 'Frozen street', city: 'Example', postalCode: '00000', country: 'ZZ', contactPhone: '+000001' }, now: '2026-11-01T00:00:00Z' });
    await h.owner.query("UPDATE public.commerce_orders SET renewal_operation_id=$2,renewal_operation_fingerprint=repeat('a',64) WHERE id=$1", [original.order, original.operation]);
    await h.owner.query("INSERT INTO public.commerce_settlement_intents(order_id,channel_key,status,amount_minor,currency_code,open_idempotency_key,settled_at) VALUES($1,'sandbox','settled',900,'XXX',$2,'2026-11-01T00:00:00Z')", [original.order, `settled-${original.order}`]);
    const reservation = randomUUID();
    await h.owner.query("INSERT INTO public.fulfillment_inventory_reservations(id,renewal_operation_id,operation_fingerprint,source_key,status) VALUES($1,$2,repeat('a',64),$3,'consumed')", [reservation, original.operation, f.source]);
    await h.owner.query("INSERT INTO public.fulfillment_inventory_reservation_lines(reservation_id,operation_fingerprint,sku,quantity) VALUES($1,repeat('a',64),$2,1)", [reservation, f.sku]);
    await h.runtime.query('SELECT public.fulfillment_capture_parcel_contact($1,$2)', [original.shipment, contact()]);
    const before = (await h.owner.query('SELECT * FROM public.fulfillment_inventory_reservations WHERE id=$1', [reservation])).rows;
    const linked = { ...f, order: original.order, shipment: original.shipment, client: original.client }, result = await replace(linked);
    if (!('replacement' in result)) throw new Error('Expected replacement');
    expect((await h.owner.query('SELECT * FROM public.fulfillment_inventory_reservations WHERE id=$1', [reservation])).rows).toEqual(before);
    expect((await h.owner.query('SELECT renewal_operation_id,purchase_order_id,status,expires_at FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=$1', [original.order])).rows)
      .toEqual([{ renewal_operation_id: null, purchase_order_id: original.order, status: 'committed', expires_at: null }]);
    expect(await cancel(linked, result.replacement.fulfillmentOrderId)).toMatchObject({ releasedReservationCount: 1 });
    expect((await h.owner.query('SELECT * FROM public.fulfillment_inventory_reservations WHERE id=$1', [reservation])).rows).toEqual(before);
  });
  it('keeps payment, non-exception holds and stock shortage guards atomic and serializes the replacement queue', async () => {
    const f = await subject(h.owner);
    await h.owner.query("UPDATE public.commerce_settlement_intents SET status='failed',settled_at=NULL WHERE order_id=$1", [f.order]);
    await expect(replace(f)).rejects.toThrow('payment_not_succeeded');
    await h.owner.query("UPDATE public.commerce_settlement_intents SET status='settled',settled_at='2026-11-01T00:00:00Z' WHERE order_id=$1", [f.order]);
    await h.owner.query("INSERT INTO public.commerce_order_holds(order_id,reason,status,idempotency_key) VALUES($1,'manual_support','active',$2)", [f.order, `hold-${randomUUID()}`]);
    await expect(replace(f)).rejects.toThrow('blocked_by_manual_support_hold');
    await h.owner.query("UPDATE public.commerce_order_holds SET status='released',released_at=now() WHERE order_id=$1", [f.order]);
    await h.owner.query("INSERT INTO public.commerce_order_holds(order_id,reason,status,idempotency_key) VALUES($1,'fulfillment_exception','active',$2)", [f.order, `hold-${randomUUID()}`]);
    await h.owner.query('UPDATE public.fulfillment_stock_current SET for_sale_quantity=0 WHERE source_key=$1', [f.source]);
    await expect(replace(f)).rejects.toThrow('insufficient_available_stock');
    expect((await h.owner.query("SELECT count(*)::int n FROM public.commerce_order_holds WHERE order_id=$1 AND status='active'", [f.order])).rows[0].n).toBe(1);
    expect(await stock(f)).toEqual([]);
    await h.owner.query('UPDATE public.fulfillment_stock_current SET for_sale_quantity=100 WHERE source_key=$1', [f.source]);
    const responses = await Promise.allSettled([replace(f), replace(f)]);
    expect(responses.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(responses.filter(r => r.status === 'rejected')).toHaveLength(1);
    const accepted = responses.find(r => r.status === 'fulfilled');
    if (accepted?.status !== 'fulfilled' || !('replacement' in accepted.value)) throw new Error('Expected one replacement');
    await h.owner.query("UPDATE public.fulfillment_shipments SET status='packed' WHERE id=$1", [accepted.value.replacement.fulfillmentOrderId]);
    // Packed is outside the reference's created/label_pending queue fence; no lifetime unique limit.
    const second = await replace(f); expect(second).toMatchObject({ replacement: { sequenceNo: 2 } });
  });
  it('orders provider evidence by occurrence, insertion time and UUID, and checks succeeded money plus active holds', async () => {
    const f = await subject(h.owner);
    await h.owner.query("UPDATE public.fulfillment_shipments SET status='exception' WHERE id=$1", [f.shipment]);
    const older = await evidence(f, 'PROCESSING', '2026-11-04T00:00:00Z'), cancelled = await evidence(f, 'CANCELLED', null);
    await expect(cancel(f)).rejects.toThrow('after_label_forbidden');
    await h.owner.query("UPDATE public.fulfillment_operator_status_evidence SET occurred_at='2026-11-04T00:00:00Z',created_at='2026-11-05T00:00:00Z',id=CASE WHEN event_key=$1 THEN 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid ELSE '00000000-0000-0000-0000-000000000001'::uuid END WHERE event_key=ANY($2::text[])", [older, [older, cancelled]]);
    await expect(cancel(f)).rejects.toThrow('after_label_forbidden');
    await h.owner.query("UPDATE public.fulfillment_operator_status_evidence SET created_at='2026-11-06T00:00:00Z' WHERE event_key=$1", [cancelled]);
    await h.owner.query("UPDATE public.commerce_settlement_intents SET status='failed',settled_at=NULL WHERE order_id=$1", [f.order]);
    await expect(cancel(f)).rejects.toThrow('payment_not_succeeded');
    await h.owner.query("UPDATE public.commerce_settlement_intents SET status='settled',settled_at='2026-11-01T00:00:00Z' WHERE order_id=$1", [f.order]);
    await h.owner.query("INSERT INTO public.commerce_order_holds(order_id,reason,status,idempotency_key) VALUES($1,'fulfillment_exception','active',$2)", [f.order, `hold-${randomUUID()}`]);
    await expect(cancel(f)).rejects.toThrow('active_hold');
    await h.owner.query("UPDATE public.commerce_order_holds SET status='released',released_at=now() WHERE order_id=$1", [f.order]);
    expect(await cancel(f)).toMatchObject({ status: 'cancelled' });
  });
  it('releases every order-owned reservation form while using only recorded mode as cancellation authority', async () => {
    const f = await subject(h.owner), unrelated = await reserve(h.runtime, f), renewal = await renewalFixture(h.owner);
    const linked = { ...f, order: renewal.order, shipment: renewal.shipment, client: renewal.client };
    const renewalReservation = randomUUID(), purchaseReservation = randomUUID(), consumed = randomUUID();
    await h.owner.query("UPDATE public.commerce_orders SET renewal_operation_id=$2,renewal_operation_fingerprint=repeat('a',64),metadata='{}' WHERE id=$1", [renewal.order, renewal.operation]);
    await h.owner.query("INSERT INTO public.commerce_settlement_intents(order_id,channel_key,status,amount_minor,currency_code,open_idempotency_key,settled_at) VALUES($1,'sandbox','settled',900,'XXX',$2,'2026-11-01T00:00:00Z')", [renewal.order, `settled-${renewal.order}`]);
    await h.owner.query("UPDATE public.fulfillment_shipments SET status='exception' WHERE id=$1", [renewal.shipment]);
    await h.owner.query("INSERT INTO public.fulfillment_inventory_reservations(id,renewal_operation_id,operation_fingerprint,source_key,status) VALUES($1,$2,repeat('a',64),$3,'committed')", [renewalReservation, renewal.operation, f.source]);
    await h.owner.query("INSERT INTO public.fulfillment_inventory_reservations(id,purchase_order_id,operation_fingerprint,source_key,status,expires_at) VALUES($1,$2,repeat('a',64),$3,'held',now()+interval '1 day'),($4,$2,repeat('a',64),$3,'consumed',NULL)", [purchaseReservation, renewal.order, f.source, consumed]);
    for (const reservation of [renewalReservation, purchaseReservation, consumed]) await h.owner.query("INSERT INTO public.fulfillment_inventory_reservation_lines(reservation_id,operation_fingerprint,sku,quantity) VALUES($1,repeat('a',64),$2,1)", [reservation, f.sku]);
    await evidence(linked, 'CANCELLED', '2026-11-03T00:00:00Z');
    const rows = async () => (await h.owner.query('SELECT id,status,updated_at FROM public.fulfillment_inventory_reservations WHERE id=ANY($1::uuid[]) ORDER BY id', [[renewalReservation,purchaseReservation,consumed,unrelated]])).rows;
    const before = await rows();
    await expect(cancel(linked)).rejects.toThrow('order_mode_unproven'); expect(await rows()).toEqual(before);
    await h.owner.query("UPDATE public.commerce_orders SET metadata=jsonb_build_object('orderDraftSnapshot',jsonb_build_object('context',jsonb_build_object('mode','one_time'))) WHERE id=$1", [renewal.order]);
    const key = `cancel-${randomUUID()}`; expect(await cancel(linked, renewal.shipment, key)).toMatchObject({ status: 'cancelled', releasedReservationCount: 0 });
    const after = await rows();
    for (const id of [renewalReservation,purchaseReservation]) expect(after.find(row => row.id===id)?.status).toBe('released');
    for (const id of [consumed,unrelated]) expect(after.find(row => row.id===id)).toEqual(before.find(row => row.id===id));
    expect(await cancel(linked, renewal.shipment, key)).toMatchObject({ replayed: true }); expect(await rows()).toEqual(after);
  });
  it('selects the latest parcel laterally without duplicating order pages or changing counts and detail', async () => {
    const one = await subject(h.owner), two = await subject(h.owner), result = await replace(one);
    if (!('replacement' in result)) throw new Error('Expected replacement');
    await h.owner.query("UPDATE public.fulfillment_shipments SET status='packed' WHERE id=$1", [result.replacement.fulfillmentOrderId]);
    const oms = createPostgresCommerceOmsControlPlane(h.runtime);
    // Isolate these rows with the existing order status filter.
    await h.owner.query("UPDATE public.commerce_orders SET status='fulfillment_pending',created_at=CASE WHEN id=$1 THEN '2026-11-02T00:00:00Z'::timestamptz ELSE '2026-11-01T00:00:00Z' END WHERE id=ANY($2::uuid[])", [one.order, [one.order, two.order]]);
    const first = await oms.listOrders({ view: 'control_plane_v1', status: 'fulfillment_pending', page: 1, pageSize: 1 }), next = await oms.listOrders({ view: 'control_plane_v1', status: 'fulfillment_pending', page: 2, pageSize: 1 });
    expect(first).toMatchObject({ totalCount: 2, orders: [{ orderId: one.order, shipmentStatus: 'packed' }] });
    expect(next).toMatchObject({ totalCount: 2, orders: [{ orderId: two.order, shipmentStatus: 'created' }] });
    expect(await oms.getOrderDetail({ view: 'control_plane_v1', orderId: one.order })).toMatchObject({ order: { orderId: one.order, shipmentStatus: 'packed' } });
    expect(await oms.listOrders({ view: 'control_plane_v1', status: 'fulfillment_pending', page: 3, pageSize: 1 })).toMatchObject({ totalCount: 2, orders: [] });
  });
});


it('roundtrips exact parcel associations, operator receipts and status evidence through finite store transfer', async () => {
  const resources = storeJourneyResources();
  try {
    const source = await resources.installation('operator-source'), target = await resources.installation('operator-target');
    const f = await subject(source.owner, false); await reserve(source.runtime, f);
    f.shipment = (await source.runtime.query("SELECT public.fulfillment_create_shipment($1,$2,'operator-fixture') AS value", [`create-${randomUUID()}`, f.order])).rows[0].value.shipment.id;
    await source.runtime.query('SELECT public.fulfillment_capture_parcel_contact($1,$2)', [f.shipment, contact()]);
    const port = createPostgresFulfillmentOperatorPort(source.runtime, { providerRef: 'warehouse', stockSourceKey: f.source });
    const result = await port.requestReplacementShipment({ idempotencyKey: `replace-${randomUUID()}`, orderId: f.order, actorUserId: f.actor, reason: 'lost' });
    if (!('replacement' in result)) throw new Error('Expected replacement');
    const parcel = result.replacement.fulfillmentOrderId, event = `event-${randomUUID()}`;
    await source.runtime.query('SELECT public.fulfillment_record_observation($1,$2,$3,\'2026-11-10T12:00:00Z\')', [event, parcel,
      { providerStatus: { primary: 'CANCELLED' }, fact: { occurredAt: '2026-11-10T12:00:00Z' }, correlation: { fulfillmentRef: parcel } }]);
    await source.runtime.query('SELECT public.fulfillment_record_operator_status_evidence($1,$2)', [event, parcel]);
    await port.cancelCommerceFulfillmentOrder({ idempotencyKey: `cancel-${randomUUID()}`, actorUserId: f.actor, fulfillmentOrderId: parcel, reason: 'operator cancellation' });
    const packet = await captureStoreJourney(source.owner, 'operator-source'), freshTarget = await captureStoreJourney(target.owner, 'operator-target');
    const tables = ['fulfillment_parcel_reservation_sets','fulfillment_parcel_lines','fulfillment_parcel_line_reservations','fulfillment_operator_receipts','fulfillment_operator_status_evidence'];
    for (const table of tables) expect(packet.owned.find(row => row.table === table)?.rows.length).toBeGreaterThan(0);
    expect(await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget })).toMatchObject({ replayed: false });
    const restored = await captureStoreJourney(target.owner, 'operator-target');
    for (const table of tables) expect(restored.owned.find(row => row.table === table)?.rows).toEqual(packet.owned.find(row => row.table === table)?.rows);
    expect(await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget })).toMatchObject({ replayed: true });
  } finally { await resources.close(); }
}, 30_000);
