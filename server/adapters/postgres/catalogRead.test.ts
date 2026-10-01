import { describe, expect, it } from "vitest";
import type { ResolvedPrice } from "../../../src/domains/pricing/types.js";
import { DEFAULT_CATALOG_PRICING_REGION } from "../../domains/catalog/catalogPricingJoin.js";
import { createPostgresCatalogReadPort } from "./catalogRead.js";
import type { PgQueryExecutor } from "./queryBuilder.js";

const PRODUCT_ID = "4f1c0e10-0001-4000-8000-000000000001";
const SMALL_SKU_ID = "4f1c0e10-0002-4000-8000-000000000001";
const LARGE_SKU_ID = "4f1c0e10-0002-4000-8000-000000000002";

function executor(primarySkuId: string | null = SMALL_SKU_ID): { sql: string[]; client: PgQueryExecutor } {
  const sql: string[] = [];
  return {
    sql,
    client: {
      async query(text) {
        sql.push(text);
        if (text.includes("catalog_products")) {
          return { rows: [{
            id: PRODUCT_ID,
            slug: "reference-alpha",
            status: "active",
            name: "Reference Alpha",
            description: null,
            ingredients: ["Barley 40%"],
            marketing_content: { line_name: "Reference", format_marketing_copy: "Box" },
            primary_sku_id: primarySkuId,
          }] };
        }
        return { rows: [
          {
            id: SMALL_SKU_ID,
            product_id: PRODUCT_ID,
            sku: "REFERENCE-ALPHA-S",
            title: "Reference Alpha, small",
            status: "active",
            net_weight_g: 400,
            is_addon: false,
            sellable_standalone: true,
            sellable_in_subscription: false,
            min_order_qty: 1,
          },
          {
            id: LARGE_SKU_ID,
            product_id: PRODUCT_ID,
            sku: "REFERENCE-ALPHA-L",
            title: "Reference Alpha, large",
            status: "active",
            net_weight_g: 800,
            is_addon: false,
            sellable_standalone: true,
            sellable_in_subscription: true,
            min_order_qty: 2,
          },
        ] };
      },
    },
  };
}

describe("Postgres catalog read adapter", () => {
  it("assembles the public catalog through direct parameterized SQL", async () => {
    const probe = executor();
    const products = await createPostgresCatalogReadPort(probe.client).listProducts();

    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({
      slug: "reference-alpha",
      displayName: "Reference Alpha",
      primarySku: { sku: "REFERENCE-ALPHA-S" },
      variants: [
        { variantId: SMALL_SKU_ID, netWeightGrams: 400 },
        { variantId: LARGE_SKU_ID, netWeightGrams: 800 },
      ],
    });
    expect(probe.sql).toHaveLength(2);
    expect(probe.sql.every((statement) => statement.includes("$1"))).toBe(true);
    expect(probe.sql.join("\n")).not.toContain("allergens");
    expect(probe.sql[1]).toContain("ORDER BY product_id, id");
  });

  it("uses one pinned exact batch authority for list and detail without changing the legacy generic seam", async () => {
    const probe = executor();
    const calls: Array<{ variantIds: readonly string[]; atTime: string }> = [];
    const exact = {
      async listExactOneTimeBasePrices(query: { variantIds: readonly string[]; atTime: string }) {
        calls.push(query);
        return new Map<string, ResolvedPrice>(query.variantIds.map((variantId) => [variantId, {
          variantId,
          mode: "one_time",
          matchedMinQty: 1,
          unitPriceMinor: variantId === SMALL_SKU_ID ? 1490 : 2490,
          amountKind: "gross",
          priceListId: "4f1c0e10-0003-4000-8000-000000000001",
          priceEntryId: `entry-${variantId}`,
          resolvedAt: query.atTime,
        }]));
      },
    };
    const port = createPostgresCatalogReadPort(probe.client, {
      exactListPriceReader: exact,
      exactListPriceAtTime: "2026-08-31T12:00:00.000Z",
    });

    const listed = await port.listProducts();
    const detail = await port.getProductBySlug("reference-alpha");
    const allergens = await port.listAllergens();

    expect(listed[0]?.primarySku.pricing.listPrice?.amountMinor).toBe(1490);
    expect(detail?.primarySku.pricing.listPrice?.amountMinor).toBe(1490);
    expect(allergens).toBeDefined();
    expect(calls).toEqual([
      { variantIds: [SMALL_SKU_ID, LARGE_SKU_ID], atTime: "2026-08-31T12:00:00.000Z", ...DEFAULT_CATALOG_PRICING_REGION },
      { variantIds: [SMALL_SKU_ID, LARGE_SKU_ID], atTime: "2026-08-31T12:00:00.000Z", ...DEFAULT_CATALOG_PRICING_REGION },
    ]);
  });

  it("selects the declared primary and carries each SKU's stored flags", async () => {
    const probe = executor();
    const [product] = await createPostgresCatalogReadPort(probe.client).listProducts();

    expect(probe.sql[0]).toContain("primary_sku_id");
    expect(product?.variants[0]?.sellability).toEqual({ oneTime: true, subscription: false });
    expect(product?.variants[1]?.sellability).toEqual({ oneTime: true, subscription: true });
  });

  it("takes the declared primary, not the lowest SKU id", async () => {
    const [product] = await createPostgresCatalogReadPort(executor(LARGE_SKU_ID).client).listProducts();

    expect(product?.primarySku.sku).toBe("REFERENCE-ALPHA-L");
    expect(product?.variants.map((variant) => variant.variantId)).toEqual([SMALL_SKU_ID, LARGE_SKU_ID]);
  });

  it("refuses an active product without a declared primary on every sellable read", async () => {
    const port = createPostgresCatalogReadPort(executor(null).client);
    const refusal = {
      name: "CatalogPrimarySkuUnresolvedError",
      code: "catalog_primary_sku_unresolved",
      productSlug: "reference-alpha",
      reason: "primary_sku_missing",
    };

    await expect(port.listProducts()).rejects.toMatchObject(refusal);
    await expect(port.getProductBySlug("reference-alpha")).rejects.toMatchObject(refusal);
    await expect(port.listAllergens()).rejects.toMatchObject(refusal);
  });

  it("keeps the placeholder on the historical read", async () => {
    const [product] = await createPostgresCatalogReadPort(executor(null).client, { includeArchived: true })
      .listProducts();

    expect(product?.primarySku).toMatchObject({ variantId: "", publicationStatus: "coming_soon" });
    expect(product?.variants).toHaveLength(2);
  });
});
