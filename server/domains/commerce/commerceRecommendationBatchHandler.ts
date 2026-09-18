import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  COMMERCE_RECOMMENDATION_CONTRACT_VERSION,
  commerceRecommendationBatchRequestSchema,
  commerceRecommendationBatchResponseSchema,
} from "../../../src/domains/commerce/recommendationContracts.js";
import type { CommerceRecommendationPort } from "../../../src/domains/commerce/ports.js";
import { CommerceRecommendationError } from "./catalogBackedRecommendationPort.js";
import { CatalogRecommendationVariantReadError } from "./catalogRecommendationVariants.js";

export interface CommerceRecommendationBatchHandlerDeps {
  recommendationPort: CommerceRecommendationPort;
}

/**
 * Batch recommendation BFF handler: builds N snapshots in one request so the
 * configurator stops fanning out one HTTP call per length tile. The injected
 * port is expected to share its catalog read across the batch (memoized
 * `listProducts`), so this is one DB warm-up, not N. Output is identical to
 * calling the single-recommendation endpoint N times, and order is preserved
 * (`recommendations[i]` ⇔ the i-th request). A failure in any item fails the
 * whole batch, mirroring the single-endpoint error mapping.
 */
export function createCommerceRecommendationBatchHandler({
  recommendationPort,
}: CommerceRecommendationBatchHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }

    const request = commerceRecommendationBatchRequestSchema.safeParse(req.body);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid commerce recommendation batch request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const results = await Promise.all(
        request.data.recommendations.map((entry) => recommendationPort.recommend(entry)),
      );
      const payload = {
        contractVersion: COMMERCE_RECOMMENDATION_CONTRACT_VERSION,
        recommendations: results.map((result) => result.recommendation),
      };
      const response = commerceRecommendationBatchResponseSchema.safeParse(payload);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Commerce recommendation batch returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data, {
        contractVersion: COMMERCE_RECOMMENDATION_CONTRACT_VERSION,
      });
    } catch (error) {
      if (error instanceof CatalogRecommendationVariantReadError) {
        sendBffError(res, "UPSTREAM_UNAVAILABLE", "Product catalog is unavailable", {
          details: { reason: "catalog_unavailable", refusalCode: error.code },
        });
        return;
      }
      if (error instanceof CommerceRecommendationError) {
        sendBffError(
          res,
          error.code === "allergen_conflict" ? "CONFLICT" : "BAD_REQUEST",
          error.message,
          { details: error.details },
        );
        return;
      }

      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Commerce recommendation batch failed");
    }
  };
}
