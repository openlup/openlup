import { CustomerSubscriptionActionConflictError } from "./customerSubscriptionActionHandler.js";

// Maps a Postgres RPC error from customer_self_service_apply_subscription_action to a
// client-actionable 4xx (CONFLICT). Anything unrecognised is returned as-is so it stays
// a 5xx upstream failure.
// `message` stays the coarse, long-standing label; the matched RPC token rides along in
// `details.reason` so the account UI can toast a specific, actionable reason (e.g. "add a
// payment method") instead of the generic "could not save". The alternation is the
// unchanged match set; the trailing `[a-z_]*` only widens the CAPTURE to the whole token
// (`..._invalid` + `_transition`), it never changes which errors are mapped.
export function mapSubscriptionRpcError(
  error: { code?: string; message?: string; details?: string; hint?: string },
  context: { action?: string } = {},
) {
  const text = [error.message, error.details, error.hint].filter(Boolean).join(" ");
  const platform = /(subscription_lifecycle_(?:unsupported_action|invalid_idempotency_key|not_found|forbidden|invalid_transition|invalid_skip|invalid_slide|payment_blocked))/.exec(text);
  if (platform) {
    const reason = platform[1];
    if (context.action === "pause" && (
      reason === "subscription_lifecycle_not_found"
      || reason === "subscription_lifecycle_forbidden"
    )) {
      return new CustomerSubscriptionActionConflictError(
        "CONFLICT", "Customer subscription action is not allowed",
        { reason: "customer_subscription_owner_refused" },
      );
    }
    if (context.action === "pause" && reason === "subscription_lifecycle_invalid_transition") {
      return new CustomerSubscriptionActionConflictError(
        "CONFLICT", "Customer subscription action is not allowed",
        { reason: "customer_subscription_transition_conflict" },
      );
    }
    if (reason === "subscription_lifecycle_unsupported_action"
      || reason === "subscription_lifecycle_invalid_idempotency_key"
      || reason === "subscription_lifecycle_invalid_skip"
      || reason === "subscription_lifecycle_invalid_slide") {
      return new CustomerSubscriptionActionConflictError(
        "BAD_REQUEST", "Invalid customer subscription action request", { reason },
      );
    }
    return new CustomerSubscriptionActionConflictError(
      "CONFLICT", "Customer subscription action is not allowed", { reason },
    );
  }
  const matched = /(customer_self_service_(?:not_found|forbidden|conflict|edit_window_closed|payment_blocked|payment_method_not_chargeable|invalid|stale_edit|quote_not_accepted|quote_expired|quote_already_used|quote_drift|charge_timing_not_confirmed|recipe_total_mismatch|below_minimum_order_units|not_a_recipe_variant)[a-z_]*)/.exec(text);
  if (matched) {
    if (context.action === "pause" && (
      matched[1] === "customer_self_service_not_found"
      || matched[1] === "customer_self_service_forbidden"
    )) {
      return new CustomerSubscriptionActionConflictError(
        "CONFLICT", "Customer subscription action is not allowed",
        { reason: "customer_subscription_owner_refused" },
      );
    }
    if (context.action === "pause" && (
      matched[1] === "customer_self_service_conflict"
      || matched[1] === "customer_self_service_invalid_transition"
    )) {
      return new CustomerSubscriptionActionConflictError(
        "CONFLICT", "Customer subscription action is not allowed",
        { reason: "customer_subscription_transition_conflict" },
      );
    }
    return new CustomerSubscriptionActionConflictError(
      "CONFLICT", "Customer subscription action is not allowed", { reason: matched[1] },
    );
  }
  return error;
}

// A pre-RPC reprice failure (subscriptionEditReprice.ts throws subscription_reprice_*)
// is usually the customer's edit being rejected. Map those to a 4xx with a
// machine-readable reason so the UI surfaces them instead of swallowing an opaque 503.
// The most common cause is a plan-length resize on a subscription whose size_constraint
// carries no dailyKcalOverride (legacy/incompletely-provisioned rows).
export function mapSubscriptionRepriceError(error: unknown, action: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("subscription_reprice_")) {
    if (message.endsWith("_unavailable") || message.endsWith("_undefined")) {
      return error instanceof Error ? error : new Error(message);
    }
    if (message === "subscription_reprice_quote_not_accepted") {
      return new CustomerSubscriptionActionConflictError(
        "BAD_REQUEST", "subscription_quote_not_accepted", { reason: message },
      );
    }
    // `message` stays the coarse, long-standing label; the precise reprice code
    // rides along in `details.reason` so the editor can tell a minimum-order
    // rejection apart from a generic pricing failure.
    return new CustomerSubscriptionActionConflictError(
      "BAD_REQUEST",
      action === "update_plan_length" ? "plan_length_unavailable" : "subscription_edit_reprice_failed",
      { reason: message },
    );
  }
  return error instanceof Error ? error : new Error(message);
}
