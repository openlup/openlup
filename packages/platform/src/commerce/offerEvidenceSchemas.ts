import { z } from "zod";

const COMMERCE_OFFER_EVIDENCE_MAX_JSON_LENGTH = 4_096;

/**
 * The adopter's own record of why a checkout was bound to an offer version.
 * Server-minted only: core bounds its keys and size and never reads it.
 */
export const commerceOfferEvidenceSchema = z
  .record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,39}$/), z.unknown())
  .superRefine((evidence, ctx) => {
    if (JSON.stringify(evidence).length > COMMERCE_OFFER_EVIDENCE_MAX_JSON_LENGTH) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "offer evidence exceeds 4096 characters" });
    }
  });

export type CommerceOfferEvidence = z.infer<typeof commerceOfferEvidenceSchema>;
