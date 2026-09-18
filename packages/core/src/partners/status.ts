import { z } from "zod";

/**
 * Lifecycle stage of a B2B / partner inquiry as it moves through a sales
 * pipeline. Neutral, provider-agnostic vocabulary:
 * - `new` — just received, not yet triaged;
 * - `contacted` — outreach made, awaiting response;
 * - `qualified` — a real, in-scope opportunity;
 * - `disqualified` — not a fit (out of scope / spam / no intent);
 * - `closed_won` — converted;
 * - `closed_lost` — did not convert.
 * The inquiry payload itself (contact details, CRM ids, PII) is NOT part of the
 * core contract; it lives in the host application's downstream adapter.
 */
/** @beta */
export const partnersB2BInquiryStatusSchema = z.enum([
  "new",
  "contacted",
  "qualified",
  "disqualified",
  "closed_won",
  "closed_lost",
]);

/** Request to move one inquiry (`id`) to a new pipeline `status`. */
/** @beta */
export const partnersB2BInquiryStatusUpdateRequestSchema = z.object({
  id: z.string().min(1),
  status: partnersB2BInquiryStatusSchema,
});

/** Successful status-update acknowledgement. `updated` is always `true`; a
 * failed update is surfaced as a rejected promise / error by the port, not as
 * `{ updated: false }`. */
/** @beta */
export const partnersB2BInquiryStatusUpdateResponseSchema = z.object({
  updated: z.literal(true),
});

/** @beta */
export type PartnersB2BInquiryStatus = z.infer<typeof partnersB2BInquiryStatusSchema>;
/** @beta */
export type PartnersB2BInquiryStatusUpdateRequest = z.infer<
  typeof partnersB2BInquiryStatusUpdateRequestSchema
>;
/** @beta */
export type PartnersB2BInquiryStatusUpdateResponse = z.infer<
  typeof partnersB2BInquiryStatusUpdateResponseSchema
>;
