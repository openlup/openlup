import { z } from 'zod';
import type { EcommerceEvent, EcommerceEventExportRequest } from './contracts/ecommerceEvents.js';
export const ECOMMERCE_EXPORT_EVENT_TYPE = 'communication.ecommerce.export.v1';
const ref = z.string().min(1).max(180), uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const base = { schemaVersion: z.literal(1), sourceId: ref, occurredAt: timestamp,
  subject: z.object({ clientId: uuid }).strict() };
const subscription = z.object({ ...base, sourceType: z.enum(['subscription.created', 'subscription.paused', 'subscription.resumed', 'subscription.cancelled']),
  data: z.object({ subscriptionId: uuid }).strict() }).strict();
export const ecommerceEventSchema: z.ZodType<EcommerceEvent> = z.union([
  z.object({ ...base, sourceType: z.literal('order.paid'), data: z.object({ orderId: uuid,
    settlementIntentId: uuid, purchaseKind: z.enum(['one_time', 'subscription_initial', 'renewal']),
    amountMinor: money, currency: z.string().regex(/^[A-Z]{3}$/),
    lines: z.array(z.object({ sku: ref, quantity: z.number().int().positive().max(2147483647), amountMinor: money }).strict()).min(1).max(100) }).strict() }).strict(),
  z.object({ ...base, sourceType: z.literal('order.refund_status_changed'), data: z.object({ orderId: uuid, status: z.literal('refunded') }).strict() }).strict(),
  z.object({ ...base, sourceType: z.literal('checkout.recovery_qualified'), data: z.object({ orderId: uuid, expiresAt: timestamp }).strict() }).strict(),
  subscription,
]);
export const ecommerceEventExportRequestSchema: z.ZodType<EcommerceEventExportRequest> = z.object({
  binding: z.object({ account: ref, environment: ref, namespace: ref, mappingVersion: ref }).strict(),
  event: ecommerceEventSchema, subjectReference: ref, profileId: ref, generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  authorityReference: ref, classification: z.enum(['live', 'historical']),
  currencyExponent: z.number().int().min(0).max(6).optional(), currencyExponentSource: ref.optional(),
}).strict().superRefine((request, ctx) => {
  if (request.event.sourceType === 'order.paid' && (request.currencyExponent === undefined || !request.currencyExponentSource)) {
    ctx.addIssue({ code: 'custom', message: 'paid currency exponent provenance required' });
  }
});
