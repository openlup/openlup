import { describe, expect, it, vi } from "vitest";
import type { CatalogReadPort } from "../../../src/domains/catalog/ports.js";
import type { CatalogProduct } from "../../../src/domains/catalog/types.js";
import type {
  CommercePackageQuantityPolicy,
  RecommendedCartLine,
} from "../../../src/domains/commerce/recommendationPolicyDeps.js";
import type { CommerceOfferAvailabilityPort } from "../../../src/domains/commerce/ports.js";
import { createCatalogBackedPackageSizingPort } from "./catalogBackedPackageSizingPort.js";

describe("catalog backed package sizing port", () => {
  it("keeps legacy add-ons out of selection ids", async () => {
    const catalog = product("lamb", ["lamb"]);
    catalog.variants.push({
      ...catalog.variants[0]!,
      variantId: "variant-addon-400",
      sku: "SKU-ADDON-400",
      isAddon: true,
    });
    const catalogReadPort: CatalogReadPort = {
      listProducts: vi.fn(async () => [catalog]),
      getProductBySlug: vi.fn(async () => catalog),
      listAllergens: vi.fn(async () => []),
    };

    const port = createCatalogBackedPackageSizingPort({
      catalogReadPort,
      packageQuantityPolicy: vi.fn<CommercePackageQuantityPolicy>(() => quantityResult(1)),
    });

    await expect(port.recipeVariantIds()).resolves.toEqual(new Set(["variant-lamb-400"]));
  });

  it("uses strict quote facts for subscription sizing without rebuilding CatalogProduct", async () => {
    const listQuoteCatalogItems = vi.fn(async () => [
      {
        skuId: "variant-lamb-400",
        skuCode: "opaque:lamb-launch.v1",
        variantId: "variant-lamb-400",
        productSlug: "lamb",
        netWeightG: 400,
        energyPer100g: 123,
        allergenSlugs: ["lamb"],
        isAddon: false,
        sellability: { oneTime: true, subscription: true },
        documentRevision: { id: "revision", digest: "a".repeat(64) },
      },
      {
        skuId: "variant-addon-400",
        skuCode: "opaque:addon-launch.v1",
        variantId: "variant-addon-400",
        productSlug: "addon",
        netWeightG: 400,
        energyPer100g: 123,
        allergenSlugs: [],
        isAddon: true,
        sellability: { oneTime: true, subscription: true },
        documentRevision: { id: "revision", digest: "b".repeat(64) },
      },
    ]);
    const packageQuantityPolicy = vi.fn<CommercePackageQuantityPolicy>(() => quantityResult(1));
    const port = createCatalogBackedPackageSizingPort({
      quoteCatalogReadPort: { listQuoteCatalogItems },
      packageQuantityPolicy,
    });

    await expect(port.recipeVariantIds()).resolves.toEqual(new Set(["variant-lamb-400"]));
    await expect(port.recomputeRecipeQuantities({
      recipeVariantIds: ["variant-lamb-400"],
      currentRecipes: [{ variantId: "variant-lamb-400", qty: 1 }],
      dailyKcal: 100,
      planDays: 1,
    })).resolves.toMatchObject({ totalUnits: 1, maxExceeded: false });
    expect(packageQuantityPolicy).toHaveBeenCalledWith([
      expect.objectContaining({ allergenSlugs: ["lamb"] }),
    ], 100, 1, { stockBounded: false });
  });

  it("passes package sizing through an injected policy", async () => {
    const input = {
      recipeVariantIds: ["variant-lamb-400", "variant-venison-400"],
      currentRecipes: [
        { variantId: "variant-lamb-400", qty: 8 },
        { variantId: "variant-venison-400", qty: 6 },
      ],
      dailyKcal: 613,
      planDays: 14,
    };
    const packageQuantityPolicy = vi.fn<CommercePackageQuantityPolicy>((variants) => ({
      lines: variants.map((variant): RecommendedCartLine => ({
        variantId: variant.variantId,
        sku: variant.sku,
        slug: variant.slug,
        qty: 9,
        netWeightG: variant.netWeightG,
        kcalPerUnit: Math.round((variant.kcalPer100g * variant.netWeightG) / 100),
        allergenSlugs: [...variant.allergenSlugs],
      })),
      totalUnits: 18,
      totalWeightG: 7200,
      totalKcal: 8856,
      feedingDays: 14.4,
      dailyGrams: 500,
      minimumApplied: false,
      largeQuantityWarning: false,
      maxExceeded: false,
      rebalanced: false,
      stockClamped: false,
      stockConstrained: false,
    }));

    const result = await createCatalogBackedPackageSizingPort({
      catalogReadPort: catalogPort(),
      packageQuantityPolicy,
    }).recomputeRecipeQuantities(input);

    expect(result).toEqual({
      recipes: [
        { variantId: "variant-lamb-400", qty: 10 },
        { variantId: "variant-venison-400", qty: 8 },
      ],
      totalUnits: 18,
      maxExceeded: false,
    });
    expect(packageQuantityPolicy).toHaveBeenCalledTimes(1);
    expect(packageQuantityPolicy.mock.calls[0]?.[0].map((variant) => variant.variantId)).toEqual(
      input.recipeVariantIds,
    );
    expect(packageQuantityPolicy.mock.calls[0]?.[1]).toBe(input.dailyKcal);
    expect(packageQuantityPolicy.mock.calls[0]?.[2]).toBe(input.planDays);
  });

  it("scales the customer's current mix with largest remainder instead of resetting it evenly", async () => {
    const packageQuantityPolicy = vi.fn<CommercePackageQuantityPolicy>(() => quantityResult(15));

    const result = await createCatalogBackedPackageSizingPort({
      catalogReadPort: catalogPort(),
      packageQuantityPolicy,
    }).recomputeRecipeQuantities({
      recipeVariantIds: ["variant-lamb-400", "variant-venison-400"],
      currentRecipes: [
        { variantId: "variant-lamb-400", qty: 8 },
        { variantId: "variant-venison-400", qty: 6 },
      ],
      dailyKcal: 300,
      planDays: 14,
    });

    expect(result).toEqual({
      recipes: [
        { variantId: "variant-lamb-400", qty: 9 },
        { variantId: "variant-venison-400", qty: 6 },
      ],
      totalUnits: 15,
      maxExceeded: false,
    });
  });

  it("keeps every selected item and respects the 99-unit per-variant limit", async () => {
    const packageQuantityPolicy = vi.fn<CommercePackageQuantityPolicy>(() => quantityResult(198));

    const result = await createCatalogBackedPackageSizingPort({
      catalogReadPort: catalogPort(),
      packageQuantityPolicy,
    }).recomputeRecipeQuantities({
      recipeVariantIds: ["variant-lamb-400", "variant-venison-400"],
      currentRecipes: [
        { variantId: "variant-lamb-400", qty: 99 },
        { variantId: "variant-venison-400", qty: 1 },
      ],
      dailyKcal: 6_000,
      planDays: 14,
    });

    expect(result.recipes).toEqual([
      { variantId: "variant-lamb-400", qty: 99 },
      { variantId: "variant-venison-400", qty: 99 },
    ]);
    expect(result.totalUnits).toBe(198);
    expect(result.maxExceeded).toBe(false);
  });

  it("corrects the proportional split upward when its energy would miss the selected cadence", async () => {
    const packageQuantityPolicy = vi.fn<CommercePackageQuantityPolicy>(() => quantityResult(14));

    const result = await createCatalogBackedPackageSizingPort({
      catalogReadPort: catalogPort(94),
      packageQuantityPolicy,
    }).recomputeRecipeQuantities({
      recipeVariantIds: ["variant-lamb-400", "variant-venison-400"],
      currentRecipes: [
        { variantId: "variant-lamb-400", qty: 1 },
        { variantId: "variant-venison-400", qty: 13 },
      ],
      dailyKcal: 400,
      planDays: 14,
    });

    expect(result).toEqual({
      recipes: [
        { variantId: "variant-lamb-400", qty: 3 },
        { variantId: "variant-venison-400", qty: 11 },
      ],
      totalUnits: 14,
      maxExceeded: false,
    });
  });

  it("caps a proportional cadence resize at live low stock and redistributes only within the selected mix", async () => {
    const packageQuantityPolicy = vi.fn<CommercePackageQuantityPolicy>(() => quantityResult(14));
    const offerAvailabilityPort = availabilityPort({
      "variant-lamb-400": 2,
      "variant-venison-400": 20,
    });

    const result = await createCatalogBackedPackageSizingPort({
      catalogReadPort: catalogPort(),
      packageQuantityPolicy,
      offerAvailabilityPort,
    }).recomputeRecipeQuantities({
      recipeVariantIds: ["variant-lamb-400", "variant-venison-400"],
      currentRecipes: [
        { variantId: "variant-lamb-400", qty: 8 },
        { variantId: "variant-venison-400", qty: 6 },
      ],
      dailyKcal: 300,
      planDays: 14,
    });

    expect(result).toEqual({
      recipes: [
        { variantId: "variant-lamb-400", qty: 2 },
        { variantId: "variant-venison-400", qty: 12 },
      ],
      totalUnits: 14,
      maxExceeded: false,
    });
    expect(packageQuantityPolicy).toHaveBeenCalledWith(
      [
        expect.objectContaining({ variantId: "variant-lamb-400", sellableNow: 2 }),
        expect.objectContaining({ variantId: "variant-venison-400", sellableNow: 20 }),
      ],
      300,
      14,
      { stockBounded: true },
    );
  });

  it("fails closed when a selected item is out of stock instead of dropping it", async () => {
    const packageQuantityPolicy = vi.fn<CommercePackageQuantityPolicy>(() => quantityResult(14));

    const result = await createCatalogBackedPackageSizingPort({
      catalogReadPort: catalogPort(),
      packageQuantityPolicy,
      offerAvailabilityPort: availabilityPort({
        "variant-lamb-400": 0,
        "variant-venison-400": 20,
      }),
    }).recomputeRecipeQuantities({
      recipeVariantIds: ["variant-lamb-400", "variant-venison-400"],
      currentRecipes: [
        { variantId: "variant-lamb-400", qty: 8 },
        { variantId: "variant-venison-400", qty: 6 },
      ],
      dailyKcal: 300,
      planDays: 14,
    });

    expect(result).toEqual({ recipes: [], totalUnits: 0, maxExceeded: true });
  });

  it.each([
    ["unknown ATP", availabilityPort({
      "variant-lamb-400": null,
      "variant-venison-400": 20,
    })],
    ["incomplete ATP", incompleteAvailabilityPort("variant-venison-400", 20)],
  ])("fails closed on %s instead of assuming the 99-unit line cap", async (_label, offerAvailabilityPort) => {
    const result = await createCatalogBackedPackageSizingPort({
      catalogReadPort: catalogPort(),
      packageQuantityPolicy: vi.fn<CommercePackageQuantityPolicy>(() => quantityResult(14)),
      offerAvailabilityPort,
    }).recomputeRecipeQuantities({
      recipeVariantIds: ["variant-lamb-400", "variant-venison-400"],
      currentRecipes: [
        { variantId: "variant-lamb-400", qty: 8 },
        { variantId: "variant-venison-400", qty: 6 },
      ],
      dailyKcal: 300,
      planDays: 14,
    });

    expect(result).toEqual({ recipes: [], totalUnits: 0, maxExceeded: true });
  });

  it("fails closed when the resized total cannot fit under the per-variant limit", async () => {
    const packageQuantityPolicy = vi.fn<CommercePackageQuantityPolicy>(() => quantityResult(199));

    await expect(createCatalogBackedPackageSizingPort({
      catalogReadPort: catalogPort(),
      packageQuantityPolicy,
    }).recomputeRecipeQuantities({
      recipeVariantIds: ["variant-lamb-400", "variant-venison-400"],
      currentRecipes: [
        { variantId: "variant-lamb-400", qty: 8 },
        { variantId: "variant-venison-400", qty: 6 },
      ],
      dailyKcal: 6_000,
      planDays: 14,
    })).resolves.toEqual({ recipes: [], totalUnits: 0, maxExceeded: true });
  });

  it("keeps the one-can floor for six flavours and resolves equal remainders deterministically", async () => {
    const slugs = ["lamb", "venison", "beef", "turkey", "salmon", "pork"];
    const result = await createCatalogBackedPackageSizingPort({
      catalogReadPort: catalogPortForSlugs(slugs),
      packageQuantityPolicy: vi.fn<CommercePackageQuantityPolicy>(() => quantityResult(14)),
    }).recomputeRecipeQuantities({
      recipeVariantIds: slugs.map((slug) => `variant-${slug}-400`),
      currentRecipes: slugs.map((slug) => ({ variantId: `variant-${slug}-400`, qty: 1 })),
      dailyKcal: 300,
      planDays: 14,
    });

    expect(result.recipes).toEqual(slugs.map((slug, index) => ({
      variantId: `variant-${slug}-400`,
      qty: index < 2 ? 3 : 2,
    })));
    expect(result.recipes.every((line) => line.qty >= 1 && line.qty <= 99)).toBe(true);
    expect(result.totalUnits).toBe(14);
  });

  it("rejects invalid neutral package unit totals", async () => {
    const packageQuantityPolicy = vi.fn<CommercePackageQuantityPolicy>((variants) => ({
      lines: variants.map((variant): RecommendedCartLine => ({
        variantId: variant.variantId,
        sku: variant.sku,
        slug: variant.slug,
        qty: 6,
        netWeightG: variant.netWeightG,
        kcalPerUnit: Math.round((variant.kcalPer100g * variant.netWeightG) / 100),
        allergenSlugs: [...variant.allergenSlugs],
      })),
      totalUnits: -1,
      totalWeightG: 4800,
      totalKcal: 5904,
      feedingDays: 9.6,
      dailyGrams: 500,
      minimumApplied: false,
      largeQuantityWarning: false,
      maxExceeded: false,
      rebalanced: false,
      stockClamped: false,
      stockConstrained: false,
    }));

    await expect(createCatalogBackedPackageSizingPort({
      catalogReadPort: catalogPort(),
      packageQuantityPolicy,
    }).recomputeRecipeQuantities({
      recipeVariantIds: ["variant-lamb-400", "variant-venison-400"],
      dailyKcal: 613,
      planDays: 14,
    })).rejects.toThrow("commerce_package_sizing_invalid_total_units");
  });

  it("rejects deprecated alias-only package quantity policy results", async () => {
    const packageQuantityPolicy = vi.fn<CommercePackageQuantityPolicy>((variants) => ({
      lines: variants.map((variant): RecommendedCartLine => ({
        variantId: variant.variantId,
        sku: variant.sku,
        slug: variant.slug,
        qty: 6,
        netWeightG: variant.netWeightG,
        kcalPerUnit: Math.round((variant.kcalPer100g * variant.netWeightG) / 100),
        allergenSlugs: [...variant.allergenSlugs],
      })),
      totalCans: 12,
      totalWeightG: 4800,
      totalKcal: 5904,
      feedingDays: 9.6,
      dailyGrams: 500,
      minimumApplied: false,
      largeQuantityWarning: false,
      maxExceeded: false,
      rebalanced: false,
      stockClamped: false,
      stockConstrained: false,
    } as unknown as ReturnType<CommercePackageQuantityPolicy>));

    await expect(createCatalogBackedPackageSizingPort({
      catalogReadPort: catalogPort(),
      packageQuantityPolicy,
    }).recomputeRecipeQuantities({
      recipeVariantIds: ["variant-lamb-400", "variant-venison-400"],
      dailyKcal: 613,
      planDays: 14,
    })).rejects.toThrow("commerce_package_sizing_invalid_total_units");
  });
});

function catalogPort(venisonEnergyPer100g = 123): CatalogReadPort {
  return {
    async listProducts() {
      return [product("lamb", ["lamb"]), product("venison", ["venison"], venisonEnergyPer100g)];
    },
    async getProductBySlug() {
      return product("lamb", ["lamb"]);
    },
    async listAllergens() {
      return [];
    },
  };
}

function catalogPortForSlugs(slugs: readonly string[]): CatalogReadPort {
  return {
    async listProducts() {
      return slugs.map((slug) => product(slug, [slug]));
    },
    async getProductBySlug(slug) {
      return slugs.includes(slug) ? product(slug, [slug]) : null;
    },
    async listAllergens() {
      return [];
    },
  };
}

function quantityResult(totalUnits: number): ReturnType<CommercePackageQuantityPolicy> {
  return {
    lines: [],
    totalUnits,
    totalWeightG: totalUnits * 400,
    totalKcal: totalUnits * 492,
    feedingDays: 14,
    dailyGrams: 400,
    minimumApplied: false,
    largeQuantityWarning: false,
    maxExceeded: false,
    rebalanced: false,
    stockClamped: false,
    stockConstrained: false,
  };
}

function availabilityPort(
  sellableByVariant: Readonly<Record<string, number | null>>,
): CommerceOfferAvailabilityPort {
  return {
    async getAvailability({ items }) {
      return items.map((item) => {
        const sellableNow = sellableByVariant[item.variantId];
        if (sellableNow == null) {
          return {
            ...item,
            status: "unknown" as const,
            visibleInConfigurator: true,
            sellableNow: null,
            reasonCode: "inventory_read_failed",
            source: "test",
          };
        }
        return {
          ...item,
          status: sellableNow <= 0 ? "out_of_stock" as const : "low_stock" as const,
          visibleInConfigurator: sellableNow > 0,
          sellableNow,
          reasonCode: sellableNow <= 0 ? "no_sellable_stock" : "low_stock",
          source: "test",
        };
      });
    },
  };
}

function incompleteAvailabilityPort(
  presentVariantId: string,
  sellableNow: number,
): CommerceOfferAvailabilityPort {
  return {
    async getAvailability({ items }) {
      return items
        .filter((item) => item.variantId === presentVariantId)
        .map((item) => ({
          ...item,
          status: "available" as const,
          visibleInConfigurator: true,
          sellableNow,
          reasonCode: "available",
          source: "test",
        }));
    },
  };
}

function product(
  slug: string,
  allergenSlugs: CatalogProduct["composition"]["allergenSlugs"],
  energyPer100g = 123,
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
    composition: { rawIngredients: "", rawIngredientsEn: null, items: [], allergenSlugs, kcalPer100g: energyPer100g },
    metadata: { format: "can", kcalPer100g: energyPer100g, legacyStatus: null },
  };
}

function sku(slug: string) {
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
