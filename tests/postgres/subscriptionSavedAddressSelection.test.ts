import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresDestinationPort } from '@openlup/platform/commerce/server/destinations';
import { createNativeRenewalCodec, createPostgresRenewalStore } from '@openlup/platform/subscriptions';
import { installAccountMutations, type AccountProfile } from './customerAccountMutations.fixture.js';
import { savedAddressPort, addressId } from './customerSavedAddresses.fixture.js';
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from '../helpers/postgresContainer.js';
const at = '2026-11-11T00:00:00.000Z';
const typed = { recipientName: 'Typed Recipient', line1: 'Typed Street 1', city: 'Example', postalCode: '12345', country: 'ZZ' };
for (const profile of ['legacy','bootstrap','separate','admin-managed','admin-operator'] as AccountProfile[]) describe(`saved subscription destination on ${profile}`, () => {
  let db: Awaited<ReturnType<typeof installAccountMutations>>;
  beforeAll(async () => { db = await installAccountMutations(profile); }, postgresSetupTimeoutMs);
  afterAll(async () => { await db?.close(); }, postgresTeardownTimeoutMs);
  const rpc = async (name: string, args: unknown[]) => (await db.runtime.query(`SELECT public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) AS result`, args)).rows[0].result;
  const port = () => createPostgresDestinationPort(db.runtime);
  async function subject(kind: 'shipping' | 'both' | 'billing' = 'shipping') {
    const principal = randomUUID(), client = randomUUID(), subscription = randomUUID();
    await db.owner.query('INSERT INTO public.platform_human_principals(principal_id,email,created_at) VALUES($1,$2,$3)', [principal,`${principal}@example.invalid`,at]);
    await db.owner.query('INSERT INTO public.clients(id,principal_id,email,created_at,updated_at) VALUES($1,$2,$3,$4,$4)', [client,principal,`${client}@example.invalid`,at]);
    await db.owner.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at,status,created_at,updated_at) VALUES($1,$2,28,$3,'active',$3,$3)", [subscription,client,at]);
    const book = savedAddressPort(db.runtime,principal,client), input = { idempotencyKey: randomUUID(), kind, line1: 'Saved Street 1', city: 'Example', postalCode: '12345', recipientName: null, contactPhone: '123456789' };
    const id = addressId(await book.upsertAddress(principal,input));
    return { principal, client, subscription, book, input, id };
  }
  type Subject = Awaited<ReturnType<typeof subject>>;
  const select = (f: Subject, key: string = randomUUID(), id: string = f.id) => port().selectSavedShippingAddress({ actorId: f.principal, clientId: f.client, subscriptionId: f.subscription, idempotencyKey: key, savedAddressId: id, now: at });
  const row = async (f: Subject) => (await db.owner.query('SELECT to_jsonb(s) AS value FROM public.subscriptions s WHERE id=$1', [f.subscription])).rows[0].value;
  const history = async (f: Subject) => (await db.owner.query('SELECT to_jsonb(e) AS value,xmin::text FROM public.subscription_events e WHERE subscription_id=$1 ORDER BY id', [f.subscription])).rows;
  const destinations = async (f: Subject) => (await db.owner.query('SELECT to_jsonb(d) AS value,xmin::text FROM public.commerce_destinations d WHERE client_id=$1 ORDER BY id', [f.client])).rows;
  it.each(['shipping','both'] as const)('selects an owned %s row without a recipient and leaves billing, cadence and template unchanged', async kind => {
    const f = await subject(kind);
    const billing = (await f.book.upsertAddress(f.principal,{ ...f.input,idempotencyKey: randomUUID(),kind: 'billing',line1: 'Billing Street 3' }))!.addresses.find(a => a.kind === 'billing')!;
    await db.owner.query('UPDATE public.subscriptions SET billing_saved_address_id=$2 WHERE id=$1', [f.subscription,billing.addressId]);
    const before = await row(f);
    expect(await select(f)).toMatchObject({ status: 'applied', shippingAddressId: f.id });
    expect(await row(f)).toEqual({ ...before, shipping_saved_address_id: f.id, updated_at: at.replace('.000Z','+00:00') });
    const document = await port().read('subscription',f.subscription);
    expect(document.address).toMatchObject({ savedAddressId: f.id, recipientName: null, line1: 'Saved Street 1' });
    expect((await history(f))[0].value).toMatchObject({ event_type: 'subscription.customer_self_service.change_shipping_address', payload: { payload: { shippingAddressId: f.id } } });
    expect((await db.owner.query("SELECT payload FROM public.customer_account_events WHERE client_id=$1 AND event_type='subscription.address_changed'", [f.client])).rows).toEqual([{ payload: { action: 'change_shipping_address', sourceEventId: (await history(f))[0].value.id } }]);
    expect((await db.owner.query("SELECT count(*)::int n FROM public.outbox_events WHERE aggregate_id=$1 AND event_type='subscription.address_changed'", [f.subscription])).rows[0].n).toBe(1);
    for (const status of ['active','paused']) {
      await db.owner.query('UPDATE public.subscriptions SET status=$2 WHERE id=$1', [f.subscription,status]);
      await expect(f.book.deleteAddress(f.principal,{ idempotencyKey: randomUUID(), addressId: f.id })).rejects.toMatchObject({ code: 'address_in_use' });
    }
  });
  it('refuses foreign, missing and billing IDs without writing; subscription ownership precedes address ownership', async () => {
    const f = await subject(), other = await subject(), billing = await subject('billing'), before = await row(f), otherBefore = await row(other);
    for (const id of [other.id, billing.id, randomUUID(), '']) await expect(select(f,randomUUID(),id)).rejects.toMatchObject({ code: 'P0001', message: 'customer_self_service_invalid_address' });
    await expect(select({ ...f,subscription: other.subscription },randomUUID(),other.id)).rejects.toMatchObject({ message: 'customer_self_service_forbidden' });
    await expect(select({ ...f,principal: other.principal })).rejects.toMatchObject({ message: 'customer_self_service_not_found' });
    await expect(rpc('subscription_select_saved_shipping_address',[null,f.client,randomUUID(),f.subscription,{ shippingAddressId: f.id },at])).rejects.toMatchObject({ message: 'customer_self_service_not_found' });
    await expect(select(f,'short')).rejects.toMatchObject({ message: 'customer_self_service_invalid_idempotency_key' });
    await expect(select(f,randomUUID(),'malformed')).rejects.toMatchObject({ code: '22P02' });
    expect(await row(f)).toEqual(before); expect(await row(other)).toEqual(otherBefore); expect(await history(f)).toEqual([]); expect(await history(other)).toEqual([]);
  });
  it('replays before address parsing, ownership and lifecycle checks, returning the current pointer without another event', async () => {
    const f = await subject(), other = await subject(), key = randomUUID(), first = await select(f,key);
    await f.book.upsertAddress(f.principal,{ ...f.input,idempotencyKey: randomUUID(),addressId: f.id,line1: 'Edited after selection' });
    const events = await history(f), before = await row(f);
    for (const id of [other.id,'malformed',randomUUID()]) expect(await select(f,key,id)).toEqual({ ...first,status: 'replayed' });
    expect(await row(f)).toEqual(before); expect(await history(f)).toEqual(events);
    await db.owner.query("UPDATE public.subscriptions SET status='cancelled' WHERE id=$1", [f.subscription]);
    await f.book.deleteAddress(f.principal,{ idempotencyKey: randomUUID(),addressId: f.id });
    expect(await select(f,key,other.id)).toMatchObject({ status: 'replayed',shippingAddressId: null,subscriptionStatus: 'cancelled',eventId: first.eventId });
    expect(await history(f)).toEqual(events);
  });
  it('keeps the mandatory recipient for typed addresses; only a successful new typed command supersedes selection', async () => {
    const f = await subject(), typedKey = randomUUID();
    const change = (key: string) => port().changeShippingAddress({ actorId: f.principal,clientId: f.client,subscriptionId: f.subscription,idempotencyKey: key,newAddress: typed,expectedVersion: 1,now: at });
    await change(typedKey); const original = await port().read('subscription',f.subscription);
    await select(f); const retained = await destinations(f);
    expect(await change(typedKey)).toMatchObject({ replayed: true });
    expect((await row(f)).shipping_saved_address_id).toBe(f.id);
    const { recipientName: _recipient, ...incomplete } = typed;
    expect(await rpc('subscription_change_shipping_destination',[f.principal,f.client,randomUUID(),f.subscription,{ newAddress: incomplete },1,at])).toMatchObject({ outcome: 'refused',refusalCode: 'invalid_address' });
    expect((await row(f)).shipping_saved_address_id).toBe(f.id);
    await f.book.upsertAddress(f.principal,{ ...f.input,...typed,idempotencyKey: randomUUID(),addressId: f.id });
    await change(randomUUID()); expect((await row(f)).shipping_saved_address_id).toBeNull();
    const changed = await port().read('subscription',f.subscription);
    expect(changed.address).toMatchObject(typed); expect(changed.address).not.toHaveProperty('savedAddressId');
    expect((await destinations(f)).filter(d => retained.some(old => old.value.id === d.value.id))).toEqual(retained);
    expect((await destinations(f)).find(d => d.value.id === original.destinationId)?.value.address).toEqual(original.address);
  });
  it('preserves status and locked-cycle refusals while accepting paused subscriptions', async () => {
    const f = await subject();
    await db.owner.query("UPDATE public.subscriptions SET status='paused' WHERE id=$1", [f.subscription]);
    expect(await select(f)).toMatchObject({ status: 'applied' });
    await db.owner.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at,status) VALUES($1,$2,$3,'paid')", [randomUUID(),f.subscription,at]);
    const before = await row(f), events = await history(f);
    await expect(select(f)).rejects.toMatchObject({ message: 'customer_self_service_payment_blocked' });
    await expect(select(f,randomUUID(),randomUUID())).rejects.toMatchObject({ message: 'customer_self_service_invalid_address' });
    expect(await row(f)).toEqual(before); expect(await history(f)).toEqual(events);
    await db.owner.query("UPDATE public.subscriptions SET status='cancelled' WHERE id=$1", [f.subscription]);
    await expect(select(f)).rejects.toMatchObject({ message: 'customer_self_service_invalid_address' });
  });
  it('freezes the live saved row for a new claim, preserves the retained claim and materialized order, and consumes edits in a future claim', async () => {
    const f = await subject('both'), source = randomUUID(), product = randomUUID(), sku = `SKU-${product}`;
    await db.owner.query('SELECT public.subscription_delivery_alignment_set_mode($1)', ['off']);
    await db.owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Synthetic')", [product,sku]);
    await db.owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$1,$2,'Synthetic')", [product,sku]);
    await db.owner.query("INSERT INTO public.fulfillment_stock_current(source_key,sku,total_quantity,for_sale_quantity,reserved_unavailable_quantity,inventory_class,last_synced_at,stale_after,sync_run_id,idempotency_key,operation_fingerprint) VALUES($1,$2,10,10,0,'sellable',$3,'2027-12-01T00:00:00Z','fixture',$2,$4)", [source,sku,at,'a'.repeat(64)]);
    await select(f);
    const codec = createNativeRenewalCodec(), store = createPostgresRenewalStore(db.runtime,codec,async work => {
      const connection = await db.runtime.connect(); try { await connection.query('BEGIN');const result = await work(connection);await connection.query('COMMIT');return result; }
      catch (error) { await connection.query('ROLLBACK');throw error; } finally { connection.release(); }
    });
    const snapshot = (when: string,counter: number) => codec.freeze({ subscription_id: f.subscription,client_id: f.client,cadence_days: 28,template_version: 1,
      scheduled_at: when,currency_code: 'XXX',stock_source_key: source,settlement_channel_key: 'sandbox',authorization_ref: 'synthetic',payer_account_ref: null,
      unattended_charge_authorized_at: at,next_cycle_number: counter,paid_cycle_count: counter,activation_cycle_id: randomUUID(),activation_cycle_paid: true,
      delivery_admission: 'allowed',purchase_facts: { templateId: 'synthetic',shippingAmountMinor: 0,acquisitionRef: null },lines: [{ lineOrdinal: 1,sku,quantity: 1,unitAmountMinor: 100 }] },
    { subscriptionId: f.subscription,scheduledAt: when,scheduledInstant: Date.parse(when) });
    const frozen = snapshot(at,1), claim = await store.claimDue({ snapshot: frozen,workerId: 'fixture',now: at });
    const id = claim.cycleSnapshot.orderSnapshot.shippingAddressRef!;
    const immutable = (await destinations(f)).find(d => d.value.id === id)!;
    expect(immutable.value.address).toMatchObject({ savedAddressId: f.id,recipientName: null,line1: 'Saved Street 1' });
    await f.book.upsertAddress(f.principal,{ ...f.input,idempotencyKey: randomUUID(),addressId: f.id,line1: 'Future Street 2' });
    expect((await store.claimDue({ snapshot: frozen,workerId: 'fixture',now: at })).cycleSnapshot).toEqual(claim.cycleSnapshot);
    expect(await destinations(f)).toEqual([immutable]);
    await expect(select(f)).rejects.toMatchObject({ message: 'customer_self_service_payment_blocked' });
    await rpc('fulfillment_reserve_subscription_renewal',[claim.operationId,claim.claimToken,900,at]);
    const prepared = await rpc('commerce_prepare_subscription_renewal',[claim.operationId,claim.claimToken,at]);
    expect(await port().read('order',prepared.orderId)).toMatchObject({ destinationId: id,address: immutable.value.address });
    await rpc('commerce_acknowledge_subscription_renewal_attempt',[claim.operationId,claim.operationFingerprint,'synthetic-ack',at]);
    await rpc('commerce_record_subscription_renewal_outcome',[claim.operationId,randomUUID(),claim.operationFingerprint,'succeeded','synthetic-ack',null,at]);
    const next = (await db.owner.query('SELECT next_cycle_at FROM public.subscriptions WHERE id=$1', [f.subscription])).rows[0].next_cycle_at.toISOString();
    const future = await store.claimDue({ snapshot: snapshot(next,2),workerId: 'fixture',now: next });
    expect(future.cycleSnapshot.orderSnapshot.shippingAddressRef).not.toBe(id);
    expect((await destinations(f)).find(d => d.value.id === future.cycleSnapshot.orderSnapshot.shippingAddressRef)?.value.address).toMatchObject({ savedAddressId: f.id,line1: 'Future Street 2' });
    expect((await destinations(f)).find(d => d.value.id === id)).toEqual(immutable);
    expect(await port().read('order',prepared.orderId)).toMatchObject({ destinationId: id,address: immutable.value.address });
  });
  it('keeps frozen null recipient data and lets the existing contact owner refuse carrier-incomplete dispatch without fallback', async () => {
    const f = await subject(), doc = await select(f).then(() => port().read('subscription',f.subscription)), order = randomUUID(), shipment = randomUUID();
    const purchase = await db.owner.connect();
    try { await purchase.query('BEGIN');
      await purchase.query("INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor,created_at,updated_at) VALUES($1,$2,'paid','XXX',100,$3,$3)", [order,f.client,at]);
      await purchase.query('INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,1,100,100)', [order]);
      await purchase.query('COMMIT');
    } catch (error) { await purchase.query('ROLLBACK');throw error; } finally { purchase.release(); }
    await db.owner.query('INSERT INTO public.commerce_destination_bindings(order_id,destination_id) VALUES($1,$2)', [order,doc.destinationId]);
    await db.owner.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES('fixture-port','3pl',true) ON CONFLICT DO NOTHING");
    await db.owner.query("INSERT INTO public.fulfillment_shipments(id,order_id,port_key,provider_type,create_idempotency_key) VALUES($1,$2,'fixture-port','3pl',$3)", [shipment,order,randomUUID()]);
    // The existing authoritative contact resolver is owner-only; keep its composition unchanged.
    const resolveContact = async () => (await db.migrator.query('SELECT public.fulfillment_resolve_parcel_contact($1) AS result', [shipment])).rows[0].result;
    const contact = await resolveContact(); expect(contact.recipientName).toBeNull(); expect(contact.contactPhone).toBe('+99123456789');
    const before = (await db.owner.query('SELECT to_jsonb(c) AS value,xmin::text FROM public.fulfillment_parcel_contacts c WHERE shipment_id=$1', [shipment])).rows;
    await db.owner.query("UPDATE public.clients SET first_name='Must not replace frozen null',phone='+99999999999' WHERE id=$1", [f.client]);
    await expect(resolveContact()).rejects.toMatchObject({ message: 'commerce_oms_replacement_delivery_contact_invalid' });
    expect((await db.owner.query('SELECT to_jsonb(c) AS value,xmin::text FROM public.fulfillment_parcel_contacts c WHERE shipment_id=$1', [shipment])).rows).toEqual(before);
    expect((await port().read('shipment',shipment)).address.recipientName).toBeNull();
    const connection = await db.owner.connect();
    try { for (const role of ['anon','authenticated']) { await connection.query(`SET ROLE ${role}`);
      await expect(connection.query('SELECT public.subscription_select_saved_shipping_address($1,$2,$3,$4,$5,$6)', [f.principal,f.client,randomUUID(),f.subscription,{ shippingAddressId: f.id },at])).rejects.toMatchObject({ code: '42501' });
      await connection.query('RESET ROLE'); } } finally { connection.release(); }
  });
});
