import { z } from "@/lib/validation/zod.js";
import { createPersistedState } from "@/lib/persistentCommerceState";
import { pricingPolicySnapshotSchema } from "@/domains/commerce/offerPolicyContracts";
import { isPersistedPricingPolicyAssignment } from "./configuratorPricingPolicyPersistence";
import type { ReferenceBuilderDraft } from "./referenceBuilderModel";

const draftSchema = z.object({
  selection: z.object({
    mode: z.enum(["one_time", "subscription"]),
    lines: z.array(z.object({ sku: z.string().min(1), quantity: z.number().int().positive() }).strict()).min(1),
    cadenceDays: z.number().int().positive().optional(),
  }).strict(),
  customer: z.object({ email: z.string() }).strict(),
  termsConsent: z.boolean(),
  expectation: z.object({
    totalGross: z.object({ amountMinor: z.number().int().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/) }).strict(),
    promotionAcceptanceToken: z.string().min(1).max(8300),
    pricingPolicy: pricingPolicySnapshotSchema.optional(),
    acquisitionTerms: z.object({ revision: z.string().min(1), delivery2DiscountBps: z.number().int().min(0).max(10000) }).strict().optional(),
  }).strict().nullable(),
}).strict();

/** Uses the existing SSR-safe codec, TTL and refusal statuses with a separate key. */
export function createReferenceBuilderDraftStore(scope: string) {
  return createPersistedState<ReferenceBuilderDraft>({
    key: `openlup:reference-builder:v1:${scope}`,
    version: 1,
    ttlMs: 7 * 24 * 60 * 60 * 1000,
    validate: value => {
      const parsed = draftSchema.safeParse(value);
      return parsed.success && isPersistedPricingPolicyAssignment(parsed.data.expectation?.pricingPolicy);
    },
  });
}
