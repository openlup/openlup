import { describe, expect, it } from "vitest";
import {
  evaluateStripeAccountingPreviewPaymentProof,
  type StripePreviewPaymentProofCase,
  type StripePreviewPaymentProofInput,
} from "./stripePreviewPaymentProof";
import { evaluatePspSandboxE2ESignoff } from "./sandboxE2ESignoff";

describe("Stripe accounting preview payment proof", () => {
  it("accepts the Stripe accounting-preview payment cases without requiring Tpay evidence", () => {
    const decision = evaluateStripeAccountingPreviewPaymentProof(validInput());

    expect(decision.readyForAccountingPreviewPaymentProof).toBe(true);
    expect(decision.missingCases).toEqual([]);
    expect(decision.failedCases).toEqual([]);
    expect(decision.invalidCases).toEqual([]);
    expect(decision.signoffCases.map((entry) => entry.caseId)).toEqual([
      "stripe_one_time",
      "duplicate_submit",
      "missing_webhook_then_reconciliation",
      "late_success_after_timeout",
    ]);
  });

  it("does not turn the accounting-preview subset into full public Stripe activation sign-off", () => {
    const decision = evaluateStripeAccountingPreviewPaymentProof(validInput());
    const publicActivation = evaluatePspSandboxE2ESignoff({
      publicActivationRequested: true,
      providerScope: ["stripe"],
      cases: decision.signoffCases,
    });

    expect(publicActivation.readyForPublicActivationPlan).toBe(false);
    expect(publicActivation.missingCases).toContain("stripe_reusable_method");
    expect(publicActivation.missingCases).toContain("stripe_off_session_requires_recovery");
    expect(publicActivation.missingCases).not.toContain("tpay_blik_one_time");
  });

  it("rejects Stripe/local provider id mismatches and missing verified event proof", () => {
    const input = validInput();
    input.cases[0] = {
      ...input.cases[0],
      provider: {
        ...input.cases[0].provider,
        eventId: null,
      },
      local: {
        ...input.cases[0].local,
        providerPaymentId: "pi_other",
        providerEventId: null,
        inboundEventSignatureVerified: false,
      },
    };

    const decision = evaluateStripeAccountingPreviewPaymentProof(input);

    expect(decision.readyForAccountingPreviewPaymentProof).toBe(false);
    expect(decision.invalidCases).toEqual(["stripe_one_time"]);
    expect(decision.reasons).toEqual(expect.arrayContaining([
      "stripe_one_time: local providerPaymentId must match Stripe PaymentIntent id",
      "stripe_one_time: Stripe evt_* webhook/dashboard event evidence is required",
      "stripe_one_time: local inbound event must be signature verified",
    ]));
  });

  it("rejects duplicate-submit evidence that could still double charge", () => {
    const input = validInput();
    input.cases[1] = {
      ...input.cases[1],
      duplicateSubmit: {
        checkoutSubmitCount: 2,
        providerDashboardPaymentIntentCount: 2,
        localProviderAttemptCount: 2,
        sameProviderIdempotencyKey: false,
      },
    };

    const decision = evaluateStripeAccountingPreviewPaymentProof(input);

    expect(decision.readyForAccountingPreviewPaymentProof).toBe(false);
    expect(decision.invalidCases).toEqual(["duplicate_submit"]);
    expect(decision.reasons).toEqual(expect.arrayContaining([
      "duplicate_submit: duplicate submit must create exactly one Stripe PaymentIntent",
      "duplicate_submit: duplicate submit must create exactly one local provider attempt",
      "duplicate_submit: duplicate submit must reuse the deterministic provider idempotency key",
    ]));
  });

  it("rejects browser-return payment proof and secret-shaped payloads", () => {
    const input = validInput();
    input.cases[2] = {
      ...input.cases[2],
      local: {
        ...input.cases[2].local,
        browserReturnAppliedResult: true,
      },
      recovery: {
        source: "operator_replay",
        processingObservedBeforeRecovery: false,
        paidObservedAfterRecovery: true,
      },
      notes: "operator pasted pi_123_secret_456 while debugging",
    };

    const decision = evaluateStripeAccountingPreviewPaymentProof(input);

    expect(decision.readyForAccountingPreviewPaymentProof).toBe(false);
    expect(decision.reasons).toContain("proof payload contains secret-shaped data");
    expect(decision.reasons).toEqual(expect.arrayContaining([
      "missing_webhook_then_reconciliation: browser return/callback must not apply payment result",
      "missing_webhook_then_reconciliation: missing-webhook proof must observe local processing before recovery",
    ]));
  });

  it("requires late success to be delayed and recorded as a transition", () => {
    const input = validInput();
    input.cases[3] = {
      ...input.cases[3],
      lateSuccess: {
        processingOrExpiredObservedBeforeSuccess: true,
        successDelaySeconds: 10,
        transitionRecorded: false,
      },
    };

    const decision = evaluateStripeAccountingPreviewPaymentProof(input);

    expect(decision.readyForAccountingPreviewPaymentProof).toBe(false);
    expect(decision.reasons).toEqual(expect.arrayContaining([
      "late_success_after_timeout: late success must prove a delayed success, not an immediate webhook",
      "late_success_after_timeout: late success must include local transition evidence",
    ]));
  });
});

function validInput(): StripePreviewPaymentProofInput {
  return {
    providerScope: ["stripe"],
    capturedAt: "2026-06-11T12:00:00.000Z",
    previewHost: "https://openlup-hidden-preview.vercel.app",
    cases: [
      caseProof("stripe_one_time", "pi_stripe_one_time", "evt_stripe_one_time"),
      {
        ...caseProof("duplicate_submit", "pi_duplicate_submit", "evt_duplicate_submit"),
        duplicateSubmit: {
          checkoutSubmitCount: 2,
          providerDashboardPaymentIntentCount: 1,
          localProviderAttemptCount: 1,
          sameProviderIdempotencyKey: true,
        },
      },
      {
        ...caseProof(
          "missing_webhook_then_reconciliation",
          "pi_missing_webhook",
          "evt_missing_webhook",
        ),
        recovery: {
          source: "stripe_event_resend",
          processingObservedBeforeRecovery: true,
          paidObservedAfterRecovery: true,
        },
      },
      {
        ...caseProof("late_success_after_timeout", "pi_late_success", "evt_late_success"),
        lateSuccess: {
          processingOrExpiredObservedBeforeSuccess: true,
          successDelaySeconds: 90,
          transitionRecorded: true,
        },
      },
    ],
  };
}

function caseProof(
  caseId: StripePreviewPaymentProofCase["caseId"],
  paymentIntentId: string,
  eventId: string,
): StripePreviewPaymentProofCase {
  return {
    caseId,
    status: "passed",
    provider: {
      mode: "sandbox",
      paymentIntentId,
      eventId,
      dashboardEvidence: `${eventId} / ${paymentIntentId} in Stripe test dashboard`,
    },
    local: {
      orderId: "44444444-4444-4444-8444-444444444444",
      paymentIntentId: "55555555-5555-4555-8555-555555555555",
      paymentIntentStatus: "succeeded",
      orderPaymentStatus: "paid",
      provider: "stripe",
      providerPaymentId: paymentIntentId,
      paymentAttemptCount: 1,
      providerEventId: eventId,
      inboundEventSignatureVerified: true,
      appliedResultStatus: "succeeded",
      browserReturnAppliedResult: false,
      processingObservedBeforeProviderEvent: true,
    },
  };
}
