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
