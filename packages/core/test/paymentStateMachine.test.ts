import { describe, expect, it } from "vitest";
import {
  applyProviderPaymentEvent,
  canTransitionPaymentAttempt,
  canTransitionPaymentIntent,
  transitionPaymentAttempt,
  transitionPaymentIntent,
  type CanonicalPaymentControlEvent,
  type PaymentAttemptAggregate,
  type PaymentIntentAggregate,
} from "../src/payment/index.js";

const at = "2026-07-01T10:00:00.000Z";

function intent(overrides: Partial<PaymentIntentAggregate> = {}): PaymentIntentAggregate {
  return {
    id: "intent-example",
    targetKind: "one_time_order",
    targetId: "order-example",
    status: "processing",
    amountMinor: 4200,
    currency: "USD",
    activeAttemptId: "attempt-example",
    updatedAt: at,
    providerPaymentId: null,
    failureReason: null,
    ...overrides,
  };
}

function attempt(overrides: Partial<PaymentAttemptAggregate> = {}): PaymentAttemptAggregate {
  return {
    id: "attempt-example",
    intentId: "intent-example",
    status: "processing",
    provider: "example-pay",
    providerAttemptId: "provider-payment-example",
    amountMinor: 4200,
    currency: "USD",
    idempotencyKey: "payment-example",
    updatedAt: at,
    nextActionKind: null,
    failureReason: null,
    ...overrides,
  };
}

function event(overrides: Partial<CanonicalPaymentControlEvent> = {}): CanonicalPaymentControlEvent {
  return {
    provider: "example-pay",
    providerEventId: "event-example",
    eventType: "payment.succeeded",
    providerPaymentId: "provider-payment-example",
    amountMinor: 4200,
    currency: "USD",
    occurredAt: "2026-07-01T10:05:00.000Z",
    rawPayload: {},
    ...overrides,
  };
}

describe("payment state machine", () => {
  it("keeps the provider-neutral transition matrix explicit", () => {
    expect(canTransitionPaymentIntent("created", "requires_action")).toBe(true);
    expect(canTransitionPaymentIntent("requires_action", "processing")).toBe(true);
    expect(canTransitionPaymentAttempt("created", "blocked_preflight")).toBe(true);
    expect(canTransitionPaymentAttempt("blocked_preflight", "failed")).toBe(true);
    expect(canTransitionPaymentAttempt("blocked_preflight", "succeeded")).toBe(false);
    expect(canTransitionPaymentAttempt("sent_to_provider", "succeeded")).toBe(true);
    expect(canTransitionPaymentAttempt("succeeded", "failed")).toBe(false);
  });

  it("rejects illegal aggregate transitions and preserves failure context", () => {
    expect(transitionPaymentIntent({ intent: intent({ status: "cancelled" }), to: "processing", at }))
      .toMatchObject({ ok: false, reason: "invalid_transition" });
    expect(transitionPaymentAttempt({ attempt: attempt({ status: "succeeded" }), to: "failed", at }))
      .toMatchObject({ ok: false, reason: "invalid_transition" });
    expect(transitionPaymentIntent({ intent: intent(), to: "failed", at }))
      .toMatchObject({ ok: true, value: { status: "failed", failureReason: "provider_failed" } });
    expect(transitionPaymentAttempt({ attempt: attempt(), to: "requires_action", at, nextActionKind: "redirect" }))
      .toMatchObject({ ok: true, value: { status: "requires_action", nextActionKind: "redirect" } });
  });

  it("fails closed on replay target and money mismatches", () => {
    expect(applyProviderPaymentEvent({
      intent: intent(),
      attempt: attempt(),
      event: event(),
      seenProviderEventIds: ["event-example"],
    })).toMatchObject({ ok: true, value: { kind: "noop", reason: "duplicate_provider_event" } });
    expect(applyProviderPaymentEvent({
      intent: intent({ activeAttemptId: "different-attempt" }),
      attempt: attempt(),
      event: event(),
    })).toMatchObject({ ok: false, reason: "wrong_attempt" });
    expect(applyProviderPaymentEvent({
      intent: intent(),
      attempt: attempt(),
      event: event({ currency: "EUR" }),
    })).toMatchObject({ ok: false, reason: "currency_mismatch" });
    expect(applyProviderPaymentEvent({
      intent: intent(),
      attempt: attempt(),
      event: event({ amountMinor: 4199 }),
    })).toMatchObject({ ok: false, reason: "amount_mismatch" });
  });

  it("records required action and provider failure", () => {
    expect(applyProviderPaymentEvent({
      intent: intent(),
      attempt: attempt(),
      event: event({ eventType: "payment.requires_action", nextActionKind: "redirect" }),
    })).toMatchObject({
      ok: true,
      value: {
        reason: "provider_requires_action",
        intent: { status: "requires_action" },
        attempt: { status: "requires_action", nextActionKind: "redirect" },
      },
    });
    expect(applyProviderPaymentEvent({
      intent: intent(),
      attempt: attempt(),
      event: event({ eventType: "payment.failed", failureReason: "declined" }),
    })).toMatchObject({
      ok: true,
      value: {
        reason: "provider_failed",
        intent: { status: "failed", failureReason: "declined" },
        attempt: { status: "failed", failureReason: "declined" },
      },
    });
  });

  it("applies provider success and supports an explicit retry transition", () => {
    expect(applyProviderPaymentEvent({
      intent: intent(),
      attempt: attempt(),
      event: event(),
    })).toMatchObject({
      ok: true,
      value: {
        kind: "state_changed",
        reason: "provider_succeeded",
        intent: { status: "succeeded", providerPaymentId: "provider-payment-example" },
        attempt: { status: "succeeded" },
      },
    });
    expect(transitionPaymentIntent({
      intent: intent({ status: "failed", activeAttemptId: null }),
      to: "processing",
      at,
    })).toMatchObject({ ok: true, value: { status: "processing" } });
    expect(transitionPaymentAttempt({
      attempt: attempt({ status: "created" }),
      to: "sent_to_provider",
      at,
    })).toMatchObject({ ok: true, value: { status: "sent_to_provider" } });
  });

  it("recovers late success but ignores failure after success", () => {
    expect(applyProviderPaymentEvent({
      intent: intent({ status: "failed" }),
      attempt: attempt({ status: "failed" }),
      event: event(),
    })).toMatchObject({ ok: true, value: { kind: "late_success_recovered" } });
    expect(applyProviderPaymentEvent({
      intent: intent({ status: "succeeded" }),
      attempt: attempt({ status: "succeeded" }),
      event: event({ eventType: "payment.failed" }),
    })).toMatchObject({ ok: true, value: { kind: "noop", reason: "ignored_failure_after_success_or_terminal" } });
    expect(applyProviderPaymentEvent({
      intent: intent({ status: "succeeded" }),
      attempt: attempt({ status: "succeeded" }),
      event: event(),
    })).toMatchObject({ ok: true, value: { kind: "noop", reason: "already_succeeded" } });
  });

  it("handles partial and full refunds only against succeeded money", () => {
    expect(applyProviderPaymentEvent({
      intent: intent({ status: "succeeded" }),
      attempt: attempt({ status: "succeeded" }),
      event: event({ eventType: "payment.refunded", amountMinor: 1000 }),
    })).toMatchObject({ ok: true, value: { intent: { status: "partially_refunded" } } });
    expect(applyProviderPaymentEvent({
      intent: intent({ status: "succeeded" }),
      attempt: attempt({ status: "succeeded" }),
      event: event({ eventType: "payment.refunded" }),
    })).toMatchObject({ ok: true, value: { intent: { status: "refunded" } } });
    expect(applyProviderPaymentEvent({
      intent: intent({ status: "created" }),
      attempt: attempt({ status: "created" }),
      event: event({ eventType: "payment.refunded" }),
    })).toMatchObject({ ok: false, reason: "refund_requires_success" });
    expect(applyProviderPaymentEvent({
      intent: intent({ status: "succeeded" }),
      attempt: attempt({ status: "succeeded" }),
      event: event({ eventType: "payment.refunded", amountMinor: 0 }),
    })).toMatchObject({ ok: false, reason: "amount_mismatch" });
  });

  it("records disputes except against a cancelled intent", () => {
    expect(applyProviderPaymentEvent({
      intent: intent({ status: "succeeded" }),
      attempt: attempt({ status: "succeeded" }),
      event: event({ eventType: "payment.disputed" }),
    })).toMatchObject({ ok: true, value: { intent: { status: "disputed" } } });
    expect(applyProviderPaymentEvent({
      intent: intent({ status: "cancelled" }),
      attempt: attempt({ status: "cancelled" }),
      event: event({ eventType: "payment.disputed" }),
    })).toMatchObject({ ok: false, reason: "terminal_intent" });
  });
});
