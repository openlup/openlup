import { z } from 'zod';
const methodKindPattern = /^[a-z][a-z0-9_]{1,63}$/;
export interface CustomerPreferencePolicy {
  messages?: { pickupPointRequired?: string };
  methods: Record<string, string>;
  providers: { warehouse: string; carrier: string; manual: string; simulator: string };
}
export function createCustomerPreferenceSchemas(policy: CustomerPreferencePolicy) {
  const methodKeys = Object.keys(policy.methods);
  if (methodKeys.length < 1 || methodKeys.length > 32
    || methodKeys.some(key => !methodKindPattern.test(key))
    || Object.keys(policy.providers).sort().join(',') !== 'carrier,manual,simulator,warehouse') {
    throw new Error('customer_preference_policy_invalid');
  }
  const methodValues = Object.values(policy.methods);
  const providerValues = Object.values(policy.providers);
  for (const [values,count] of [[methodValues,methodKeys.length],[providerValues,4]] as const) {
    if (values.length !== count || new Set(values).size !== count || values.some(value => typeof value !== 'string' || !value.trim() || value !== value.trim())) throw new Error('customer_preference_policy_invalid');
  }
  const scope = z.enum(['one_time','subscription','any']);
  const pickup = z.object({ id: z.string().trim().min(1).max(80),name: z.string().trim().min(1).max(160),
    address: z.object({ line1: z.string().trim().min(1).max(160),postalCode: z.string().trim().min(3).max(16),city: z.string().trim().min(1).max(120),country: z.string().trim().length(2) }).strict().nullable().default(null) }).strict();
  const methodEnum = z.enum(methodValues as [string, ...string[]]);
  const payment = z.object({ scope,methodKind: methodEnum }).strict();
  const paymentResponse = z.object({ scope,methodKind: z.union([methodEnum, z.string().regex(methodKindPattern)]),lastSelectedAt: z.iso.datetime({ offset: true }) }).strict();
  const delivery = z.object({ scope,deliveryKind: z.enum(['courier','parcel-locker']),providerKind: z.enum(providerValues as [string, ...string[]]),
    carrierKind: z.string().trim().min(2).max(40),carrierCode: z.string().trim().min(1).max(80),serviceCode: z.string().trim().min(1).max(120),pickupPoint: pickup.nullable().default(null) }).strict()
    .superRefine((v,ctx) => { if (v.deliveryKind === 'parcel-locker' && !v.pickupPoint) ctx.addIssue({ code: 'custom',message: policy.messages?.pickupPointRequired ?? 'Pickup point required',path: ['pickupPoint'] }); });
  return { payment,delivery,paymentResponse,deliveryResponse: delivery.safeExtend({ lastSelectedAt: z.iso.datetime({ offset: true }) }) };
}
