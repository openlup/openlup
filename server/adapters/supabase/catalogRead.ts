import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CatalogAllergen,
  CatalogProduct,
  CatalogProductSlug,
} from "../../../src/domains/catalog/types.js";
import type { CatalogReadPort } from "../../../src/domains/catalog/ports.js";
import type { PricingResolverPort } from "../../../src/domains/pricing/ports.js";
import {
  type CatalogPricingRegion,
  joinCatalogPricing,
} from "../../domains/catalog/catalogPricingJoin.js";
import {
  CATALOG_ALLERGEN_REGISTRY,
  deriveCatalogAllergens,
} from "../../../src/domains/catalog/allergenRegistry.js";
import {
  assembleProduct,
  type CatalogProductRow,
  type CatalogSkuRow,
} from "../../domains/catalog/catalogAssembler.js";

/**
 * Query-shim-shaped implementation of {@link CatalogReadPort}.
 *
 * Reads `catalog_products` + `catalog_skus` and assembles a {@link CatalogProduct}
 * graph via {@link assembleProduct}. When a row carries Wave-2
 * `marketing_content.content`, the rich content (composition.items, route
 * translations, localized copy) is reproduced verbatim so the DB-backed port
 * matches the static port (parity gate, `catalogReadParity.test.ts`); older rows
 * fall back to structural-only assembly.
 *
 * Mounted storefront discovery uses the strict overlay composition root. This
 * adapter remains the managed request-scoped catalog binding.
 */
/**
 * Which columns the read asks for.
 *
 * `full` is the shipped projection: every column the managed chain declares.
 * `neutral` is the subset the public platform manifest declares, and it is the
 * only one an adopter's database can answer — asking for a column that is not
 * there fails the whole read, so this is a portability property, not a tuning
 * knob. Nothing downstream branches on it: the assembler already treats the
 * columns outside the neutral set as optional.
 *
 * The neutral set is a strict subset of the full one, and it has to stay that
 * way: the discovery harness serves BOTH bundles through this projection, so a
 * column only one schema has would fail half the proof on contact. That is why
 * the attribute forward reused three names the managed chain already carried
 * rather than inventing better ones.
 */
export type CatalogReadProjection = "full" | "neutral";

const PRODUCT_COLUMNS: Record<CatalogReadProjection, string> = {
  full: "id, slug, status, name, description, ingredients, allergens, marketing_content",
  neutral: "id, slug, status, name, description, ingredients, marketing_content",
};

/**
 * `full` deliberately does NOT ask for the per-unit energy column
 * (`catalog_skus.kcal_per_unit`), and neither does the Postgres twin. Energy is
 * the published document's `energy.unscaled` (per 100 g) scaled by the SKU's net
 * weight, which is how the money path reads it; the column is a stale duplicate
 * this projection stopped reproducing, so a row with no rich content now reports
 * a null energy rather than a number derived from a copy nothing keeps in step.
 * The neighbouring per-unit ration column went with it for the plainer reason
 * that no consumer ever read it.
 */
const SKU_COLUMNS: Record<CatalogReadProjection, string> = {
  full: "id, product_id, sku, title, pet_type, status, net_weight_g, format_code, unit_form_code, "
    + "is_addon, sellable_standalone, sellable_in_subscription, requires_pet_profile, min_order_qty",
  neutral: "id, product_id, sku, title, status, net_weight_g, is_addon, sellable_standalone, "
    + "sellable_in_subscription, min_order_qty",
};

export interface SupabaseCatalogReadPortDeps {
  client: SupabaseClient;
  /** Defaults to the shipped `full` projection; see {@link CatalogReadProjection}. */
  projection?: CatalogReadProjection;
  /**
   * When false (default) the port returns only `status = 'active'` products and
   * SKUs — the sellable catalog (storefront, recommendation, quote, checkout).
   *
   * When true the port also returns draft/archived rows. Used ONLY by the two
   * "historical" consumers that must resolve a product/variant a customer
   * already committed to even after it leaves the sellable set:
   *   - the order-email product-name lookup (cron), and
   *   - the subscription re-pricer (an existing line may reference an archived SKU;
   *     `catalogBackedPackageSizingPort` throws `unknown_variant` if it can't be
   *     resolved).
   * Today every catalog row is `active`, so this flag is behaviour-neutral; it
   * exists so those paths do not break once Wave 4 introduces non-active rows.
   */
  includeArchived?: boolean;
  /**
   * Optional live-pricing overlay. When set, resolved one-time list prices are
   * joined onto each SKU (`pricing.status = "configured"`); when absent (default)
   * every SKU stays `not_configured` — the structural read that keeps parity with
   * the static port. The resolver adapter is constructed + injected by the BFF
   * layer (gated on `COMMERCE_V2_W2_PRICING_RESOLVER`), so the catalog domain never
   * imports a cross-domain adapter. See {@link joinCatalogPricing}.
   */
  pricingResolver?: PricingResolverPort;
  /** Region/currency for the pricing overlay; defaults to PL/PLN. */
  pricingRegion?: CatalogPricingRegion;
}

export function createSupabaseCatalogReadPort({
  client,
  includeArchived = false,
  pricingResolver,
  pricingRegion,
  projection = "full",
}: SupabaseCatalogReadPortDeps): CatalogReadPort {
  async function withPricing(products: CatalogProduct[]): Promise<CatalogProduct[]> {
    if (!pricingResolver) return products;
    return joinCatalogPricing(products, pricingResolver, pricingRegion);
  }

  // Structural assembly (no pricing overlay) shared by listProducts (which then
  // applies pricing) and listAllergens (which derives the registry from composition
  // and needs no prices).
  async function assembleAllProducts(): Promise<CatalogProduct[]> {
    const [products, skusByProductId] = await Promise.all([
      fetchProducts(client, undefined, includeArchived, projection),
      fetchSkusByProductId(client, undefined, includeArchived, projection),
    ]);
    return products.map((row) => assembleProduct(row, skusByProductId.get(row.id) ?? []));
  }

  return {
    async listProducts(): Promise<CatalogProduct[]> {
      return withPricing(await assembleAllProducts());
    },

    async getProductBySlug(slug: CatalogProductSlug): Promise<CatalogProduct | null> {
      const products = await fetchProducts(client, slug, includeArchived, projection);
      const product = products[0];
      if (!product) return null;
      const skusByProductId = await fetchSkusByProductId(client, product.id, includeArchived, projection);
      const assembled = assembleProduct(product, skusByProductId.get(product.id) ?? []);
      const [withPrice] = await withPricing([assembled]);
      return withPrice;
    },

    async listAllergens(): Promise<CatalogAllergen[]> {
      // The allergen taxonomy (slug/name/nameEn/category) is reference data with no
      // DB table; the product↔allergen links are derived from each product's
      // composition, which IS in the DB. Sharing the registry + derivation with the
      // static port keeps the two byte-identical (catalogReadParity.test.ts). Uses
      // the un-priced assembly — allergens never need prices.
      return deriveCatalogAllergens(CATALOG_ALLERGEN_REGISTRY, await assembleAllProducts());
    },
  };
}

async function fetchProducts(
  client: SupabaseClient,
  slug?: CatalogProductSlug,
  includeArchived = false,
  projection: CatalogReadProjection = "full",
): Promise<CatalogProductRow[]> {
  let query = client
    .from("catalog_products")
    .select(PRODUCT_COLUMNS[projection]);

  // Sellable-catalog default: never leak draft/archived products. The chokepoint
  // lives here (not per-route) so every consumer is active-only unless it opts in.
  if (!includeArchived) {
    query = query.eq("status", "active");
  }

  if (slug) {
    query = query.eq("slug", slug);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`catalog_products read failed: ${error.message}`);
  }
  return (data ?? []) as unknown as CatalogProductRow[];
}

async function fetchSkusByProductId(
  client: SupabaseClient,
  productId?: string,
  includeArchived = false,
  projection: CatalogReadProjection = "full",
): Promise<Map<string, CatalogSkuRow[]>> {
  let query = client
    .from("catalog_skus")
    .select(SKU_COLUMNS[projection]);

  // Same sellable-catalog chokepoint as fetchProducts: active-only by default.
  if (!includeArchived) {
    query = query.eq("status", "active");
  }

  if (productId) {
    query = query.eq("product_id", productId);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`catalog_skus read failed: ${error.message}`);
  }

  const rows = (data ?? []) as unknown as CatalogSkuRow[];
  const byProductId = new Map<string, CatalogSkuRow[]>();
  for (const row of rows) {
    const bucket = byProductId.get(row.product_id) ?? [];
    bucket.push(row);
    byProductId.set(row.product_id, bucket);
  }
  return byProductId;
}
