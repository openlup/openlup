import { z } from "../../lib/validation/zod.js";
import {
  datetimeSchema,
  nullableTextSchema,
  omsFulfillmentStatusSchema,
  omsInventoryStatusSchema,
  omsProviderOpsSlaStatusSchema,
  omsSubscriptionCycleStatusSchema,
  uuidSchema,
} from "./omsContractBase.js";
import { omsProviderEvidenceSchema } from "./omsProviderEvidenceSchemas.js";

export const omsProviderOpsSlaSchema = z.object({
  status: omsProviderOpsSlaStatusSchema,
  dispatchedAt: datetimeSchema.nullable(),
  deadlineAt: datetimeSchema.nullable(),
  remainingOperationalMinutes: z.number().int().min(0).nullable(),
}).strict();

export const omsFulfillmentTrackingReferenceSchema = z.object({
  providerKind: z.string().min(1),
  trackingNumber: z.string().min(1),
  trackingUrl: nullableTextSchema,
  carrierKind: nullableTextSchema,
  service: nullableTextSchema,
  updatedAt: datetimeSchema.nullable(),
}).strict();

export const omsFulfillmentTimelineEventSchema = z.object({
  eventType: z.string().min(1),
  label: z.string().min(1),
  occurredAt: datetimeSchema.nullable(),
  source: z.enum(["webhook", "reconciliation", "manual", "simulator", "fulfillment", "dispatch", "provider"]),
}).strict();

export const omsSubscriptionContextSchema = z.object({
  subscriptionId: uuidSchema.nullable(),
  subscriptionCycleId: uuidSchema.nullable(),
  subscriptionCycleStatus: omsSubscriptionCycleStatusSchema.nullable(),
  // Operator-facing dates. `nextCycleAt` is `subscriptions.next_cycle_at` (the
  // next CHARGE instant, not a delivery date); `cyclePaidAt` is this cycle's
  // `subscription_cycles.paid_at`. Both nullable: `commerce_orders` has no
  // `paid_at`, so one-time orders carry neither.
  nextCycleAt: datetimeSchema.nullable(),
  cyclePaidAt: datetimeSchema.nullable(),
});

export const omsInventorySummarySchema = z.object({
  status: omsInventoryStatusSchema,
  reservationId: uuidSchema.nullable(),
  reservationStatus: z.enum(["reserved", "released", "consumed", "expired"]).nullable(),
  expiresAt: datetimeSchema.nullable(),
  locationId: uuidSchema.nullable(),
  locationCode: z.string().nullable(),
});

export const omsFulfillmentSummarySchema = z.object({
  fulfillmentOrderId: uuidSchema.nullable(),
  status: omsFulfillmentStatusSchema.nullable(),
  providerKind: nullableTextSchema.default(null),
  latestOperationType: z.string().min(1).nullable(),
  latestOperationAt: datetimeSchema.nullable(),
  providerTrackingId: z.string().min(1).nullable(),
  trackingUrl: nullableTextSchema.default(null),
  carrierKind: nullableTextSchema.default(null),
  service: nullableTextSchema.default(null),
  trackingReferences: z.array(omsFulfillmentTrackingReferenceSchema).default([]),
  trackingTimeline: z.array(omsFulfillmentTimelineEventSchema).default([]),
  providerEvidence: z.array(omsProviderEvidenceSchema).optional().default([]),
});

/**
 * The order's replacement chain, detail-only.
 *
 * ⛔ This is NOT a second fulfilment summary. `fulfillment` stays exactly what W3 collapsed it
 * to - one row, the parcel currently representing the order, with every companion narrowed to
 * that parcel's id. Widening those companions was measured and rejected: the dispatch refs,
 * provider attempts and status evidence of a superseded parcel would then be read by the
 * fulfilment health classifier, the fulfilment debug panel and the customer-step derivation,
 * each of which would answer for the wrong parcel - a dispatch status of `created` for a
 * replacement that has never been dispatched, or a customer step of `delivered` for a parcel
 * that is still `created`.
 *
 * So the superseded parcels carry their own, deliberately small payload: what a support agent
 * needs to answer "where did the first one go?" and to file a carrier claim. Tracking number,
 * carrier, service, the two handover instants, and the parcel's own status.
 */
export const omsSupersededParcelSchema = z.object({
  fulfillmentOrderId: uuidSchema,
  sequenceNo: z.number().int().min(0),
  status: omsFulfillmentStatusSchema.nullable(),
  replacementReason: nullableTextSchema.default(null),
  handedOverAt: datetimeSchema.nullable(),
  deliveredAt: datetimeSchema.nullable(),
  trackingReferences: z.array(omsFulfillmentTrackingReferenceSchema).default([]),
}).strict();

export const omsReplacementChainSchema = z.object({
  // `sequenceNo` 0 is the ordinary order: one parcel, no replacement, nothing to disclose.
  sequenceNo: z.number().int().min(0),
  replacesFulfillmentOrderId: uuidSchema.nullable(),
  replacementReason: nullableTextSchema.default(null),
  supersededParcels: z.array(omsSupersededParcelSchema).default([]),
}).strict();

export type OmsReplacementChain = z.infer<typeof omsReplacementChainSchema>;

export const defaultOmsReplacementChain: OmsReplacementChain = {
  sequenceNo: 0,
  replacesFulfillmentOrderId: null,
  replacementReason: null,
  supersededParcels: [],
};
