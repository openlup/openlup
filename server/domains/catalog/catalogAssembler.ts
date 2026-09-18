import type {
  CatalogAllergenSlug,
  CatalogIngredientItem,
  CatalogProduct,
  CatalogProductSlug,
  CatalogPublicationStatus,
  CatalogSku,
} from "../../../src/domains/catalog/types.js";
import { CATALOG_ALLERGEN_SLUGS } from "../../../src/domains/catalog/types.js";
import { readCatalogMarketingContent } from "../../../src/domains/catalog/catalogContentSerialization.js";

/**
 * A product row as the read port projects it.
 *
 * The five required members are the ones the public platform manifest declared
 * from the start. `ingredients` and `marketing_content` joined them in the
 * attribute forward and both projections now ask for them; they stay optional so
 * a caller assembling a row by hand is not forced to supply them. `allergens`
 * remains overlay-only and OPTIONAL for the original reason: the neutral
 * projection does not ask for it at all, and a row shape that insisted on it
 * would make the read unrunnable on an adopter's schema rather than merely
 * poorer.
 */
export interface CatalogProductRow {
  id: string;
  slug: CatalogProductSlug;
  status: string;
  name: string;
  description: string | null;
  ingredients?: string[];
  allergens?: string[];
  marketing_content?: Record<string, unknown>;
}

/** Same rule as {@link CatalogProductRow}: declared columns required, overlay
 *  columns optional, so one assembler serves both projections. `net_weight_g` is
 *  declared on both schemas since the attribute forward and is read by both. */
export interface CatalogSkuRow {
  id: string;
  product_id: string;
  sku: string;
  title: string;
  status: string;
  is_addon: boolean;
  sellable_standalone: boolean;
  sellable_in_subscription: boolean;
  min_order_qty: number;
  pet_type?: string;
  net_weight_g?: number;
  format_code?: string | null;
  unit_form_code?: string | null;
  requires_pet_profile?: boolean;
}

/**
 * Build a CatalogProduct from a product row + its SKU rows.
 *
 * When the row carries rich Wave-2 `marketing_content.content`, the product's
 * content fields (displayName / lineName / species / route / composition /
 * metadata) are read back verbatim — this is what makes the DB-backed port
 * reproduce the static port exactly (parity gate). Rows seeded before Wave 2
 * (no `content`) fall back to the structural-only assembly used since W1, so the
 * live cron/subscription consumers are unaffected until the Wave 2b seed lands.
 */
export function assembleProduct(
  row: CatalogProductRow,
  skuRows: CatalogSkuRow[],
): CatalogProduct {
  const variants = skuRows.map((skuRow) => mapSku(skuRow, row.slug));
  const primarySku = variants[0] ?? makeEmptySku(row.slug);
  const publicationStatus = mapPublicationStatus(row.status);
  const content = readCatalogMarketingContent(row.marketing_content);

  if (content) {
    return {
      id: row.id,
      slug: row.slug,
      displayName: content.displayName,
      lineName: content.lineName,
      species: content.species,
      publicationStatus,
      route: content.route,
      primarySku,
      variants,
      composition: content.composition,
      metadata: content.metadata,
    };
  }

  // Structural fallback: no rich content, so the product is assembled from the
  // columns alone. Two consumers predate the public route (the cron name lookup,
  // which reads displayName, and the subscription re-pricer, which reads
  // kcal/weight); the third is the public listing, which is why the composition
  // below is built rather than left empty — a product whose composition has no
  // entries is refused by the response contract, so on this path "empty" and
  // "unpublishable" are the same state.
  //
  // `kcalPer100g` is `null` here BY CONSTRUCTION, and that is the point. Energy
  // has one authority — the published document's `energy.unscaled` — and this
  // function is handed a product row and its SKU rows, never a document. It used
  // to reconstruct kcal/100 g from `catalog_skus.kcal_per_unit / net_weight_g`,
  // which is a second answer derived from a column nothing keeps in step with the
  // document; the Postgres read never selected that column at all, so the two
  // bundles disagreed. Fail closed instead: a consumer that needs energy reads
  // the document, and one that cannot see it says so. Do not reintroduce a
  // column-derived value here — move the consumer to the document port.
  const declared = row.ingredients ?? [];
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.name,
    lineName: readMarketingString(row.marketing_content, "line_name") ?? "",
    species: "dog",
    publicationStatus,
    route: {
      pl: `/produkty/${row.slug}`,
      en: `/products/${row.slug}`,
    },
    primarySku,
    variants,
    composition: {
      rawIngredients: declared.join(", "),
      rawIngredientsEn: null,
      items: declared.map(toCompositionItem),
      allergenSlugs: toAllergenSlugs(row.allergens ?? []),
      kcalPer100g: null,
    },
    metadata: {
      format:
        readMarketingString(row.marketing_content, "format_marketing_copy") ?? "",
      kcalPer100g: null,
      legacyStatus: null,
    },
  };
}

function mapSku(row: CatalogSkuRow, productSlug: CatalogProductSlug): CatalogSku {
  return {
    sku: row.sku,
    productSlug,
    variantId: row.id,
    publicationStatus: mapPublicationStatus(row.status),
    unit: row.unit_form_code === "jar" ? "jar" : "can",
    netWeightGrams: row.net_weight_g ?? 0,
    isAddon: row.is_addon === true,
    pricing: {
      status: "not_configured",
      listPrice: null,
      taxCategory: "pet_food",
      externalRefs: {
        paymentProviderPriceId: null,
        inventoryProviderSku: null,
      },
    },
  };
}

function mapPublicationStatus(dbStatus: string): CatalogPublicationStatus {
  // 1:1 mapping. On the default (active-only) read path only `active` rows arrive,
  // so this maps them to `published`. On the includeArchived path (cron name lookup,
  // subscription re-pricer) draft/archived rows also arrive; they collapse to
  // `coming_soon` — a safe non-published value (those consumers read displayName/
  // kcal/weight, not publicationStatus, so the collapse is benign). Any unexpected
  // value also defaults to `coming_soon`: better to hide a SKU than publish one we
  // did not mean to release.
  if (dbStatus === "active") return "published";
  return "coming_soon";
}

function makeEmptySku(slug: CatalogProductSlug): CatalogSku {
  return {
    sku: `CATALOG-${slug.toUpperCase()}-PLACEHOLDER`,
    productSlug: slug,
    variantId: "",
    publicationStatus: "coming_soon",
    unit: "can",
    netWeightGrams: 0,
    isAddon: false,
    pricing: {
      status: "not_configured",
      listPrice: null,
      taxCategory: "pet_food",
      externalRefs: {
        paymentProviderPriceId: null,
        inventoryProviderSku: null,
      },
    },
  };
}

function readMarketingString(
  marketing: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = marketing?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A declared entry that ends in a share, e.g. `Barley 40%` or `Oats 7,5 %`. */
const DECLARED_SHARE = /^(.*\S)\s+([\d]+(?:[.,][\d]+)?\s*%)$/;

/**
 * One composition entry from one line of free text.
 *
 * The platform stores the operator's own wording and no numeric share column, so
 * a trailing share is read off the line when there is one and the line stands as
 * its own label when there is not. Nothing is invented: an entry that declares no
 * share reports `0`, which is what the contract's `nonnegative` means here, and
 * the role/body copy an overlay would carry stays empty rather than fabricated.
 */
function toCompositionItem(entry: string): CatalogIngredientItem {
  const share = DECLARED_SHARE.exec(entry);
  return {
    name: share?.[1] ?? entry,
    pctText: share?.[2] ?? entry,
    percentage: share ? Number.parseFloat(share[2]!.replace(",", ".")) : 0,
    role: "",
    body: "",
    allergenSlugs: [],
  };
}

function toAllergenSlugs(values: readonly string[]): CatalogAllergenSlug[] {
  const allowed = new Set<string>(CATALOG_ALLERGEN_SLUGS);
  return values.filter((value): value is CatalogAllergenSlug => allowed.has(value));
}
