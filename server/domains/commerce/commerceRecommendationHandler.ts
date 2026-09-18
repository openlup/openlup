import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  COMMERCE_RECOMMENDATION_CONTRACT_VERSION,
  commerceRecommendationRequestSchema,
  commerceRecommendationResponseSchema,
} from "../../../src/domains/commerce/recommendationContracts.js";
import type { CommerceRecommendationPort } from "../../../src/domains/commerce/ports.js";
import { CommerceRecommendationError } from "./catalogBackedRecommendationPort.js";
import { CatalogRecommendationVariantReadError } from "./catalogRecommendationVariants.js";

export interface CommerceRecommendationHandlerDeps {
  recommendationPort: CommerceRecommendationPort;
}

export function createCommerceRecommendationHandler({
  recommendationPort,
}: CommerceRecommendationHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }

    const request = commerceRecommendationRequestSchema.safeParse(req.body);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid commerce recommendation request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const recommendation = await recommendationPort.recommend(request.data);
      const response = commerceRecommendationResponseSchema.safeParse(recommendation);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Commerce recommendation returned invalid response");
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
        sendBffError(res, error.code === "allergen_conflict" ? "CONFLICT" : "BAD_REQUEST", error.message, {
          details: error.details,
        });
        return;
      }

      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Commerce recommendation failed");
    }
  };
}
