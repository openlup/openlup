import {
  checkoutRequestSchema,
  type CheckoutKind,
} from "../../../src/domains/commerce/checkoutContracts.js";
import type { ConfiguratorIntent } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import { sendBffError, sendMethodNotAllowed } from "../../_lib/bff/response.js";
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
}

type ParsedCheckout = ReturnType<typeof checkoutRequestSchema.parse>;

export type CheckoutAdmission =
  | {
      kind: "accepted";
      data: ParsedCheckout;
      intent: ConfiguratorIntent;
      checkoutKind: CheckoutKind;
    }
  | { kind: "responded"; outcome: "error" | "rejected" };

export async function admitCheckoutRequest(input: {
  req: CheckoutAdmissionRequest;
  res: CheckoutAdmissionResponse;
  deps: CheckoutAdmissionDeps;
  record: <T>(
    stage: "rate_limit" | "risk_blocklist",
    operation: () => Promise<T>,
  ) => Promise<T>;
}): Promise<CheckoutAdmission> {
  const { req, res, deps } = input;
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, ["POST"]);
    return { kind: "responded", outcome: "rejected" };
  }

  const parsed = checkoutRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    sendBffError(res, "BAD_REQUEST", "Invalid checkout request", {
      details: parsed.error.flatten(),
    });
    return { kind: "responded", outcome: "rejected" };
  }

  const intent = parsed.data.intent;
  const checkoutKind = checkoutKindForIntent(intent);
  if (rejectMissingPromotionExpectedQuote({
    res,
    enforced: deps.promotionAcceptanceEnforced ?? false,
    intent,
    expectedQuote: parsed.data.expectedQuote,
  })) {
    return { kind: "responded", outcome: "rejected" };
  }

  if ((deps.dhlOnlyDeliveryEnabled?.() ?? false) && !isDhlCourierDelivery(intent)) {
    sendBffError(res, "BAD_REQUEST", "DHL courier delivery is required", {
      details: {
        feature: "checkout",
        featureFlag: "COMMERCE_DHL_ONLY_DELIVERY",
        reason: "dhl_only_delivery_required",
      },
    });
    return { kind: "responded", outcome: "rejected" };
  }

  if (
    checkoutKind === "subscription_initial" &&
    !(deps.subscriptionCheckoutContractEnabled?.() ?? false)
  ) {
    sendBffError(res, "BAD_REQUEST", "Subscription checkout contract is disabled", {
      details: {
        feature: "checkout",
        featureFlag: "COMMERCE_V2_W11_SUBSCRIPTION_CHECKOUT_CONTRACT_ENABLED",
        reason: "subscription_checkout_contract_disabled",
      },
    });
    return { kind: "responded", outcome: "rejected" };
  }

  let decision: CheckoutRateLimitDecision;
  try {
    decision = await input.record("rate_limit", () =>
      deps.checkRateLimit(req, intent, parsed.data.paymentAttemptSequence),
    );
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Checkout rate limit unavailable", {
      details: { feature: "checkout", reason: "rate_limit_unavailable" },
    });
    return { kind: "responded", outcome: "error" };
  }
  if (!decision.allowed) {
    sendBffError(res, "RATE_LIMITED", deps.rateLimitMessage(decision.reason), {
      details: { feature: "checkout", reason: decision.reason ?? "ip_quota" },
    });
    return { kind: "responded", outcome: "rejected" };
  }

  if (deps.checkRiskBlocklist) {
    try {
      const risk = await input.record("risk_blocklist", () =>
        deps.checkRiskBlocklist!(req, intent),
      );
      if (risk.blocked) {
        sendBffError(res, "FORBIDDEN", "Checkout cannot be completed", {
          details: { feature: "checkout", reason: "risk_blocked_checkout" },
        });
        return { kind: "responded", outcome: "rejected" };
      }
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Checkout risk check unavailable", {
        details: { feature: "checkout", reason: "risk_check_unavailable" },
      });
      return { kind: "responded", outcome: "error" };
    }
  }

  return { kind: "accepted", data: parsed.data, intent, checkoutKind };
}

function checkoutKindForIntent(intent: ConfiguratorIntent): CheckoutKind {
  return intent.mode === "subscription" ? "subscription_initial" : "one_time";
}
