import {
  resolveUnsubscribeEndpoint,
  type UnsubscribeTarget,
} from "./unsubscribeFunctionsBaseUrl.js";

export interface OutboxMarketingReadinessEnv {
  COMMERCE_ABANDONED_CART_ENABLED?: string;
  COMMERCE_BACK_IN_STOCK_ENABLED?: string;
  COMMERCE_REORDER_REMINDER_ENABLED?: string;
  COMMERCE_REVIEW_REQUEST_ENABLED?: string;
  UNSUBSCRIBE_FUNCTIONS_BASE_URL?: string;
  UNSUBSCRIBE_TOKEN_SECRET?: string;
}

export type OutboxMarketingReadiness =
  | { ok: true; enabled: false }
  | { ok: true; enabled: true; unsubscribeEndpointUrl: string; unsubscribeTarget: UnsubscribeTarget }
  | { ok: false; error: string };

const MARKETING_FLAGS = [
  "COMMERCE_ABANDONED_CART_ENABLED",
  "COMMERCE_BACK_IN_STOCK_ENABLED",
  "COMMERCE_REORDER_REMINDER_ENABLED",
  "COMMERCE_REVIEW_REQUEST_ENABLED",
] as const;

export function readOutboxMarketingReadiness(
  env: OutboxMarketingReadinessEnv,
): OutboxMarketingReadiness {
  const marketingEnabled = MARKETING_FLAGS.some((flag) => env[flag] === "true");
  if (!marketingEnabled) return { ok: true, enabled: false };

  if (!env.UNSUBSCRIBE_TOKEN_SECRET?.trim()) {
    return { ok: false, error: "unsubscribe_token_secret_required" };
  }

  // No fallback: the base is operator-supplied or the marketing group does not
  // register. Deriving one from the project URL used to mint a dead link after
  // the managed function was retired, so an absent value is a refusal.
  const explicitBaseUrl = env.UNSUBSCRIBE_FUNCTIONS_BASE_URL?.trim();
  if (!explicitBaseUrl) {
    return { ok: false, error: "unsubscribe_functions_base_url_required" };
  }

  const resolvedEndpoint = resolveUnsubscribeEndpoint(explicitBaseUrl);
  if (!resolvedEndpoint) {
    return { ok: false, error: "unsubscribe_functions_base_url_invalid" };
  }
  return {
    ok: true,
    enabled: true,
    unsubscribeEndpointUrl: resolvedEndpoint.unsubscribeEndpointUrl,
    unsubscribeTarget: resolvedEndpoint.target,
  };
}
