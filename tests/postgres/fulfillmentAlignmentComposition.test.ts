import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPostgresFulfillmentShipmentCommandPort, createPostgresCustomerAlignmentRowsReader } from '@openlup/platform/fulfillment/native';
import { readFulfillmentDelay, createNativeUnsupportedFulfillmentPorts, FULFILLMENT_NATIVE_UNSUPPORTED } from '@openlup/platform/fulfillment';
import { executor, fixture, nativeHarness, openCase, replacement, schedule } from '../helpers/fulfillmentNative.js';
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from '../helpers/postgresContainer.js';

const h = nativeHarness('alignment-composition');
beforeAll(() => h.start(), postgresSetupTimeoutMs);
afterAll(() => h.stop(), postgresTeardownTimeoutMs);

it('repairs a protected case earlier without shifting or stacking the cycle through the admitted tracking writer', async () => {
  const f = await fixture(h.pool), actor = randomUUID(), sibling = await replacement(h.pool, f);
  await h.pool.query('INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)', [actor, `${actor}@example.invalid`]);
  await openCase(h.pool, f);
  await h.pool.query("UPDATE public.fulfillment_shipments SET status='handed_over' WHERE id=ANY($1::uuid[])", [[f.shipment, sibling]]);
  const command = createPostgresFulfillmentShipmentCommandPort(executor(h.pool));
  const key = randomUUID();
  const track = (occurredAt: string) => command.recordCommerceFulfillmentTrackingEvent({
    idempotencyKey: key, fulfillmentOrderId: f.shipment, actorUserId: actor, status: 'delivered', rawEvent: { occurredAt },
  });
  const clock = (await h.pool.query('SELECT now() AS t')).rows[0].t.getTime();
  const first = new Date(clock - 3 * 86400000).toISOString(), earlier = new Date(clock - 4 * 86400000).toISOString();
  await track(first);
  const before = await schedule(h.pool, f.subscription);
  await track(earlier);
  const parcel = (await h.pool.query('SELECT delivered_at FROM public.fulfillment_shipments WHERE id=$1', [f.shipment])).rows[0];
  const c = (await h.pool.query('SELECT state,delivered_at FROM public.subscription_delivery_alignment_cases WHERE predecessor_order_id=$1 AND shipment_id=$2', [f.order, f.shipment])).rows[0];
  expect(parcel.delivered_at.toISOString()).toBe(earlier);
  expect(c).toEqual({ state: 'protected', delivered_at: new Date(earlier) });
  expect((await h.pool.query('SELECT state FROM public.subscription_delivery_alignment_cases WHERE predecessor_order_id=$1', [f.order])).rows.every(row => row.state === 'protected')).toBe(true);
  expect(await schedule(h.pool, f.subscription)).toEqual(before);
  // Later evidence is ignored by the admitted writer; it never adds a cadence.
  await track(new Date(clock - 2 * 86400000).toISOString());
  expect((await h.pool.query('SELECT delivered_at FROM public.fulfillment_shipments WHERE id=$1', [f.shipment])).rows[0]).toEqual(parcel);
  const last = new Date(clock - 86400000).toISOString();
  await command.recordCommerceFulfillmentTrackingEvent({ idempotencyKey: randomUUID(), fulfillmentOrderId: sibling, actorUserId: actor, status: 'delivered', rawEvent: { occurredAt: last } });
  const expected = new Date(new Date(last).getTime() + 28 * 86400000);
  expect((await schedule(h.pool, f.subscription)).next_cycle_at).toEqual(expected);
  await track(earlier);
  expect((await schedule(h.pool, f.subscription)).next_cycle_at).toEqual(expected);
  // Settled chronology can update the audit time, never the aligned target.
  await h.pool.query('UPDATE public.fulfillment_shipments SET delivered_at=$2 WHERE id=$1', [sibling, new Date(clock + 86400000)]);
  expect((await schedule(h.pool, f.subscription)).next_cycle_at).toEqual(expected);
});

it('reads only protected/aligned raw rows in update order and retains the existing current-schedule mapper', async () => {
  const f = await fixture(h.pool), absent = await fixture(h.pool), old = await openCase(h.pool, f);
  const second = await replacement(h.pool, f);
  await h.pool.query("INSERT INTO public.subscription_delivery_alignment_cases(subscription_id,predecessor_cycle_id,predecessor_cycle_number,predecessor_order_id,shipment_id,captured_mode,state,evidence_kind,observed_next_cycle_at,aligned_next_cycle_at,aligned_at,updated_at) SELECT subscription_id,predecessor_cycle_id,predecessor_cycle_number,predecessor_order_id,$2,captured_mode,'aligned',evidence_kind,observed_next_cycle_at,observed_next_cycle_at,now(),now()+interval '1 second' FROM public.subscription_delivery_alignment_cases WHERE id=$1", [old.id, second]);
  const reader = createPostgresCustomerAlignmentRowsReader(executor(h.pool));
  const rows = await reader([f.subscription, absent.subscription]);
  if (!Array.isArray(rows)) throw new Error('Expected native rows');
  expect(rows.map(row => row.state)).toEqual(['aligned', 'protected']);
  for (const row of rows) {
    expect(Object.keys(row).sort()).toEqual(['aligned_next_cycle_at','state','subscription_id','updated_at']);
    expect(typeof row.updated_at).toBe('string');
  }
  const next = (await schedule(h.pool, f.subscription)).next_cycle_at.toISOString();
  expect(await readFulfillmentDelay(reader, new Map([[f.subscription, next.replace('Z', '+00:00')], [absent.subscription, next]]))).toEqual(new Map([[f.subscription, { state: 'aligned' }]]));
  await h.pool.query("UPDATE public.subscription_delivery_alignment_cases SET state='released' WHERE id=$1", [old.id]);
  expect(await readFulfillmentDelay(reader, new Map([[f.subscription, new Date(new Date(next).getTime()+86400000).toISOString()]]))).toEqual(new Map());
  expect(await reader([])).toEqual([]);
  expect(await reader([absent.subscription])).toEqual([]);
  const fallback = createNativeUnsupportedFulfillmentPorts();
  expect(await fallback.getShipmentsOverview({} as never)).toBe(FULFILLMENT_NATIVE_UNSUPPORTED);
});

it('arrival without a case has zero schedule and customer-presentation effect; captured protect releases without shifting', async () => {
  const f = await fixture(h.pool);
  const before = await schedule(h.pool, f.subscription);
  await h.pool.query("SELECT public.fulfillment_record_alignment_arrival($1,$2,now(),'evidence:fixture')", [randomUUID(), f.shipment]);
  expect(await schedule(h.pool, f.subscription)).toEqual(before);
  expect(await createPostgresCustomerAlignmentRowsReader(executor(h.pool))([f.subscription])).toEqual([]);
  const protectedOnly = await fixture(h.pool); await openCase(h.pool, protectedOnly, 'protect');
  const original = await schedule(h.pool, protectedOnly.subscription);
  await h.pool.query("SELECT public.fulfillment_record_alignment_arrival($1,$2,now(),'evidence:protect')", [randomUUID(), protectedOnly.shipment]);
  expect((await h.pool.query('SELECT state FROM public.subscription_delivery_alignment_cases WHERE predecessor_order_id=$1', [protectedOnly.order])).rows).toEqual([{state:'released'}]);
  expect(await schedule(h.pool, protectedOnly.subscription)).toEqual(original);
});
