import { z } from 'zod';
export interface CustomerPreferencePolicy {
  messages?: { pickupPointRequired?: string };
  methods: { instant: string; card: string; transfer: string };
  providers: { warehouse: string; carrier: string; manual: string; simulator: string };
}
export function createCustomerPreferenceSchemas(policy: CustomerPreferencePolicy) {
  if (Object.keys(policy.methods).sort().join(',') !== 'card,instant,transfer' || Object.keys(policy.providers).sort().join(',') !== 'carrier,manual,simulator,warehouse') throw new Error('customer_preference_policy_invalid');
  for (const [values,count] of [[Object.values(policy.methods),3],[Object.values(policy.providers),4]] as const) {
    if (values.length !== count || new Set(values).size !== count || values.some(value => typeof value !== 'string' || !value.trim() || value !== value.trim())) throw new Error('customer_preference_policy_invalid');
  }
  const scope = z.enum(['one_time','subscription','any']);
  const pickup = z.object({ id: z.string().trim().min(1).max(80),name: z.string().trim().min(1).max(160),
    address: z.object({ line1: z.string().trim().min(1).max(160),postalCode: z.string().trim().min(3).max(16),city: z.string().trim().min(1).max(120),country: z.string().trim().length(2) }).strict().nullable().default(null) }).strict();
  const payment = z.object({ scope,methodKind: z.enum(Object.values(policy.methods)) }).strict();
  const delivery = z.object({ scope,deliveryKind: z.enum(['courier','parcel-locker']),providerKind: z.enum(Object.values(policy.providers)),
    carrierKind: z.string().trim().min(2).max(40),carrierCode: z.string().trim().min(1).max(80),serviceCode: z.string().trim().min(1).max(120),pickupPoint: pickup.nullable().default(null) }).strict()
    .superRefine((v,ctx) => { if (v.deliveryKind === 'parcel-locker' && !v.pickupPoint) ctx.addIssue({ code: 'custom',message: policy.messages?.pickupPointRequired ?? 'Pickup point required',path: ['pickupPoint'] }); });
  return { payment,delivery,paymentResponse: payment.extend({ lastSelectedAt: z.iso.datetime({ offset: true }) }),deliveryResponse: delivery.safeExtend({ lastSelectedAt: z.iso.datetime({ offset: true }) }) };
}
