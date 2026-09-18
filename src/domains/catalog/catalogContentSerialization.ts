import type {
  CatalogComposition,
  CatalogProduct,
  CatalogSpecies,
} from "./types.js";

/**
 * Serialization of a product's rich, label-/front-of-house content into the
 * `catalog_products.marketing_content` jsonb, under a single `content` key.
 *
 * The DB columns (`slug`, `name`, `status`, `ingredients[]`, `allergens[]`) plus
 * the `catalog_skus` rows cover the *structural* product, but the static catalog
 * also carries rich content that has no column home: ingredient cards (with i18n
 * keys + claim pills), localized raw ingredients, route translations, line name,
 * marketing format copy. Wave 2 stores that here so the DB-backed read port can
 * reproduce the static `CatalogProduct` graph exactly (the parity gate), and the
 * seed (Wave 2b) is generated from the same static source via `serialize…`.
 *
 * Round-trip invariant: `read(serialize(p).content-wrapped) ⇒ the same content`.
 */
export interface CatalogMarketingContent {
  displayName: string;
  lineName: string;
  species: CatalogSpecies;
  route: { pl: string; en: string };
  composition: CatalogComposition;
  metadata: {
    format: string;
    kcalPer100g: number | null;
    legacyStatus: string | null;
  };
}

/** jsonb key under which the rich content lives in `marketing_content`. */
export const CATALOG_CONTENT_KEY = "content";

/** Produce the `marketing_content` object for a product (Wave 2b seed + tests). */
export function serializeCatalogProductContent(
  product: CatalogProduct,
): { [CATALOG_CONTENT_KEY]: CatalogMarketingContent } {
  return {
    [CATALOG_CONTENT_KEY]: {
      displayName: product.displayName,
      lineName: product.lineName,
      species: product.species,
      route: product.route,
      composition: product.composition,
      metadata: product.metadata,
    },
  };
}

/** Read rich content back from a `marketing_content` jsonb, or null if absent /
 *  structurally incomplete (older rows seeded before Wave 2 fall back). */
export function readCatalogMarketingContent(
  marketing: Record<string, unknown> | null | undefined,
): CatalogMarketingContent | null {
  if (!marketing || typeof marketing !== "object") return null;
  const raw = (marketing as Record<string, unknown>)[CATALOG_CONTENT_KEY];
  if (!raw || typeof raw !== "object") return null;

  const c = raw as Partial<CatalogMarketingContent>;
  if (
    typeof c.displayName !== "string" ||
    typeof c.lineName !== "string" ||
    typeof c.species !== "string" ||
    !c.route ||
    typeof c.route.pl !== "string" ||
    typeof c.route.en !== "string" ||
    !c.composition ||
    !Array.isArray(c.composition.items) ||
    !c.metadata
  ) {
    return null;
  }

  return c as CatalogMarketingContent;
}
