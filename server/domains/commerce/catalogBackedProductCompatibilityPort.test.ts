import { describe, expect, it } from "vitest";

import type { CatalogReadPort } from "../../../src/domains/catalog/ports.js";
import type {
  CatalogProduct,
  CatalogProductSlug,
} from "../../../src/domains/catalog/types.js";
import type {
  CommerceOfferAvailability,
  CommerceOfferAvailabilityRequestItem,
} from "../../../src/domains/commerce/offerAvailabilityContracts.js";
import type { CommerceOfferAvailabilityPort } from "../../../src/domains/commerce/ports.js";
import {
  createCatalogBackedProductCompatibilityPort,
  createVariantBackedProductCompatibilityPort,
} from "./catalogBackedProductCompatibilityPort.js";
import { createCatalogRecommendationVariantReadPort } from "./catalogRecommendationVariants.js";

describe("catalog backed product compatibility port", () => {
  it("returns the full six-SKU compatibility matrix", async () => {
    const response = await createCatalogBackedProductCompatibilityPort(catalogPort()).getCompatibility({
      allergenSlugs: ["chicken"],
    });

    expect(response.products).toHaveLength(6);
    expect(response.products.find((product) => product.slug === "salmon")).toMatchObject({
      selectable: false,
      conflictAllergenSlugs: ["chicken"],
    });
    expect(response.products.find((product) => product.slug === "turkey")).toMatchObject({
      selectable: true,
      conflictAllergenSlugs: [],
    });
  });

  it("treats salmon oil as distinct from salmon", async () => {
    const salmonResponse = await createCatalogBackedProductCompatibilityPort(catalogPort()).getCompatibility({
      allergenSlugs: ["salmon"],
    });

    expect(salmonResponse.products.find((product) => product.slug === "salmon")).toMatchObject({
      selectable: false,
      conflictAllergenSlugs: ["salmon"],
    });
    expect(salmonResponse.products.find((product) => product.slug === "turkey")).toMatchObject({
      selectable: true,
      conflictAllergenSlugs: [],
    });

    const salmonOilResponse = await createCatalogBackedProductCompatibilityPort(catalogPort()).getCompatibility({
      allergenSlugs: ["salmon_oil"],
    });

    expect(salmonOilResponse.products.every((product) => product.selectable === false)).toBe(true);
    expect(
      salmonOilResponse.products.every((product) =>
        product.conflictAllergenSlugs.includes("salmon_oil"),
      ),
    ).toBe(true);
  });

  it("blocks only venison when pumpkin allergy is selected", async () => {
    const response = await createCatalogBackedProductCompatibilityPort(catalogPort()).getCompatibility({
      allergenSlugs: ["pumpkin"],
    });

    expect(response.products.find((product) => product.slug === "venison")).toMatchObject({
      selectable: false,
      conflictAllergenSlugs: ["pumpkin"],
    });
    for (const slug of ["lamb", "beef", "turkey", "salmon", "pork"]) {
      expect(response.products.find((product) => product.slug === slug)).toMatchObject({
        selectable: true,
        conflictAllergenSlugs: [],
      });
    }
  });

  it("includes offer availability visibility for configurator filtering", async () => {
    const response = await createCatalogBackedProductCompatibilityPort(
      catalogPort(),
      availabilityPort({
        "opaque:lamb-launch.v1": "low_stock",
        "opaque:salmon-launch.v1": "out_of_stock",
      }),
    ).getCompatibility({
      allergenSlugs: [],
    });

    expect(response.products.find((product) => product.slug === "lamb")).toMatchObject({
      purchaseAvailability: "low_stock",
      visibleInConfigurator: true,
    });
    expect(response.products.find((product) => product.slug === "salmon")).toMatchObject({
      purchaseAvailability: "out_of_stock",
      visibleInConfigurator: false,
    });
  });

  it("fails closed when the catalog has no active variants", async () => {
    await expect(
      createCatalogBackedProductCompatibilityPort(emptyCatalogPort()).getCompatibility({
        allergenSlugs: [],
      }),
    ).rejects.toThrow("Catalog has no active products");
  });

  it("accepts the shared narrow variant-reader contract", async () => {
    const variants = createCatalogRecommendationVariantReadPort(catalogPort());

    await expect(createVariantBackedProductCompatibilityPort(variants).getCompatibility({
      allergenSlugs: ["lamb"],
    })).resolves.toMatchObject({
      products: expect.arrayContaining([expect.objectContaining({ slug: "lamb", selectable: false })]),
    });
  });

});

function catalogPort(): CatalogReadPort {
  return {
    async listProducts() {
      return [
        product("lamb", ["lamb", "salmon_oil", "yeast"]),
        product("venison", ["venison", "salmon_oil", "pumpkin", "yeast"]),
        product("beef", ["beef", "salmon_oil", "carrot", "yeast"]),
        product("turkey", ["turkey", "salmon_oil", "apple", "yeast"]),
        product("salmon", ["salmon", "salmon_oil", "chicken", "carrot", "yeast"]),
        product("pork", ["pork", "salmon_oil", "sweet_potato", "yeast"]),
      ];
    },
    async getProductBySlug() {
      return product("lamb", ["lamb", "salmon_oil", "yeast"]);
    },
    async listAllergens() {
      return [];
    },
  };
}

function emptyCatalogPort(): CatalogReadPort {
  return {
    async listProducts() {
      return [];
    },
    async getProductBySlug() {
      return null;
    },
    async listAllergens() {
      return [];
    },
  };
}

function product(
  slug: CatalogProductSlug,
  allergenSlugs: CatalogProduct["composition"]["allergenSlugs"],
): CatalogProduct {
  return {
    id: `product-${slug}`,
    slug,
    displayName: slug,
    lineName: "openlup",
    species: "dog",
    publicationStatus: "published",
    route: { pl: `/psy/${slug}`, en: `/dogs/${slug}` },
    primarySku: sku(slug),
    variants: [sku(slug)],
    composition: { rawIngredients: "", rawIngredientsEn: null, items: [], allergenSlugs, kcalPer100g: 123 },
    metadata: { format: "can", kcalPer100g: 123, legacyStatus: null },
  };
}

function sku(slug: CatalogProductSlug) {
  return {
    sku: `opaque:${slug}-launch.v1`,
    productSlug: slug,
    variantId: `variant-${slug}-400`,
    publicationStatus: "published" as const,
    unit: "can" as const,
    netWeightGrams: 400,
    pricing: {
      status: "configured" as const,
      listPrice: { amountMinor: 1490, currency: "PLN" as const },
      taxCategory: "pet_food" as const,
      externalRefs: { paymentProviderPriceId: null, inventoryProviderSku: null },
    },
  };
}

function availabilityPort(
  statuses: Record<string, CommerceOfferAvailability["status"]>,
): CommerceOfferAvailabilityPort {
  return {
    async getAvailability({ items }) {
      return items.map((item) => availability(item, statuses[item.sku] ?? "available"));
    },
  };
}

function availability(
  item: CommerceOfferAvailabilityRequestItem,
  status: CommerceOfferAvailability["status"],
): CommerceOfferAvailability {
  return {
    sku: item.sku,
    productSlug: item.productSlug,
    variantId: item.variantId,
    status,
    visibleInConfigurator: status !== "out_of_stock",
    sellableNow: status === "out_of_stock" ? 0 : status === "low_stock" ? 2 : 10,
    reasonCode: status,
    source: "test",
  };
}
