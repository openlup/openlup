import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertPaymentTruthEvent,
  paymentPayloadFingerprint,
  paymentReconciliationFingerprint,
  paymentSourceFingerprint,
  paymentTruthFingerprint,
  type PaymentTruthEvent,
} from "./paymentTruth.js";

const event = (overrides: Partial<PaymentTruthEvent> = {}): PaymentTruthEvent => ({
  sourceEventId: "simulator-event-1",
  idempotencyKey: "payment-event:simulator-event-1",
  settlementIntentId: "11111111-1111-4111-8111-111111111111",
  outcome: "captured",
  amountMinor: 2599,
  currency: "XTS",
  occurredAt: "2026-08-15T12:00:00.000Z",
  failure: null,
  evidence: {
    sourceKind: "accepted_event",
    sourceReference: "simulator:event-1",
    observedStatus: "captured",
    observedAt: "2026-08-15T12:00:00.000Z",
    payloadFingerprint: createHash("sha256").update("captured:event-1").digest("hex"),
  },
  ...overrides,
});

describe("payment truth", () => {
  it("builds one canonical fingerprint independent of object insertion order", () => {
    const first = paymentTruthFingerprint(event());
    const reordered = event({
      evidence: {
        payloadFingerprint: event().evidence.payloadFingerprint,
        observedAt: event().evidence.observedAt,
        observedStatus: event().evidence.observedStatus,
        sourceReference: event().evidence.sourceReference,
        sourceKind: event().evidence.sourceKind,
      },
    });
    expect(paymentTruthFingerprint(reordered)).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes the fingerprint when financial or source evidence changes", () => {
    const first = paymentTruthFingerprint(event());
    expect(paymentTruthFingerprint(event({ currency: "EUR" }))).not.toBe(first);
    expect(paymentTruthFingerprint(event({ sourceEventId: "simulator-event-2" }))).not.toBe(first);
  });

  it("fingerprints an accepted source before local intent ownership is known", () => {
    const payloadFingerprint = paymentPayloadFingerprint({ status: "captured", amount: 2599 });
    expect(paymentSourceFingerprint({
      sourceEventId: "simulator:event-1",
      eventKind: "payment.captured",
      settlementIntentId: null,
      amountMinor: 2599,
      currency: "XTS",
      occurredAt: "2026-08-15T12:00:00.000Z",
      payloadFingerprint,
    })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps currency as validated data and never defaults it", () => {
    expect(() => assertPaymentTruthEvent(event({ currency: "PLN" }))).not.toThrow();
    expect(() => assertPaymentTruthEvent(event({ currency: "XTS" }))).not.toThrow();
    expect(() => assertPaymentTruthEvent(event({ currency: "" }))).toThrow("payment_truth_currency_invalid");
  });

  it("requires neutral failure taxonomy only for an explicit refusal", () => {
    expect(() => assertPaymentTruthEvent(event({ outcome: "refused", failure: null })))
      .toThrow("payment_truth_refusal_classification_required");
    expect(() => assertPaymentTruthEvent(event({
      outcome: "refused",
      failure: { classification: "insufficient_funds", reason: "declined" },
    }))).not.toThrow();
    expect(() => assertPaymentTruthEvent(event({
      outcome: "indeterminate",
      failure: { classification: "unknown_refusal", reason: null },
    }))).toThrow("payment_truth_failure_only_for_refusal");
  });

  it("does not let failed reconciliation evidence terminalize money", () => {
    expect(() => paymentReconciliationFingerprint({
      eventId: "event-1",
      idempotencyKey: "reconcile:event-1:1",
      evidenceStatus: "failed",
      outcome: "captured",
      occurredAt: "2026-08-15T12:05:00.000Z",
      failure: null,
      evidence: { ...event().evidence, sourceKind: "reconciliation_read" },
    })).toThrow("payment_reconciliation_failure_cannot_terminalize");
  });

  it("enforces the closed neutral failure taxonomy at runtime", () => {
    expect(() => assertPaymentTruthEvent(event({
      outcome: "refused",
      failure: { classification: "provider_declined" as "unknown_refusal", reason: null },
    }))).toThrow("payment_truth_failure_class_invalid");
  });

  it("uses code-unit key order for canonical payload fingerprints", () => {
    const first = paymentPayloadFingerprint({ z: 1, Z: 2, a: { y: 3, A: 4 } });
    const reordered = paymentPayloadFingerprint({ a: { A: 4, y: 3 }, Z: 2, z: 1 });
    expect(reordered).toBe(first);
  });
});
