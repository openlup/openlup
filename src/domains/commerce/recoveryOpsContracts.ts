import { z } from "../../lib/validation/zod.js";
import { COMMERCE_CONTRACT_VERSION } from "./types.js";

export const paidFulfillmentRecoveryActionSchema = z.enum([
  "wait_for_outbox",
  "requeue_discarded_order_paid_outbox",
  "inspect_processed_without_effect",
  "inspect_missing_order_paid_outbox",
  "monitor_dispatch",
  "inspect_missing_dispatch_ref",
  "inspect_stale_dispatch_submission",
  "inspect_uncertain_dispatch",
  "inspect_failed_dispatch",
  "inspect_created_dispatch_without_provider_order_id",
  "inspect_terminal_dispatch",
  "inspect_unknown_dispatch_status",
]);

export const paidFulfillmentRecoveryReasonSchema = z.enum([
  "paid_order_without_fulfillment_order",
  "order_paid_outbox_missing",
  "order_paid_outbox_discarded",
  "order_paid_outbox_processed_without_fulfillment",
  "omnipack_dispatch_in_progress",
  "omnipack_fulfillment_without_dispatch_ref",
  "omnipack_dispatch_submission_stale",
  "omnipack_dispatch_outcome_uncertain",
  "omnipack_dispatch_failed",
  "omnipack_dispatch_created_without_provider_order_id",
  "omnipack_dispatch_terminal_without_progress",
  "omnipack_dispatch_status_unknown",
]);

export const paidFulfillmentRecoveryPostureSchema = z.enum([
  "automatic_local_requeue_safe",
  "wait_for_existing_automation",
  "operator_review_required",
]);

export const adminPaidFulfillmentRecoveryPreviewRequestSchema = z.object({
  operation: z.literal("preview"),
  orderIds: z.array(z.string().uuid()).max(50).optional().default([]),
  minimumAgeSeconds: z.coerce.number().int().min(60).max(7 * 24 * 60 * 60).default(30 * 60),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const adminPaidFulfillmentRecoveryExecuteRequestSchema = z.object({
  operation: z.literal("execute"),
  action: z.literal("requeue_discarded_order_paid_outbox"),
  eventIds: z.array(z.string().uuid()).min(1).max(50),
  orderIds: z.array(z.string().uuid()).max(50).optional().default([]),
  reason: z.string().trim().min(8).max(240),
  minimumAgeSeconds: z.coerce.number().int().min(60).max(7 * 24 * 60 * 60).default(30 * 60),
});

export const adminPaidFulfillmentRecoveryRequestSchema = z.discriminatedUnion("operation", [
  adminPaidFulfillmentRecoveryPreviewRequestSchema,
  adminPaidFulfillmentRecoveryExecuteRequestSchema,
]);

export const adminPaidFulfillmentRecoveryCandidateSchema = z.object({
  orderId: z.string().uuid(),
  orderStatus: z.string(),
  orderMode: z.string().nullable(),
  fulfillmentOrderId: z.string().uuid().nullable(),
  providerKind: z.string().nullable(),
  dispatchRefId: z.string().uuid().nullable().optional(),
  dispatchStatus: z.string().nullable().optional(),
  outboxEventId: z.string().uuid().nullable(),
  outboxStatus: z.string().nullable(),
  outboxAttempts: z.number().int().nullable(),
  reason: paidFulfillmentRecoveryReasonSchema,
  recommendedAction: paidFulfillmentRecoveryActionSchema,
  recoveryPosture: paidFulfillmentRecoveryPostureSchema,
  ageSeconds: z.number().int().nonnegative(),
});

export const adminPaidFulfillmentRecoveryPreviewResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  checkedOrders: z.number().int().nonnegative(),
  candidates: z.array(adminPaidFulfillmentRecoveryCandidateSchema),
});

export const adminPaidFulfillmentRecoveryExecuteResponseSchema = z.object({
  contractVersion: z.literal(COMMERCE_CONTRACT_VERSION),
  action: z.literal("requeue_discarded_order_paid_outbox"),
  requeuedCount: z.number().int().nonnegative(),
  eventIds: z.array(z.string().uuid()),
});

export type AdminPaidFulfillmentRecoveryRequest = z.infer<typeof adminPaidFulfillmentRecoveryRequestSchema>;
export type AdminPaidFulfillmentRecoveryPreviewRequest = z.infer<typeof adminPaidFulfillmentRecoveryPreviewRequestSchema>;
export type AdminPaidFulfillmentRecoveryExecuteRequest = z.infer<typeof adminPaidFulfillmentRecoveryExecuteRequestSchema>;
export type AdminPaidFulfillmentRecoveryCandidate = z.infer<typeof adminPaidFulfillmentRecoveryCandidateSchema>;
export type AdminPaidFulfillmentRecoveryPreviewResponse = z.infer<typeof adminPaidFulfillmentRecoveryPreviewResponseSchema>;
export type AdminPaidFulfillmentRecoveryExecuteResponse = z.infer<typeof adminPaidFulfillmentRecoveryExecuteResponseSchema>;
