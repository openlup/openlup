import { describe, expect, it } from "vitest";
import {
  COMMERCE_RECOMMENDATION_CONTRACT_VERSION,
  commerceRecommendationRequestSchema,
  commerceRecommendationResponseSchema,
  commerceRecommendationSnapshotSchema,
} from "./recommendationContracts.js";
import {
  COMMERCE_RECOMMENDATION_VERSION,
} from "./recommendationEngine.js";

const SAMPLE_POLICY_VERSION = "sample.energy_policy.generic.v1";
const SAMPLE_POLICY_SOURCE = "sample_energy_policy";

describe("commerceRecommendationResponseSchema", () => {
  it("accepts ready, warning and manual review statuses", () => {
    for (const status of ["ready_to_buy", "warning", "manual_review"] as const) {
      const response = responseForStatus(status);
      const result = commerceRecommendationResponseSchema.safeParse(response);
      expect(result.success, status).toBe(true);
    }
  });

  it("rejects a buyable recommendation with no lines", () => {
    const result = commerceRecommendationResponseSchema.safeParse({
      ...responseForStatus("ready_to_buy"),
      recommendation: {
        ...responseForStatus("ready_to_buy").recommendation,
        lines: [],
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts implementation-owned energy policy identity", () => {
    const response = responseForStatus("ready_to_buy");
    response.recommendation.energy.policyVersion = "adopter.energy_policy.custom.v1";
    response.recommendation.energy.source = "adopter_custom_energy";

    const result = commerceRecommendationResponseSchema.safeParse(response);

    expect(result.success).toBe(true);
  });

  it("keeps legacy puppy manual-review snapshots parseable", () => {
    const response = responseForStatus("manual_review");
    const legacyPuppyResponse = {
      ...response,
      recommendation: {
        ...response.recommendation,
        reasonCodes: ["puppy_not_supported"],
        energy: {
          ...response.recommendation.energy,
          ageBand: "puppy",
          dailyKcal: null,
          dailyGrams: null,
        },
        dailyKcal: null,
        dailyGrams: null,
      },
    };

    expect(commerceRecommendationResponseSchema.safeParse(legacyPuppyResponse).success).toBe(true);
  });

  it("parses an unversioned request and snapshot deep-equal, adding no key", () => {
    const request = unversionedRequest();
    const snapshot = responseForStatus("ready_to_buy").recommendation;

    const parsedRequest = commerceRecommendationRequestSchema.parse(request);
    const parsedSnapshot = commerceRecommendationSnapshotSchema.parse(snapshot);

    expect(parsedRequest).toEqual(request);
    expect(Object.keys(parsedRequest)).toEqual(Object.keys(request));
    expect(parsedSnapshot).toEqual(snapshot);
    expect(Object.keys(parsedSnapshot)).toEqual(Object.keys(snapshot));
  });

  it("accepts an offer version on the request and refuses a malformed one", () => {
    expect(commerceRecommendationRequestSchema.parse({ ...unversionedRequest(), offerVersion: "offer.v2" }))
      .toMatchObject({ offerVersion: "offer.v2" });
    for (const offerVersion of ["Offer V2", "", "a..b", 2]) {
      expect(
        commerceRecommendationRequestSchema.safeParse({ ...unversionedRequest(), offerVersion }).success,
        String(offerVersion),
      ).toBe(false);
    }
  });

  it("requires a snapshot's offer version and minimum to travel together", () => {
    const snapshot = responseForStatus("ready_to_buy").recommendation;

    expect(commerceRecommendationSnapshotSchema.parse({ ...snapshot, offerVersion: "offer.v2", minimumUnits: 12 }))
      .toMatchObject({ offerVersion: "offer.v2", minimumUnits: 12 });
    const versionOnly = commerceRecommendationSnapshotSchema.safeParse({ ...snapshot, offerVersion: "offer.v2" });
    const minimumOnly = commerceRecommendationSnapshotSchema.safeParse({ ...snapshot, minimumUnits: 12 });
    expect(versionOnly.error?.issues).toContainEqual(expect.objectContaining({
      message: "offerVersion and minimumUnits travel together",
      path: ["minimumUnits"],
    }));
    expect(minimumOnly.error?.issues).toContainEqual(expect.objectContaining({
      message: "offerVersion and minimumUnits travel together",
      path: ["offerVersion"],
    }));
    for (const minimumUnits of [0, 100, 12.5]) {
      expect(
        commerceRecommendationSnapshotSchema.safeParse({ ...snapshot, offerVersion: "offer.v2", minimumUnits }).success,
        String(minimumUnits),
      ).toBe(false);
    }
  });

  it("still refuses unknown request and snapshot keys", () => {
    expect(commerceRecommendationRequestSchema.safeParse({ ...unversionedRequest(), offerTier: "b" }).success)
      .toBe(false);
    expect(commerceRecommendationSnapshotSchema.safeParse({
      ...responseForStatus("ready_to_buy").recommendation,
      offerTier: "b",
    }).success).toBe(false);
  });
});

function unversionedRequest() {
  return {
    petProfile: {
      ageBand: "adult",
      weightKg: 12,
      allergenSlugs: [],
      dailyKcalOverride: null,
    },
    desiredSizeKind: "feeding_days",
    cadenceDays: 21,
    consciousAllergenOverride: false,
  };
}

function responseForStatus(status: "ready_to_buy" | "warning" | "manual_review") {
  return {
    contractVersion: COMMERCE_RECOMMENDATION_CONTRACT_VERSION,
    recommendation: {
      version: COMMERCE_RECOMMENDATION_VERSION,
      status,
      reasonCodes: ["energy_policy_fediaf_2025"],
      energy: {
        policyVersion: SAMPLE_POLICY_VERSION,
        source: SAMPLE_POLICY_SOURCE,
        ageBand: "adult",
        activityLevel: "normal",
        bcs: "ideal",
        kcalPerKgBodyWeight075: 95,
        dailyKcal: 613,
        dailyGrams: status === "manual_review" ? null : 576,
      },
      dailyKcal: 613,
      dailyGrams: status === "manual_review" ? null : 576,
      totalWeightG: status === "manual_review" ? 0 : 8400,
      feedingDays: status === "manual_review" ? null : 14.2,
      desiredSizeKind: "feeding_days",
      cadenceDays: 14,
      lines: status === "manual_review" ? [] : [{
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
