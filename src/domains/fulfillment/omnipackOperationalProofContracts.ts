import { z } from "../../lib/validation/zod.js";

const dateTimeStringSchema = z.string().datetime({ offset: true });
const nullableDateTimeStringSchema = dateTimeStringSchema.nullable();
const countSchema = z.number().int().nonnegative();

export const adminOmnipackOperationalProofWebhookSchema = z.object({
  route: z.string().min(1),
  lastReceivedAt: nullableDateTimeStringSchema,
  lastProcessedAt: nullableDateTimeStringSchema,
  failedCount: countSchema,
  ignoredCount: countSchema,
});

export const adminOmnipackOperationalProofResponseSchema = z.object({
  generatedAt: dateTimeStringSchema,
  ok: z.boolean(),
  blockers: z.array(z.string().min(1)),
  webhooks: z.object({
    routes: z.array(adminOmnipackOperationalProofWebhookSchema),
    failedInboundEvents: countSchema,
    ignoredInboundEvents: countSchema,
  }),
  reconciliation: z.object({
    lastReconciledAt: nullableDateTimeStringSchema,
    statusEvidenceCount: countSchema,
    quarantineCount: countSchema,
  }),
  stockSync: z.object({
    status: z.string().min(1).nullable(),
    lastStockSyncedAt: nullableDateTimeStringSchema,
    staleProviderStockSkuCount: countSchema,
    reservationCoverageCount: countSchema.optional(),
    unknownStockSkuCount: countSchema.optional(),
    // Compatibility-only projection for responses recorded before stock truth v2.
    providerLocalMismatchSkuCount: countSchema.optional(),
  }),
  fulfillment: z.object({
    consumedReservationGapCount: countSchema,
    sampleFulfillmentOrderIds: z.array(z.string().min(1)),
  }),
});

export type AdminOmnipackOperationalProofResponse = z.infer<
  typeof adminOmnipackOperationalProofResponseSchema
>;
