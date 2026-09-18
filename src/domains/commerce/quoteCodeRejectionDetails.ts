import { z } from "../../lib/validation/zod.js";

/** UI-safe, additive explanation for a frozen `codeRejections` item. */
export type CommerceCodeRejectionDetail =
  | { code: string; reason: "scope_not_applicable"; allowedScopes: Array<"one_time" | "subscription_initial"> }
  | { code: string; reason: "minimum_not_met"; minimumReferenceMinor: number }
  | { code: string; reason: "not_yet_active"; validFrom: string }
  | { code: string; reason: "global_limit_reached" };

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
