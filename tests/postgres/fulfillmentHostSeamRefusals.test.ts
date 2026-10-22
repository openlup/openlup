import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createNativeUnsupportedFulfillmentPorts, FULFILLMENT_NATIVE_UNSUPPORTED, createPostgresFulfillmentShipmentSpinePort, createAdminCommerceOrderRequestReplacementShipmentHandler, createAdminCommerceFulfillmentCreateOrderHandler, createAdminCommerceFulfillmentRecordProviderAttemptHandler, createAdminCommerceFulfillmentRecordLabelHandler, createAdminCommerceFulfillmentHandOffHandler, createAdminCommerceFulfillmentTrackingEventHandler, createAdminCommerceFulfillmentCancelOrderHandler, readFulfillmentDelay } from '@openlup/platform/fulfillment';
import { createBffResponder } from '@openlup/platform/bff';
import type { HttpResponse } from '@openlup/platform/http';
import { executor, nativeHarness } from '../helpers/fulfillmentNative.js';

const h = nativeHarness('p5a-refusal');
beforeAll(() => h.start(), 120_000);
afterAll(() => h.stop());
it('native replacement/operator requests share one typed refusal and leave all PostgreSQL state byte-identical with mode off', async () => {
  const clientId = randomUUID(), orderId = randomUUID(), actorUserId = randomUUID();
  await h.pool.query('INSERT INTO public.clients(id,email) VALUES($1,$2)',[clientId,`${clientId}@example.invalid`]);
  const tx = await h.pool.connect();
  try {
    await tx.query('BEGIN');
  await tx.query("INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor) VALUES($1,$2,'paid','XXX',900)",[orderId,clientId]);
  await tx.query('INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,1,900,900)',[orderId]);
    await tx.query('COMMIT');
  } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
  await h.pool.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES('p5a-host','3pl',true)");
  // Set up the parcel through its real native write path, never by inserting a shipment.
  const spine = createPostgresFulfillmentShipmentSpinePort(executor(h.pool),{portKey:'p5a-host'});
  const shipment = await spine.createShipment({idempotencyKey:`create-${orderId}`,orderId});
  await spine.raiseException({idempotencyKey:`exception-${orderId}`,shipmentId:shipment.shipmentId,reason:'host-proof'});
  const tables: { tablename: string }[] = (await h.pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  async function snapshot() {
    return Promise.all(tables.map(async ({tablename}) => {
      const identifier = '"'+tablename.replaceAll('"','""')+'"';
      return [tablename,(await h.pool.query(`SELECT to_jsonb(record)::text AS bytes FROM public.${identifier} record ORDER BY to_jsonb(record)::text`)).rows];
    }));
  }
  const before = await snapshot();
  let output: unknown;
  const res = {setHeader(){},status(){return this;},json(value: unknown){output=value;return this;}} as unknown as HttpResponse;
  const native = createNativeUnsupportedFulfillmentPorts();
  const deps = {respond:createBffResponder(),authorizeAdmin:async()=>({ok:true as const,userId:actorUserId}),fulfillmentPort:native};
  const parcel = {fulfillmentOrderId:shipment.shipmentId};
  const cases = [
    [createAdminCommerceOrderRequestReplacementShipmentHandler({...deps,omsPort:native}),{orderId,reason:'lost'}],
    [createAdminCommerceFulfillmentCreateOrderHandler(deps),{orderId}],
    [createAdminCommerceFulfillmentRecordProviderAttemptHandler(deps),{...parcel,providerKind:'warehouse',status:'recorded'}],
    [createAdminCommerceFulfillmentRecordLabelHandler(deps),{...parcel,providerKind:'warehouse',providerTrackingId:'tracking'}],
    [createAdminCommerceFulfillmentHandOffHandler(deps),parcel],
    [createAdminCommerceFulfillmentTrackingEventHandler(deps),{...parcel,status:'delivered'}],
    [createAdminCommerceFulfillmentCancelOrderHandler(deps),{...parcel,reason:'operator'}],
  ] as const;
  for (const [i,[handler,body]] of cases.entries()) {
    await handler({method:'POST',query:{},body:{...body,idempotencyKey:`native-refusal-${i}`}},res);
    expect(output).toMatchObject({error:{code:'UPSTREAM_UNAVAILABLE',details:FULFILLMENT_NATIVE_UNSUPPORTED}});
    expect(await snapshot()).toEqual(before);
  }
  expect(await readFulfillmentDelay(native.readCustomerAlignmentRows,new Map([[randomUUID(),null]]))).toBe(FULFILLMENT_NATIVE_UNSUPPORTED);
  expect(await snapshot()).toEqual(before);
  expect((await h.pool.query('SELECT mode FROM public.subscription_delivery_alignment_control')).rows).toEqual([{mode:'off'}]);
},30_000);
