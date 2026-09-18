import type { PlatformCurrency } from "../../lib/currency/platformCurrency.js";

/**
 * Non-authoritative SEED list of the launch catalog's product slugs.
 *
 * NOT a validation gate and NOT the source of `CatalogProductSlug` any more —
 * slugs are an open value space (see `slugFormat.ts`), so an admin/agent-added
 * product with a new slug is valid. Kept for static fixtures, the legacy price
 * book, and "is this a launch slug?" checks. Do not reintroduce
 * `z.enum(CATALOG_PRODUCT_SLUGS)` (guardrail: noEnumOverOpenValueSpace).
 */
export const CATALOG_PRODUCT_SLUGS = [
  "lamb",
  "venison",
  "beef",
  "turkey",
  "salmon",
  "pork",
] as const;

export const CATALOG_SPECIES = ["dog", "cat"] as const;
export const CATALOG_PUBLICATION_STATUSES = ["published", "coming_soon"] as const;
export const CATALOG_PACKAGING_UNITS = ["can", "jar"] as const;
export const CATALOG_PRICE_STATUSES = ["not_configured", "configured"] as const;
// Catalog used to carry its own copy of the accepted-currency list, which could
// drift from commerce's without anything noticing. Both are now the same object
// from src/lib/currency/platformCurrency.ts.
export { PLATFORM_ACCEPTED_CURRENCIES as CATALOG_CURRENCIES } from "../../lib/currency/platformCurrency.js";
/** Non-authoritative SEED list of launch allergen slugs — same open-value-space
 *  rule as CATALOG_PRODUCT_SLUGS. Not a validation gate. */
export const CATALOG_ALLERGEN_SLUGS = [
  "lamb",
  "venison",
  "beef",
  "turkey",
  "salmon",
  "salmon_oil",
  "chicken",
  "pork",
  "carrot",
  "pumpkin",
  "apple",
  "sweet_potato",
  "yeast",
] as const;
export const CATALOG_ALLERGEN_CATEGORIES = [
  "animal_protein",
  "fish",
  "plant",
  "microbial",
] as const;

// Open value space: a catalog slug is any well-formed slug, not a fixed union.
// (Was `(typeof CATALOG_PRODUCT_SLUGS)[number]`; widened so admin/agent-added
// products type-check. Format is enforced at the contract boundary via slugFormat.)
export type CatalogProductSlug = string;
export type CatalogSpecies = (typeof CATALOG_SPECIES)[number];
export type CatalogPublicationStatus = (typeof CATALOG_PUBLICATION_STATUSES)[number];
export type CatalogPackagingUnit = (typeof CATALOG_PACKAGING_UNITS)[number];
export type CatalogPriceStatus = (typeof CATALOG_PRICE_STATUSES)[number];
export type CatalogCurrency = PlatformCurrency;
// Open value space (see CatalogProductSlug). Format-validated, not enum-gated.
export type CatalogAllergenSlug = string;
export type CatalogAllergenCategory = (typeof CATALOG_ALLERGEN_CATEGORIES)[number];

export interface CatalogMoney {
  amountMinor: number;
  currency: CatalogCurrency;
}

export interface CatalogPricingMetadata {
  status: CatalogPriceStatus;
  listPrice: CatalogMoney | null;
  taxCategory: "pet_food" | null;
  externalRefs: {
    paymentProviderPriceId: string | null;
    inventoryProviderSku: string | null;
  };
}

export interface CatalogSku {
  sku: string;
  productSlug: CatalogProductSlug;
  variantId: string;
  publicationStatus: CatalogPublicationStatus;
  unit: CatalogPackagingUnit;
  netWeightGrams: number;
  /** Mirror of catalog_skus.is_addon: addon SKUs cannot be used as recipe lines.
   *  Optional so existing fixtures default to a line (undefined = not an addon);
   *  the live read port always sets it. */
  isAddon?: boolean;
  pricing: CatalogPricingMetadata;
}

export interface CatalogIngredientItem {
  name: string;
  pctText: string;
  percentage: number;
  role: string;
  body: string;
  allergenSlugs: CatalogAllergenSlug[];
  nameKey?: string;
  roleKey?: string;
  bodyKey?: string;
  claimPill?: string;
  claimPillKey?: string;
}

export interface CatalogComposition {
  rawIngredients: string;
  rawIngredientsEn: string | null;
  items: CatalogIngredientItem[];
  allergenSlugs: CatalogAllergenSlug[];
  kcalPer100g: number | null;
}

export interface CatalogProduct {
  id: string;
  slug: CatalogProductSlug;
  displayName: string;
  lineName: string;
  species: CatalogSpecies;
  publicationStatus: CatalogPublicationStatus;
  route: {
    pl: string;
    en: string;
  };
  primarySku: CatalogSku;
  variants: CatalogSku[];
  composition: CatalogComposition;
  metadata: {
    format: string;
    kcalPer100g: number | null;
    legacyStatus: string | null;
  };
}

export interface CatalogAllergenProductLink {
  productSlug: CatalogProductSlug;
  sku: string;
  ingredientNames: string[];
}

export interface CatalogAllergen {
  slug: CatalogAllergenSlug;
  name: string;
  nameEn: string;
  category: CatalogAllergenCategory;
  products: CatalogAllergenProductLink[];
}
