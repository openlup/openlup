import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { createPostgresCustomerDefaultsPort } from '@openlup/platform/shipping';
import { createCustomerPreferencePrivacyContributor } from '@openlup/platform/identity';
import { installAccountMutations,type AccountProfile } from './customerAccountMutations.fixture.js';
import { preferencePolicy,preferenceAt as at,preferencePort,courierPreference } from './customerPreferences.fixture.js';
import { postgresSetupTimeoutMs,postgresTeardownTimeoutMs } from '../helpers/postgresContainer.js';
for (const profile of ['legacy','bootstrap','separate','admin-managed','admin-operator'] as AccountProfile[]) describe(`customer preferences on ${profile}`,() => {
 let db: Awaited<ReturnType<typeof installAccountMutations>>;
 beforeAll(async () => { db = await installAccountMutations(profile); },postgresSetupTimeoutMs);
 afterAll(async () => { await db?.close(); },postgresTeardownTimeoutMs);
 async function subject() { const principal = randomUUID(),client = randomUUID();
  await db.owner.query('INSERT INTO public.platform_human_principals(principal_id,email,created_at) VALUES($1,$2,$3)',[principal,`${principal}@example.invalid`,at]);
  await db.owner.query('INSERT INTO public.clients(id,principal_id,email,created_at,updated_at) VALUES($1,$2,$3,$4,$4)',[client,principal,`${client}@example.invalid`,at]);
  return { principal,client,port: preferencePort(db.runtime,principal,client) }; }
 const call = async (name: string,args: unknown[]) => (await db.runtime.query(`SELECT public.${name}(${args.map((_,i) => `$${i+1}`).join(',')}) AS value`,args)).rows[0].value;
 it('lists and upserts exact scopes without touching instruments or appending account events',async () => {
  const f = await subject(),other = await subject();
  const sub = randomUUID();
  await db.owner.query('INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES($1,$2,28,$3)',[sub,f.client,at]);
  await db.owner.query("INSERT INTO public.subscription_method_states(subscription_id,health_state,updated_at) VALUES($1,'healthy',$2)",[sub,at]);
  const instruments = (await db.owner.query('SELECT to_jsonb(m) AS row,xmin::text FROM public.subscription_method_states m ORDER BY subscription_id')).rows;
  for (const scope of ['one_time','subscription','any'] as const) {
   expect(await f.port.upsertPaymentPreference(f.principal,{ scope,methodKind: 'card' })).toMatchObject({ scope,methodKind: 'card',lastSelectedAt: at.replace('.000Z','+00:00') });
   await f.port.upsertDeliveryPreference(f.principal,{ ...courierPreference,scope });
  }
  await f.port.upsertPaymentPreference(f.principal,{ scope: 'subscription',methodKind: 'transfer' });
  expect(await f.port.listPaymentPreferences(f.principal)).toHaveLength(3);expect(await f.port.listDeliveryPreferences(f.principal)).toHaveLength(3);
  expect(await other.port.listPaymentPreferences(other.principal)).toEqual([]);
  await expect(f.port.listPaymentPreferences(other.principal)).rejects.toThrow('customer_preference_scope_mismatch');
  await expect(f.port.upsertPaymentPreference(f.principal,{ scope: 'any',methodKind: 'unknown' })).rejects.toThrow();
  await expect(f.port.upsertDeliveryPreference(f.principal,{ ...courierPreference,deliveryKind: 'parcel-locker',pickupPoint: null })).rejects.toThrow();
  await db.owner.query('UPDATE public.clients SET principal_id=NULL WHERE id=$1',[f.client]);
  expect(await f.port.listPaymentPreferences(f.principal)).toBeNull();expect(await f.port.upsertPaymentPreference(f.principal,{ scope: 'any',methodKind: 'card' })).toBeNull();
  expect((await db.owner.query('SELECT to_jsonb(m) AS row,xmin::text FROM public.subscription_method_states m ORDER BY subscription_id')).rows).toEqual(instruments);
  expect((await db.owner.query('SELECT 1 FROM public.customer_account_events WHERE client_id=$1',[f.client])).rows).toEqual([]);
 });
 it('preserves explicit selections; prefers complete subscription then any, skipping incomplete lockers',async () => {
  const f = await subject(),sub = randomUUID();await db.owner.query('INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES($1,$2,28,$3)',[sub,f.client,at]);
  const select = (metadata = {}) => call('customer_renewal_delivery_selection',[sub,metadata]);
  expect(await select()).toEqual({});
  await f.port.upsertDeliveryPreference(f.principal,{ ...courierPreference,scope: 'any',serviceCode: 'any' });
  await f.port.upsertDeliveryPreference(f.principal,{ ...courierPreference,deliveryKind: 'parcel-locker',serviceCode: 'locker',pickupPoint: { id: 'point-a',name: 'Point A',address: null } });
  expect(await select()).toMatchObject({ selectedDelivery: { serviceCode: 'any',pickupPoint: null } });
  await f.port.upsertDeliveryPreference(f.principal,{ ...courierPreference,deliveryKind: 'parcel-locker',serviceCode: 'locker',pickupPoint: { id: 'point-a',name: 'Point A',address: { line1: 'Example 1',postalCode: '12345',city: 'Example',country: 'ZZ' } } });
  expect(await select()).toMatchObject({ selectedDelivery: { serviceCode: 'locker',pickupPoint: { id: 'point-a' } } });
  for (const explicit of [{ selectedDelivery: null },{ selectedDelivery: { service: 'explicit' } },{ runtimeFinalize: { selectedDelivery: { service: 'explicit' } } }]) expect(await select(explicit)).toEqual(explicit);
 });
 it('falls back to the earliest qualifying anchor and leaves metadata unchanged for a non-object anchor',async () => {
  const f = await subject(),sub = randomUUID(),cycle = randomUUID();
  await db.owner.query('INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES($1,$2,28,$3)',[sub,f.client,at]);
  await db.owner.query('INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at) VALUES($1,$2,$3)',[cycle,sub,at]);
  const first = randomUUID();
  await db.owner.query('INSERT INTO public.commerce_orders(id,client_id,subscription_cycle_id,metadata,created_at) VALUES($1,$2,$3,$4,$5)',[first,f.client,cycle,{ runtimeFinalize: { selectedDelivery: { serviceCode: 'first-anchor' } } },at]);
  await db.owner.query('INSERT INTO public.commerce_orders(id,client_id,subscription_cycle_id,metadata,created_at) VALUES($1,$2,$3,$4,$5)',[randomUUID(),f.client,cycle,{ selectedDelivery: { serviceCode: 'later-anchor' } },'2026-11-12T00:00:00.000Z']);
  expect(await call('customer_renewal_delivery_selection',[sub,{ untouched: true }])).toEqual({ untouched: true,selectedDelivery: { serviceCode: 'first-anchor' } });
  await db.owner.query('UPDATE public.commerce_orders SET metadata=$2 WHERE id=$1',[first,{ selectedDelivery: null }]);
  expect(await call('customer_renewal_delivery_selection',[sub,{ untouched: true }])).toEqual({ untouched: true });
 });
 it('blocks leads with either preference table while an empty lead absorbs and replays',async () => {
  const f = await subject(),operator = randomUUID();
  await db.owner.query('INSERT INTO public.platform_human_principals(principal_id,email,created_at) VALUES($1,$2,$3)',[operator,`${operator}@example.invalid`,at]);
  await db.owner.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',$2)",[operator,at]);
  await db.owner.query('INSERT INTO public.platform_communication_operators(principal_id,active) VALUES($1,true)',[operator]);
  for (const kind of ['payment','delivery','empty']) {
   const lead = randomUUID();await db.owner.query("INSERT INTO public.clients(id,email,lifecycle_stage,created_at,updated_at) VALUES($1,$2,'lead',$3,$3)",[lead,`${lead}@example.invalid`,at]);
   if (kind === 'payment') await db.owner.query("INSERT INTO public.customer_payment_preferences(client_id,scope,method_kind) VALUES($1,'any','card')",[lead]);
   if (kind === 'delivery') await db.owner.query("INSERT INTO public.customer_delivery_preferences(client_id,scope,delivery_kind,provider_kind,provider_ref,carrier_kind,carrier_code,service_code) VALUES($1,'any','courier','warehouse','warehouse-a','carrier-a','courier-a','standard')",[lead]);
   const key = randomUUID(),absorb = () => call('customer_support_absorb_lead_v1',[operator,f.client,lead,`${lead}@example.invalid`,key,at]);
   const result = await absorb();if (kind === 'empty') { expect(result.outcome).toBe('applied');expect(await absorb()).toEqual({ ...result,outcome: 'replayed' }); }
   else expect(result).toMatchObject({ outcome: 'refused',refusalCode: 'lead_has_commercial_footprint',blockingTables: [`customer_${kind}_preferences`] });
  }
 });
 it('returns redacted unapplied hints through the trusted checkout client owner, including an unlinked client',async () => {
  const f = await subject();await f.port.upsertPaymentPreference(f.principal,{ scope: 'any',methodKind: 'instant' });await f.port.upsertPaymentPreference(f.principal,{ scope: 'subscription',methodKind: 'card' });
  const both = randomUUID(),shipping = randomUUID(),billingAddress = randomUUID();
  for (const [id,kind,isDefault,updated] of [[both,'both',true,at],[shipping,'shipping',false,'2026-11-12T00:00:00.000Z'],[billingAddress,'billing',true,'2026-11-13T00:00:00.000Z']]) {
   await db.owner.query('INSERT INTO public.customer_saved_addresses(id,client_id,kind,line1,city,postal_code,is_default,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,f.client,kind,'Private Street 1','Private City','12345',isDefault,at,updated]);
  }
  const billing = randomUUID(),defaults = createPostgresCustomerDefaultsPort(db.runtime,{ clientId: f.client },preferencePolicy,async () => [{ id: randomUUID(),isDefault: false },{ id: billing,isDefault: true }]);
  await db.owner.query('UPDATE public.clients SET principal_id=NULL WHERE id=$1',[f.client]);
  const value = await defaults.getCustomerDefaultsSnapshot({ clientId: f.client,checkoutKind: 'subscription_initial' });
  expect(value.payment).toMatchObject({ methodKind: 'card',applied: false });expect(value.addresses).toMatchObject({ defaultOrdererProfileId: billing,defaultShippingAddressId: both,defaultBillingAddressId: billingAddress,applied: false,hasDeliveryNotes: false });
  expect((await defaults.getCustomerDefaultsSnapshot({ clientId: f.client,checkoutKind: 'one_time' })).payment.methodKind).toBe('instant');
  expect(JSON.stringify(value)).not.toContain('Private');expect(value.redactedFields).toContain('payment_secret');expect(JSON.stringify(value)).not.toContain('warehouse-a');
  await expect(defaults.getCustomerDefaultsSnapshot({ clientId: randomUUID(),checkoutKind: 'one_time' })).rejects.toThrow('customer_preference_scope_mismatch');
 });
 it('classifies both private tables, denies browser/raw access and erases only the subject through explicit coverage',async () => {
  const f = await subject(),other = await subject();for (const s of [f,other]) { await s.port.upsertPaymentPreference(s.principal,{ scope: 'any',methodKind: 'card' });await s.port.upsertDeliveryPreference(s.principal,courierPreference); }
  const contributor = createCustomerPreferencePrivacyContributor(),privacySubject = { contactId: f.client,principalId: f.principal,identity: {} };
  const before = await call('customer_preferences_export',[other.client]);
  const exported = await contributor.export(db.migrator,privacySubject);expect(exported.coverage.complete).toBe(true);expect(exported.data).toMatchObject({ payment: [{ client_id: f.client }],delivery: [{ client_id: f.client }] });
  await contributor.prepareErasure(db.migrator);await db.owner.query('UPDATE public.clients SET principal_id=NULL WHERE id=$1',[f.client]);
  await contributor.eraseOrRetain(db.migrator,privacySubject,await contributor.assessErasure(db.migrator,privacySubject),{ principalId: randomUUID() });
  expect(await call('customer_preferences_export',[f.client])).toEqual({ payment: [],delivery: [] });expect(await call('customer_preferences_export',[other.client])).toEqual(before);
  for (const table of ['customer_payment_preferences','customer_delivery_preferences']) {
   expect((await db.owner.query('SELECT disposition FROM public.client_absorption_policy WHERE table_name=$1',[table])).rows).toEqual([{ disposition: 'block' }]);
   if (profile !== 'legacy') await expect(db.runtime.query(`SELECT scope FROM public.${table}`)).rejects.toMatchObject({ code: '42501' });
   const c = await db.owner.connect();try { for (const role of ['anon','authenticated']) { await c.query(`SET ROLE ${role}`);await expect(c.query(`SELECT * FROM public.${table}`)).rejects.toMatchObject({ code: '42501' });await c.query('RESET ROLE'); } }finally { c.release(); }
  }
 });
});
