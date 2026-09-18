import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  createQuoteBatchRequestSchema,
  publicCreateQuoteBatchResponseSchema,
  type CreateQuoteRequest,
} from "../../../src/domains/commerce/contracts.js";
import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import {
  CommerceQuoteError,
  type CommerceQuotePort,
} from "../../../src/domains/commerce/ports.js";
import { CommerceQuoteCatalogReadError } from "./commerceQuoteCatalogReadPort.js";
import { mapPricingPolicyFailure } from "./commercePricingPolicy.js";
import type { PricingPolicySnapshot } from "../../../src/domains/commerce/offerPolicyContracts.js";

export interface CommerceQuoteBatchHandlerDeps {
  quotePort: CommerceQuotePort;
  resolveCustomerEligibility?: (
    request: CreateQuoteRequest,
  ) => Promise<{ clientId: string | null; source: "anonymous" | "resolved_client" }>;
  resolvePricingPolicy?: (
    request: CreateQuoteRequest,
  ) => PricingPolicySnapshot | undefined | Promise<PricingPolicySnapshot | undefined>;
}

/**
 * Batch quote BFF handler: prices N independent quotes in one request so the
 * configurator stops fanning out one HTTP call per length tile. The injected
 * `quotePort` is expected to share its catalog + active price-list reads across
 * the batch (single `atTime` + memoized catalog), so this is one DB warm-up, not
 * N. Output is identical to calling the single-quote endpoint N times, and order
 * is preserved (`quotes[i]` ⇔ the i-th request). A failure in any quote fails
 * the whole batch, mirroring the single-endpoint error mapping.
 */
export function createCommerceQuoteBatchHandler({
  quotePort,
  resolveCustomerEligibility,
  resolvePricingPolicy,
}: CommerceQuoteBatchHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }

    const request = createQuoteBatchRequestSchema.safeParse(req.body);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid commerce quote batch request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const results = await Promise.all(
        request.data.quotes.map(async (quote) => {
          const eligibility = resolveCustomerEligibility
            ? await resolveCustomerEligibility(quote)
            : { clientId: null, source: "anonymous" as const };
          const pricingPolicy = await resolvePricingPolicy?.(quote);
          return quotePort.createQuote(quote, {
            clientId: eligibility.clientId,
            ...(pricingPolicy ? { pricingPolicy } : {}),
          });
        }),
      );
      const payload = {
        contractVersion: COMMERCE_CONTRACT_VERSION,
        quotes: results.map((result) => result.quote),
      };
      const response = publicCreateQuoteBatchResponseSchema.safeParse(payload);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Commerce quote batch returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data, {
        contractVersion: COMMERCE_CONTRACT_VERSION,
      });
    } catch (error) {
      if (error instanceof CommerceQuoteCatalogReadError) {
        sendBffError(res, "UPSTREAM_UNAVAILABLE", "Commerce catalog is unavailable", {
          details: { reason: "catalog_unavailable", refusalCode: error.code },
        });
        return;
      }
      if (error instanceof CommerceQuoteError) {
        sendBffError(
          res,
          error.code === "UNKNOWN_SKU" ? "BAD_REQUEST" : "CONFLICT",
          error.message,
          { details: error.details },
        );
        return;
      }
      // Without this the batch route answered every pricing-policy refusal with
      // a detail-free 503, so the one route the configurator actually fans out
      // to said the least about why it refused.
      const policyFailure = mapPricingPolicyFailure(error);
      if (policyFailure) {
        console.error(
          "[commerce-quote-batch] pricing policy refused:",
          JSON.stringify(policyFailure.details),
        );
        sendBffError(res, policyFailure.code, policyFailure.code === "BAD_REQUEST"
          ? "Commerce quote batch request is missing offer policy context"
          : "Commerce quote batch failed", { details: policyFailure.details });
        return;
      }

      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Commerce quote batch failed");
    }
  };
}
