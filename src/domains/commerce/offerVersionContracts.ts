import { z } from "../../lib/validation/zod.js";
import { COMMERCE_MIN_ORDER_UNITS } from "./recommendationPolicyDeps.js";

/**
 * An adopter's offer version: an opaque, format-validated token that core
 * carries and never interprets. Absent means the adopter's default offer, with
 * core's default minimum basket and default quote list.
 */
export const commerceOfferVersionSchema = z
  .string()
  .max(40)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);

/** The smallest basket, in units, that an answered offer version accepts. */
export const commerceMinimumUnitsSchema = z.number().int().min(1).max(99);

export const COMMERCE_OFFER_EVIDENCE_MAX_JSON_LENGTH = 4_096;

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

/** The minimum basket a snapshot or intent carries, else core's default minimum. */
export function commerceMinimumUnits(input: { minimumUnits?: number | null }): number {
  return input.minimumUnits ?? COMMERCE_MIN_ORDER_UNITS;
}

export type CommerceOfferVersion = z.infer<typeof commerceOfferVersionSchema>;
export type CommerceOfferEvidence = z.infer<typeof commerceOfferEvidenceSchema>;
