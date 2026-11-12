import { z } from 'zod';
import type { SavedAddressQueryExecutor, CustomerSavedAddressScope } from './postgresAddressBook.js';
import { createCustomerPreferenceSchemas, type CustomerPreferencePolicy } from './customerPreferenceSchemas.js';
import type { CustomerPaymentPreferenceInput, CustomerDeliveryPreferenceInput, CustomerPaymentPreference, CustomerDeliveryPreference, CustomerPreferenceScope, CustomerPreferenceDefaultsSnapshot } from './contracts/preferences.js';
type Row = Record<string, unknown>;
/** Closed canonical families are mapped bijectively to adopter-owned public values. */
export function createPostgresCustomerPreferencePort(db: SavedAddressQueryExecutor, scope: CustomerSavedAddressScope, policy: CustomerPreferencePolicy, options: {
  now(): string; readOrdererHints(clientId: string): Promise<{ id: string; isDefault: boolean }[]>;
}) {
  const schemas = createCustomerPreferenceSchemas(policy);
  if (typeof options.readOrdererHints !== 'function') throw new Error('customer_preference_billing_reader_required');
  const verify = (id: string) => { if (id.toLowerCase() !== scope.principalId.toLowerCase()) throw new Error('customer_preference_scope_mismatch'); };
  const rpc = async (name: string, args: unknown[]) => (await db.query(`SELECT public.${name}(${args.map((_,i) => `$${i+1}`).join(',')}) AS value`,args)).rows[0]?.value;
  const read = async (id: string) => { verify(id); return await rpc('customer_preferences_read',[scope.principalId,scope.clientId]) as { payment: Row[]; delivery: Row[] } | null; };
  const payment = (r: Row): CustomerPaymentPreference => schemas.paymentResponse.parse({ scope: r.scope,methodKind: policy.methods[r.method_kind as keyof typeof policy.methods],lastSelectedAt: r.last_selected_at });
  const delivery = (r: Row): CustomerDeliveryPreference => schemas.deliveryResponse.parse({ scope: r.scope,deliveryKind: r.delivery_kind,providerKind: r.provider_ref,carrierKind: r.carrier_kind,carrierCode: r.carrier_code,serviceCode: r.service_code,
    pickupPoint: r.pickup_point_id ? { id: r.pickup_point_id,name: r.pickup_point_name ?? r.pickup_point_id,address: r.pickup_point_address ?? null } : null,lastSelectedAt: r.last_selected_at });
  const family = (map: Record<string,string>, value: string) => Object.keys(map).find(key => map[key] === value)!;
  return {
    async listPaymentPreferences(id: string) { const rows = await read(id); return rows ? rows.payment.map(payment) : null; },
    async listDeliveryPreferences(id: string) { const rows = await read(id); return rows ? rows.delivery.map(delivery) : null; },
    async upsertPaymentPreference(id: string,input: CustomerPaymentPreferenceInput) { verify(id);const value = schemas.payment.parse(input);
      const r = await rpc('customer_preference_save',[scope.principalId,scope.clientId,'payment',{ ...value,methodKind: family(policy.methods,value.methodKind) },options.now()]);return r ? payment(r as Row) : null; },
    async upsertDeliveryPreference(id: string,input: CustomerDeliveryPreferenceInput) { verify(id);const value = schemas.delivery.parse(input);
      const r = await rpc('customer_preference_save',[scope.principalId,scope.clientId,'delivery',{ ...value,providerFamily: family(policy.providers,value.providerKind) },options.now()]);return r ? delivery(r as Row) : null; },
    getCustomerDefaultsSnapshot: createPostgresCustomerDefaultsPort(db,{ clientId: scope.clientId },policy,options.readOrdererHints).getCustomerDefaultsSnapshot,
  };
}

/** Bind only a client ID established by the checkout/customer identity owner. Returns redacted hints only. */
export function createPostgresCustomerDefaultsPort(db: SavedAddressQueryExecutor, scope: { clientId: string }, policy: CustomerPreferencePolicy,
  readOrdererHints: (clientId: string) => Promise<{ id: string; isDefault: boolean }[]>) {
  createCustomerPreferenceSchemas(policy);
  z.guid().parse(scope.clientId);
  if (typeof readOrdererHints !== 'function') throw new Error('customer_preference_billing_reader_required');
  const options = { readOrdererHints };
  const rpc = async (name: string, args: unknown[]) => (await db.query(`SELECT public.${name}(${args.map((_,i) => `$${i+1}`).join(',')}) AS value`,args)).rows[0]?.value;
  return {
    async getCustomerDefaultsSnapshot(input: { clientId: string; checkoutKind: string }): Promise<CustomerPreferenceDefaultsSnapshot> {
      if (input.clientId.toLowerCase() !== scope.clientId.toLowerCase()) throw new Error('customer_preference_scope_mismatch');
      const [hints,orderers] = await Promise.all([rpc('customer_default_address_hints',[scope.clientId]),options.readOrdererHints(scope.clientId)]);
      const h = hints as { shipping: string | null; billing: string | null; payment: { scope: CustomerPreferenceScope; methodKind: keyof typeof policy.methods }[] };
      const p = h.payment.find(r => r.scope === (input.checkoutKind === 'subscription_initial' ? 'subscription' : 'one_time')) ?? h.payment.find(r => r.scope === 'any');
      const orderer = orderers.find(r => r.isDefault) ?? orderers[0];
      if (orderer) z.guid().parse(orderer.id);
      return { version: 'commerce.customer_defaults_snapshot.v1' as const,clientId: scope.clientId,
        payment: { available: Boolean(p),scope: p?.scope ?? null,methodKind: p ? policy.methods[p.methodKind] : null,source: 'customer_payment_preferences' as const,applied: false as const },
        addresses: { hasDefaultShippingAddress: Boolean(h.shipping),defaultShippingAddressId: h.shipping,hasDefaultBillingAddress: Boolean(h.billing),defaultBillingAddressId: h.billing,
          hasDefaultOrdererProfile: Boolean(orderer),defaultOrdererProfileId: orderer?.id ?? null,hasDeliveryNotes: false,hasCourierInstructions: false,source: 'customer_address_profiles' as const,applied: false as const },
        redactedFields: ['contact','orderer_profile','shipping_address','billing_address','delivery_notes','courier_instructions','payment_provider','payment_secret'] as ('contact'|'orderer_profile'|'shipping_address'|'billing_address'|'delivery_notes'|'courier_instructions'|'payment_provider'|'payment_secret')[] };
    },
  };
}
