import { z } from "../../lib/validation/zod.js";
import { uuidSchema } from "./omsContractBase.js";

export const omsFulfillmentHealthSchema = z.object({
  healthStatus: z.enum(["ok", "needs_attention", "blocked_uncertain", "local_ahead", "provider_ahead", "missing_local_commitment"]),
  attentionReasons: z.array(z.enum([
    "paid_order_missing_fulfillment",
    "paid_order_missing_dispatch_ref",
    "dispatch_submission_stale",
    "dispatch_outcome_uncertain",
    "dispatch_failed",
    "dispatch_created_without_provider_order_id",
    "dispatch_terminal_without_progress",
    "dispatch_status_unknown",
    "provider_exception_after_delivery",
    "provider_exception_after_handover",
    "provider_exception_before_handover",
    "local_status_ahead_of_provider",
    "provider_accepted_local_label_ack_missing",
    "order_paid_outbox_discarded",
    "order_paid_outbox_processed_without_fulfillment",
    "order_paid_outbox_missing",
  ])),
  oldestAgeSeconds: z.number().int().nonnegative().nullable(),
  dispatchRefId: uuidSchema.nullable().optional(),
  dispatchStatus: z.string().nullable().optional(),
  opaqueIds: z.object({
    orderId: uuidSchema,
    fulfillmentOrderId: uuidSchema.nullable(),
    outboxEventId: uuidSchema.nullable(),
    dispatchRefFulfillmentOrderId: uuidSchema.nullable(),
    latestEvidenceFulfillmentOrderId: uuidSchema.nullable(),
  }).strict(),
}).strict();

// The list-row projection of the health snapshot above: the two fields an
// operator can act on, picked from the same schema so the vocabulary cannot
// fork. The list path builds it from the provider evidence it already fetches
// per page and never reads `outbox_events`, so a digest can never carry the
// three `order_paid_outbox_*` reasons - the builder is told the outbox is
// unread and answers `paid_order_missing_fulfillment` instead of naming an
// outbox row it did not look at. The enum stays whole rather than being
// narrowed here: the omission is a property of the input, not of the contract.
export const omsFulfillmentHealthDigestSchema = omsFulfillmentHealthSchema
  .pick({ healthStatus: true, attentionReasons: true })
  .strict();
