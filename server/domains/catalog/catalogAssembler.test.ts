import { describe, expect, it } from "vitest";
import {
  assembleProduct,
  type CatalogProductRow,
  type CatalogSkuRow,
} from "./catalogAssembler.js";

function productRow(overrides: Partial<CatalogProductRow> = {}): CatalogProductRow {
  return {
    id: "product-1",
    slug: "beef",
    status: "active",
    name: "Example recipe",
    description: null,
    ingredients: [],
    allergens: [],
    marketing_content: {},
    ...overrides,
  };
}

function skuRow(overrides: Partial<CatalogSkuRow> = {}): CatalogSkuRow {
  return {
    id: "sku-1",
    product_id: "product-1",
    sku: "CORE-SKU-BEEF-400G",
    title: "Example recipe",
    pet_type: "dog",
    status: "active",
    net_weight_g: 400,
    format_code: "can",
    unit_form_code: "can",
    is_addon: false,
    sellable_standalone: true,
    sellable_in_subscription: true,
    requires_pet_profile: false,
    min_order_qty: 1,
    ...overrides,
  };
}

describe("assembleProduct", () => {
  it("uses a neutral placeholder SKU when a product has no SKU rows", () => {
    const product = assembleProduct(productRow(), []);

    expect(product.primarySku).toMatchObject({
      sku: "CATALOG-BEEF-PLACEHOLDER",
      productSlug: "beef",
      publicationStatus: "coming_soon",
      netWeightGrams: 0,
    });
    expect(product.variants).toEqual([]);
  });

  it("uses the first real SKU as the primary SKU when rows exist", () => {
    const product = assembleProduct(productRow(), [skuRow()]);

    expect(product.primarySku.sku).toBe("CORE-SKU-BEEF-400G");
    expect(product.primarySku.publicationStatus).toBe("published");
    expect(product.variants).toHaveLength(1);
  });
});
