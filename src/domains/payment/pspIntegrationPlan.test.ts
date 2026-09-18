import { describe, expect, it } from "vitest";
import {
  ASYNC_CHECKOUT_STATUSES,
  PSP_ACCEPTANCE_GATES,
  PSP_BRUTAL_CHALLENGE_CHECKS,
  PSP_INTEGRATION_WAVES,
  PSP_OBSERVABILITY_EVENTS,
  PSP_PAYMENT_SCENARIOS,
  PSP_PROVIDER_MATRIX,
} from "./pspIntegrationPlan.js";

describe("PSP integration wave gates", () => {
  it("captures the selected sandbox provider matrix without outsourcing ownership", () => {
    expect(PSP_PAYMENT_SCENARIOS).toEqual([
      "stripe_one_time_card_wallet",
      "stripe_reusable_off_session",
      "tpay_one_time_blik",
      "tpay_blik_recurring",
    ]);
    expect(PSP_PROVIDER_MATRIX).toHaveLength(4);
    expect(PSP_PROVIDER_MATRIX.every((entry) => entry.localOwner === "payment-control")).toBe(true);
    expect(PSP_PROVIDER_MATRIX.every((entry) => entry.subscriptionOwner === "downstream-subscription-engine")).toBe(true);
    expect(PSP_PROVIDER_MATRIX.every((entry) => entry.requiredRefs.length > 0)).toBe(true);
  });

  it("locks async checkout to states that cannot mark paid from browser return alone", () => {
    expect(ASYNC_CHECKOUT_STATUSES).toEqual([
      "pending_provider_action",
      "requires_action",
      "processing",
      "paid",
      "failed",
      "expired",
    ]);
  });

  it("requires every wave to run the full brutal challenge ritual", () => {
    expect(PSP_INTEGRATION_WAVES).toHaveLength(9);
    for (const wave of PSP_INTEGRATION_WAVES) {
      expect(wave.mustHaveDetailedPlan).toBe(true);
      expect(wave.mustRunPreImplementationBrutalChallenge).toBe(true);
      expect(wave.mustRunPostImplementationBrutalReview).toBe(true);
      expect(wave.requiresDocsUpdate).toBe(true);
      expect(wave.requiredChallengeChecks).toEqual(PSP_BRUTAL_CHALLENGE_CHECKS);
      expect(wave.requiredObservabilityEvents.length).toBeGreaterThan(0);
      expect(wave.requiredAcceptanceGates.length).toBeGreaterThan(0);
    }
  });

  it("keeps the required observability and acceptance gates explicit", () => {
    expect(PSP_OBSERVABILITY_EVENTS).toEqual([
      "payment.checkout_started",
      "payment.provider_attempt_created",
      "payment.provider_action_returned",
      "payment.webhook_received",
      "payment.webhook_rejected",
      "payment.result_applied",
      "payment.reconciliation_mismatch",
      "payment.recovery_link_created",
      "payment.recovery_completed",
      "payment.stuck_processing_detected",
    ]);
    expect(PSP_ACCEPTANCE_GATES).toContain("deterministic_provider_idempotency");
    expect(PSP_ACCEPTANCE_GATES).toContain("browser_return_never_marks_paid");
    expect(PSP_ACCEPTANCE_GATES).toContain("stuck_processing_has_watchdog_or_reconciliation");
    expect(PSP_ACCEPTANCE_GATES).toContain("sandbox_e2e_before_public_launch");
  });
});
