import { z } from "zod";
import type { SubscriptionCommand, SubscriptionLifecycleTerms } from "./contracts/commands.js";

const integer = z.number().int().positive().max(2_147_483_647);
const terms = z.object({ pauseDays: integer, pauseMonths: integer, slideMinDays: integer,
  slideMaxDays: integer, orderNowDelayMinutes: integer, reactivateDelayDays: integer }).strict()
  .refine(value => value.slideMinDays <= value.slideMaxDays);

/** Call after receipt replay: changing host configuration cannot invalidate an accepted command. */
export function lifecycleTerms(input: SubscriptionLifecycleTerms): SubscriptionLifecycleTerms {
  const result = terms.safeParse(input);
  if (!result.success) throw new Error("subscription_command_invalid_input");
  return result.data;
}

const survey = z.object({ reasonCode: z.string().min(1).max(120).optional(),
  comment: z.string().trim().min(1).max(500).nullable().optional(),
  acceptedSaveOfferId: z.string().trim().min(1).max(120).nullable().optional() }).strict();
const offer = z.object({ offerId: z.string().trim().min(1).max(120),
  kind: z.enum(["pause", "skip", "reschedule", "plan_length", "recipe_mix", "support_callback"]),
  accepted: z.boolean(), externalOfferRef: z.string().trim().min(1).max(180).nullable().optional() }).strict();

/** Legacy strings stay strings; arbitrary legacy text never becomes structured evidence. */
export function retentionFields(command: Extract<SubscriptionCommand, { action: "pause" | "cancel" }>) {
  const output: Record<string, unknown> = {};
  for (const key of ["survey", "saveOffer"] as const) {
    const value = command[key];
    if (value === undefined || value === null || typeof value === "string") { output[key] = value; continue; }
    const parsed = (key === "survey" ? survey : offer).safeParse(value);
    if (!parsed.success) return null;
    output[key] = parsed.data;
  }
  return output;
}
