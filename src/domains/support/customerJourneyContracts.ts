import { z } from "../../lib/validation/zod.js";

export const CUSTOMER_JOURNEY_CONTRACT_VERSION = "support.customer_journey.v1" as const;
export const SUPPORT_CUSTOMER_JOURNEY_CONTRACT_VERSION = CUSTOMER_JOURNEY_CONTRACT_VERSION;

const uuidSchema = z.guid();
const datetimeSchema = z.string().datetime({ offset: true }).nullable();
const lookupTextSchema = z.string().trim().min(1).max(320);
const unknownRecordSchema = z.record(z.string(), z.unknown());

export const customerJourneyLookupRequestSchema = z
  .object({
    query: lookupTextSchema.optional(),
    orderId: uuidSchema.optional(),
    orderNumber: z.string().trim().min(1).max(80).optional(),
    trackingNumber: z.string().trim().min(1).max(160).optional(),
    subscriptionId: uuidSchema.optional(),
    clientId: uuidSchema.optional(),
    email: z.string().trim().toLowerCase().email().max(320).optional(),
    pageSize: z.coerce.number().int().positive().max(25).default(10),
    limit: z.coerce.number().int().positive().max(25).optional(),
    mode: z.enum(["search", "snapshot"]).optional(),
  })
  .strict()
  .refine(
    (value) =>
      Boolean(
        value.query ||
          value.orderId ||
          value.orderNumber ||
          value.trackingNumber ||
          value.subscriptionId ||
          value.clientId ||
          value.email,
      ),
    "At least one lookup key is required",
  );

export const customerJourneyGapSchema = z
  .object({
    code: z.string().min(1).max(120),
    severity: z.enum(["info", "warning", "critical"]),
    explanation: z.string().min(1).max(500),
    nextRead: z.string().min(1).max(300),
  })
  .strict();

export const customerJourneyTimelineEventSchema = z
  .object({
    occurredAt: datetimeSchema,
    kind: z.string().min(1).max(120),
    label: z.string().min(1).max(300),
    source: z.string().min(1).max(120).nullable(),
    entityRef: unknownRecordSchema,
  })
  .strict();

const journeyLookupSchema = z
  .object({
    query: z.string().max(320),
    matchedBy: z.string().min(1).max(80).nullable(),
    confidence: z.string().min(1).max(80),
    warnings: z.array(z.string().min(1).max(300)),
  })
  .strict();

export const customerJourneySearchResultSchema = z
  .object({
    contractVersion: z.literal(CUSTOMER_JOURNEY_CONTRACT_VERSION),
    query: z.string().max(320),
    candidates: z.array(
      z
        .object({
          matchedBy: z.string().min(1).max(80).nullable(),
          confidence: z.string().min(1).max(80),
          clientId: uuidSchema.nullable(),
          email: z.string().email().max(320).nullable(),
          name: z.string().max(240).nullable(),
          orderId: uuidSchema.nullable(),
          orderNumber: z.string().max(80).nullable(),
          subscriptionId: uuidSchema.nullable(),
          trackingNumber: z.string().max(160).nullable(),
          status: z.string().max(120).nullable(),
          lastActivityAt: datetimeSchema,
          snapshotLookup: unknownRecordSchema,
        })
        .strict(),
    ),
    warnings: z.array(z.string().min(1).max(300)),
  })
  .strict();

export const customerJourneySnapshotResponseSchema = z
  .object({
    contractVersion: z.literal(CUSTOMER_JOURNEY_CONTRACT_VERSION),
    lookup: journeyLookupSchema,
    customer: z
      .object({
        clientId: uuidSchema.nullable(),
        email: z.string().email().max(320).nullable(),
        name: z.string().max(240).nullable(),
        authUserLinked: z.boolean(),
        lifecycleStage: z.string().max(120).nullable(),
      })
      .strict(),
    firstTrace: z
      .object({
        kind: z.string().max(120).nullable(),
        source: z.string().max(120).nullable(),
        occurredAt: datetimeSchema,
        sourceRef: unknownRecordSchema,
      })
      .strict(),
    checkout: z
      .object({
        orderDrafts: z.array(unknownRecordSchema),
        recoveryTokens: z.array(unknownRecordSchema),
        abandonedCartEvents: z.array(unknownRecordSchema),
      })
      .strict(),
    payment: z
      .object({
        status: z.string().max(120).nullable(),
        intents: z.array(unknownRecordSchema),
        attempts: z.array(unknownRecordSchema),
        transitions: z.array(unknownRecordSchema),
        providerRefs: z.array(unknownRecordSchema),
      })
      .strict(),
    orders: z.array(
      z
        .object({
          orderId: uuidSchema,
          orderNumber: z.string().max(80).nullable(),
          mode: z.string().max(80).nullable(),
          status: z.string().max(80).nullable(),
          customerStep: z.string().max(80),
          customerLabel: z.string().max(160),
          customerAccountProjection: unknownRecordSchema,
          omsProjection: unknownRecordSchema,
          fulfillment: unknownRecordSchema,
          communications: z.array(unknownRecordSchema),
          providerEvidence: z.array(unknownRecordSchema),
          gaps: z.array(customerJourneyGapSchema),
        })
        .strict(),
    ),
    subscriptions: z.array(
      z
        .object({
          subscriptionId: uuidSchema,
          status: z.string().max(120).nullable(),
          nextCycleAt: datetimeSchema,
          templateVersion: z.number().int().min(1).nullable(),
          editBlockedReason: z.string().max(160).nullable(),
          paymentMethodStatus: z.string().max(120).nullable(),
          cycles: z.array(unknownRecordSchema),
          renewalOrders: z.array(unknownRecordSchema),
          renewalCommunications: z.array(unknownRecordSchema),
          gaps: z.array(customerJourneyGapSchema),
        })
        .strict(),
    ),
    timeline: z.array(customerJourneyTimelineEventSchema),
    gaps: z.array(customerJourneyGapSchema),
    nextChecks: z.array(z.string().min(1).max(300)),
  })
  .strict();

export type CustomerJourneyLookupRequest = z.infer<typeof customerJourneyLookupRequestSchema>;
export type CustomerJourneyGap = z.infer<typeof customerJourneyGapSchema>;
export type CustomerJourneyTimelineEvent = z.infer<typeof customerJourneyTimelineEventSchema>;
export type CustomerJourneySearchResult = z.infer<typeof customerJourneySearchResultSchema>;
export type CustomerJourneySnapshotResponse = z.infer<typeof customerJourneySnapshotResponseSchema>;
