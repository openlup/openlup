import { describe, expect, it } from "vitest";
import { CommerceRuntimeConflictError } from "../../../src/domains/commerce/runtimePorts.js";
import {
  ProviderAttemptExecutionError,
  ProviderAttemptInFlightError,
  ProviderAttemptPreDispatchError,
} from "../../shared/preparedProviderAttempt.js";
import { mapStartRuntimeFailure } from "./commerceCheckoutStartRuntimeFailure.js";

const PREPARE_PROVIDER_ATTEMPT_IDEMPOTENCY_CONFLICT =
  "payment_control_provider_attempt_prepare_idempotency_conflict";

describe("start-runtime failure mapping", () => {
  it.each([
    [new ProviderAttemptInFlightError({ paymentAttemptId: "attempt", status: "processing", providerAttemptId: null, providerSessionId: null }), null, "provider_attempt_in_flight"],
    [new ProviderAttemptExecutionError(new Error("timeout")), null, "provider_attempt_in_flight"],
    [new CommerceRuntimeConflictError("prepare conflict", { code: "23505", reason: PREPARE_PROVIDER_ATTEMPT_IDEMPOTENCY_CONFLICT }), null, "provider_attempt_in_flight"],
    [new CommerceRuntimeConflictError("unrelated unique conflict", { code: "23505" }), "draft-id", null],
    [new CommerceRuntimeConflictError("consumed", { reason: "journey_consumed" }), "draft-id", "journey_consumed"],
    [new Error("before-dispatch"), "draft-id", null],
  ])("preserves the compensation capability for %s", (error, orderIdForCompensation, reason) => {
    expect(mapStartRuntimeFailure(error, "draft-id")).toMatchObject({ orderIdForCompensation, reason });
  });

  it("carries only trusted pre-dispatch facts outside generic compensation", () => {
    const mapped = mapStartRuntimeFailure(new ProviderAttemptPreDispatchError({
      phase: "oauth",
      code: "tpay_oauth_invalid_response",
      dispatchState: "not_dispatched",
    }, "attempt-1"), "draft-id");

    expect(mapped).toMatchObject({
      orderIdForCompensation: null,
      reason: "provider_attempt_not_dispatched",
      paymentAttemptId: "attempt-1",
      phase: "oauth",
      code: "tpay_oauth_invalid_response",
      dispatchState: "not_dispatched",
    });
    expect(mapped.message).toBe("start_runtime: provider transaction was not dispatched");
  });
});
