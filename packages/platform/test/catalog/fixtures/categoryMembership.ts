/** Catalog enrollment is explicit data; SKU status and per-mode eligibility remain separate. */
import { z } from "../../../src/catalog/validation.js";
const LEGACY_CONFIGURED_SKU_CODES = ["ARTICLE-ONE", "ARTICLE-TWO", "ARTICLE-THREE", "ARTICLE-FOUR", "ARTICLE-FIVE", "ARTICLE-SIX"];

export const CATALOG_OFFER_VERSIONS = ["classic", "sized.v1"] as const;
export const catalogOfferVersionSchema = z.enum(CATALOG_OFFER_VERSIONS);
export const catalogMembershipSkuCodeSchema = z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,79}$/u);
export const catalogPresentationProductSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/u);
const reference = z.string().min(1).max(500).refine((value) => value.trim() === value);
const shortName = z.string().min(1).max(120).refine((value) => value.trim() === value);
export const catalogCanNetWeightSchema = z.number().int().min(1).max(9_999_999);
const classicCodes = new Set<string>(LEGACY_CONFIGURED_SKU_CODES);

/** Publication names an opaque catalog code; persistence resolves its exact immutable SKU ID. */
export const catalogOfferMembershipSchema = z.object({
  skuCode: catalogMembershipSkuCodeSchema,
  offerVersion: catalogOfferVersionSchema,
  admitted: z.boolean(),
}).strict().superRefine((membership, context) => {
  if (membership.offerVersion === "classic" && (!classicCodes.has(membership.skuCode) || !membership.admitted)) {
    context.addIssue({ code: "custom", message: "classic membership is frozen to the existing admitted six" });
  }
});

/** Optional media/accent describe presentation, never weight, price, stock or eligibility. */
export const catalogProductPresentationSchema = z.object({
  routePath: z.object({
    pl: z.string().regex(/^\/psy\/[a-z0-9][a-z0-9-]{0,79}$/u),
    en: z.string().regex(/^\/dogs\/[a-z0-9][a-z0-9-]{0,79}$/u),
  }).strict(),
  shortName: z.object({ pl: shortName, en: shortName }).strict(),
  advertisedWeightsG: z.array(catalogCanNetWeightSchema),
  mediaRef: reference.optional(),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/u).optional(),
}).strict().superRefine((presentation, context) => {
  if (!presentation.advertisedWeightsG.every((weight, index, values) => index === 0 || values[index - 1]! < weight)) {
    context.addIssue({ code: "custom", message: "advertised weights must be sorted and unique" });
  }
});

export const catalogProductPresentationEntrySchema = z.object({
  productSlug: catalogPresentationProductSlugSchema,
  presentation: catalogProductPresentationSchema,
}).strict();
export const catalogSkuMetadataSchema = z.object({ skuCode: catalogMembershipSkuCodeSchema, logisticsRef: reference }).strict();

export type CatalogOfferVersion = z.infer<typeof catalogOfferVersionSchema>;
export type CatalogOfferMembership = z.infer<typeof catalogOfferMembershipSchema>;
export type CatalogProductPresentation = z.infer<typeof catalogProductPresentationSchema>;
export type CatalogProductPresentationEntry = z.infer<typeof catalogProductPresentationEntrySchema>;
export type CatalogSkuMetadata = z.infer<typeof catalogSkuMetadataSchema>;

/** ASCII code-unit order agrees with the publication SQL's C collation. */
export function catalogOfferMembershipKey(membership: Pick<CatalogOfferMembership, "offerVersion" | "skuCode">): string {
  return `${membership.offerVersion}:${membership.skuCode}`;
}
