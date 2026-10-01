import { describe, expect, it } from "vitest";
import type { CatalogReadPort } from "../../../src/domains/catalog/ports.js";
import { CATALOG_SPECIES } from "../../../src/domains/catalog/types.js";
import { createLegacyCommerceQuoteCatalogReadPort } from "./commerceQuoteCatalogReadPort.js";

describe("legacy commerce quote catalog adapter", () => {
  it("exposes only narrow quote facts", async () => {
    const items = await createLegacyCommerceQuoteCatalogReadPort(
      catalogFixture({ kcalPer100g: 123 }),
    )
      .listQuoteCatalogItems();

    expect(items).toEqual([expect.objectContaining({
      skuCode: "opaque:neutral-launch.v1",
      productSlug: "neutral",
      species: CATALOG_SPECIES[0],
      isPrimarySku: true,
      energyPer100g: 123,
      sellability: { oneTime: true, subscription: true },
    })]);
  });

  it("preserves the legacy nullable-energy behavior", async () => {
    const items = await createLegacyCommerceQuoteCatalogReadPort(catalogFixture())
      .listQuoteCatalogItems();

    expect(items).toEqual([expect.objectContaining({
      skuCode: "opaque:neutral-launch.v1",
      productSlug: "neutral",
      energyPer100g: null,
    })]);
  });
});

function catalogFixture(composition?: { kcalPer100g: number | null }): CatalogReadPort {
  const products = [{
    slug: "neutral",
    species: CATALOG_SPECIES[0],
    composition,
    primarySku: { variantId: "neutral-400" },
    variants: [{
      sku: "opaque:neutral-launch.v1",
      variantId: "neutral-400",
      netWeightGrams: 400,
    }],
  }] as unknown as Awaited<ReturnType<CatalogReadPort["listProducts"]>>;
  return {
    async listProducts() { return products; },
    async getProductBySlug(slug) { return products.find((item) => item.slug === slug) ?? null; },
    async listAllergens() { return []; },
  };
}

describe("legacy commerce quote catalog adapter: stored sellability and the declared primary", () => {
  async function quoteFacts() {
    const products = [{
      slug: "neutral",
      species: CATALOG_SPECIES[0],
      primarySku: { variantId: "variant-b" },
      variants: [
        { sku: "SKU-A", variantId: "variant-a", sellability: { oneTime: true, subscription: false } },
        { sku: "SKU-B", variantId: "variant-b", sellability: { oneTime: false, subscription: true } },
        { sku: "SKU-C", variantId: "variant-c" },
      ],
    }] as unknown as Awaited<ReturnType<CatalogReadPort["listProducts"]>>;
    const items = await createLegacyCommerceQuoteCatalogReadPort({
      async listProducts() { return products; },
      async getProductBySlug() { return null; },
      async listAllergens() { return []; },
    }).listQuoteCatalogItems();
    return new Map(items.map((item) => [item.skuCode, item]));
  }

  it("passes each SKU's stored flags", async () => {
    const items = await quoteFacts();

    expect(items.get("SKU-A")?.sellability).toEqual({ oneTime: true, subscription: false });
    expect(items.get("SKU-B")?.sellability).toEqual({ oneTime: false, subscription: true });
  });

  it("treats a SKU without stored flags as sellable in both modes", async () => {
    expect((await quoteFacts()).get("SKU-C")?.sellability).toEqual({ oneTime: true, subscription: true });
  });

  it("marks only the declared primary as the primary SKU", async () => {
    const items = await quoteFacts();

    expect([...items.values()].filter((item) => item.isPrimarySku).map((item) => item.skuCode)).toEqual(["SKU-B"]);
  });
});
