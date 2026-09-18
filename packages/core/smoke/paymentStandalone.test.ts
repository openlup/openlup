import { describe, expect, it } from "vitest";
import {
  derivePaymentRecoveryGuidance,
  PAYMENT_ATTEMPT_STATUSES,
  PAYMENT_CONTROL_EVENT_TYPES,
  PAYMENT_EXECUTION_ATTEMPT_STATUSES,
  PAYMENT_EXECUTION_MODES,
  PAYMENT_INTENT_STATUSES,
  PAYMENT_FAILURE_CLASSES,
  PAYMENT_TARGET_KINDS,
  SCHEME_RETRY_ATTEMPT_CEILING,
  applyProviderPaymentEvent,
  buildProviderAttemptIdentity,
  canTransitionPaymentAttempt,
  canTransitionPaymentIntent,
  classifyPaymentFailure,
  failureClassDecision,
  isProviderAttemptReplaySafe,
  withinSchemeRetryCeiling,
} from "@openlup/core/payment";
import type {
  PaymentProviderCapabilityDescriptor,
  PaymentProviderCapabilityRegistry,
} from "@openlup/core/payment";

describe("payment standalone", () => {
  it("projects recovery with only portable method and refusal facts", () => {
    const evidence = { refusalVerified: true, cause: "generic_decline" as const, certainty: "unknown" as const,
      disclosure: "safe" as const, advice: null, operation: "one_time_payment" as const,
      method: { kind: "example_method", recoveryMethodKey: "choice", interaction: "new_instrument" as const } };
    const result = derivePaymentRecoveryGuidance({ paymentState: "failed", activeAttemptId: "current",
      historyComplete: true, attempts: [{ id: "current", status: "failed", evidence }, { id: "previous", status: "failed", evidence }] });
    expect(result).toMatchObject({ cause: "generic_decline", consecutiveRefusals: 2, emphasis: "recommended" });
  });

  it("types an unattended-charge capability without naming a provider", () => {
    const descriptor: PaymentProviderCapabilityDescriptor = {
      providerKind: "example_pay",
      captureFlows: [{ kind: "wallet_on_file_setup", handoff: "embedded_client_secret" }],
      requiresStoredMandateEvidence: true,
      assessMandate: (snapshot) => snapshot.recurringModel === "unattended"
        ? { chargeable: true }
        : { chargeable: false, blockReason: "mandate_model_unsupported_for_unattended_charge" },
      unattendedChargeFlow: "off_session_payment",
      payerContext: { requiresPayerBlock: true, customerRefFallsBackToContactEmail: true },
      methodHealth: {
        requiresCustomerRef: false,
        requiredMethodKind: "wallet",
        requiresPayerContact: true,
      },
      mandateUpsertIsSubscriptionScoped: true,
  terminalOutcomeReporting: { kind: "status_field", silenceBecomesSuspectAfterMinutes: 360 },
    };
    const registry: PaymentProviderCapabilityRegistry = {
      get: (providerKind) => providerKind === descriptor.providerKind ? descriptor : null,
      kinds: () => [descriptor.providerKind],
    };

    expect(registry.get("example_pay")?.assessMandate({ recurringModel: null })).toEqual({
      chargeable: false,
      blockReason: "mandate_model_unsupported_for_unattended_charge",
    });
    expect(registry.kinds()).toEqual(["example_pay"]);
    expect(registry.get("unregistered")).toBeNull();
  });

  it("exports neutral payment-control primitives and state transitions", () => {
    expect(PAYMENT_TARGET_KINDS).toEqual(["one_time_order", "subscription_cycle"]);
    expect(PAYMENT_INTENT_STATUSES).toContain("partially_refunded");
    expect(PAYMENT_ATTEMPT_STATUSES).toContain("blocked_preflight");
    expect(PAYMENT_EXECUTION_MODES).toEqual(["one_time", "subscription_cycle"]);
    expect(PAYMENT_EXECUTION_ATTEMPT_STATUSES).toEqual([
      "sent_to_provider",
      "requires_action",
      "processing",
    ]);
    expect(PAYMENT_CONTROL_EVENT_TYPES).toContain("payment.disputed");
    expect(canTransitionPaymentIntent("processing", "succeeded")).toBe(true);
    expect(canTransitionPaymentAttempt("succeeded", "failed")).toBe(false);
  });

  it("applies a provider success event without provider-specific runtime", () => {
    const decision = applyProviderPaymentEvent({
      intent: {
        id: "payment_intent_example",
        targetKind: "subscription_cycle",
        targetId: "cycle_example",
        status: "processing",
        amountMinor: 4200,
        currency: "USD",
        activeAttemptId: "payment_attempt_example",
        updatedAt: "2026-01-01T00:00:00.000Z",
        providerPaymentId: null,
        failureReason: null,
      },
      attempt: {
        id: "payment_attempt_example",
        intentId: "payment_intent_example",
        status: "processing",
        provider: "example-pay",
        providerAttemptId: "example_provider_attempt",
        amountMinor: 4200,
        currency: "USD",
        idempotencyKey: "example-idempotency-key",
        updatedAt: "2026-01-01T00:00:00.000Z",
        nextActionKind: null,
        failureReason: null,
      },
      event: {
        provider: "example-pay",
        providerEventId: "event_success",
        eventType: "payment.succeeded",
        providerPaymentId: "example_provider_attempt",
        amountMinor: 4200,
        currency: "USD",
        occurredAt: "2026-01-01T00:05:00.000Z",
        rawPayload: {},
      },
    });

    expect(decision).toMatchObject({
      ok: true,
      value: {
        kind: "state_changed",
        reason: "provider_succeeded",
        intent: { status: "succeeded", providerPaymentId: "example_provider_attempt" },
        attempt: { status: "succeeded" },
      },
    });
  });

  it("classifies a refusal from neutral evidence with no adapter present", () => {
    expect(PAYMENT_FAILURE_CLASSES).toContain("mandate_dead");
    expect(classifyPaymentFailure({
      adviceCode: "do_not_try_again",
      neutralReasonHints: ["transient"],
    })).toEqual({ failureClass: "hard_do_not_retry", decidedBy: "advice_code" });
    expect(failureClassDecision("hard_do_not_retry")).toEqual({
      retryAllowed: false,
      retryProfile: "none",
      customerActionRequired: true,
      methodReplacementRequired: true,
    });
    expect(withinSchemeRetryCeiling(SCHEME_RETRY_ATTEMPT_CEILING, 30)).toBe(true);
    expect(withinSchemeRetryCeiling(SCHEME_RETRY_ATTEMPT_CEILING + 1, 30)).toBe(false);
  });

  it("builds provider attempt identity with caller-owned namespace", () => {
    const first = buildProviderAttemptIdentity({
      namespace: "example",
      provider: "Example Pay",
      localExecutionIdempotencyKey: "checkout:payment execution",
      paymentIntentId: "payment_intent_example",
      amountMinor: 4200,
      currency: "usd",
      mode: "one_time",
      orderRef: "order_example",
    });
    const changedAmount = buildProviderAttemptIdentity({
      namespace: "example",
      provider: "Example Pay",
      localExecutionIdempotencyKey: "checkout:payment execution",
      paymentIntentId: "payment_intent_example",
      amountMinor: 4300,
      currency: "USD",
      mode: "one_time",
      orderRef: "order_example",
    });

    expect(first).toEqual({
      providerIdempotencyKey: "example:example_pay:payment_intent_example:checkout:payment_execution",
      providerRequestFingerprint: "example_pay|payment_intent_example|4200|USD|one_time|order_example",
    });
    expect(changedAmount.providerIdempotencyKey).toBe(first.providerIdempotencyKey);
    expect(isProviderAttemptReplaySafe({
      existingFingerprint: first.providerRequestFingerprint,
      nextFingerprint: changedAmount.providerRequestFingerprint,
    })).toBe(false);
  });
});
