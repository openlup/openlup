import type { z } from "zod";
import type { HttpResponse } from "../../http/index.js";
import type { BffResponder } from "../../bff/index.js";
import type { CheckoutKind, ConfiguratorIntent } from "../contracts/index.js";

export interface CheckoutRateLimitDecision {
  allowed: boolean;
  reason?: "ip_quota" | "email_quota";
}

export interface CheckoutAdmissionRequest {
  method?: string;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
}

type CheckoutAdmissionResponse = HttpResponse;

export interface CheckoutAdmissionDeps<Intent> {
  checkRateLimit: (
    req: CheckoutAdmissionRequest,
    intent: Intent,
    paymentAttemptSequence: number | undefined,
  ) => Promise<CheckoutRateLimitDecision>;
  rateLimitMessage: (reason: "ip_quota" | "email_quota" | undefined) => string;
  checkRiskBlocklist?: (
    req: CheckoutAdmissionRequest,
    intent: Intent,
  ) => Promise<{ blocked: boolean }>;
  subscriptionCheckoutContractEnabled?: () => boolean;
  deliveryRequired?: () => boolean;
  promotionAcceptanceEnforced?: boolean;
  offerPolicy?: unknown;
}



export function createCheckoutAdmission<Intent extends ConfiguratorIntent, Data extends { intent: Intent; expectedQuote?: unknown; paymentAttemptSequence?: number }>(bindings: {
  requestSchema: z.ZodType<Data>; responder: BffResponder;
  minimumOrderUnits?: number;
  deliveryAllowed(intent: Intent): boolean; respondDeliveryRequired(res: HttpResponse): void;
  rejectMissingPromotionExpectedQuote(input: { res: HttpResponse; enforced: boolean; intent: Intent; expectedQuote?: unknown }): boolean;
}) {
  const { sendBffError, sendMethodNotAllowed } = bindings.responder;
async function admitCheckoutRequest(input: {
  req: CheckoutAdmissionRequest;
  res: CheckoutAdmissionResponse;
  deps: CheckoutAdmissionDeps<Intent>;
  record: <T>(
    stage: "rate_limit" | "risk_blocklist",
    operation: () => Promise<T>,
  ) => Promise<T>;
}): Promise<{ kind: "accepted"; data: Data; intent: Intent; checkoutKind: CheckoutKind } | { kind: "responded"; outcome: "error" | "rejected" }> {
  const { req, res, deps } = input;
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, ["POST"]);
    return { kind: "responded", outcome: "rejected" };
  }

  const parsed = bindings.requestSchema.safeParse(req.body);
  if (!parsed.success) {
    sendBffError(res, "BAD_REQUEST", "Invalid checkout request", {
      details: parsed.error.flatten(),
    });
    return { kind: "responded", outcome: "rejected" };
  }

  const intent = parsed.data.intent;
  // An untrusted minimum cannot waive the host floor without an offer resolver.
  if (bindings.minimumOrderUnits !== undefined && !deps.offerPolicy) {
    const selectedUnits = intent.selectedVariants.reduce((total, variant) => total + variant.qty, 0);
    const reason = selectedUnits < bindings.minimumOrderUnits
      ? `selected variants require at least ${bindings.minimumOrderUnits} total units`
      : intent.minimumUnits !== undefined || intent.offerVersion !== undefined
        ? "offer_version_unsupported" : null;
    if (reason) {
      sendBffError(res, "BAD_REQUEST", "Invalid checkout request", {
        details: { formErrors: [], fieldErrors: { intent: [reason] } },
      });
      return { kind: "responded", outcome: "rejected" };
    }
  }
  const checkoutKind = checkoutKindForIntent(intent);
  if (bindings.rejectMissingPromotionExpectedQuote({
    res,
    enforced: deps.promotionAcceptanceEnforced ?? false,
    intent,
    expectedQuote: parsed.data.expectedQuote,
  })) {
    return { kind: "responded", outcome: "rejected" };
  }

  if ((deps.deliveryRequired?.() ?? false) && !bindings.deliveryAllowed(intent)) {
    bindings.respondDeliveryRequired(res);
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

function checkoutKindForIntent(intent: Intent): CheckoutKind {
  return intent.mode === "subscription" ? "subscription_initial" : "one_time";
}

return { admitCheckoutRequest };
}
