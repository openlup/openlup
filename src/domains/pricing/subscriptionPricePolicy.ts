import { z } from "../../lib/validation/zod.js";

const uuidSchema = z.guid();
const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const currencySchema = z.string().regex(/^[A-Z]{3}$/u);
const channelSchema = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/);

export const SUBSCRIPTION_PRICE_POLICY_SCHEMA_VERSION = "subscription-price-policy.v1";
export const SUBSCRIPTION_PRICE_POLICY_DEFAULT_DISCOUNT_BPS = 1_000;
export const SUBSCRIPTION_PRICE_POLICY_DEFAULT_QUANTUM_MINOR = 10;

export const subscriptionPricePolicySemanticsSchema = z.object({
  discountBps: z.number().int().min(0).max(10_000),
  roundingQuantumMinor: z.number().int().positive().refine(Number.isSafeInteger, "rounding quantum must be a safe integer"),
  roundingRule: z.enum(["FLOOR_TO_QUANTUM"]),
}).strict();

const subscriptionPricePolicyRevisionFields = {
  id: uuidSchema,
  revisionNo: z.number().int().positive(),
  priceListId: uuidSchema,
  regionCode: z.string().regex(/^[A-Z]{2,3}$/u),
  currency: currencySchema,
  channel: channelSchema,
  effectiveFrom: z.string().datetime({ offset: true }),
  effectiveTo: z.string().datetime({ offset: true }).nullable(),
  ...subscriptionPricePolicySemanticsSchema.shape,
};

export const subscriptionPricePolicyCanonicalInputSchema = z.object(subscriptionPricePolicyRevisionFields).strict().superRefine((policy, context) => {
  if (policy.effectiveTo && policy.effectiveTo <= policy.effectiveFrom) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["effectiveTo"], message: "effectiveTo must be later than effectiveFrom" });
  }
});

export const subscriptionPricePolicyRevisionSchema = subscriptionPricePolicyCanonicalInputSchema.extend({
  digest: sha256DigestSchema,
}).strict();

export type SubscriptionPricePolicySemantics = z.infer<typeof subscriptionPricePolicySemanticsSchema>;
export type SubscriptionPricePolicyCanonicalInput = z.infer<typeof subscriptionPricePolicyCanonicalInputSchema>;
export type SubscriptionPricePolicyRevision = z.infer<typeof subscriptionPricePolicyRevisionSchema>;
export type SubscriptionPricePolicyDigestRefusal = "subscription_price_policy_digest_mismatch";

export class SubscriptionPricePolicyDigestError extends Error {
  constructor(readonly code: SubscriptionPricePolicyDigestRefusal) {
    super(code);
    this.name = "SubscriptionPricePolicyDigestError";
  }
}

/** The exact tuple whose canonical digest is persisted with a policy revision. */
export function canonicalSubscriptionPricePolicyTuple(
  policy: SubscriptionPricePolicyCanonicalInput | SubscriptionPricePolicyRevision,
): string {
  const value = parseCanonicalPolicyInput(policy);
  return JSON.stringify({
    schemaVersion: SUBSCRIPTION_PRICE_POLICY_SCHEMA_VERSION,
    id: value.id,
    revisionNo: value.revisionNo,
    priceListId: value.priceListId,
    regionCode: value.regionCode,
    currency: value.currency,
    channel: value.channel,
    effectiveFrom: value.effectiveFrom,
    effectiveTo: value.effectiveTo,
    discountBps: value.discountBps,
    roundingQuantumMinor: value.roundingQuantumMinor,
    roundingRule: value.roundingRule,
  });
}

/** Hashes application-owned canonical UTF-8 bytes; never a database JSON rendering. */
export async function digestSubscriptionPricePolicy(
  policy: SubscriptionPricePolicyCanonicalInput | SubscriptionPricePolicyRevision,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalSubscriptionPricePolicyTuple(policy));
  const crypto = globalThis.crypto;
  if (!crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Parses a persisted revision and refuses a digest outside its canonical UTF-8 tuple. */
export async function assertSubscriptionPricePolicyDigest(value: unknown): Promise<SubscriptionPricePolicyRevision> {
  const revision = subscriptionPricePolicyRevisionSchema.parse(value);
  const actual = await digestSubscriptionPricePolicy(revision);
  if (actual !== revision.digest) {
    throw new SubscriptionPricePolicyDigestError("subscription_price_policy_digest_mismatch");
  }
  return revision;
}

/** Resolves a subscription unit price from a base unit price and a policy revision. */
export function deriveSubscriptionUnitPrice(
  baseUnitAmountMinor: number,
  semantics: SubscriptionPricePolicySemantics | SubscriptionPricePolicyCanonicalInput | SubscriptionPricePolicyRevision,
): number {
  if (!Number.isSafeInteger(baseUnitAmountMinor) || baseUnitAmountMinor < 0) {
    throw new RangeError("baseUnitAmountMinor must be a non-negative safe integer");
  }
  const policy = subscriptionPricePolicySemanticsSchema.parse({
    discountBps: semantics.discountBps,
    roundingQuantumMinor: semantics.roundingQuantumMinor,
    roundingRule: semantics.roundingRule,
  });
  const discounted = (BigInt(baseUnitAmountMinor) * BigInt(10_000 - policy.discountBps)) / 10_000n;
  const quantum = BigInt(policy.roundingQuantumMinor);
  const resolved = (discounted / quantum) * quantum;
  if (resolved > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("resolved subscription price exceeds Number.MAX_SAFE_INTEGER");
  }
  return Number(resolved);
}

function parseCanonicalPolicyInput(value: unknown): SubscriptionPricePolicyCanonicalInput {
  const persisted = subscriptionPricePolicyRevisionSchema.safeParse(value);
  return persisted.success ? persisted.data : subscriptionPricePolicyCanonicalInputSchema.parse(value);
}
