import { z } from "../../lib/validation/zod.js";

// Cancel-survey contract, split out of `selfServiceContracts.ts` so the generic
// self-service contract stays within its LOC budget. The subscription domain
// validates the survey *shape*; the concrete reason-code set is owned by the
// vertical layer (`src/data/cancelSurveyReasons.ts`) and injected at the BFF
// composition root for membership validation (E10).

const cancelSurveyCommentSchema = z.string().trim().min(1).max(500).nullable().optional();
const cancelSurveyAcceptedOfferSchema = z.string().trim().min(1).max(120).nullable().optional();

/**
 * Cancel-survey schema factory. Validates the survey shape and constrains
 * `reasonCode` to the supplied vertical taxonomy. `reasonCode` stays optional and
 * the object stays `.strict()`, matching the historical hard-coded enum contract
 * byte-for-byte, so this domain never owns a species-specific reason list.
 */
export function createCancelSurveySchema<const T extends readonly [string, ...string[]]>(reasonCodes: T) {
  return z
    .object({
      reasonCode: z.enum(reasonCodes).optional(),
      comment: cancelSurveyCommentSchema,
      acceptedSaveOfferId: cancelSurveyAcceptedOfferSchema,
    })
    .strict();
}

/**
 * @deprecated Transitional generic alias. The **shape-only** survey embedded in the
 * static self-service action union: `reasonCode` is a bounded string, not a
 * species-specific (pet) enum. Reason-code membership is supplied by the vertical layer via
 * {@link createCancelSurveySchema} and enforced at the BFF composition root. Do not
 * re-hardcode a reason list here.
 */
export const subscriptionCancelSurveySchema = z
  .object({
    // No `.trim()`: the raw code must reach the injected membership enum verbatim so
    // a padded value the historical enum rejected is not silently accepted.
    reasonCode: z.string().min(1).max(120).optional(),
    comment: cancelSurveyCommentSchema,
    acceptedSaveOfferId: cancelSurveyAcceptedOfferSchema,
  })
  .strict();

export type SubscriptionCancelSurvey = z.infer<typeof subscriptionCancelSurveySchema>;
