import { z } from "zod";
import type { ShippingPolicy, ShippingPolicyEntry, ShippingSettings, ShippingTerms } from "./contracts/threshold.js";

const minorSchema = z.number().int().nonnegative().max(2_147_483_647);
const instantSchema = z.string().datetime({ offset: true }).refine((value) => {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= days && Number.isFinite(Date.parse(value));
}, "Invalid calendar date");

export const shippingTermsSchema = z.object({
  version: z.literal("shipping-threshold.v1"),
  currency: z.string().regex(/^[A-Z]{3}$/),
  flatMinor: minorSchema,
  freeThresholdMinor: minorSchema,
}).strict();
const entrySchema = z.object({
  enabled: z.boolean(), flatMinor: minorSchema, freeThresholdMinor: minorSchema,
  effectiveFrom: instantSchema,
}).strict();
export const shippingPolicySchema = z.object({
  version: z.literal("shipping-policy.v1"),
  current: entrySchema.nullable(), scheduled: entrySchema.nullable().optional(),
}).strict().refine((policy) => !policy.current || !policy.scheduled ||
  Date.parse(policy.current.effectiveFrom) < Date.parse(policy.scheduled.effectiveFrom),
"Scheduled policy must follow current policy");

/** Absence selects legacy behavior; malformed retained promises refuse. */
export function parseShippingTerms(value: unknown): ShippingTerms | undefined {
  return value === undefined ? undefined : shippingTermsSchema.parse(value);
}
export function hasShippingTerms(quote: { context?: { shippingTerms?: unknown } }): boolean {
  return quote.context?.shippingTerms !== undefined;
}
/** Resolve effective entries on read, without a scheduled write. */
export function normalizeShippingPolicy(policy: ShippingPolicy, asOf: Date | string): ShippingPolicy {
  const parsed = shippingPolicySchema.parse(policy);
  const now = new Date(asOf).getTime();
  if (!Number.isFinite(now)) throw new Error("shipping_policy_invalid_as_of");
  const entries = [parsed.current, parsed.scheduled].filter((entry): entry is ShippingPolicyEntry => !!entry);
  const effective = entries.filter((entry) => Date.parse(entry.effectiveFrom) <= now);
  const future = entries.filter((entry) => Date.parse(entry.effectiveFrom) > now);
  if (future.length > 1) throw new Error("shipping_policy_multiple_scheduled_changes");
  return { version: parsed.version, current: effective[effective.length - 1] ?? null, scheduled: future[0] ?? null };
}
export function resolveShippingPolicy(settings: ShippingSettings, asOf: Date | string, currency: string): {
  configured: boolean; flatMinor: number; terms?: ShippingTerms;
} {
  if (settings.policy === null) return { configured: false, flatMinor: minorSchema.parse(settings.legacyFlatMinor) };
  const { current } = normalizeShippingPolicy(settings.policy, asOf);
  if (!current?.enabled) return { configured: true, flatMinor: 0 };
  const terms = shippingTermsSchema.parse({
    version: "shipping-threshold.v1", currency,
    flatMinor: current.flatMinor, freeThresholdMinor: current.freeThresholdMinor,
  });
  return { configured: true, flatMinor: terms.flatMinor, terms };
}
/** Only product payable after discounts counts; equality receives free delivery. */
export function resolveThresholdShipping(terms: ShippingTerms, productPayableMinor: number): {
  grossMinor: number; remainingMinor: number;
} {
  const payable = minorSchema.parse(productPayableMinor);
  const remainingMinor = Math.max(0, terms.freeThresholdMinor - payable);
  return { grossMinor: remainingMinor > 0 ? terms.flatMinor : 0, remainingMinor };
}
