import type { CatalogAdmissionEvidence } from "@openlup/core/catalog";
import { z } from "./validation.js";

const ref = z.string().min(1).max(240).refine(value => value.trim() === value && new TextEncoder().encode(value).length <= 240);
const guid = z.guid().refine(value => value === value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const positive = z.number().int().min(1).max(2_147_483_647);
const priceEvidenceRef = z.string().regex(/^price\.v1:[a-f0-9]{64}$/u);
const policyEvidenceRef = z.string().regex(/^policy\.v1:[a-f0-9]{64}$/u);
const line = z.object({
  sourceOrdinal: positive, lineKey: ref.optional(), skuId: guid,
  skuCode: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/u),
  mode: z.enum(["one_time", "subscription"]), quantity: positive, role: z.enum(["core", "addon"]),
});
const lines = z.array(z.discriminatedUnion("source", [
  line.extend({ source: z.literal("legacy") }).strict(),
  line.extend({ source: z.enum(["fresh", "retained"]), skuRevisionId: guid }).strict(),
])).min(1).max(100).refine(values => {
  const keys = values.flatMap(value => value.lineKey === undefined ? [] : [value.lineKey]);
  return new Set(keys).size === keys.length && values.every((value, index) => value.sourceOrdinal === index + 1);
});
const review = z.object({ priceEvidenceRef, policyEvidenceRef });
const legacyReview = z.discriminatedUnion("identityComparison", [
  review.extend({ identityComparison: z.literal("unavailable") }).strict(),
  review.extend({ identityComparison: z.enum(["changed", "equal"]), priorPriceEvidenceRef: priceEvidenceRef, priorPolicyEvidenceRef: policyEvidenceRef }).strict(),
]).refine(value => value.identityComparison === "unavailable"
  || (value.identityComparison === "equal") === (value.priceEvidenceRef === value.priorPriceEvidenceRef
    && value.policyEvidenceRef === value.priorPolicyEvidenceRef));

export const catalogAdmissionEvidenceSchema: z.ZodType<CatalogAdmissionEvidence> = z.object({
  quoteRef: ref.optional(), quoteDigest: digest, moneyVersion: z.literal("v0"),
  priceEvidenceRef, policyEvidenceRef, acceptanceTokenDigest: digest.optional(),
  consultedHeads: z.array(z.object({
    productId: guid, publicationId: guid, revision: positive, documentDigest: digest,
  }).strict()).max(500).refine(values => values.every((value, index) => index === 0 || values[index - 1]!.productId < value.productId)),
  offer: z.object({ ref, version: ref }).strict().optional(), lineBindings: lines,
  legacyReviewEvidence: legacyReview.optional(), destinationRef: ref.optional(), destinationDigest: digest.optional(),
  graduation: z.object({ phaseDigest: digest, lineBindings: lines }).strict().optional(),
}).strict().refine(value => (value.destinationRef === undefined) === (value.destinationDigest === undefined));
