import { describe, expect, it } from "vitest";
import { CatalogPrimarySkuUnresolvedError } from "../../../src/domains/catalog/ports.js";
import { catalogSkuEnvelopeFixture } from "../../adapters/catalogSkuEnvelope.fixture.js";
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

  it("resolves the declared primary SKU", () => {
    const product = assembleProduct(productRow({ primary_sku_id: "sku-1" }), [skuRow()]);

    expect(product.primarySku.sku).toBe("CORE-SKU-BEEF-400G");
    expect(product.primarySku.publicationStatus).toBe("published");
    expect(product.variants).toHaveLength(1);
  });
});

// One product with three SKU rows, listed in ascending id order; its declared
// primary is not the lowest id, so no row position passes for it.
const envelope = catalogSkuEnvelopeFixture.products[0]!;
const envelopeRows: CatalogSkuRow[] = catalogSkuEnvelopeFixture.supabaseSkus.map((row) => ({
  ...row,
  title: row.sku,
  min_order_qty: 1,
}));
const FOREIGN_SKU_ID = "44444444-4444-4444-8444-444444444444";

function envelopeProduct(overrides: Partial<CatalogProductRow> = {}): CatalogProductRow {
  return productRow({
    id: envelope.id,
    slug: envelope.slug,
    primary_sku_id: envelope.primary_sku_id,
    ...overrides,
  });
}

function refusalOf(assemble: () => unknown): CatalogPrimarySkuUnresolvedError {
  try {
    assemble();
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogPrimarySkuUnresolvedError);
    return error as CatalogPrimarySkuUnresolvedError;
  }
  throw new Error("expected the assembly to refuse");
}

function everyOrder<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    everyOrder([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

describe("assembleProduct: declared primary and stored sellability", () => {
  it("resolves the declared primary for every row order and lists variants by SKU id", () => {
    const ids = envelopeRows.map((row) => row.id);
    expect(ids).toEqual([...ids].sort());
    expect(ids.indexOf(envelope.primary_sku_id)).toBeGreaterThan(0);

    const orders = everyOrder(envelopeRows);
    expect(orders).toHaveLength(6);
    for (const rows of orders) {
      const product = assembleProduct(envelopeProduct(), rows);
      expect(product.primarySku.variantId).toBe(envelope.primary_sku_id);
      expect(product.variants.map((variant) => variant.variantId)).toEqual(ids);
    }
  });

  it("refuses an active product with SKU rows and no declared primary, a single row included", () => {
    for (const rows of [envelopeRows, envelopeRows.slice(0, 1)]) {
      for (const primary of [null, undefined]) {
        expect(refusalOf(() => assembleProduct(envelopeProduct({ primary_sku_id: primary }), rows))).toMatchObject({
          code: "catalog_primary_sku_unresolved",
          productSlug: envelope.slug,
          reason: "primary_sku_missing",
        });
      }
    }
  });

  it("refuses a declared primary that is none of the product's rows", () => {
    expect(refusalOf(() => assembleProduct(envelopeProduct({ primary_sku_id: FOREIGN_SKU_ID }), envelopeRows)))
      .toMatchObject({ productSlug: envelope.slug, reason: "primary_sku_not_in_rows" });
  });

  it("keeps the placeholder for a product without SKU rows, with or without a declared primary", () => {
    for (const primary of [null, envelope.primary_sku_id]) {
      const product = assembleProduct(envelopeProduct({ primary_sku_id: primary }), []);

      expect(product.primarySku).toMatchObject({ variantId: "", publicationStatus: "coming_soon" });
      expect(product.primarySku).not.toHaveProperty("sellability");
      expect(product.variants).toEqual([]);
    }
  });

  it("keeps the placeholder for a product that is not active and declares no primary", () => {
    for (const status of ["draft", "archived"]) {
      const product = assembleProduct(envelopeProduct({ status, primary_sku_id: null }), envelopeRows);

      expect(product.primarySku.variantId).toBe("");
      expect(product.variants).toHaveLength(3);
    }
  });

  it("never refuses on the historical read, and still resolves a declared primary there", () => {
    const historical = { unresolvedPrimary: "placeholder" } as const;
    for (const primary of [null, FOREIGN_SKU_ID]) {
      expect(assembleProduct(envelopeProduct({ primary_sku_id: primary }), envelopeRows, historical)
        .primarySku.variantId).toBe("");
    }
    expect(assembleProduct(envelopeProduct(), envelopeRows, historical).primarySku.variantId)
      .toBe(envelope.primary_sku_id);
  });

  it("carries each SKU's stored flags, and a null flag fails closed", () => {
    const [first, second, third] = envelopeRows;
    const product = assembleProduct(envelopeProduct(), [
      { ...first!, sellable_standalone: true, sellable_in_subscription: false },
      { ...second!, sellable_standalone: false, sellable_in_subscription: true },
      { ...third!, sellable_standalone: null as unknown as boolean, sellable_in_subscription: null as unknown as boolean },
    ]);

    expect(product.variants.map((variant) => variant.sellability)).toEqual([
      { oneTime: true, subscription: false },
      { oneTime: false, subscription: true },
      { oneTime: false, subscription: false },
    ]);
    expect(product.primarySku.sellability).toEqual({ oneTime: false, subscription: true });
  });
});
