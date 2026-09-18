import { describe, expect, it, vi } from "vitest";
import type { CatalogReadPort } from "../../../src/domains/catalog/ports.js";
import type { CatalogProduct } from "../../../src/domains/catalog/types.js";
import type {
  CommerceOfferAvailability,
  CommerceOfferAvailabilityRequestItem,
} from "../../../src/domains/commerce/offerAvailabilityContracts.js";
import type { CommerceOfferAvailabilityPort } from "../../../src/domains/commerce/ports.js";
import {
  createCatalogBackedRecommendationPort,
  createVariantBackedRecommendationPort,
} from "./catalogBackedRecommendationPort.js";
import type {
  CatalogRecommendationVariant,
  CatalogRecommendationVariantReadPort,
} from "./catalogRecommendationVariants.js";
import { TEST_RECOMMENDATION_POLICIES } from "../../../src/lib/testSupport/recommendationPolicyTestSupport.js";
import type { BuildCartRecommendationPolicies } from "../../../src/domains/commerce/recommendationPolicyDeps.js";

describe("catalog backed recommendation port", () => {
  it("builds versioned cart recommendations from catalog variants", async () => {
    const response = await createCatalogBackedRecommendationPort(catalogPort(), {
      recommendationPolicies: TEST_RECOMMENDATION_POLICIES,
    }).recommend({
      petProfile: { ageBand: "adult", weightKg: 12, allergenSlugs: [] },
      selectedFlavorSlugs: ["lamb"],
      desiredSizeKind: "feeding_days",
      cadenceDays: 21,
      consciousAllergenOverride: false,
    });

    expect(response.recommendation).toMatchObject({
      status: "ready_to_buy",
      dailyKcal: expect.any(Number),
    });
    expect(response.recommendation.lines[0]).toMatchObject({
      sku: "opaque:lamb-launch.v1",
      slug: "lamb",
      netWeightG: 400,
    });
  });

  it("filters strict variants by the requested purchase mode before availability", async () => {
    const getAvailability = vi.fn(async ({ items }: { items: CommerceOfferAvailabilityRequestItem[] }) =>
      items.map((item) => availability(item, "available")),
    );
    const listRecommendationVariants = vi.fn(async () => [
      strictVariant("one-time", ["one_time"]),
      strictVariant("subscription", ["subscription"]),
    ]);
    const variants: CatalogRecommendationVariantReadPort = { listRecommendationVariants };
    const port = createVariantBackedRecommendationPort(
      variants,
      { recommendationPolicies: TEST_RECOMMENDATION_POLICIES },
      { getAvailability },
    );
    const baseRequest = {
      petProfile: { ageBand: "adult" as const, weightKg: 12, allergenSlugs: [] },
      cadenceDays: 21,
      consciousAllergenOverride: false,
    };

    await port.recommend({
      ...baseRequest,
      selectedFlavorSlugs: ["subscription"],
      desiredSizeKind: "feeding_days",
    });
    expect(getAvailability).toHaveBeenLastCalledWith({
      items: [expect.objectContaining({
        sku: "opaque:subscription-launch.v1",
        checkoutMode: "subscription",
      })],
    });

    await port.recommend({
      ...baseRequest,
      selectedFlavorSlugs: ["one-time"],
      desiredSizeKind: "unit_count",
    });
    expect(getAvailability).toHaveBeenLastCalledWith({
      items: [expect.objectContaining({
        sku: "opaque:one-time-launch.v1",
        checkoutMode: "one_time",
      })],
    });
    expect(listRecommendationVariants).toHaveBeenCalledTimes(2);
  });

  it("excludes allergen conflicts and falls back to safe catalog products", async () => {
    const response = await createCatalogBackedRecommendationPort(catalogPort(), {
      recommendationPolicies: TEST_RECOMMENDATION_POLICIES,
    }).recommend({
      petProfile: { ageBand: "adult", weightKg: 12, allergenSlugs: ["lamb"] },
      selectedFlavorSlugs: ["lamb"],
      desiredSizeKind: "feeding_days",
      cadenceDays: 21,
      consciousAllergenOverride: true,
    });

    expect(response.recommendation.status).toBe("warning");
    expect(response.recommendation.lines.map((line) => line.slug)).toEqual(["venison"]);
    expect(response.recommendation.excludedProducts).toEqual([
      expect.objectContaining({ slug: "lamb", allergenSlugs: ["lamb"] }),
    ]);
    expect(response.recommendation.allergenOverrideRecorded).toBe(false);
  });

  it("preserves an explicitly selected OOS flavour and requires explicit replacement", async () => {
    const response = await createCatalogBackedRecommendationPort(
      catalogPort(),
      {
        recommendationPolicies: STOCK_CAPACITY_TEST_POLICIES,
        stockBoundedQuantities: true,
      },
      availabilityPort({ "opaque:lamb-launch.v1": "out_of_stock" }),
    ).recommend({
      petProfile: { ageBand: "adult", weightKg: 12, allergenSlugs: [] },
      selectedFlavorSlugs: ["lamb"],
      desiredSizeKind: "feeding_days",
      cadenceDays: 21,
      consciousAllergenOverride: false,
    });

    expect(response.recommendation.status).toBe("manual_review");
    expect(response.recommendation.lines).toEqual([]);
    expect(response.recommendation.reasonCodes).toContain(
      "additional_safe_flavor_selection_required",
    );
    expect(response.recommendation.suggestedVariants).toEqual([
      expect.objectContaining({ slug: "venison", variantId: "variant-venison-400" }),
    ]);
  });

  it("never suggests an unselected OOS flavour", async () => {
    const response = await createCatalogBackedRecommendationPort(
      catalogPort(),
      {
        recommendationPolicies: STOCK_CAPACITY_TEST_POLICIES,
        stockBoundedQuantities: true,
      },
      availabilityPort({
        "opaque:lamb-launch.v1": "low_stock",
        "opaque:venison-launch.v1": "out_of_stock",
      }),
    ).recommend({
      petProfile: { ageBand: "adult", weightKg: 12, allergenSlugs: [] },
      selectedFlavorSlugs: ["lamb"],
      desiredSizeKind: "feeding_days",
      cadenceDays: 21,
      consciousAllergenOverride: false,
    });

    expect(response.recommendation.status).toBe("manual_review");
    expect(response.recommendation.suggestedVariants).toEqual([]);
    expect(response.recommendation.lines.every((line) => line.slug === "lamb")).toBe(true);
  });

  it("keeps low-stock variants and carries the line status", async () => {
    const response = await createCatalogBackedRecommendationPort(
      catalogPort(),
      { recommendationPolicies: TEST_RECOMMENDATION_POLICIES },
      availabilityPort({ "opaque:lamb-launch.v1": "low_stock" }),
    ).recommend({
      petProfile: { ageBand: "adult", weightKg: 12, allergenSlugs: [] },
      selectedFlavorSlugs: ["lamb"],
      desiredSizeKind: "feeding_days",
      cadenceDays: 21,
      consciousAllergenOverride: false,
    });

    expect(response.recommendation.lines[0]).toMatchObject({
      slug: "lamb",
      purchaseAvailability: "low_stock",
    });
  });

  it("passes injected recommendation policies through without changing default output", async () => {
    const request = {
      petProfile: { ageBand: "adult" as const, weightKg: 12, allergenSlugs: [] },
      selectedFlavorSlugs: ["lamb"],
      desiredSizeKind: "feeding_days" as const,
      cadenceDays: 21,
      consciousAllergenOverride: false,
    };
    const resolveDailyEnergyPolicy = vi.fn(TEST_RECOMMENDATION_POLICIES.resolveDailyEnergy);
    const buildPackageQuantityPolicy = vi.fn(TEST_RECOMMENDATION_POLICIES.buildPackageQuantity);

    const baseline = await createCatalogBackedRecommendationPort(catalogPort(), {
      recommendationPolicies: TEST_RECOMMENDATION_POLICIES,
    }).recommend(request);
    const injected = await createCatalogBackedRecommendationPort(
      catalogPort(),
      {
        recommendationPolicies: {
          resolveDailyEnergy: resolveDailyEnergyPolicy,
          buildPackageQuantity: buildPackageQuantityPolicy,
        },
      },
    ).recommend(request);

    expect(injected).toEqual(baseline);
    expect(resolveDailyEnergyPolicy).toHaveBeenCalledWith(request.petProfile);
    expect(buildPackageQuantityPolicy).toHaveBeenCalledTimes(1);
  });

  it("keeps the stock-bounded quantity gate wired through the port", async () => {
    const request = {
      petProfile: { ageBand: "adult" as const, weightKg: 12, allergenSlugs: [] },
      selectedFlavorSlugs: ["lamb"],
      desiredSizeKind: "feeding_days" as const,
      cadenceDays: 21,
      consciousAllergenOverride: false,
    };

    const unbounded = await createCatalogBackedRecommendationPort(
      catalogPort(),
      { recommendationPolicies: TEST_RECOMMENDATION_POLICIES },
      availabilityPort({
        "opaque:lamb-launch.v1": "low_stock",
        "opaque:venison-launch.v1": "low_stock",
      }),
    ).recommend(request);
    const bounded = await createCatalogBackedRecommendationPort(
      catalogPort(),
      {
        recommendationPolicies: TEST_RECOMMENDATION_POLICIES,
        stockBoundedQuantities: true,
      },
      availabilityPort({
        "opaque:lamb-launch.v1": "low_stock",
        "opaque:venison-launch.v1": "low_stock",
      }),
    ).recommend(request);

    expect(unbounded.recommendation.reasonCodes).not.toContain(
      "stock_bounded_quantities_applied",
    );
    expect(unbounded.recommendation.lines[0]?.qty).toBeGreaterThan(2);
    expect(bounded.recommendation.reasonCodes).toContain("stock_bounded_quantities_applied");
    expect(bounded.recommendation.lines.every((line) => line.qty <= 2)).toBe(true);
  });
});

function strictVariant(
  slug: "one-time" | "subscription",
  permittedPurchaseModes: CatalogRecommendationVariant["permittedPurchaseModes"],
): CatalogRecommendationVariant {
  return {
    variantId: `variant-${slug}-400`,
    sku: `opaque:${slug}-launch.v1`,
    slug,
    kcalPer100g: 123,
    netWeightG: 400,
    allergenSlugs: [],
    permittedPurchaseModes,
  };
}

// Keep adapter tests on commerce's public seam; the vertical policy has domain tests.
const STOCK_CAPACITY_TEST_POLICIES: BuildCartRecommendationPolicies = {
  ...TEST_RECOMMENDATION_POLICIES,
  buildPackageQuantity(variants, dailyKcal, cadenceDays, options) {
    const baseline = TEST_RECOMMENDATION_POLICIES.buildPackageQuantity(
      variants,
      dailyKcal,
      cadenceDays,
      options,
    );
    const unavailableSelectedVariantIds = variants
      .filter((variant) => variant.purchaseAvailability === "out_of_stock" || (variant.sellableNow ?? 1) < 1)
      .map((variant) => variant.variantId);
    const capacityConstrained = Boolean(options?.stockBounded) && (
      unavailableSelectedVariantIds.length > 0 ||
      baseline.totalUnits < 14 ||
      baseline.totalKcal < dailyKcal * cadenceDays
    );
    if (!capacityConstrained) return baseline;
    const selectedUnavailable = unavailableSelectedVariantIds.length > 0;
    return {
      ...baseline,
      lines: selectedUnavailable ? [] : baseline.lines,
      totalUnits: selectedUnavailable ? 0 : baseline.totalUnits,
      totalWeightG: selectedUnavailable ? 0 : baseline.totalWeightG,
      totalKcal: selectedUnavailable ? 0 : baseline.totalKcal,
      feedingDays: selectedUnavailable ? 0 : baseline.feedingDays,
      dailyGrams: selectedUnavailable ? 0 : baseline.dailyGrams,
      stockConstrained: true,
      selectedCapacityConstrained: true,
      unavailableSelectedVariantIds,
      suggestedVariantIds: (options?.extraVariants ?? [])
        .filter((variant) => variant.purchaseAvailability !== "out_of_stock" && (variant.sellableNow ?? 0) >= 1)
        .map((variant) => variant.variantId),
    };
  },
};

function catalogPort(): CatalogReadPort {
  return {
    async listProducts() {
      return [product("lamb", ["lamb"]), product("venison", ["venison"])];
    },
    async getProductBySlug() {
      return product("lamb", ["lamb"]);
    },
    async listAllergens() {
      return [];
    },
  };
}

function product(slug: "lamb" | "venison", allergenSlugs: CatalogProduct["composition"]["allergenSlugs"]): CatalogProduct {
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

function sku(slug: "lamb" | "venison") {
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
