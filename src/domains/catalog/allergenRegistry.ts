import type {
  CatalogAllergen,
  CatalogAllergenCategory,
  CatalogAllergenSlug,
  CatalogProduct,
} from "./types.js";

/**
 * Neutral allergen-taxonomy registry.
 *
 * The allergen *taxonomy* (slug → name/nameEn/category) is reference data with no
 * DB home — there is no `catalog_allergens` table; product↔allergen links are
 * derived from a product's composition (which IS in the DB via `marketing_content`).
 * This module is therefore the single source of truth for the taxonomy and the
 * pure derivation, consumed by BOTH read ports:
 *   - the static port (`staticProductAdapter.mapStaticAllergensToCatalogAllergens`), and
 *   - the managed DB-backed catalog adapter (`catalogRead.listAllergens`), which previously
 *     returned `[]` (Wave 1 gap). Sharing one registry + one derivation keeps the
 *     two ports byte-identical (parity gate, `catalogReadParity.test.ts`).
 *
 * Deliberately free of any static-product-content import so the DB port stays
 * decoupled from `src/data/catalog*`. `catalogContent.catalogAllergenDefinitions`
 * extends these base entries with text matchers (used only to derive allergenSlugs
 * from raw ingredient strings at seed time).
 */
export interface CatalogAllergenDefinitionBase {
  slug: CatalogAllergenSlug;
  name: string;
  nameEn: string;
  category: CatalogAllergenCategory;
}

export const CATALOG_ALLERGEN_REGISTRY: readonly CatalogAllergenDefinitionBase[] = [
  { slug: "lamb", name: "Jagnięcina", nameEn: "Lamb", category: "animal_protein" },
  { slug: "venison", name: "Dziczyzna", nameEn: "Venison", category: "animal_protein" },
  { slug: "beef", name: "Wołowina", nameEn: "Beef", category: "animal_protein" },
  { slug: "turkey", name: "Indyk", nameEn: "Turkey", category: "animal_protein" },
  { slug: "salmon", name: "Łosoś", nameEn: "Salmon", category: "fish" },
  { slug: "salmon_oil", name: "Olej z łososia", nameEn: "Salmon oil", category: "fish" },
  { slug: "chicken", name: "Kurczak", nameEn: "Chicken", category: "animal_protein" },
  { slug: "pork", name: "Wieprzowina", nameEn: "Pork", category: "animal_protein" },
  { slug: "carrot", name: "Marchew", nameEn: "Carrot", category: "plant" },
  { slug: "pumpkin", name: "Dynia", nameEn: "Pumpkin", category: "plant" },
  { slug: "apple", name: "Jabłko", nameEn: "Apple", category: "plant" },
  { slug: "sweet_potato", name: "Batat", nameEn: "Sweet potato", category: "plant" },
  { slug: "yeast", name: "Drożdże", nameEn: "Yeast", category: "microbial" },
] as const;

/**
 * Derive the allergen registry (taxonomy + product links) for a set of products.
 *
 * An allergen lists a product only when the product's composition both flags the
 * allergen slug AND has at least one named ingredient carrying it — identical to
 * the original static mapping, now shared so the DB-backed port matches exactly.
 */
export function deriveCatalogAllergens(
  definitions: readonly CatalogAllergenDefinitionBase[],
  products: readonly CatalogProduct[],
): CatalogAllergen[] {
  return definitions.map((allergen) => ({
    slug: allergen.slug,
    name: allergen.name,
    nameEn: allergen.nameEn,
    category: allergen.category,
    products: products.flatMap((product) => {
      const ingredientNames = product.composition.items
        .filter((item) => item.allergenSlugs.includes(allergen.slug))
        .map((item) => item.name);

      if (!product.composition.allergenSlugs.includes(allergen.slug)) return [];
      if (ingredientNames.length === 0) return [];

      return {
        productSlug: product.slug,
        sku: product.primarySku.sku,
        ingredientNames,
      };
    }),
  }));
}
