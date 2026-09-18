import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  commerceOfferPricingResponseSchema,
  type CommerceOfferPricingResponse,
} from "../../../src/domains/commerce/offerPricingContracts.js";
import {
  pricingPolicyRequestSchema,
  type PricingPolicyRequest,
  type PricingPolicySnapshot,
} from "../../../src/domains/commerce/offerPolicyContracts.js";

// Price/promotion validity can end at any instant. Keep the public cache very
// short and omit stale-while-revalidate; a future contract may expose the next
// validity boundary and clamp this exactly to it.
export const COMMERCE_OFFER_PRICING_CACHE_CONTROL =
  "public, max-age=0, s-maxage=5, must-revalidate";
export const COMMERCE_OFFER_PRICING_ASSIGNED_CACHE_CONTROL = "private, no-store";

export const OFFER_POLICY_CAPABILITY_HEADER = "x-commerce-offer-policy-capability";
export const OFFER_POLICY_TOKEN_HEADER = "x-commerce-pricing-policy-token";
export const OFFER_POLICY_VISITOR_HEADER = "x-commerce-visitor-id";

const ROUTER_QUERY_KEYS = new Set(["path", "__bffPath"]);

export interface CommerceOfferPricingHandlerDeps {
  readOfferPricing(pricingPolicy?: PricingPolicySnapshot): Promise<CommerceOfferPricingResponse>;
  requirePricingPolicy?: boolean;
  resolvePricingPolicy?(request: {
    visitorId: string;
    pricingPolicy: PricingPolicyRequest;
  }): PricingPolicySnapshot | undefined | Promise<PricingPolicySnapshot | undefined>;
}

export function createCommerceOfferPricingHandler({
  readOfferPricing,
  resolvePricingPolicy,
  requirePricingPolicy = false,
}: CommerceOfferPricingHandlerDeps) {
  return async function handler(
    req: VercelRequest,
    res: VercelResponse,
  ): Promise<void> {
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

    try {
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
      const parsed = commerceOfferPricingResponseSchema.safeParse(
        await readOfferPricing(pricingPolicy),
      );
      if (!parsed.success) {
        sendBffError(
          res,
          "INVALID_RESPONSE",
          "Commerce offer pricing returned invalid response",
        );
        return;
      }
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
    } catch {
      sendBffError(
        res,
        "UPSTREAM_UNAVAILABLE",
        "Commerce offer pricing is unavailable",
      );
    }
  };
}

function readPolicyRequest(req: VercelRequest): {
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

function singleHeader(req: VercelRequest, name: string): string | undefined {
  const value = req.headers?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
