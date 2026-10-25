import { z } from "zod";

// Contract for the public order-feedback (post-delivery review) submit BFF.
// No login: the opaque token from the review-email link is the only credential.
export const ORDER_FEEDBACK_SUBMIT_RPC_NAME = "submit_order_feedback";
export const ORDER_FEEDBACK_CHECK_RPC_NAME = "check_order_feedback_token";

export const orderFeedbackTokenCheckRequestSchema = z
  .object({ token: z.string().min(1).max(128) })
  .strict();
export type OrderFeedbackTokenCheckRequest = z.infer<typeof orderFeedbackTokenCheckRequestSchema>;

export const orderFeedbackTokenCheckStatusSchema = z.enum([
  "ready",
  "already_submitted",
  "not_found",
]);
export type OrderFeedbackTokenCheckStatus = z.infer<typeof orderFeedbackTokenCheckStatusSchema>;

export const orderFeedbackTokenCheckResponseSchema = z
  .object({ status: orderFeedbackTokenCheckStatusSchema })
  .strict();
export type OrderFeedbackTokenCheckResponse = z.infer<typeof orderFeedbackTokenCheckResponseSchema>;

export const orderFeedbackSubmitRequestSchema = z
  .object({
    token: z.string().min(1).max(128),
    rating: z.number().int().min(1).max(5),
    comment: z.string().max(2000).optional(),
  })
  .strict();

export type OrderFeedbackSubmitRequest = z.infer<typeof orderFeedbackSubmitRequestSchema>;

// The RPC reports outcome without ever exposing the row, so the form can show
// the right state (submitted / already submitted / unknown token).
export const orderFeedbackSubmitStatusSchema = z.enum([
  "submitted",
  "already_submitted",
  "not_found",
]);
export type OrderFeedbackSubmitStatus = z.infer<typeof orderFeedbackSubmitStatusSchema>;

export const orderFeedbackSubmitResponseSchema = z
  .object({ status: orderFeedbackSubmitStatusSchema })
  .strict();
export type OrderFeedbackSubmitResponse = z.infer<typeof orderFeedbackSubmitResponseSchema>;
