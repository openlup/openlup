import type { HttpRequest, HttpResponse } from '../http/index.js';
import type { BffResponder } from '../bff/index.js';
import { createCustomerPreferenceSchemas, type CustomerPreferencePolicy } from './customerPreferenceSchemas.js';
import type { createPostgresCustomerPreferencePort } from './postgresCustomerPreferences.js';
export interface CustomerPreferenceHandlerOptions {
  port: ReturnType<typeof createPostgresCustomerPreferencePort>;
  policy: CustomerPreferencePolicy;
  authenticateUser(req: HttpRequest): Promise<{ ok: true; userId: string } | { ok: false; code: 'UNAUTHORIZED' | 'FORBIDDEN'; message: string }>;
  responder: BffResponder;
  messages: { authentication: string; unlinked: string; invalid: string; upstream: string; invalidResponse: string };
}
function handler(options: CustomerPreferenceHandlerOptions, kind: 'payment' | 'delivery') {
  const schemas = createCustomerPreferenceSchemas(options.policy),r = options.responder;
  return async (req: HttpRequest,res: HttpResponse): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'PATCH') { r.sendMethodNotAllowed(res,['GET','PATCH']);return; }
    let auth: Awaited<ReturnType<typeof options.authenticateUser>>;
    try { auth = await options.authenticateUser(req); } catch { r.sendBffError(res,'UPSTREAM_UNAVAILABLE',options.messages.authentication);return; }
    if (!auth.ok) { r.sendBffError(res,auth.code,auth.message);return; }
    try {
      const version = kind === 'payment' ? 'customer.preferences.v1' : 'customer.delivery_preferences.v1';
      let value: unknown;
      if (req.method === 'GET') value = kind === 'payment' ? await options.port.listPaymentPreferences(auth.userId) : await options.port.listDeliveryPreferences(auth.userId);
      else if (kind === 'payment') { const input = schemas.payment.safeParse(req.body);if (!input.success) { r.sendBffError(res,'BAD_REQUEST',options.messages.invalid);return; }value = await options.port.upsertPaymentPreference(auth.userId,input.data); }
      else { const input = schemas.delivery.safeParse(req.body);if (!input.success) { r.sendBffError(res,'BAD_REQUEST',options.messages.invalid);return; }value = await options.port.upsertDeliveryPreference(auth.userId,input.data); }
      if (value === null) { r.sendBffError(res,'FORBIDDEN',options.messages.unlinked);return; }
      const schema = kind === 'payment' ? schemas.paymentResponse : schemas.deliveryResponse;
      const valid = req.method === 'GET' ? schema.array().safeParse(value) : schema.safeParse(value);
      if (!valid.success) { r.sendBffError(res,'INVALID_RESPONSE',options.messages.invalidResponse);return; }
      r.sendBffSuccess(res,{ contractVersion: version,...(req.method === 'GET' ? { preferences: valid.data } : { preference: valid.data }) });
    } catch { r.sendBffError(res,'UPSTREAM_UNAVAILABLE',options.messages.upstream); }
  };
}
export const createCustomerPaymentPreferencesHandler = (options: CustomerPreferenceHandlerOptions) => handler(options,'payment');
export const createCustomerDeliveryPreferencesHandler = (options: CustomerPreferenceHandlerOptions) => handler(options,'delivery');
