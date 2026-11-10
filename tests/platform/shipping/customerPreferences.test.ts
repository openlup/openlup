import type { CommerceCustomerDefaultsReadPort, CommerceCustomerDefaultsSnapshot } from '@openlup/platform/commerce/contracts';
import type { CustomerPreferenceScope } from '@openlup/platform/shipping/contracts';
import { expect,it,vi } from 'vitest';
import { createCustomerPreferenceSchemas,createCustomerPaymentPreferencesHandler,createCustomerDeliveryPreferencesHandler,createPostgresCustomerPreferencePort } from '@openlup/platform/shipping';
import { bffResponder } from '../../../server/_lib/bff/response.js';
import { preferencePolicy as policy,courierPreference,preferenceAt } from '../../postgres/customerPreferences.fixture.js';
const id = 'e4000000-0000-4000-8000-000000000001';
const schemas = () => createCustomerPreferenceSchemas(policy);
it('pins closed families, strict envelopes and exact pickup/carrier bounds',() => {
 const s = schemas();expect(s.payment.safeParse({ scope: 'any',methodKind: 'card',secret: 'ignored' }).success).toBe(false);
 expect(s.delivery.parse({ ...courierPreference,carrierCode: ' trim ' }).carrierCode).toBe('trim');
 for (const input of [{ ...courierPreference,carrierKind: 'x' },{ ...courierPreference,carrierCode: 'x'.repeat(81) },{ ...courierPreference,serviceCode: 'x'.repeat(121) },{ ...courierPreference,providerKind: 'other' },{ ...courierPreference,deliveryKind: 'parcel-locker',pickupPoint: null }]) expect(s.delivery.safeParse(input).success).toBe(false);
 expect(s.delivery.safeParse({ ...courierPreference,deliveryKind: 'parcel-locker',pickupPoint: { id: 'point',name: 'Point',address: null } }).success).toBe(true);
 expect(() => createCustomerPreferenceSchemas({ ...policy,methods: { ...policy.methods,extra: 'extra' } } as never)).toThrow('customer_preference_policy_invalid');
 expect(() => createCustomerPreferenceSchemas({ ...policy,providers: { ...policy.providers,carrier: policy.providers.warehouse } })).toThrow('customer_preference_policy_invalid');
});
function response() { const res = { status: vi.fn(),json: vi.fn(),setHeader: vi.fn() };res.status.mockReturnValue(res);res.json.mockReturnValue(res);return res; }
for (const kind of ['payment','delivery'] as const) it(`binds ${kind} GET/PATCH, authentication, refusal and response validation`,async () => {
 const port = createPostgresCustomerPreferencePort({ query: async () => ({ rows: [] }) },{ principalId: id,clientId: id },policy,{ now: () => preferenceAt,readOrdererHints: async () => [] });
 const defaults: CommerceCustomerDefaultsReadPort<CommerceCustomerDefaultsSnapshot<CustomerPreferenceScope,string>> = port;
 expect(defaults.getCustomerDefaultsSnapshot).toBe(port.getCustomerDefaultsSnapshot);
 const payment = { scope: 'any' as const,methodKind: 'card',lastSelectedAt: preferenceAt },delivery = { ...courierPreference,lastSelectedAt: preferenceAt };
 vi.spyOn(port,'listPaymentPreferences').mockResolvedValue([payment]);vi.spyOn(port,'listDeliveryPreferences').mockResolvedValue([delivery]);
 vi.spyOn(port,'upsertPaymentPreference').mockResolvedValue(payment);vi.spyOn(port,'upsertDeliveryPreference').mockResolvedValue(delivery);
 let allowed = true; const options = { port,policy,authenticateUser: async () => allowed ? { ok: true as const,userId: id } : { ok: false as const,code: 'UNAUTHORIZED' as const,message: 'Denied' },responder: bffResponder,messages: { authentication: 'Authentication failed',unlinked: 'Unlinked',invalid: 'Invalid',upstream: 'Unavailable',invalidResponse: 'Invalid response' } };
 const handler = (kind === 'payment' ? createCustomerPaymentPreferencesHandler : createCustomerDeliveryPreferencesHandler)(options);
 const get = response();await handler({ method: 'GET',query: { userId: 'planted' } } as never,get as never);expect(get.status).toHaveBeenCalledWith(200);
 const patch = response();await handler({ method: 'PATCH',body: kind === 'payment' ? { scope: 'any',methodKind: 'card' } : courierPreference } as never,patch as never);expect(patch.status).toHaveBeenCalledWith(200);
 const invalid = response();await handler({ method: 'PATCH',body: {} } as never,invalid as never);expect(invalid.status).toHaveBeenCalledWith(400);
 const method = response();await handler({ method: 'DELETE' } as never,method as never);expect(method.status).toHaveBeenCalledWith(405);
 allowed = false;const denied = response();await handler({ method: 'GET' } as never,denied as never);expect(denied.status).toHaveBeenCalledWith(401);
});
