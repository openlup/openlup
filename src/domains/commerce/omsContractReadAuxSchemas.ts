import { z } from "../../lib/validation/zod.js";
import { commerceMoneySchema } from "./contracts.js";
import { datetimeSchema, nullableTextSchema, uuidSchema } from "./omsContractBase.js";

export const omsPricingSummarySchema = z.object({
  subtotal: commerceMoneySchema,
  productDiscount: commerceMoneySchema,
  shipping: commerceMoneySchema,
  shippingDiscount: commerceMoneySchema,
  discountTotal: commerceMoneySchema,
  finalTotal: commerceMoneySchema,
  source: z.literal("order_columns"),
}).strict();

export const omsFirstSubscriptionPricePresentationSchema = z.object({
  catalogProducts: commerceMoneySchema,
  productDiscount: commerceMoneySchema,
  productPayable: commerceMoneySchema,
  shipping: commerceMoneySchema,
  shippingDiscount: commerceMoneySchema,
  shippingEffective: commerceMoneySchema,
  total: commerceMoneySchema,
  discountPercent: z.literal(50),
}).strict();

export const omsCommunicationDeliveryStatusSchema = z.enum([
  "planned",
  "queued",
  "blocked",
  "skipped",
  "processing",
  "sent",
  "delivered",
  "delivery_delayed",
  "bounced",
  "complained",
  "failed",
  "missed",
  "legacy_unlinked",
]);

export const omsCommunicationDeliverySchema = z.object({
  id: uuidSchema,
  purpose: z.string().min(1),
  templateSlug: z.string().min(1),
  triggerSource: z.string().min(1),
  triggerEvent: z.string().min(1),
  aggregateType: z.string().nullable(),
  aggregateId: z.string().nullable(),
  dedupeKey: z.string().min(1),
  status: omsCommunicationDeliveryStatusSchema,
  providerKind: z.string().nullable(),
  providerMessageId: z.string().nullable(),
  scheduledDueAt: datetimeSchema.nullable(),
  expectedSendAt: datetimeSchema.nullable(),
  queuedAt: datetimeSchema.nullable(),
  firstAttemptAt: datetimeSchema.nullable(),
  sentAt: datetimeSchema.nullable(),
  deliveredAt: datetimeSchema.nullable(),
  terminalAt: datetimeSchema.nullable(),
  lastErrorCode: z.string().nullable(),
  outboxEventId: uuidSchema.nullable(),
  platformJobRunId: uuidSchema.nullable(),
  emailSendId: uuidSchema.nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: datetimeSchema,
  updatedAt: datetimeSchema,
}).strict();

export const omsDeliverySelectionSchema = z.object({
  deliveryKind: z.enum(["courier", "parcel-locker"]),
  providerKind: nullableTextSchema,
  carrierKind: nullableTextSchema,
  carrierCode: nullableTextSchema,
  serviceCode: nullableTextSchema,
  pickupPoint: z
    .object({
      id: z.string().min(1),
      name: z.string().min(1),
      address: z
        .object({
          line1: z.string().min(1),
          postalCode: z.string().min(1),
          city: z.string().min(1),
          country: z.string().min(1),
        })
        .strict()
        .nullable(),
    })
    .strict()
    .nullable(),
  source: nullableTextSchema,
}).strict();

export const omsDeliveryContactSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.string().trim().min(1).max(80),
  revision: z.number().int().positive(),
  recipientName: nullableTextSchema,
  contactEmail: nullableTextSchema,
  contactPhone: nullableTextSchema,
  line1: nullableTextSchema,
  line2: nullableTextSchema,
  city: nullableTextSchema,
  postalCode: nullableTextSchema,
  country: nullableTextSchema,
  selectedDelivery: z.record(z.string(), z.unknown()).nullable(),
  deliveryInstructions: nullableTextSchema,
  courierInstructions: nullableTextSchema,
}).strict();

export const omsDeliveryContactResolutionSchema = z.object({
  resolutionVersion: z.literal(1),
  scope: z.enum(["baseline", "order_override", "parcel", "legacy_inferred", "missing"]),
  baseline: omsDeliveryContactSchema.nullable(),
  contact: omsDeliveryContactSchema.nullable(),
  contactDigest: z.string().regex(/^[0-9a-f]{32}$/).nullable(),
}).strict().superRefine((value, context) => {
  if (Boolean(value.contact) !== Boolean(value.contactDigest)) {
    context.addIssue({
      code: "custom",
      message: "contact and contactDigest must be present together",
      path: ["contactDigest"],
    });
  }
});

export const omsDeliveryContactProjectionSchema = z.object({
  baseline: omsDeliveryContactSchema.nullable(),
  effective: omsDeliveryContactSchema.nullable(),
  scope: z.enum(["baseline", "order_override", "parcel", "legacy_inferred", "missing"]),
  source: nullableTextSchema,
  revision: z.number().int().positive().nullable(),
  digest: z.string().regex(/^[0-9a-f]{32}$/).nullable(),
  frozen: z.boolean(),
  providerSubmissionState: z.enum([
    "not_materialized", "not_started", "draft", "submitting", "created", "uncertain",
    "failed", "cancel_requested", "cancelled", "unknown",
  ]),
  correctionAllowed: z.boolean(),
}).strict();
