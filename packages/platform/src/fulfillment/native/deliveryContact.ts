import { z } from 'zod';
import type { PgExecutor } from '../postgresDispatchStore.js';

// The native port carries the existing operator contact representation without
// depending on the commerce module or widening managed response schemas.
const text = z.string().nullable();
export const nativeDeliveryContactSchema = z.object({
  schemaVersion: z.literal(1), source: z.string().trim().min(1).max(80), revision: z.number().int().positive(),
  recipientName: text, contactEmail: text, contactPhone: text, line1: text, line2: text,
  city: text, postalCode: text, country: text, selectedDelivery: z.record(z.string(), z.unknown()).nullable(),
  deliveryInstructions: text, courierInstructions: text,
}).strict();
const scope = z.enum(['baseline','order_override','parcel','legacy_inferred','missing']);
const digest = z.string().regex(/^[0-9a-f]{32}$/).nullable();
export const nativeDeliveryContactResolutionSchema = z.object({ resolutionVersion: z.literal(1), scope,
  baseline: nativeDeliveryContactSchema.nullable(), contact: nativeDeliveryContactSchema.nullable(), contactDigest: digest,
}).strict().superRefine((value, context) => {
  if (Boolean(value.contact) !== Boolean(value.contactDigest)) context.addIssue({ code: 'custom', message: 'contact and contactDigest must be present together', path: ['contactDigest'] });
});
export const nativeDeliveryContactProjectionSchema = z.object({ baseline: nativeDeliveryContactSchema.nullable(), effective: nativeDeliveryContactSchema.nullable(),
  scope, source: text, revision: z.number().int().positive().nullable(), digest, frozen: z.boolean(),
  providerSubmissionState: z.enum(['not_materialized','not_started','draft','submitting','created','uncertain','failed','cancel_requested','cancelled','unknown']), correctionAllowed: z.boolean(),
}).strict();

/** Side-effect-free order read, including before the first shipment exists. */
export function createPostgresDeliveryContactReadPort(executor: PgExecutor) {
  return { async resolve(orderId: string) {
    const { rows } = await executor.query('SELECT public.commerce_oms_resolve_delivery_contact_v1($1::uuid) AS value', [orderId]);
    return nativeDeliveryContactResolutionSchema.parse(rows[0]?.value);
  } };
}

export function nativeDeliveryContactProjection(resolution: z.infer<typeof nativeDeliveryContactResolutionSchema>, status: string,
  refs: { status: string; external_ref: string | null }[]): z.infer<typeof nativeDeliveryContactProjectionSchema> {
  const effectful = (ref: typeof refs[number]) => ref.status !== 'draft' || Boolean(ref.external_ref);
  const frozen = refs.some(effectful) || !['created','packed','label_pending'].includes(status);
  const ref = refs.find(effectful) ?? refs[0];
  const known = ['draft','submitting','created','uncertain','failed','cancel_requested','cancelled'] as const;
  const providerSubmissionState = ref ? known.find(status => status === ref.status) ?? 'unknown' : 'not_started';
  const effective = normalizedContact(resolution.contact);
  return { baseline: normalizedContact(resolution.baseline), effective, scope: resolution.scope, source: effective?.source ?? null,
    revision: effective?.revision ?? null, digest: effective ? resolution.contactDigest : null,
    frozen, providerSubmissionState, correctionAllowed: Boolean(effective && resolution.contactDigest) && !frozen };
}

function normalizedContact(value: z.infer<typeof nativeDeliveryContactSchema> | null) {
  if (!value) return null;
  const nullable = (text: string | null) => text?.trim() || null;
  return { ...value, source: value.source.trim(), recipientName: nullable(value.recipientName),
    contactEmail: nullable(value.contactEmail), contactPhone: nullable(value.contactPhone),
    line1: nullable(value.line1), line2: nullable(value.line2), city: nullable(value.city),
    postalCode: nullable(value.postalCode), country: nullable(value.country),
    deliveryInstructions: nullable(value.deliveryInstructions), courierInstructions: nullable(value.courierInstructions) };
}
