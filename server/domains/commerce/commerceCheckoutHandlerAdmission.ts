import { createCheckoutAdmission } from "@openlup/platform/commerce/server";
import { checkoutRequestSchema } from "../../../src/domains/commerce/checkoutContracts.js";
import { COMMERCE_MIN_ORDER_UNITS } from "../../../src/domains/commerce/recommendationPolicyDeps.js";
import type { ConfiguratorIntent } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import { isDhlCourierDelivery } from "./commerceCheckoutHandlerHelpers.js";
import { rejectMissingPromotionExpectedQuote } from "./commerceCheckoutPromotionPriceChange.js";
export interface CheckoutRateLimitDecision {
  allowed: boolean;
  reason?: "ip_quota" | "email_quota";
}

export interface CheckoutAdmissionRequest {
  method?: string;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
}

type CheckoutAdmissionResponse = Parameters<typeof sendBffError>[0];

export interface CheckoutAdmissionDeps {
  checkRateLimit: (
    req: CheckoutAdmissionRequest,
    intent: ConfiguratorIntent,
    paymentAttemptSequence: number | undefined,
  ) => Promise<CheckoutRateLimitDecision>;
  rateLimitMessage: (reason: "ip_quota" | "email_quota" | undefined) => string;
  checkRiskBlocklist?: (
    req: CheckoutAdmissionRequest,
    intent: ConfiguratorIntent,
  ) => Promise<{ blocked: boolean }>;
  subscriptionCheckoutContractEnabled?: () => boolean;
  dhlOnlyDeliveryEnabled?: () => boolean;
  promotionAcceptanceEnforced?: boolean;
  offerPolicy?: import("./checkoutOfferPolicyPort.js").CheckoutOfferPolicyPort;
}

const core = createCheckoutAdmission({ minimumOrderUnits: COMMERCE_MIN_ORDER_UNITS, requestSchema: checkoutRequestSchema, responder: { sendBffError, sendBffSuccess, sendMethodNotAllowed }, deliveryAllowed: isDhlCourierDelivery,
  respondDeliveryRequired: (res) => sendBffError(res, "BAD_REQUEST", "DHL courier delivery is required", { details: { feature: "checkout", featureFlag: "COMMERCE_DHL_ONLY_DELIVERY", reason: "dhl_only_delivery_required" } }), rejectMissingPromotionExpectedQuote });
export function admitCheckoutRequest(input: Omit<Parameters<typeof core.admitCheckoutRequest>[0], "deps"> & { deps: CheckoutAdmissionDeps }) { return core.admitCheckoutRequest({ ...input, deps: { ...input.deps, deliveryRequired: input.deps.dhlOnlyDeliveryEnabled } }); }
export type CheckoutAdmission = Awaited<ReturnType<typeof admitCheckoutRequest>>;
