import type { HttpRequest, HttpResponse } from "../http/index.js";
import type { BffResponder } from "../bff/index.js";
import type { z } from "zod";
import { COMMERCE_OFFER_PRICING_V3_CONTRACT_VERSION, type AcquisitionOfferPricingResponse, type CommerceOfferPricingResponse } from "./contracts/offer.js";
import type { AcquisitionCapability } from "./contracts/acquisitionTerms.js";
import { acquisitionCapabilitySchema } from "./acquisitionTermsSchemas.js";
import { pricingPolicyRequestSchema } from "./offerPolicySchemas.js";
import type { PricingPolicyRequest, PricingPolicySnapshot } from "./contracts/offerPolicy.js";
import { mapPricingPolicyFailure } from "./commercePricingPolicyErrors.js";
import { COMMERCE_OFFER_PRICING_ASSIGNED_CACHE_CONTROL, COMMERCE_OFFER_PRICING_CACHE_CONTROL,
  OFFER_POLICY_CAPABILITY_HEADER, OFFER_POLICY_TOKEN_HEADER, OFFER_POLICY_VISITOR_HEADER } from "./commerceOfferPricingHandler.js";
export const ACQUISITION_CAPABILITY_HEADER = "x-commerce-acquisition-capability";
const ROUTER_QUERY_KEYS = new Set(["path", "__bffPath"]);

export interface AcquisitionOfferPricingHandlerDeps {
  responder: BffResponder;
  commerceOfferPricingResponseSchema: z.ZodType<AcquisitionOfferPricingResponse | CommerceOfferPricingResponse>;
  incumbentHandler(req: HttpRequest, res: HttpResponse): Promise<void>;
  readOfferPricing(pricingPolicy?: PricingPolicySnapshot, acquisitionCapability?: AcquisitionCapability): Promise<AcquisitionOfferPricingResponse | CommerceOfferPricingResponse>;
  requirePricingPolicy?: boolean;
  resolvePricingPolicy?(request: {
    visitorId: string;
    pricingPolicy: PricingPolicyRequest;
  }): PricingPolicySnapshot | undefined | Promise<PricingPolicySnapshot | undefined>;
}

export function createAcquisitionOfferPricingHandler({
  responder, commerceOfferPricingResponseSchema, incumbentHandler,
  readOfferPricing,
  resolvePricingPolicy,
  requirePricingPolicy = false,
}: AcquisitionOfferPricingHandlerDeps) {
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = responder;
  return async function handler(
    req: HttpRequest,
    res: HttpResponse,
  ): Promise<void> {
    if (req.headers?.[ACQUISITION_CAPABILITY_HEADER] === undefined) return incumbentHandler(req, res);
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }
    const userQueryKeys = Object.keys(req.query ?? {}).filter(
      (key) => !ROUTER_QUERY_KEYS.has(key),
    );
    if (userQueryKeys.length > 0) {
      sendBffError(res, "BAD_REQUEST", "Commerce offer pricing does not accept query parameters");
      return;
    }

    let failureReason = "offer_pricing_policy_unavailable";
    try {
      const acquisitionCapability = readAcquisitionCapability(req);
      if (acquisitionCapability === null) {
        sendBffError(res, "BAD_REQUEST", "Commerce acquisition capability is invalid");
        return;
      }
      const policyRequest = readPolicyRequest(req);
      if (policyRequest === null) {
        sendBffError(res, "BAD_REQUEST", "Commerce offer pricing policy capability is invalid");
        return;
      }
      if (!policyRequest && requirePricingPolicy) {
        // A caller that sent no capability headers is an incomplete request,
        // not an unavailable origin — the same attribution the missing-visitor
        // branch above already applies.
        sendBffError(
          res,
          "BAD_REQUEST",
          "Commerce offer pricing requires offer policy v2",
          {
            details: {
              reason: "pricing_policy_request_invalid",
              stage: "pricing_policy",
              policyReason: "v2_capability_required",
            },
          },
        );
        return;
      }
      const pricingPolicy = policyRequest && resolvePricingPolicy
        ? await resolvePricingPolicy(policyRequest)
        : undefined;
      if (acquisitionCapability && pricingPolicy?.offerPolicyVersion !== "commerce.offer-policy.v2") {
        sendBffError(res, "BAD_REQUEST", "Commerce acquisition pricing requires offer policy v2");
        return;
      }
      failureReason = "offer_pricing_projection_unavailable";
      const parsed = commerceOfferPricingResponseSchema.safeParse(
        await (acquisitionCapability ? readOfferPricing(pricingPolicy, acquisitionCapability) : readOfferPricing(pricingPolicy)),
      );
      if (!parsed.success || Boolean(acquisitionCapability) !==
          (parsed.data.contractVersion === COMMERCE_OFFER_PRICING_V3_CONTRACT_VERSION)) {
        sendBffError(
          res,
          "INVALID_RESPONSE",
          "Commerce offer pricing returned invalid response",
        );
        return;
      }
      res.setHeader("Vary", [ACQUISITION_CAPABILITY_HEADER, OFFER_POLICY_CAPABILITY_HEADER,
        OFFER_POLICY_TOKEN_HEADER, OFFER_POLICY_VISITOR_HEADER].join(", "));
      sendBffSuccess(
        res,
        parsed.data,
        { contractVersion: parsed.data.contractVersion },
        {
          cacheControl: policyRequest
            ? COMMERCE_OFFER_PRICING_ASSIGNED_CACHE_CONTROL
            : COMMERCE_OFFER_PRICING_CACHE_CONTROL,
        },
      );
    } catch (error) {
      const policyFailure = failureReason === "offer_pricing_policy_unavailable"
        ? mapPricingPolicyFailure(error) : null;
      sendBffError(
        res,
        "UPSTREAM_UNAVAILABLE",
        "Commerce offer pricing is unavailable",
        {
          details: {
            reason: failureReason,
            ...(policyFailure ? { policyReason: policyFailure.details.policyReason } : {}),
          },
        },
      );
    }
  };
}

export function readAcquisitionCapability(req: HttpRequest): AcquisitionCapability | undefined | null {
  const raw = req.headers?.[ACQUISITION_CAPABILITY_HEADER];
  if (raw === undefined) return undefined;
  const parsed = acquisitionCapabilitySchema.safeParse(typeof raw === "string" ? raw.trim() : raw);
  return parsed.success ? parsed.data : null;
}

function readPolicyRequest(req: HttpRequest): {
  visitorId: string;
  pricingPolicy: PricingPolicyRequest;
} | undefined | null {
  const capability = singleHeader(req, OFFER_POLICY_CAPABILITY_HEADER);
  const token = singleHeader(req, OFFER_POLICY_TOKEN_HEADER);
  if (!capability && !token) return undefined;
  const visitorId = singleHeader(req, OFFER_POLICY_VISITOR_HEADER);
  if (!visitorId || visitorId.length > 120) return null;
  const parsed = pricingPolicyRequestSchema.safeParse({
    ...(capability ? { capability } : {}),
    ...(token ? { token } : {}),
  });
  return parsed.success ? { visitorId, pricingPolicy: parsed.data } : null;
}

function singleHeader(req: HttpRequest, name: string): string | undefined {
  const value = req.headers?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
