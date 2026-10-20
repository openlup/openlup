// Browser validation binding; the pricing server entry owns the portable counterpart.
import { z } from "../../lib/validation/zod.js";

export type { CommerceCodeRejectionDetail } from "@openlup/platform/pricing/contracts";

export const quoteCodeRejectionDetailSchema = z.discriminatedUnion("reason", [
  z.object({
    code: z.string().trim().min(1).max(80),
    reason: z.literal("scope_not_applicable"),
    allowedScopes: z.array(z.enum(["one_time", "subscription_initial"])).min(1).max(2),
  }).strict(),
  z.object({
    code: z.string().trim().min(1).max(80),
    reason: z.literal("minimum_not_met"),
    minimumReferenceMinor: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    code: z.string().trim().min(1).max(80),
    reason: z.literal("not_yet_active"),
    validFrom: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({
    code: z.string().trim().min(1).max(80),
    reason: z.literal("global_limit_reached"),
  }).strict(),
]);
