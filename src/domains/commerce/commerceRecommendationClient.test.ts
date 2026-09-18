import { describe, expect, it, vi } from "vitest";
import {
  createCommerceRecommendation,
  getCommerceProductCompatibility,
} from "./commerceClient";
import {
  COMMERCE_PRODUCT_COMPATIBILITY_CONTRACT_VERSION,
} from "./productCompatibilityContracts";
import {
  COMMERCE_RECOMMENDATION_CONTRACT_VERSION,
} from "./recommendationContracts";
import { COMMERCE_RECOMMENDATION_VERSION } from "./recommendationEngine";

const SAMPLE_POLICY_VERSION = "sample.energy_policy.generic.v1";
const SAMPLE_POLICY_SOURCE = "sample_energy_policy";

describe("commerce recommendation BFF client", () => {
  it("creates a headless package recommendation through the typed BFF client", async () => {
    const fetcher = createFetcher(recommendationResponse());
    const request = {
      petProfile: {
        ageBand: "adult" as const,
        weightKg: 12,
        activityLevel: "normal" as const,
        bcs: "ideal" as const,
        allergenSlugs: [],
      },
      selectedFlavorSlugs: ["lamb" as const],
      desiredSizeKind: "feeding_days" as const,
      cadenceDays: 21,
      consciousAllergenOverride: false,
    };

    await expect(createCommerceRecommendation(request, { fetcher })).resolves.toMatchObject({
      recommendation: {
        status: "ready_to_buy",
        lines: [{ sku: "opaque:lamb-launch.v1", qty: 21 }],
      },
    });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/bff/commerce/recommendation",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(request),
      }),
    );
  });

  it("reads product compatibility through the typed BFF client", async () => {
    const fetcher = createFetcher(productCompatibilityResponse());
    const request = { allergenSlugs: ["chicken" as const] };

    await expect(getCommerceProductCompatibility(request, { fetcher })).resolves.toMatchObject({
      products: [
        expect.objectContaining({
          slug: "salmon",
          selectable: false,
          conflictAllergenSlugs: ["chicken"],
        }),
      ],
    });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/bff/commerce/product-compatibility",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(request),
      }),
    );
  });
});

function recommendationResponse() {
  return {
    contractVersion: COMMERCE_RECOMMENDATION_CONTRACT_VERSION,
    recommendation: {
      version: COMMERCE_RECOMMENDATION_VERSION,
      status: "ready_to_buy",
      reasonCodes: ["energy_policy_fediaf_2025", "preferred_flavors_used"],
      energy: {
        policyVersion: SAMPLE_POLICY_VERSION,
        source: SAMPLE_POLICY_SOURCE,
        ageBand: "adult",
        activityLevel: "normal",
        bcs: "ideal",
        kcalPerKgBodyWeight075: 95,
        dailyKcal: 613,
        dailyGrams: 576,
      },
      dailyKcal: 613,
      dailyGrams: 576,
      totalWeightG: 8400,
      feedingDays: 20.5,
      desiredSizeKind: "feeding_days",
      cadenceDays: 21,
      lines: [{
        variantId: "variant-lamb-400",
        sku: "opaque:lamb-launch.v1",
        slug: "lamb",
        qty: 21,
        netWeightG: 400,
        kcalPerUnit: 492,
        allergenSlugs: ["lamb"],
      }],
      allergenConflicts: [],
      excludedProducts: [],
      allergenOverrideRecorded: false,
    },
  };
}

function productCompatibilityResponse() {
  return {
    contractVersion: COMMERCE_PRODUCT_COMPATIBILITY_CONTRACT_VERSION,
    products: [{
      variantId: "variant-salmon-400",
      sku: "opaque:salmon-launch.v1",
      slug: "salmon",
      selectable: false,
      conflictAllergenSlugs: ["chicken"],
    }],
  };
}

function createFetcher(data: unknown) {
  return vi.fn().mockResolvedValue({
    status: 200,
    json: () => Promise.resolve({ ok: true, data }),
  });
}
