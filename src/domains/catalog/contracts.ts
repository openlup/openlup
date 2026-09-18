import { platformCurrencySchema } from "../../lib/currency/platformCurrency.js";
import { z } from "../../lib/validation/zod.js";
import {
  CATALOG_ALLERGEN_CATEGORIES,
  CATALOG_PACKAGING_UNITS,
  CATALOG_PRICE_STATUSES,
  CATALOG_PUBLICATION_STATUSES,
  CATALOG_SPECIES,
} from "./types.js";
import {
  catalogProductIdSchema,
  skuSchema,
  slugSchema,
  variantIdSchema,
} from "./slugFormat.js";

export const CATALOG_CONTRACT_VERSION = "2026-06-01.ecommerce-0a";
export const SELLABLE_CATALOG_CONTRACT_VERSION = "catalog.sellable.v1";

// This deliberately small contract is independent of the current pet catalog.
// It is the public shape consumed by a neutral storefront: a sellable SKU is
// not required to be a food product, a product variant, or an active DB row.
const sellableCatalogMoneySchema = z.object({
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
}).strict();

export const sellableCatalogItemSchema = z.object({
  sku: z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/),
  title: z.string().trim().min(1).max(160),
  unitPrice: sellableCatalogMoneySchema,
  permittedPurchaseModes: z.array(z.enum(["one_time", "subscription"])).min(1).max(2),
}).strict();

export const sellableCatalogProfileSchema = z.object({
  id: z.string().trim().min(1).max(120),
  brand: z.string().trim().min(1).max(160),
  country: z.string().regex(/^[A-Z]{2}$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  locale: z.string().trim().min(2).max(35),
  timezone: z.string().trim().min(1).max(80),
}).strict();

export const sellableCatalogListResponseSchema = z.object({
  contractVersion: z.literal(SELLABLE_CATALOG_CONTRACT_VERSION),
  profile: sellableCatalogProfileSchema,
  items: z.array(sellableCatalogItemSchema).min(1),
}).strict();

export type SellableCatalogItem = z.infer<typeof sellableCatalogItemSchema>;
export type SellableCatalogProfile = z.infer<typeof sellableCatalogProfileSchema>;
export type SellableCatalogListResponse = z.infer<typeof sellableCatalogListResponseSchema>;

// Slugs are an OPEN value space, validated by format (slugFormat.ts), never a
// closed enum — so admin/agent-added products and real DB rows validate.
export const catalogProductSlugSchema = slugSchema;
export const catalogAllergenSlugSchema = slugSchema;
// Re-export the format primitives so cross-domain consumers (commerce,
// configurator) share one source instead of re-deriving enums.
export { slugSchema, skuSchema };

export const catalogSpeciesSchema = z.enum(CATALOG_SPECIES);
export const catalogPublicationStatusSchema = z.enum(CATALOG_PUBLICATION_STATUSES);
export const catalogPackagingUnitSchema = z.enum(CATALOG_PACKAGING_UNITS);
export const catalogPriceStatusSchema = z.enum(CATALOG_PRICE_STATUSES);
// Alias of the one platform currency schema — catalog and commerce validate the
// identical object, so the two can no longer disagree.
export const catalogCurrencySchema = platformCurrencySchema;
export const catalogAllergenCategorySchema = z.enum(CATALOG_ALLERGEN_CATEGORIES);

export const catalogMoneySchema = z.object({
  amountMinor: z.number().int().nonnegative(),
  currency: catalogCurrencySchema,
});

export const catalogPricingMetadataSchema = z
  .object({
    status: catalogPriceStatusSchema,
    listPrice: catalogMoneySchema.nullable(),
    taxCategory: z.literal("pet_food").nullable(),
    externalRefs: z.object({
      paymentProviderPriceId: z.string().min(1).nullable(),
      inventoryProviderSku: z.string().min(1).nullable(),
    }),
  })
  .refine(
    (pricing) =>
      pricing.status === "not_configured"
        ? pricing.listPrice === null
        : pricing.listPrice !== null,
    {
      message: "catalog price status must match listPrice",
      path: ["listPrice"],
    },
  );

export const catalogSkuSchema = z.object({
  sku: skuSchema,
  productSlug: catalogProductSlugSchema,
  variantId: variantIdSchema,
  publicationStatus: catalogPublicationStatusSchema,
  unit: catalogPackagingUnitSchema,
  netWeightGrams: z.number().int().positive(),
  isAddon: z.boolean().optional(),
  pricing: catalogPricingMetadataSchema,
});

export const catalogIngredientItemSchema = z.object({
  name: z.string().trim().min(1),
  pctText: z.string().trim().min(1),
  percentage: z.number().nonnegative(),
  role: z.string(),
  body: z.string(),
  allergenSlugs: z.array(catalogAllergenSlugSchema),
  nameKey: z.string().trim().min(1).optional(),
  roleKey: z.string().trim().min(1).optional(),
  bodyKey: z.string().trim().min(1).optional(),
  claimPill: z.string().trim().min(1).optional(),
  claimPillKey: z.string().trim().min(1).optional(),
});

export const catalogCompositionSchema = z.object({
  rawIngredients: z.string().trim().min(1),
  rawIngredientsEn: z.string().trim().min(1).nullable(),
  items: z.array(catalogIngredientItemSchema).min(1),
  allergenSlugs: z.array(catalogAllergenSlugSchema),
  kcalPer100g: z.number().int().positive().nullable(),
});

export const catalogProductSchema = z
  .object({
    id: catalogProductIdSchema,
    slug: catalogProductSlugSchema,
    displayName: z.string().trim().min(1),
    lineName: z.string().trim().min(1),
    species: catalogSpeciesSchema,
    publicationStatus: catalogPublicationStatusSchema,
    route: z.object({
      pl: z.string().startsWith("/"),
      en: z.string().startsWith("/"),
    }),
    primarySku: catalogSkuSchema,
    variants: z.array(catalogSkuSchema).min(1),
    composition: catalogCompositionSchema,
    metadata: z.object({
      format: z.string().trim().min(1),
      kcalPer100g: z.number().int().positive().nullable(),
      legacyStatus: z.string().trim().min(1).nullable(),
    }),
  })
  .refine(
    (product) =>
      product.primarySku.productSlug === product.slug &&
      product.variants.some((variant) => variant.sku === product.primarySku.sku),
    {
      message: "primarySku must belong to the catalog product variants",
      path: ["primarySku"],
    },
  );

export const catalogAllergenProductLinkSchema = z.object({
  productSlug: catalogProductSlugSchema,
  sku: skuSchema,
  ingredientNames: z.array(z.string().trim().min(1)).min(1),
});

export const catalogAllergenSchema = z.object({
  slug: catalogAllergenSlugSchema,
  name: z.string().trim().min(1),
  nameEn: z.string().trim().min(1),
  category: catalogAllergenCategorySchema,
  products: z.array(catalogAllergenProductLinkSchema),
});

export const catalogProductListResponseSchema = z.object({
  contractVersion: z.literal(CATALOG_CONTRACT_VERSION),
  products: z.array(catalogProductSchema),
});

export const catalogProductReadResponseSchema = z.object({
  contractVersion: z.literal(CATALOG_CONTRACT_VERSION),
  product: catalogProductSchema,
});

export const catalogAllergenListResponseSchema = z.object({
  contractVersion: z.literal(CATALOG_CONTRACT_VERSION),
  allergens: z.array(catalogAllergenSchema),
});

export type CatalogAllergenListResponse = z.infer<typeof catalogAllergenListResponseSchema>;
export type CatalogProductContract = z.infer<typeof catalogProductSchema>;
export type CatalogProductListResponse = z.infer<typeof catalogProductListResponseSchema>;
export type CatalogProductReadResponse = z.infer<typeof catalogProductReadResponseSchema>;

// Admin read of the catalog_sku_eans packs (Wave H): a read-only per-SKU EAN projection for the
// CatalogPage panel. One SKU → many packs (PL can / ENG can / collective carton).
export const adminCatalogSkuPackSchema = z.object({
  ean: z.string().min(1),
  kind: z.enum(["unit", "collective"]),
  quantity: z.number().int().positive(),
  isPrimary: z.boolean(),
  source: z.enum(["local", "omnipack"]),
});

export const adminCatalogSkuPacksItemSchema = z.object({
  sku: z.string().min(1),
  packs: z.array(adminCatalogSkuPackSchema),
});

export const adminCatalogSkuPacksResponseSchema = z.object({
  skus: z.array(adminCatalogSkuPacksItemSchema),
  totalPacks: z.number().int().nonnegative(),
});

export type AdminCatalogSkuPack = z.infer<typeof adminCatalogSkuPackSchema>;
export type AdminCatalogSkuPacksItem = z.infer<typeof adminCatalogSkuPacksItemSchema>;
export type AdminCatalogSkuPacksResponse = z.infer<typeof adminCatalogSkuPacksResponseSchema>;
