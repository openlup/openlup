import { z } from "../../lib/validation/zod.js";
export { actionEligibilitySchema, commerceOrderModeSchema, datetimeSchema, nullableTextSchema, omsAttentionReasonSchema, omsFulfillmentBlockReasonSchema, omsFulfillmentStatusSchema, omsHoldReasonSchema, omsHoldStatusSchema, omsInventoryStatusSchema, omsNextActionSchema, omsOperationTypeSchema, omsPaymentAttemptStatusSchema, omsPaymentStatusSchema, omsProviderOpsSlaStatusSchema, omsSubscriptionCycleStatusSchema, uuidSchema } from "@openlup/platform/commerce";
export const omsProviderOpsStatusSchema = z.enum([
  "none",
  "omnipack_dispatched_not_picked",
  "omnipack_picked_not_shipped",
  "omnipack_dispatch_failed",
]);
export const omsAccountingStatusSchema = z.enum([
  "missing",
  "draft",
  "issue_requested",
  "blocked",
  "issued",
  "ksef_pending",
  "accepted",
  "rejected",
  "correction_requested",
  "corrected",
  "voided",
  "outbox_failed",
]);
