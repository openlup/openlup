import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresFulfillmentCommerceReadPort, nativeFulfillmentCommerceResponseSchemas } from '@openlup/platform/fulfillment/native';
import { createAdminCommerceFulfillmentOrderDetailHandler, createAdminCommerceFulfillmentOrdersListHandler } from '@openlup/platform/fulfillment';
import { createBffResponder } from '@openlup/platform/bff';
import type { HttpResponse } from '@openlup/platform/http';
import { createPostgresDestinationPort } from '@openlup/platform/commerce/server/destinations';
import { evaluateCommerceFulfillmentEligibility } from '@openlup/platform/commerce';
import { createPostgresMigrationRunner } from '../../server/adapters/postgres/migrationRunner.js';
import { qualifiedPostgresStartupOptions } from '../../server/adapters/postgres/qualifiedInstall.js';
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from '../helpers/postgresContainer.js';
describe.each(['default', 'Etc/GMT-9', 'Etc/GMT+5'])('shipment reads in %s', zone => {
const zoneOptions = zone === 'default' ? '' : ` -c timezone=${zone}`;
let container: PostgresContainer | undefined, owner: Pool, runtime: Pool;
const selection = { generation: 'qualified-v2', roleMode: 'installer-managed', bootstrapLogin: 'postgres', migrationLogin: 'postgres', runtimeLogin: 'fulfillment_reads_runtime', restoreLogin: 'fulfillment_reads_restore' } as const;
beforeAll(async () => {
  container = await runPostgresContainer({ name: `fulfillment-reads-${process.pid}`, password: 'synthetic-conformance' });
  expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
  const root = new Pool({ connectionString: container.connectionString });
  for (const role of [selection.runtimeLogin, selection.restoreLogin]) await root.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-conformance'`);
  await root.end();
  owner = new Pool({ connectionString: container.connectionString, options: qualifiedPostgresStartupOptions(selection) + zoneOptions });
  await createPostgresMigrationRunner({ connectionString: container.connectionString }, { installation: selection, poolFactory: () => owner }).apply();
  const url = new URL(container.connectionString); url.username = selection.runtimeLogin;
  runtime = new Pool({ connectionString: url.toString(), options: '-c role=service_role' + zoneOptions });
  const actual = (await runtime.query('SHOW TimeZone')).rows[0].TimeZone;
  expect(actual).toBe(zone === 'default' ? 'Etc/UTC' : zone);
  expect((await owner.query('SHOW TimeZone')).rows[0].TimeZone).toBe(actual);
  console.info(`Shipment read TimeZone: requested=${zone}; runtime=${actual}; owner=${actual}`);
}, postgresSetupTimeoutMs);
afterAll(async () => { await closePostgres(container, [owner, runtime]); }, postgresTeardownTimeoutMs);
const destinations = () => createPostgresDestinationPort(runtime);
const port = () => createPostgresFulfillmentCommerceReadPort({ executor: runtime, policy: { evaluateCommerceFulfillmentEligibility }, orderMode: () => 'one_time' });
async function fixture(status = 'created', client = randomUUID()) {
  const order = randomUUID(), shipment = randomUUID(), sku = randomUUID(), product = randomUUID();
  await owner.query('BEGIN');
  try {
    await owner.query('INSERT INTO public.clients(id,email) VALUES($1,$2)', [client, `${client}@example.invalid`]);
    await owner.query('INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,$3)', [product, product, 'Unit']);
    await owner.query('INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$2,$3,$4)', [sku, product, sku, 'Unit']);
    await owner.query("INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor,metadata) VALUES($1,$2,'paid','XTS',200,$3)", [order, client, { orderDraftSnapshot: { lines: [{ sku, title: 'Unit', quantity: 2, opaque: 'captured' }] } }]);
    await owner.query('INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,$2,1,2,100,200)', [order, sku]);
    await owner.query("INSERT INTO public.commerce_settlement_intents(order_id,channel_key,status,amount_minor,currency_code,external_ref,open_idempotency_key,settled_at) VALUES($1,'sandbox','settled',200,'XTS','opaque',$2,now())", [order, order]);
    await owner.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES('read-port','3pl',true) ON CONFLICT DO NOTHING");
    await owner.query('INSERT INTO public.fulfillment_shipments(id,order_id,port_key,provider_type,status,create_idempotency_key) VALUES($1,$2,$3,$4,$5,$1::uuid::text)', [shipment, order, 'read-port', '3pl', status]);
    await owner.query("INSERT INTO public.fulfillment_shipment_operations(shipment_id,order_id,operation_type,idempotency_key) VALUES($1,$2,'shipment_created',$1::uuid::text)", [shipment, order]);
    await owner.query('COMMIT');
  } catch (error) { await owner.query('ROLLBACK'); throw error; }
  const destination = await destinations().registerOrder({ idempotencyKey: `register-${order}`, orderId: order, address: { recipientName: 'Synthetic recipient', line1: 'Synthetic street', city: 'Fixture', postalCode: '00000', country: 'ZZ' }, now: '2026-11-03T00:00:00Z' });
  return { order, shipment, client, sku, destination };
}
async function reserve(f: Awaited<ReturnType<typeof fixture>>) {
  const id = randomUUID();
  await owner.query("INSERT INTO public.fulfillment_inventory_reservations(id,purchase_order_id,operation_fingerprint,source_key,status,expires_at) VALUES($1,$2,repeat('a',64),'read-stock','held',now()+interval '1 day')", [id, f.order]);
  await owner.query("INSERT INTO public.fulfillment_inventory_reservation_lines(reservation_id,operation_fingerprint,sku,quantity) VALUES($1,repeat('a',64),$2,2)", [id, f.sku]);
  return id;
}
it('reads full native facts under the actual restricted login with stable repeat results', async () => {
  expect((await runtime.query('SELECT current_user,session_user')).rows).toEqual([{ current_user: 'service_role', session_user: selection.runtimeLogin }]);
  const f = await fixture(); await reserve(f);
  const first = await port().getCommerceFulfillmentOrderDetail({ fulfillmentOrderId: f.shipment });
  expect(first).toMatchObject({ order: { id: f.shipment, orderId: f.order, shippingAddress: { addressId: null },
    lines: [{ sku: f.sku, quantity: 2, inventoryReservationIds: [], productSnapshot: { opaque: 'captured' } }],
    payment: { paymentStatus: 'succeeded' }, inventory: { status: 'reserved', locationId: null, locationCode: null }, omsEligibility: { allowed: true }, latestOperation: { type: 'created' } } });
  expect(await port().getCommerceFulfillmentOrderDetail({ orderId: f.order })).toEqual(first);
  expect(await port().getCommerceFulfillmentOrderDetail({ fulfillmentOrderId: randomUUID() })).toBeNull();
  const counts = async () => (await owner.query('SELECT (SELECT count(*) FROM public.commerce_destination_bindings) AS bindings,(SELECT count(*) FROM public.fulfillment_shipment_operations) AS operations')).rows;
  const before = await counts(); expect(await port().getCommerceFulfillmentOrderDetail({ orderId: f.order })).toEqual(first); expect(await counts()).toEqual(before);
  await owner.query("INSERT INTO public.fulfillment_provider_attempts(attempt_key,shipment_id,provider_kind,mode,evidence,status,created_at) VALUES($1,$2,'sandbox','stage',$3,'recorded',now()+interval '1 second')", [randomUUID(), f.shipment, { attempt: 'opaque' }]);
  expect(await port().getCommerceFulfillmentOrderDetail({ orderId: f.order })).toEqual(first);
});
it('filters status before paging and reports the unpaged shipment total', async () => {
  const one = await fixture('packed'), two = await fixture('packed');
  await owner.query("UPDATE public.fulfillment_shipments SET created_at=$2,updated_at=$3 WHERE id=$1", [one.shipment, '2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z']);
  await owner.query("UPDATE public.fulfillment_shipments SET created_at=$2,updated_at=$3 WHERE id=$1", [two.shipment, '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z']);
  const first = await port().listCommerceFulfillmentOrders({ page: 1, pageSize: 1, status: 'packed' });
  const next = await port().listCommerceFulfillmentOrders({ page: 2, pageSize: 1, status: 'packed' });
  expect(first).toMatchObject({ totalCount: 2, page: 1, orders: [{ status: 'packed' }] });
  expect(next).toMatchObject({ totalCount: 2, page: 2, orders: [{ status: 'packed' }] });
  if (!('orders' in first) || !('orders' in next)) throw new Error('projection missing');
  expect([first.orders[0].id, next.orders[0].id]).toEqual([one.shipment, two.shipment]);
  expect(await port().listCommerceFulfillmentOrders({ page: 3, pageSize: 1, status: 'packed' })).toMatchObject({ totalCount: 2, orders: [] });
});
it('retains hold, unpaid, missing and elapsed reservation facts and names missing destination', async () => {
  const f = await fixture();
  expect(await port().getCommerceFulfillmentOrderDetail({ orderId: f.order })).toMatchObject({ order: { inventory: { status: 'missing' }, omsEligibility: { reason: 'inventory_review' } } });
  await reserve(f);
  await owner.query("INSERT INTO public.commerce_order_holds(order_id,reason,status,idempotency_key) VALUES($1,'manual_support','active',$1::uuid::text)", [f.order]);
  expect(await port().getCommerceFulfillmentOrderDetail({ orderId: f.order })).toMatchObject({ order: { omsEligibility: { reason: 'active_hold' } } });
  await owner.query("UPDATE public.commerce_order_holds SET status='released',released_at=now() WHERE order_id=$1", [f.order]);
  await owner.query("UPDATE public.commerce_settlement_intents SET status='created',settled_at=null WHERE order_id=$1", [f.order]);
  expect(await port().getCommerceFulfillmentOrderDetail({ orderId: f.order })).toMatchObject({ order: { payment: { paymentStatus: 'created' }, omsEligibility: { reason: 'payment_not_succeeded' } } });
  await owner.query("UPDATE public.commerce_settlement_intents SET status='settled',settled_at=now() WHERE order_id=$1", [f.order]);
  await owner.query("UPDATE public.fulfillment_inventory_reservations SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE purchase_order_id=$1", [f.order]);
  expect(await port().getCommerceFulfillmentOrderDetail({ orderId: f.order })).toMatchObject({ order: { inventory: { status: 'reserved' }, omsEligibility: { allowed: true } } });
  await owner.query('DELETE FROM public.commerce_destination_bindings WHERE order_id=$1 OR shipment_id=$2', [f.order, f.shipment]);
  // Remove the order's immutable document only in privileged fixture setup.
  await owner.query('DELETE FROM public.commerce_destinations WHERE purchase_order_id=$1', [f.order]);
  await expect(port().getCommerceFulfillmentOrderDetail({ orderId: f.order })).rejects.toThrow('native_fulfillment_destination_unavailable');
});
it('reads an unprepared shipment without writing any public row and retains private-table denial', async () => {
  const f = await fixture('exception');
  const tables = (await owner.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const countSql = tables.map(({ tablename }) => `SELECT '${tablename}' AS name,count(*)::text AS n FROM public."${tablename}"`).join(' UNION ALL ');
  const counts = async () => (await owner.query(countSql)).rows;
  const bindings = async () => (await owner.query('SELECT count(*)::int AS n FROM public.commerce_destination_bindings WHERE shipment_id=$1', [f.shipment])).rows[0].n;
  expect(await bindings()).toBe(0);
  const before = await counts();
  const viewed = (await runtime.query('SELECT public.commerce_view_shipment_destination($1::uuid) AS value', [f.shipment])).rows[0].value;
  expect(viewed).toMatchObject({ destinationId: f.destination.destinationId, clientId: f.client, pinned: false });
  expect(await port().getCommerceFulfillmentOrderDetail({ orderId: f.order })).toMatchObject({ order: { id: f.shipment, shippingAddress: { line1: 'Synthetic street' } } });
  await port().listCommerceFulfillmentOrders({ page: 1, pageSize: 100, status: 'exception' });
  expect(await counts()).toEqual(before);
  expect(await bindings()).toBe(0);
  await expect(runtime.query('SELECT * FROM public.commerce_destination_bindings')).rejects.toMatchObject({ code: '42501' });
  await expect(runtime.query('SELECT * FROM public.commerce_destinations')).rejects.toMatchObject({ code: '42501' });
});
it('maps routine owner mismatch, preserves an unmapped routine error and permits an injected override', async () => {
  const f = await fixture(), other = await fixture();
  await owner.query('INSERT INTO public.commerce_destination_bindings(shipment_id,destination_id) VALUES($1,$2)', [f.shipment, other.destination.destinationId]);
  await expect(port().getCommerceFulfillmentOrderDetail({ orderId: f.order })).rejects.toThrow('native_fulfillment_destination_owner_mismatch');
  const unmapped = createPostgresFulfillmentCommerceReadPort({ executor: { query: (sql, values) => runtime.query(sql, sql.startsWith('SELECT public.commerce_view_shipment_destination') ? [null] : values) },
    policy: { evaluateCommerceFulfillmentEligibility }, orderMode: () => 'one_time' });
  await expect(unmapped.getCommerceFulfillmentOrderDetail({ orderId: f.order })).rejects.toMatchObject({ code: '22023', message: 'commerce_destination_invalid_scope' });
  const injected = createPostgresFulfillmentCommerceReadPort({ executor: { query(sql, values) {
    expect(sql).not.toContain('commerce_view_shipment_destination'); return runtime.query(sql, values);
  } }, destinations: { async read(scope, id) {
    expect([scope, id]).toEqual(['shipment', f.shipment]);
    return { ...f.destination, address: { ...f.destination.address, line1: 'Override street' } };
  } }, policy: { evaluateCommerceFulfillmentEligibility }, orderMode: () => 'one_time' });
  expect(await injected.getCommerceFulfillmentOrderDetail({ orderId: f.order })).toMatchObject({ order: { shippingAddress: { line1: 'Override street' } } });
});

it('serves equivalent uppercase client UUIDs unchanged and refuses another owner', async () => {
  const f = await fixture('in_transit', 'abcdefab-cdef-4abc-8def-abcdefabcdef');
  const stored = (await runtime.query('SELECT client_id::text AS client_id FROM public.commerce_orders WHERE id=$1::uuid', [f.order])).rows[0].client_id;
  expect(stored).toBe(f.client);
  let clientId = stored.toUpperCase();
  expect(clientId).not.toBe(stored);
  const injected = createPostgresFulfillmentCommerceReadPort({ executor: runtime,
    destinations: { async read(scope, id) {
      expect([scope, id]).toEqual(['shipment', f.shipment]);
      return { ...f.destination, clientId };
    } }, policy: { evaluateCommerceFulfillmentEligibility }, orderMode: () => 'one_time' });
  const deps = { respond: createBffResponder(), authorizeAdmin: async () => ({ ok: true as const, userId: 'operator' }),
    fulfillmentPort: injected, responseSchemas: nativeFulfillmentCommerceResponseSchemas };
  const detail = createAdminCommerceFulfillmentOrderDetailHandler(deps);
  const list = createAdminCommerceFulfillmentOrdersListHandler(deps);
  let output: unknown;
  const response = { setHeader() {}, status() { return this; }, json(value: unknown) { output = value; return this; } } as unknown as HttpResponse;
  const res = { response, output: () => output };
  await detail({ method: 'GET', query: { fulfillmentOrderId: f.shipment } }, res.response);
  expect(res.output()).toMatchObject({ ok: true, data: { order: { id: f.shipment, shippingAddress: { clientId } } } });
  await list({ method: 'GET', query: { page: '1', pageSize: '25', status: 'in_transit' } }, res.response);
  expect(res.output()).toMatchObject({ ok: true, data: { orders: [{ id: f.shipment, shippingAddress: { clientId } }] } });
  clientId = randomUUID().toUpperCase();
  await expect(injected.getCommerceFulfillmentOrderDetail({ fulfillmentOrderId: f.shipment })).rejects.toThrow('native_fulfillment_destination_owner_mismatch');
  await expect(injected.listCommerceFulfillmentOrders({ page: 1, pageSize: 25, status: 'in_transit' })).rejects.toThrow('native_fulfillment_destination_owner_mismatch');
  await detail({ method: 'GET', query: { fulfillmentOrderId: f.shipment } }, res.response);
  expect(res.output()).toMatchObject({ ok: false, error: { code: 'UPSTREAM_UNAVAILABLE' } });
  await list({ method: 'GET', query: { page: '1', pageSize: '25', status: 'in_transit' } }, res.response);
  expect(res.output()).toMatchObject({ ok: false, error: { code: 'UPSTREAM_UNAVAILABLE' } });
});

it('selects the highest sequence then id, with an explicit id taking precedence over an order id', async () => {
  const f = await fixture();
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  // Equal sequences cannot be stored by the native unique key; evaluate the same SELECT over typed fixture rows.
  const base = (await owner.query('SELECT to_jsonb(s) AS row FROM public.fulfillment_shipments s WHERE id=$1', [f.shipment])).rows[0].row;
  const shipments = [
    { ...base, id: id(10), sequence_no: 0, created_at: '2026-03-01T00:00:00Z' },
    { ...base, id: id(2), sequence_no: 1, created_at: '2026-02-01T00:00:00Z' },
    { ...base, id: id(3), sequence_no: 1, created_at: '2026-01-01T00:00:00Z' },
  ];
  const selected = createPostgresFulfillmentCommerceReadPort({
    executor: { async query(sql, values) {
      return sql.startsWith('SELECT to_jsonb(s)')
        ? runtime.query(sql.replace('public.fulfillment_shipments', 'jsonb_populate_recordset(NULL::public.fulfillment_shipments,$3::jsonb)'), [...(values ?? []), JSON.stringify(shipments)])
        : runtime.query(sql, values);
    } },
    destinations: { async read() { return { ...f.destination, clientId: f.client }; } },
    policy: { evaluateCommerceFulfillmentEligibility }, orderMode: () => 'one_time',
  });
  expect(await selected.getCommerceFulfillmentOrderDetail({ orderId: f.order })).toMatchObject({ order: { id: id(3) } });
  expect(await selected.getCommerceFulfillmentOrderDetail({ fulfillmentOrderId: id(2), orderId: randomUUID() })).toMatchObject({ order: { id: id(2) } });
  expect(await selected.getCommerceFulfillmentOrderDetail({ fulfillmentOrderId: id(10) })).toMatchObject({ order: { id: id(10) } });
  expect(await selected.getCommerceFulfillmentOrderDetail({ fulfillmentOrderId: randomUUID(), orderId: f.order })).toBeNull();
});

it('forwards the same database timestamp spelling in list and detail, including sub-millisecond precision', async () => {
  const f = await fixture('label_pending');
  await owner.query("UPDATE public.fulfillment_shipments SET created_at='2026-06-05T10:00:00.123456+00:00',updated_at='2026-06-05T10:01:00.654321+00:00' WHERE id=$1", [f.shipment]);
  const detail = await port().getCommerceFulfillmentOrderDetail({ orderId: f.order });
  const list = await port().listCommerceFulfillmentOrders({ page: 1, pageSize: 25, status: 'label_pending' });
  if (!detail || !('order' in detail) || !('orders' in list)) throw new Error('projection missing');
  expect(list.orders).toEqual([detail.order]);
  const stored = (await runtime.query("SELECT to_jsonb('2026-06-05T10:00:00.123456Z'::timestamptz) AS created, to_jsonb('2026-06-05T10:01:00.654321Z'::timestamptz) AS updated")).rows[0];
  expect(detail.order).toMatchObject({ createdAt: stored.created, updatedAt: stored.updated });
  if (zone === 'default') expect(detail.order).toMatchObject({ createdAt: '2026-06-05T10:00:00.123456+00:00', updatedAt: '2026-06-05T10:01:00.654321+00:00' });
});

it('retains newest order tracking for unattributed historical references on current and earlier shipments', async () => {
  const f = await fixture(), replacement = randomUUID();
  await owner.query("INSERT INTO public.fulfillment_shipments(id,order_id,port_key,provider_type,status,create_idempotency_key,sequence_no,replaces_shipment_id,replacement_reason) VALUES($1,$2,'read-port','3pl','created',$1::uuid::text,1,$3,'lost')", [replacement, f.order, f.shipment]);
  await owner.query("INSERT INTO public.shipment_external_refs(shipment_id,ref_role,external_id,recorded_at) VALUES($1,'tracking','earlier-ref','2026-06-01T00:00:00Z'),($2,'tracking','current-ref','2026-06-02T00:00:00Z')", [f.shipment, replacement]);
  expect(await port().getCommerceFulfillmentOrderDetail({ fulfillmentOrderId: f.shipment })).toMatchObject({ order: { providerTrackingId: 'current-ref' } });
  expect(await port().getCommerceFulfillmentOrderDetail({ orderId: f.order })).toMatchObject({ order: { id: replacement, providerTrackingId: 'current-ref' } });
  await owner.query("UPDATE public.shipment_external_refs SET provider_kind='carrier' WHERE shipment_id=ANY($1::uuid[])", [[f.shipment, replacement]]);
  expect(await port().getCommerceFulfillmentOrderDetail({ fulfillmentOrderId: f.shipment })).toMatchObject({ order: { providerTrackingId: 'earlier-ref' } });
  expect(await port().getCommerceFulfillmentOrderDetail({ orderId: f.order })).toMatchObject({ order: { id: replacement, providerTrackingId: 'current-ref' } });
});

});
