import type { ShippingTerms } from "../shipping/index.js";
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
import type { PricingPolicySnapshot } from "./contracts/offerPolicy.js";
import { mapPricingPolicyFailure } from "./commercePricingPolicyErrors.js";
import { CommerceQuoteCatalogReadError } from "./commerceQuoteCatalogReadPort.js";

type CommerceQuoteFailureStage =
  | "customer_eligibility"
  | "pricing_policy"
  | "quote_evaluation"
  | "promotion_acceptance"
  | "promotion_fallback";

function commerceQuoteFailureDetails(stage: CommerceQuoteFailureStage) {
  return { reason: "quote_dependency_failed" as const, stage };
}

export interface CommerceQuoteHandlerDeps<Request extends CreateQuoteRequest = CreateQuoteRequest, Response extends CreateQuoteResponse = CreateQuoteResponse> {
  responder: BffResponder;
  shipping?: { terms(quote: Response["quote"]): ShippingTerms | undefined };
  acquisition?: { terms(quote: Response["quote"]): ResolvedAcquisitionTerms | undefined };
  createQuoteRequestSchema: z.ZodType<Request>;
  createQuoteResponseSchema: z.ZodType<Response>;
  publicCreateQuoteRequestSchema: z.ZodType<Request & { promotionAcceptanceToken?: string }>;
  publicCreateQuoteResponseSchema: z.ZodType<Response & { promotionAcceptanceToken?: string }>;

  quotePort: CommerceQuotePort<Request, Response>;
  fallbackQuotePort?: CommerceQuotePort<Request, Response>;
  resolveCustomerEligibility?: (
    request: Request,
  ) => Promise<{ clientId: string | null; source: "anonymous" | "resolved_client" }>;
  resolvePricingPolicy?: (
    request: Request,
  ) => PricingPolicySnapshot | undefined | Promise<PricingPolicySnapshot | undefined>;
  createPromotionAcceptance?: (
    request: Request,
    quote: Awaited<ReturnType<CommerceQuotePort<Request, Response>["createQuote"]>>["quote"],
    acquisitionTerms?: ResolvedAcquisitionTerms,
    shippingTerms?: ShippingTerms,
  ) => string | null;
  honorPromotionAcceptance?: (
    token: string,
    request: Request,
    quote: Awaited<ReturnType<CommerceQuotePort<Request, Response>["createQuote"]>>["quote"],
    acquisitionTerms?: ResolvedAcquisitionTerms,
    shippingTerms?: ShippingTerms,
  ) => boolean;
}

export function createCommerceQuoteHandler<Request extends CreateQuoteRequest, Response extends CreateQuoteResponse>({
  responder, createQuoteRequestSchema, createQuoteResponseSchema, publicCreateQuoteRequestSchema, publicCreateQuoteResponseSchema,
  quotePort,
  acquisition,
  shipping,
  fallbackQuotePort,
  resolveCustomerEligibility,
  resolvePricingPolicy,
  createPromotionAcceptance,
  honorPromotionAcceptance,
}: CommerceQuoteHandlerDeps<Request, Response>) {
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = responder;
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }

    const publicRequest = publicCreateQuoteRequestSchema.safeParse(req.body);
    if (!publicRequest.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid commerce quote request", {
        details: publicRequest.error.flatten(),
      });
      return;
    }
    const { promotionAcceptanceToken, ...canonicalInput } = publicRequest.data;
    const request = createQuoteRequestSchema.safeParse(canonicalInput);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid commerce quote request");
      return;
    }

    let stage: CommerceQuoteFailureStage = "customer_eligibility";
    try {
      const eligibility = resolveCustomerEligibility
        ? await resolveCustomerEligibility(request.data)
        : { clientId: null, source: "anonymous" as const };
      console.info(
        "commerce_quote_promo_eligibility_context",
        JSON.stringify({ promoEligibilityContext: eligibility.source }),
      );
      stage = "pricing_policy";
      const pricingPolicy = await resolvePricingPolicy?.(request.data);
      stage = "quote_evaluation";
      const rawQuote = await quotePort.createQuote(request.data, {
        clientId: eligibility.clientId,
        ...(pricingPolicy ? { pricingPolicy } : {}),
      });
      const canonicalQuote = createQuoteResponseSchema.safeParse(rawQuote);
      if (!canonicalQuote.success) {
        sendBffError(res, "INVALID_RESPONSE", "Commerce quote returned invalid response");
        return;
      }
      let quote = canonicalQuote.data;
      stage = "promotion_acceptance";
      const acquisitionTerms = acquisition?.terms(quote.quote);
      const shippingTerms = shipping?.terms(quote.quote);
      const honoredToken = promotionAcceptanceToken && (shipping
        ? honorPromotionAcceptance?.(promotionAcceptanceToken, request.data, quote.quote, acquisitionTerms, shippingTerms)
        : honorPromotionAcceptance?.(promotionAcceptanceToken, request.data, quote.quote, acquisitionTerms))
        ? promotionAcceptanceToken : undefined;
      const issuedToken = honoredToken ?? (shipping
        ? createPromotionAcceptance?.(request.data, quote.quote, acquisitionTerms, shippingTerms)
        : createPromotionAcceptance?.(request.data, quote.quote, acquisitionTerms)) ?? undefined;
      const containsV2Promotion = quote.quote.discounts.some((discount) =>
        discount.promotionEngineVersion === "promotion-engine.v2");
      if (shippingTerms && !issuedToken) {
        sendBffError(res, "CONFLICT", "Shipping quote must be refreshed", {
          details: { feature: "quote", reason: "promotion_acceptance_refresh_required" },
        });
        return;
      }
      if ((containsV2Promotion || acquisitionTerms) && !issuedToken) {
        stage = "promotion_fallback";
        const fallback = fallbackQuotePort
          ? createQuoteResponseSchema.safeParse(await fallbackQuotePort.createQuote(request.data, {
              clientId: eligibility.clientId,
              ...(pricingPolicy ? { pricingPolicy } : {}),
            }))
          : null;
        if (!fallback?.success || shipping?.terms(fallback.data.quote) || acquisition?.terms(fallback.data.quote) || fallback.data.quote.discounts.some((discount) =>
          discount.promotionEngineVersion === "promotion-engine.v2")) {
          sendBffError(res, "CONFLICT", "Promotion quote must be refreshed", {
            details: { feature: "quote", reason: "promotion_acceptance_refresh_required" },
          });
          return;
        }
        quote = fallback.data;
      }
      const response = publicCreateQuoteResponseSchema.safeParse({
        ...quote,
        promotionAcceptanceToken: quote === canonicalQuote.data ? issuedToken : undefined,
      });
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Commerce quote returned invalid response");
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

      const policyFailure = stage === "pricing_policy" ? mapPricingPolicyFailure(error) : null;
      if (policyFailure) {
        console.error("[commerce-quote] pricing policy refused:", JSON.stringify(policyFailure.details));
        sendBffError(res, policyFailure.code, policyFailure.code === "BAD_REQUEST"
          ? "Commerce quote request is missing offer policy context"
          : "Commerce quote failed", { details: policyFailure.details });
        return;
      }

      const details = commerceQuoteFailureDetails(stage);
      console.error("[commerce-quote] dependency failed:", JSON.stringify(details));
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Commerce quote failed", { details });
    }
  };
}
