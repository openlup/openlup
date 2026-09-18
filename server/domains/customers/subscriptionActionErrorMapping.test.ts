import { describe, expect, it } from "vitest";

import { CustomerSubscriptionActionConflictError } from "./customerSubscriptionActionHandler.js";
import {
  mapSubscriptionRepriceError,
  mapSubscriptionRpcError,
} from "./subscriptionActionErrorMapping.js";

describe("mapSubscriptionRpcError", () => {
  it("maps a known self-service RPC rejection to a CONFLICT", () => {
    const mapped = mapSubscriptionRpcError({ message: "customer_self_service_payment_blocked" });
    expect(mapped).toBeInstanceOf(CustomerSubscriptionActionConflictError);
    expect((mapped as CustomerSubscriptionActionConflictError).code).toBe("CONFLICT");
  });

  it("maps RPC quote and charge-timing guard rejections to CONFLICT", () => {
    for (const message of [
      "customer_self_service_quote_not_accepted",
      "customer_self_service_quote_expired",
      "customer_self_service_quote_already_used",
      "customer_self_service_quote_drift",
      "customer_self_service_charge_timing_not_confirmed",
    ]) {
      const mapped = mapSubscriptionRpcError({ message });
      expect(mapped).toBeInstanceOf(CustomerSubscriptionActionConflictError);
      expect((mapped as CustomerSubscriptionActionConflictError).code).toBe("CONFLICT");
    }
  });

  it("maps the RPC minimum-order-quantity floor to CONFLICT", () => {
    const mapped = mapSubscriptionRpcError({
      message: "customer_self_service_below_minimum_order_units",
    });
    expect(mapped).toBeInstanceOf(CustomerSubscriptionActionConflictError);
    expect((mapped as CustomerSubscriptionActionConflictError).code).toBe("CONFLICT");
  });

  it("carries the matched RPC token as details.reason while keeping the coarse message", () => {
    const mapped = mapSubscriptionRpcError({
      message: 'new row violates ... customer_self_service_payment_blocked',
    });
    expect(mapped.message).toBe("Customer subscription action is not allowed");
    expect((mapped as CustomerSubscriptionActionConflictError).details).toEqual({
      reason: "customer_self_service_payment_blocked",
    });
  });

  // A resume that would strand the subscription is refused while a charge may
  // still land. The refusal has to reach the customer as a conflict with its own
  // reason, not as an anonymous 5xx, which is why the RPC raises inside this
  // vocabulary instead of letting the terminalization helper's raw code escape.
  it("maps the in-flight refusal on resume to CONFLICT and keeps its whole token", () => {
    const mapped = mapSubscriptionRpcError({
      message: "customer_self_service_payment_blocked_attempt_in_flight",
    });
    expect(mapped).toBeInstanceOf(CustomerSubscriptionActionConflictError);
    expect((mapped as CustomerSubscriptionActionConflictError).code).toBe("CONFLICT");
    expect((mapped as CustomerSubscriptionActionConflictError).details).toEqual({
      reason: "customer_self_service_payment_blocked_attempt_in_flight",
    });
  });

  it("captures the whole token, not just the matched alternative", () => {
    for (const reason of [
      "customer_self_service_invalid_transition",
      "customer_self_service_edit_window_closed",
      "customer_self_service_not_found_line",
    ]) {
      const mapped = mapSubscriptionRpcError({ details: reason });
      expect((mapped as CustomerSubscriptionActionConflictError).details).toEqual({ reason });
    }
  });

  it("passes an unrecognised error through unchanged (stays a 5xx upstream)", () => {
    const raw = { message: "some_unexpected_db_outage" };
    expect(mapSubscriptionRpcError(raw)).toBe(raw);
  });

  it.each([
    "subscription_lifecycle_not_found",
    "subscription_lifecycle_forbidden",
    "customer_self_service_not_found",
    "customer_self_service_forbidden",
  ])("normalizes pause ownership refusals without an existence oracle: %s", (message) => {
    expect(mapSubscriptionRpcError({ message }, { action: "pause" })).toMatchObject({
      code: "CONFLICT",
      message: "Customer subscription action is not allowed",
      details: { reason: "customer_subscription_owner_refused" },
    });
  });

  it.each([
    "subscription_lifecycle_invalid_transition",
    "customer_self_service_invalid_transition",
    "customer_self_service_conflict",
  ])("normalizes pause transition conflicts across bundles: %s", (message) => {
    expect(mapSubscriptionRpcError({ message }, { action: "pause" })).toMatchObject({
      code: "CONFLICT",
      details: { reason: "customer_subscription_transition_conflict" },
    });
  });
});

describe("mapSubscriptionRepriceError", () => {
  it("maps a plan-length reprice failure to BAD_REQUEST plan_length_unavailable", () => {
    const mapped = mapSubscriptionRepriceError(
      new Error("subscription_reprice_missing_daily_kcal"),
      "update_plan_length",
    );
    expect(mapped).toBeInstanceOf(CustomerSubscriptionActionConflictError);
    expect((mapped as CustomerSubscriptionActionConflictError).code).toBe("BAD_REQUEST");
    expect(mapped.message).toBe("plan_length_unavailable");
  });

  it("maps other reprice failures to subscription_edit_reprice_failed", () => {
    const mapped = mapSubscriptionRepriceError(
      new Error("subscription_reprice_recipe_total_mismatch"),
      "update_recipe_mix",
    );
    expect(mapped.message).toBe("subscription_edit_reprice_failed");
  });

  it("keeps reprice dependency/config faults as upstream failures", () => {
    for (const message of ["subscription_reprice_unavailable", "subscription_reprice_undefined"]) {
      const err = new Error(message);
      expect(mapSubscriptionRepriceError(err, "update_package_template")).toBe(err);
    }
  });

  it("still maps accepted-quote repricer rejections to BAD_REQUEST", () => {
    const mapped = mapSubscriptionRepriceError(
      new Error("subscription_reprice_quote_not_accepted"),
      "update_package_template",
    );
    expect(mapped).toBeInstanceOf(CustomerSubscriptionActionConflictError);
    expect((mapped as CustomerSubscriptionActionConflictError).code).toBe("BAD_REQUEST");
    expect(mapped.message).toBe("subscription_quote_not_accepted");
  });

  it("maps the BFF minimum-order-quantity floor to a client-facing BAD_REQUEST", () => {
    const mapped = mapSubscriptionRepriceError(
      new Error("subscription_reprice_below_minimum_order_units"),
      "update_package_template",
    );
    expect(mapped).toBeInstanceOf(CustomerSubscriptionActionConflictError);
    expect((mapped as CustomerSubscriptionActionConflictError).code).toBe("BAD_REQUEST");
    expect(mapped.message).toBe("subscription_edit_reprice_failed");
  });

  it("carries the precise reprice code as details.reason while keeping the coarse message", () => {
    for (const [message, action, expectedMessage] of [
      ["subscription_reprice_below_minimum_order_units", "update_package_template", "subscription_edit_reprice_failed"],
      ["subscription_reprice_missing_daily_kcal", "update_plan_length", "plan_length_unavailable"],
      ["subscription_reprice_quote_not_accepted", "update_package_template", "subscription_quote_not_accepted"],
    ] as const) {
      const mapped = mapSubscriptionRepriceError(new Error(message), action);
      expect(mapped.message).toBe(expectedMessage);
      expect((mapped as CustomerSubscriptionActionConflictError).details).toEqual({ reason: message });
    }
  });

  it("passes a non-reprice error through unchanged", () => {
    const err = new Error("network down");
    expect(mapSubscriptionRepriceError(err, "update_plan_length")).toBe(err);
  });
});
