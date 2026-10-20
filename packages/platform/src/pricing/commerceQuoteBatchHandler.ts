import type { HttpRequest, HttpResponse } from "../http/index.js";
import type { BffResponder } from "../bff/index.js";
import type { z } from "zod";
import {
  type CreateQuoteRequest, type CreateQuoteResponse,
} from "./contracts/quote.js";
import { COMMERCE_CONTRACT_VERSION } from "./contracts/index.js";
import {
  CommerceQuoteError,
  type CommerceQuotePort,
} from "./quotePorts.js";
import { CommerceQuoteCatalogReadError } from "./commerceQuoteCatalogReadPort.js";
import { mapPricingPolicyFailure } from "./commercePricingPolicyErrors.js";
import type { PricingPolicySnapshot } from "./contracts/offerPolicy.js";

export interface CommerceQuoteBatchHandlerDeps<Request extends CreateQuoteRequest = CreateQuoteRequest, Response extends CreateQuoteResponse = CreateQuoteResponse> {
  responder: BffResponder;
  createQuoteBatchRequestSchema: z.ZodType<{ quotes: Request[] }>;
  publicCreateQuoteBatchResponseSchema: z.ZodType<{ contractVersion: typeof COMMERCE_CONTRACT_VERSION; quotes: Response["quote"][] }>;

  quotePort: CommerceQuotePort<Request, Response>;
  resolveCustomerEligibility?: (
    request: Request,
  ) => Promise<{ clientId: string | null; source: "anonymous" | "resolved_client" }>;
  resolvePricingPolicy?: (
    request: Request,
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
export function createCommerceQuoteBatchHandler<Request extends CreateQuoteRequest, Response extends CreateQuoteResponse>({
  responder, createQuoteBatchRequestSchema, publicCreateQuoteBatchResponseSchema,
  quotePort,
  resolveCustomerEligibility,
  resolvePricingPolicy,
}: CommerceQuoteBatchHandlerDeps<Request, Response>) {
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = responder;
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
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
