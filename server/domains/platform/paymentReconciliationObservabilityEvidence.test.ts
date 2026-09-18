import { describe, expect, it } from "vitest";
import { collectReconciliationMismatchEvidence } from "./paymentReconciliationObservabilityEvidence.js";

describe("payment reconciliation observability", () => {
  it("keeps one latest active mismatch and masks the provider reference", () => {
    const result = collectReconciliationMismatchEvidence(
      [{
        payment_attempt_id: "attempt-1",
        payment_intent_id: "intent-1",
        provider: "stripe",
        provider_payment_id: "pi_secret_reference",
        correction_status: "failed",
        checked_at: "2026-07-14T10:00:00.000Z",
        payload: { failureReason: "provider_amount_mismatch" },
      }, {
        payment_attempt_id: "attempt-1",
        correction_status: "failed",
        checked_at: "2026-07-14T09:00:00.000Z",
        payload: { failureReason: "provider_currency_mismatch" },
      }],
      new Map([["attempt-1", {
        id: "attempt-1",
        payment_intent_id: "intent-1",
        status: "processing",
        provider: "stripe",
      }]]),
      new Map([["intent-1", {
        id: "intent-1",
        status: "processing",
        order_id: "order-1",
      }]]),
      new Date("2026-07-14T10:05:00.000Z"),
    );

    expect([...result.attemptIds]).toEqual(["attempt-1"]);
    expect(result.evidence).toEqual([expect.objectContaining({
      reason: "provider_amount_mismatch",
      providerPaymentId: "redacted_provider_reference",
      operatorNextAction: "inspect_provider_before_retry",
    })]);
    expect(JSON.stringify(result.evidence)).not.toContain("pi_secret_reference");
  });
});
