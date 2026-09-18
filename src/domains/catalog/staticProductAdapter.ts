import { deriveCatalogAllergens } from "./allergenRegistry.js";
import { CATALOG_PRODUCT_SLUGS } from "./types.js";
import type {
  CatalogAllergen,
  CatalogAllergenCategory,
  CatalogAllergenSlug,
  CatalogProduct,
  CatalogProductSlug,
  CatalogPackagingUnit,
  CatalogPublicationStatus,
  CatalogSpecies,
} from "./types.js";

export interface StaticProductRoutes {
  pl: Record<string, string>;
  en: Record<string, string>;
}

export interface StaticProductCatalogConfig {
  skuPrefix: string;
}

interface StaticIngredientCardLike {
  name: string;
  pct: string;
  role: string;
  body: string;
  allergenSlugs: CatalogAllergenSlug[];
  claimPill?: string;
  nameKey?: string;
  roleKey?: string;
  bodyKey?: string;
  claimPillKey?: string;
}

interface StaticProductLike {
  slug: string;
  name: string;
  status?: string;
  lineName: string;
  species: string;
  format: string;
  weight: string;
  ingredients: string;
  ingredientsEn?: string;
  ingredientCards: StaticIngredientCardLike[];
  kcalPer100g: number | null;
  allergenSlugs: CatalogAllergenSlug[];
}

interface StaticAllergenDefinitionLike {
  slug: CatalogAllergenSlug;
  name: string;
  nameEn: string;
  category: CatalogAllergenCategory;
}

export function mapStaticProductToCatalogProduct(
  product: StaticProductLike,
  routes: StaticProductRoutes,
  config: StaticProductCatalogConfig,
): CatalogProduct {
  const slug = toCatalogProductSlug(product.slug);
  const species = toCatalogSpecies(product.species);
  const netWeightGrams = parseWeightGrams(product.weight);
  const publicationStatus = toCatalogPublicationStatus(product.status);
  const unit: CatalogPackagingUnit = species === "cat" ? "jar" : "can";
  const skuPrefix = toSkuPrefix(config.skuPrefix);
  const sku = `${skuPrefix}-${species.toUpperCase()}-${slug.toUpperCase()}-${unit.toUpperCase()}-${netWeightGrams}G`;

  const primarySku = {
    sku,
    productSlug: slug,
    variantId: `variant_${slug}_${netWeightGrams}g_${unit}`,
    publicationStatus,
    unit,
    netWeightGrams,
    isAddon: false,
    pricing: {
      status: "not_configured" as const,
      listPrice: null,
      taxCategory: "pet_food" as const,
      externalRefs: {
        paymentProviderPriceId: null,
        inventoryProviderSku: null,
      },
    },
  };

  return {
    id: `catalog_product_${slug}`,
    slug,
    displayName: product.name.replace(/ Recipe$/, ""),
    lineName: product.lineName,
    species,
    publicationStatus,
    route: {
      pl: `/${species === "dog" ? "psy" : "koty"}/${routes.pl[slug] ?? slug}`,
      en: `/${species === "dog" ? "dogs" : "cats"}/${routes.en[slug] ?? slug}`,
    },
    primarySku,
    variants: [primarySku],
    composition: {
      rawIngredients: product.ingredients,
      rawIngredientsEn: product.ingredientsEn ?? null,
      items: product.ingredientCards.map((card) => ({
        name: card.name,
        pctText: card.pct,
        percentage: parsePercentage(card.pct),
        role: card.role,
        body: card.body,
        allergenSlugs: card.allergenSlugs,
        claimPill: card.claimPill,
        nameKey: card.nameKey,
        roleKey: card.roleKey,
        bodyKey: card.bodyKey,
        claimPillKey: card.claimPillKey,
      })),
      allergenSlugs: product.allergenSlugs,
      kcalPer100g: product.kcalPer100g,
    },
    metadata: {
      format: product.format,
      kcalPer100g: product.kcalPer100g,
      legacyStatus: product.status ?? null,
    },
  };
}

export function mapStaticProductsToCatalogProducts(
  products: Record<string, StaticProductLike>,
  routes: StaticProductRoutes,
  config: StaticProductCatalogConfig,
): CatalogProduct[] {
  return Object.values(products).map((product) =>
    mapStaticProductToCatalogProduct(product, routes, config),
  );
}

export function mapStaticAllergensToCatalogAllergens(
  allergens: StaticAllergenDefinitionLike[],
  products: CatalogProduct[],
): CatalogAllergen[] {
  // Delegates to the neutral registry derivation so the static and DB-backed read
  // ports produce identical allergen graphs (see allergenRegistry.ts).
  return deriveCatalogAllergens(allergens, products);
}

function toCatalogProductSlug(slug: string): CatalogProductSlug {
  if (isCatalogProductSlug(slug)) return slug;
  throw new Error(`Unsupported catalog product slug: ${slug}`);
}

function isCatalogProductSlug(slug: string): slug is CatalogProductSlug {
  return (CATALOG_PRODUCT_SLUGS as readonly string[]).includes(slug);
}

function toCatalogSpecies(species: string): CatalogSpecies {
  const normalized = species.trim().toLowerCase();
  if (normalized === "dog" || normalized === "cat") return normalized;
  throw new Error(`Unsupported catalog species: ${species}`);
}

function parseWeightGrams(weight: string): number {
  const match = weight.match(/^(\d+)\s*g$/i);
  if (!match) throw new Error(`Unsupported catalog weight: ${weight}`);
  return Number(match[1]);
}

function parsePercentage(value: string): number {
  const normalized = value.replace("%", "").replace(",", ".").trim();
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) throw new Error(`Unsupported catalog percentage: ${value}`);
  return parsed;
}

function toSkuPrefix(prefix: string): string {
  const normalized = prefix.trim().toUpperCase();
  if (/^[A-Z][A-Z0-9_]*$/.test(normalized)) return normalized;
  throw new Error(`Unsupported catalog SKU prefix: ${prefix}`);
}

function toCatalogPublicationStatus(status: string | undefined): CatalogPublicationStatus {
  return status === "coming_soon" ? "coming_soon" : "published";
}
