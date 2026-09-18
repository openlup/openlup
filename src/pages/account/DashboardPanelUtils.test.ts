import { describe, expect, it } from "vitest";

import { BffClientError } from "@/lib/bff/client";
import { subscriptionActionErrorToastKey } from "./DashboardPanelUtils";

describe("subscriptionActionErrorToastKey", () => {
  const fallback = "account:dashboard.saveFailed";

  function bffError(details: unknown) {
    return new BffClientError(
      { code: "CONFLICT", message: "Customer subscription action is not allowed", details },
      409,
    );
  }

  it("maps the known RPC rejection reasons to their specific toast keys", () => {
    expect(subscriptionActionErrorToastKey(bffError({ reason: "customer_self_service_payment_blocked" })))
      .toBe("account:dashboard.actionError.paymentBlocked");
    expect(subscriptionActionErrorToastKey(bffError({ reason: "customer_self_service_invalid_transition" })))
      .toBe("account:dashboard.actionError.invalidTransition");
    expect(subscriptionActionErrorToastKey(bffError({ reason: "customer_self_service_edit_window_closed" })))
      .toBe("account:dashboard.actionError.editWindowClosed");
    // Distinct from paymentBlocked on purpose: the remedy is waiting, not adding
    // a payment method, and the two must not share copy.
    expect(subscriptionActionErrorToastKey(
      bffError({ reason: "customer_self_service_payment_blocked_attempt_in_flight" }),
    )).toBe("account:dashboard.actionError.paymentInFlight");
  });

  it("falls back to the generic toast for an unmapped or malformed reason", () => {
    expect(subscriptionActionErrorToastKey(bffError({ reason: "customer_self_service_stale_edit" }))).toBe(fallback);
    expect(subscriptionActionErrorToastKey(bffError({ reason: 42 }))).toBe(fallback);
    expect(subscriptionActionErrorToastKey(bffError({}))).toBe(fallback);
    expect(subscriptionActionErrorToastKey(bffError(undefined))).toBe(fallback);
  });

  it("falls back to the generic toast for a non-BFF failure", () => {
    expect(subscriptionActionErrorToastKey(new Error("network down"))).toBe(fallback);
    expect(subscriptionActionErrorToastKey(null)).toBe(fallback);
  });
});
