import type {
  CatalogAllergen,
  CatalogProduct,
  CatalogProductSlug,
} from "../../../src/domains/catalog/types.js";
import type { CatalogReadPort } from "../../../src/domains/catalog/ports.js";
import type { PricingResolverPort } from "../../../src/domains/pricing/ports.js";
import {
  CATALOG_ALLERGEN_REGISTRY,
  deriveCatalogAllergens,
} from "../../../src/domains/catalog/allergenRegistry.js";
import {
  assembleProduct,
  type CatalogProductRow,
  type CatalogSkuRow,
} from "../../domains/catalog/catalogAssembler.js";
import {
  joinCatalogListPricing,
  joinCatalogPricing,
  type CatalogExactOneTimeBasePriceReadPort,
  type CatalogPricingRegion,
} from "../../domains/catalog/catalogPricingJoin.js";
import type { PgQueryExecutor } from "./queryBuilder.js";

export interface PostgresCatalogReadOptions {
  includeArchived?: boolean;
  /** Bounded public-discovery authority; never enables generic tier/`any` selection. */
  exactListPriceReader?: CatalogExactOneTimeBasePriceReadPort;
  exactListPriceAtTime?: string;
  pricingResolver?: PricingResolverPort;
  pricingRegion?: CatalogPricingRegion;
}

const PRODUCT_SQL = `
  SELECT id, slug, status, name, description, ingredients, marketing_content
  FROM public.catalog_products
  WHERE ($1::boolean OR status = 'active')
    AND ($2::text IS NULL OR slug = $2)
  ORDER BY slug, id`;

const SKU_SQL = `
  SELECT id, product_id, sku, title, status, net_weight_g,
    is_addon, sellable_standalone, sellable_in_subscription, min_order_qty
  FROM public.catalog_skus
  WHERE ($1::boolean OR status = 'active')
    AND ($2::uuid IS NULL OR product_id = $2)
  ORDER BY product_id, id`;

export function createPostgresCatalogReadPort(
  executor: PgQueryExecutor,
  {
    includeArchived = false,
    exactListPriceReader,
    exactListPriceAtTime,
    pricingResolver,
    pricingRegion,
  }: PostgresCatalogReadOptions = {},
): CatalogReadPort {
  const pinnedExactListPriceAtTime = exactListPriceReader
    ? exactListPriceAtTime ?? new Date().toISOString()
    : null;

  async function withPricing(products: CatalogProduct[]): Promise<CatalogProduct[]> {
    if (exactListPriceReader && pinnedExactListPriceAtTime) {
      return joinCatalogListPricing(
        products,
        exactListPriceReader,
        pricingRegion,
        pinnedExactListPriceAtTime,
      );
    }
    return pricingResolver ? joinCatalogPricing(products, pricingResolver, pricingRegion) : products;
  }

  async function products(slug?: CatalogProductSlug): Promise<CatalogProductRow[]> {
    const result = await executor.query(PRODUCT_SQL, [includeArchived, slug ?? null]);
    return result.rows as unknown as CatalogProductRow[];
  }

  async function skus(productId?: string): Promise<Map<string, CatalogSkuRow[]>> {
    const result = await executor.query(SKU_SQL, [includeArchived, productId ?? null]);
    const grouped = new Map<string, CatalogSkuRow[]>();
    for (const row of result.rows as unknown as CatalogSkuRow[]) {
      const bucket = grouped.get(row.product_id) ?? [];
      bucket.push(row);
      grouped.set(row.product_id, bucket);
    }
    return grouped;
  }

  async function assembleAll(): Promise<CatalogProduct[]> {
    const [productRows, skusByProduct] = await Promise.all([products(), skus()]);
    return productRows.map((row) => assembleProduct(row, skusByProduct.get(row.id) ?? []));
  }

  return {
    async listProducts(): Promise<CatalogProduct[]> {
      return withPricing(await assembleAll());
    },

    async getProductBySlug(slug: CatalogProductSlug): Promise<CatalogProduct | null> {
      const product = (await products(slug))[0];
      if (!product) return null;
      const variants = await skus(product.id);
      const [resolved] = await withPricing([
        assembleProduct(product, variants.get(product.id) ?? []),
      ]);
      return resolved ?? null;
    },

    async listAllergens(): Promise<CatalogAllergen[]> {
      return deriveCatalogAllergens(CATALOG_ALLERGEN_REGISTRY, await assembleAll());
    },
  };
}
