import type { ResolvedAcquisitionTerms } from "./contracts/acquisitionTerms.js";
import { mapAcquisitionTermsFailure } from "./acquisitionQuoteBinding.js";
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
  acquisition?: { terms(quote: Response["quote"]): ResolvedAcquisitionTerms | undefined };
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
 * For each validated quote entry, resolves optional eligibility and policy and
 * then calls the injected quote port; entries run concurrently. It returns each
 * result's quote in request order, and a failed call fails the whole batch. This
 * handler supplies no shared timestamp or read context; any cross-entry sharing
 * belongs to the injected port. It returns quote bodies only and does not apply
 * the separate single-route acceptance or fallback steps.
 */
export function createCommerceQuoteBatchHandler<Request extends CreateQuoteRequest, Response extends CreateQuoteResponse>({
  responder, createQuoteBatchRequestSchema, publicCreateQuoteBatchResponseSchema,
  quotePort,
  acquisition,
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
      const acquisitionFailure = acquisition ? mapAcquisitionTermsFailure(error) : null;
      if (acquisitionFailure) {
        sendBffError(res, acquisitionFailure.code, "Acquisition terms unavailable", { details: acquisitionFailure.details });
        return;
      }
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
