import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  COMMERCE_RECOMMENDATION_CONTRACT_VERSION,
  type CommerceRecommendationResponse,
} from "../../../src/domains/commerce/recommendationContracts.js";
import { COMMERCE_RECOMMENDATION_VERSION } from "../../../src/domains/commerce/recommendationEngine.js";
import type { CommerceRecommendationPort } from "../../../src/domains/commerce/ports.js";
import { CommerceRecommendationError } from "./catalogBackedRecommendationPort.js";
import { CatalogRecommendationVariantReadError } from "./catalogRecommendationVariants.js";
import { createCommerceRecommendationBatchHandler } from "./commerceRecommendationBatchHandler.js";

const SAMPLE_POLICY_VERSION = "sample.energy_policy.generic.v1";
const SAMPLE_POLICY_SOURCE = "sample_energy_policy";

describe("commerce recommendation batch handler", () => {
  it("builds every snapshot in one envelope, preserving request order", async () => {
    const port = createPort();
    const res = createResponse();

    await createCommerceRecommendationBatchHandler({ recommendationPort: port })(
      request("POST", {
        recommendations: [
          { ...recommendationRequest(), cadenceDays: 14 },
          { ...recommendationRequest(), cadenceDays: 28 },
        ],
      }),
      res,
    );

    expect(port.recommend).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: {
        contractVersion: COMMERCE_RECOMMENDATION_CONTRACT_VERSION,
        recommendations: [
          recommendationResponse().recommendation,
          recommendationResponse().recommendation,
        ],
      },
      meta: { contractVersion: COMMERCE_RECOMMENDATION_CONTRACT_VERSION },
    });
  });

  it("rejects unsupported methods and invalid request bodies", async () => {
    const method = createResponse();
    await createCommerceRecommendationBatchHandler({ recommendationPort: createPort() })(
      request("GET"),
      method,
    );

    const empty = createResponse();
    await createCommerceRecommendationBatchHandler({ recommendationPort: createPort() })(
      request("POST", { recommendations: [] }),
      empty,
    );

    expect(method.status).toHaveBeenCalledWith(405);
    expect(empty.status).toHaveBeenCalledWith(400);
  });

  it("maps domain errors and invalid/upstream failures, failing the whole batch", async () => {
    const conflict = createResponse();
    await createCommerceRecommendationBatchHandler({
      recommendationPort: createPort(
        new CommerceRecommendationError("allergen_conflict", "conflict", { slug: "lamb" }),
      ),
    })(request("POST", { recommendations: [recommendationRequest()] }), conflict);

    const invalid = createResponse();
    await createCommerceRecommendationBatchHandler({
      recommendationPort: createPort({ contractVersion: COMMERCE_RECOMMENDATION_CONTRACT_VERSION }),
    })(request("POST", { recommendations: [recommendationRequest()] }), invalid);

    const upstream = createResponse();
    await createCommerceRecommendationBatchHandler({
      recommendationPort: createPort(new Error("catalog unavailable")),
    })(request("POST", { recommendations: [recommendationRequest()] }), upstream);

    expect(conflict.status).toHaveBeenCalledWith(409);
    expect(invalid.status).toHaveBeenCalledWith(502);
    expect(upstream.status).toHaveBeenCalledWith(503);
  });

  it("fails the complete batch closed with the bounded D1 catalog refusal", async () => {
    const res = createResponse();
    await createCommerceRecommendationBatchHandler({
      recommendationPort: createPort(
        new CatalogRecommendationVariantReadError("catalog_authority_changed"),
      ),
    })(request("POST", { recommendations: [recommendationRequest()] }), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({
        code: "UPSTREAM_UNAVAILABLE",
        details: {
          reason: "catalog_unavailable",
          refusalCode: "catalog_authority_changed",
        },
      }),
    }));
  });
});

function createPort(result?: unknown): CommerceRecommendationPort {
  return {
    recommend: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return (result as CommerceRecommendationResponse | undefined) ?? recommendationResponse();
    }),
  };
}

function recommendationRequest() {
  return {
    petProfile: { ageBand: "adult", weightKg: 12 },
    selectedFlavorSlugs: ["lamb"],
    desiredSizeKind: "feeding_days",
    cadenceDays: 21,
  };
}

function recommendationResponse(): CommerceRecommendationResponse {
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
        kcalPerKgBodyWeight075: 110,
        dailyKcal: 708,
        dailyGrams: 576,
      },
      dailyKcal: 708,
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

function request(method: string, body?: unknown): VercelRequest {
  return { method, body, query: {} } as unknown as VercelRequest;
}

function createResponse(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
