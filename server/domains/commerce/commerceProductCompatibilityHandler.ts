import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  COMMERCE_PRODUCT_COMPATIBILITY_CONTRACT_VERSION,
  commerceProductCompatibilityRequestSchema,
  commerceProductCompatibilityResponseSchema,
} from "../../../src/domains/commerce/productCompatibilityContracts.js";
import type { CommerceProductCompatibilityPort } from "../../../src/domains/commerce/ports.js";
import {
  CommerceProductCompatibilityError,
} from "./catalogBackedProductCompatibilityPort.js";
import { CatalogRecommendationVariantReadError } from "./catalogRecommendationVariants.js";

export interface CommerceProductCompatibilityHandlerDeps {
  productCompatibilityPort: CommerceProductCompatibilityPort;
}

export function createCommerceProductCompatibilityHandler({
  productCompatibilityPort,
}: CommerceProductCompatibilityHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }

    const request = commerceProductCompatibilityRequestSchema.safeParse(req.body);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid product compatibility request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const compatibility = await productCompatibilityPort.getCompatibility(request.data);
      const response = commerceProductCompatibilityResponseSchema.safeParse(compatibility);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Product compatibility returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data, {
        contractVersion: COMMERCE_PRODUCT_COMPATIBILITY_CONTRACT_VERSION,
      });
    } catch (error) {
      if (error instanceof CatalogRecommendationVariantReadError) {
        sendBffError(res, "UPSTREAM_UNAVAILABLE", "Product catalog is unavailable", {
          details: { reason: "catalog_unavailable", refusalCode: error.code },
        });
        return;
      }
      if (error instanceof CommerceProductCompatibilityError) {
        sendBffError(res, "BAD_REQUEST", error.message, { details: error.details });
        return;
      }

      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Product compatibility check failed");
    }
  };
}
