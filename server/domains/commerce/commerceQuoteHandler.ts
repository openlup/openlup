import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  createQuoteRequestSchema,
  createQuoteResponseSchema,
  publicCreateQuoteRequestSchema,
  publicCreateQuoteResponseSchema,
  type CreateQuoteRequest,
} from "../../../src/domains/commerce/contracts.js";
import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import {
  CommerceQuoteError,
  type CommerceQuotePort,
} from "../../../src/domains/commerce/ports.js";
import type { PricingPolicySnapshot } from "../../../src/domains/commerce/offerPolicyContracts.js";
import { mapPricingPolicyFailure } from "./commercePricingPolicy.js";
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

export interface CommerceQuoteHandlerDeps {
  quotePort: CommerceQuotePort;
  fallbackQuotePort?: CommerceQuotePort;
  resolveCustomerEligibility?: (
    request: CreateQuoteRequest,
  ) => Promise<{ clientId: string | null; source: "anonymous" | "resolved_client" }>;
  resolvePricingPolicy?: (
    request: CreateQuoteRequest,
  ) => PricingPolicySnapshot | undefined | Promise<PricingPolicySnapshot | undefined>;
  createPromotionAcceptance?: (
    request: CreateQuoteRequest,
    quote: Awaited<ReturnType<CommerceQuotePort["createQuote"]>>["quote"],
  ) => string | null;
  honorPromotionAcceptance?: (
    token: string,
    request: CreateQuoteRequest,
    quote: Awaited<ReturnType<CommerceQuotePort["createQuote"]>>["quote"],
  ) => boolean;
}

export function createCommerceQuoteHandler({
  quotePort,
  fallbackQuotePort,
  resolveCustomerEligibility,
  resolvePricingPolicy,
  createPromotionAcceptance,
  honorPromotionAcceptance,
}: CommerceQuoteHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
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
      const honoredToken = promotionAcceptanceToken && honorPromotionAcceptance?.(
        promotionAcceptanceToken, request.data, quote.quote,
      ) ? promotionAcceptanceToken : undefined;
      const issuedToken = honoredToken ?? createPromotionAcceptance?.(request.data, quote.quote) ?? undefined;
      const containsV2Promotion = quote.quote.discounts.some((discount) =>
        discount.promotionEngineVersion === "promotion-engine.v2");
      if (containsV2Promotion && !issuedToken) {
        stage = "promotion_fallback";
        const fallback = fallbackQuotePort
          ? createQuoteResponseSchema.safeParse(await fallbackQuotePort.createQuote(request.data, {
              clientId: eligibility.clientId,
              ...(pricingPolicy ? { pricingPolicy } : {}),
            }))
          : null;
        if (!fallback?.success || fallback.data.quote.discounts.some((discount) =>
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
