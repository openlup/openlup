import { describe, expect, it } from "vitest";

import { CheckoutOrchestrationError } from "./commerceCheckoutOrchestration.js";
import {
  START_RUNTIME_SIMPLE_CONFLICTS,
  isJourneyConsumedCheckoutConflict,
  isProviderAttemptInFlightCheckoutConflict,
  isStockUnavailableCheckoutConflict,
} from "./checkoutConflictClassifiers.js";

describe("checkout conflict classifiers", () => {
  it("recognises the inventory-reservation stock conflict by message", () => {
    expect(
      isStockUnavailableCheckoutConflict(
        new CheckoutOrchestrationError("start_runtime: Inventory reservation conflict", "order-1"),
      ),
    ).toBe(true);
  });

  it("rejects non-stock orchestration errors and non-errors as stock conflicts", () => {
    expect(
      isStockUnavailableCheckoutConflict(new CheckoutOrchestrationError("start_runtime: something else", null)),
    ).toBe(false);
    expect(isStockUnavailableCheckoutConflict(new Error("start_runtime: Inventory reservation conflict"))).toBe(false);
    expect(isStockUnavailableCheckoutConflict("nope")).toBe(false);
  });

  it("recognises the consumed-journey conflict by reason", () => {
    expect(
      isJourneyConsumedCheckoutConflict(
        new CheckoutOrchestrationError(
          "start_runtime: Commerce checkout journey already completed",
          "order-1",
          "journey_consumed",
        ),
      ),
    ).toBe(true);
  });

  it("rejects other reasons and non-errors as consumed-journey conflicts", () => {
    expect(
      isJourneyConsumedCheckoutConflict(
        new CheckoutOrchestrationError("start_runtime: x", "order-1", "some_other_reason"),
      ),
    ).toBe(false);
    expect(isJourneyConsumedCheckoutConflict(new Error("journey_consumed"))).toBe(false);
    expect(isJourneyConsumedCheckoutConflict(undefined)).toBe(false);
  });

  it("recognises the provider-attempt-in-flight conflict by reason", () => {
    expect(
      isProviderAttemptInFlightCheckoutConflict(
        new CheckoutOrchestrationError("start_runtime: attempt replayed", null, "provider_attempt_in_flight"),
      ),
    ).toBe(true);
  });

  it("rejects other reasons and non-errors as in-flight conflicts", () => {
    expect(
      isProviderAttemptInFlightCheckoutConflict(
        new CheckoutOrchestrationError("start_runtime: x", null, "some_other_reason"),
      ),
    ).toBe(false);
    expect(isProviderAttemptInFlightCheckoutConflict(new Error("x"))).toBe(false);
    expect(isProviderAttemptInFlightCheckoutConflict(null)).toBe(false);
  });

  it("maps every simple start-runtime conflict to a CONFLICT reason and matches its predicate", () => {
    expect(START_RUNTIME_SIMPLE_CONFLICTS.map((c) => c.reason)).toEqual(["provider_attempt_in_flight"]);

    for (const conflict of START_RUNTIME_SIMPLE_CONFLICTS) {
      expect(conflict.message.length).toBeGreaterThan(0);
      expect(
        conflict.match(new CheckoutOrchestrationError("start_runtime: x", null, conflict.reason)),
      ).toBe(true);
      expect(conflict.match(new Error("unrelated"))).toBe(false);
    }
  });
});
