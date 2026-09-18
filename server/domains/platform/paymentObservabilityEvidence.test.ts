import { describe, expect, it } from "vitest";
import { summarizePayments } from "./paymentObservabilityEvidence.js";

const now = new Date("2026-07-03T14:00:00.000Z");

describe("payment observability evidence", () => {
  it.each([
    {
      label: "renewal",
      targetKind: "subscription_cycle",
      subscriptionId: "sub-1",
      subscriptionCycleId: "cycle-1",
    },
    {
      label: "one-time",
      targetKind: "one_time_order",
      subscriptionId: null,
      subscriptionCycleId: null,
    },
  ])("surfaces stale prepared $label attempts without provider acknowledgement", ({
    targetKind,
    subscriptionId,
    subscriptionCycleId,
  }) => {
    const snapshot = summarizePayments(
      [{
        id: "intent-1",
        status: "processing",
        target_kind: targetKind,
        order_id: "order-1",
        subscription_id: subscriptionId,
        subscription_cycle_id: subscriptionCycleId,
        amount_cents: 1299,
        currency: "PLN",
      }],
      [{
        id: "attempt-1",
        payment_intent_id: "intent-1",
        status: "created",
        provider: "stripe",
        created_at: "2026-07-03T13:20:00.000Z",
        request_payload: {
          client_secret: "pi_secret",
          paymentMethodRef: "pm_ref",
          blik: "123456",
        },
      }],
      [],
      now,
    );

    expect(snapshot.preparedWithoutProviderAckCount).toBe(1);
    expect(snapshot.evidence).toContainEqual(expect.objectContaining({
      kind: "prepared_without_provider_ack",
      paymentIntentId: "intent-1",
      paymentAttemptId: "attempt-1",
      orderId: "order-1",
      subscriptionId,
      subscriptionCycleId,
      providerPaymentId: null,
      owner: "commerce/payment",
      customerSafeStatus: "operator_review_required",
      operatorNextAction: "inspect_provider_before_retry",
      reason: targetKind === "subscription_cycle"
        ? "prepared_subscription_attempt_without_provider_ack"
        : "prepared_attempt_without_provider_ack",
    }));
    expect(JSON.stringify(snapshot.evidence)).not.toContain("client_secret");
    expect(JSON.stringify(snapshot.evidence)).not.toContain("paymentMethodRef");
    expect(JSON.stringify(snapshot.evidence)).not.toContain("123456");
  });

  it("does not flag fresh, provider-acknowledged, or terminal prepared attempts", () => {
    const snapshot = summarizePayments(
      [
        {
          id: "fresh-intent",
          status: "processing",
          target_kind: "subscription_cycle",
        },
        {
          id: "acked-intent",
          status: "processing",
          target_kind: "subscription_cycle",
        },
        {
          id: "terminal-intent",
          status: "succeeded",
          target_kind: "subscription_cycle",
        },
      ],
      [
        {
          id: "fresh-attempt",
          payment_intent_id: "fresh-intent",
          status: "created",
          provider: "stripe",
          created_at: "2026-07-03T13:50:00.000Z",
        },
        {
          id: "acked-attempt",
          payment_intent_id: "acked-intent",
          status: "created",
          provider: "tpay",
          provider_session_id: "tpay-session",
          created_at: "2026-07-03T13:00:00.000Z",
        },
        {
          id: "terminal-attempt",
          payment_intent_id: "terminal-intent",
          status: "created",
          provider: "stripe",
          created_at: "2026-07-03T13:00:00.000Z",
        },
      ],
      [],
      now,
    );

    expect(snapshot.preparedWithoutProviderAckCount).toBe(0);
    expect(snapshot.evidence.some((row) => row.kind === "prepared_without_provider_ack")).toBe(false);
  });

  it("uses the fresher side of the attempt-intent pair for stale evidence", () => {
    const snapshot = summarizePayments(
      [
        {
          id: "fresh-intent",
          status: "processing",
          target_kind: "one_time_order",
          updated_at: "2026-07-03T13:50:00.000Z",
        },
        {
          id: "stale-intent",
          status: "processing",
          target_kind: "one_time_order",
          updated_at: "2026-07-03T13:00:00.000Z",
        },
      ],
      [
        {
          id: "attempt-with-fresh-intent",
          payment_intent_id: "fresh-intent",
          status: "created",
          provider: "stripe",
          created_at: "2026-07-03T12:00:00.000Z",
          updated_at: "2026-07-03T13:00:00.000Z",
        },
        {
          id: "fresh-attempt",
          payment_intent_id: "stale-intent",
          status: "created",
          provider: "stripe",
          created_at: "2026-07-03T12:00:00.000Z",
          updated_at: "2026-07-03T13:50:00.000Z",
        },
      ],
      [],
      now,
    );

    expect(snapshot.preparedWithoutProviderAckCount).toBe(0);
    expect(snapshot.webhookMissingCount).toBe(0);
    expect(snapshot.stuckProcessingCount).toBe(0);
  });

  it("treats refunded intents as consistent with provider success events", () => {
    const snapshot = summarizePayments(
      [{
        id: "intent-1",
        status: "refunded",
        target_kind: "one_time_order",
        order_id: "order-1",
        amount_cents: 1299,
        currency: "PLN",
      }],
      [{
        id: "attempt-1",
        payment_intent_id: "intent-1",
        status: "succeeded",
        provider: "tpay",
        provider_payment_id: "tpay-payment-1",
        created_at: "2026-07-03T12:00:00.000Z",
        updated_at: "2026-07-03T12:05:00.000Z",
      }],
      [{
        event_type: "payment.succeeded",
        payment_intent_id: "intent-1",
        payment_attempt_id: "attempt-1",
        provider_payment_id: "tpay-payment-1",
        amount_cents: 1299,
        currency: "PLN",
        signature_verified: true,
      }],
      now,
    );

    expect(snapshot.providerPaidLocalUnpaidCount).toBe(0);
    expect(snapshot.evidence.some((row) => row.kind === "provider_paid_local_unpaid")).toBe(false);
  });

  it("still flags provider success events for genuinely unpaid intents", () => {
    const snapshot = summarizePayments(
      [{
        id: "intent-1",
        status: "pending",
        target_kind: "one_time_order",
        amount_cents: 1299,
        currency: "PLN",
      }],
      [],
      [{
        event_type: "payment.succeeded",
        payment_intent_id: "intent-1",
        amount_cents: 1299,
        currency: "PLN",
        signature_verified: true,
      }],
      now,
    );

    expect(snapshot.providerPaidLocalUnpaidCount).toBe(1);
    expect(snapshot.evidence).toContainEqual(expect.objectContaining({
      kind: "provider_paid_local_unpaid",
      paymentIntentId: "intent-1",
      reason: "provider_success_event_local_not_succeeded",
    }));
  });

  it("masks provider references in mismatch evidence", () => {
    const snapshot = summarizePayments(
      [{
        id: "intent-1",
        status: "processing",
        amount_cents: 1299,
        currency: "PLN",
      }],
      [{
        id: "attempt-1",
        payment_intent_id: "intent-1",
        status: "processing",
        provider: "tpay",
        provider_payment_id: "payid_reusable_alias",
        created_at: "2026-07-03T13:00:00.000Z",
      }],
      [{
        event_type: "payment.succeeded",
        payment_intent_id: "intent-1",
        payment_attempt_id: "attempt-1",
        provider_payment_id: "pi_123_secret_456",
        signature_verified: true,
      }],
      now,
    );

    expect(snapshot.evidence.some((row) => row.providerPaymentId === "redacted_provider_reference")).toBe(true);
    expect(JSON.stringify(snapshot.evidence)).not.toContain("payid_reusable_alias");
    expect(JSON.stringify(snapshot.evidence)).not.toContain("pi_123_secret_456");
  });

  it("promotes reconciliation mismatch evidence and suppresses its derived stuck alerts", () => {
    const snapshot = summarizePayments(
      [{
        id: "intent-1",
        status: "processing",
        order_id: "order-1",
        subscription_id: "sub-1",
        subscription_cycle_id: "cycle-1",
        amount_cents: 1299,
        currency: "PLN",
      }],
      [{
        id: "attempt-1",
        payment_intent_id: "intent-1",
        status: "processing",
        provider: "stripe",
        provider_payment_id: "pi_sensitive_reference",
        created_at: "2026-07-03T13:00:00.000Z",
      }],
      [],
      now,
      [{
        payment_attempt_id: "attempt-1",
        payment_intent_id: "intent-1",
        provider: "stripe",
        provider_payment_id: "pi_sensitive_reference",
        correction_status: "failed",
        checked_at: "2026-07-03T13:45:00.000Z",
        payload: { failureReason: "provider_amount_mismatch", providerPayload: { client_secret: "secret" } },
      }],
    );

    expect(snapshot).toMatchObject({
      amountCurrencyMismatchCount: 1,
      webhookMissingCount: 0,
      stuckProcessingCount: 0,
    });
    expect(snapshot.evidence).toContainEqual(expect.objectContaining({
      kind: "amount_currency_mismatch",
      paymentIntentId: "intent-1",
      paymentAttemptId: "attempt-1",
      orderId: "order-1",
      reason: "provider_amount_mismatch",
      operatorNextAction: "inspect_provider_before_retry",
    }));
    expect(JSON.stringify(snapshot.evidence)).not.toContain("pi_sensitive_reference");
    expect(JSON.stringify(snapshot.evidence)).not.toContain("client_secret");
  });

  it("keeps resolved mismatch history ledger-only once the attempt is terminal", () => {
    const snapshot = summarizePayments(
      [{ id: "intent-1", status: "failed", amount_cents: 1299, currency: "PLN" }],
      [{ id: "attempt-1", payment_intent_id: "intent-1", status: "failed", provider: "stripe" }],
      [],
      now,
      [{
        payment_attempt_id: "attempt-1",
        payment_intent_id: "intent-1",
        provider: "stripe",
        correction_status: "failed",
        checked_at: "2026-07-03T13:45:00.000Z",
        payload: { failureReason: "provider_amount_mismatch" },
      }],
    );

    expect(snapshot.amountCurrencyMismatchCount).toBe(0);
  });

  it("lets the latest corrected readback supersede an older mismatch", () => {
    const snapshot = summarizePayments(
      [{ id: "intent-1", status: "processing", amount_cents: 1299, currency: "PLN" }],
      [{ id: "attempt-1", payment_intent_id: "intent-1", status: "processing", provider: "stripe" }],
      [],
      now,
      [
        {
          payment_attempt_id: "attempt-1",
          payment_intent_id: "intent-1",
          correction_status: "corrected",
          checked_at: "2026-07-03T13:55:00.000Z",
          payload: {},
        },
        {
          payment_attempt_id: "attempt-1",
          payment_intent_id: "intent-1",
          correction_status: "failed",
          checked_at: "2026-07-03T13:45:00.000Z",
          payload: { failureReason: "provider_amount_mismatch" },
        },
      ],
    );

    expect(snapshot.amountCurrencyMismatchCount).toBe(0);
  });

  it("deduplicates a provider event mismatch without attempt id by provider reference", () => {
    const snapshot = summarizePayments(
      [{ id: "intent-1", status: "processing", amount_cents: 1299, currency: "PLN" }],
      [{
        id: "attempt-1",
        payment_intent_id: "intent-1",
        status: "processing",
        provider: "stripe",
        provider_payment_id: "pi_same",
      }],
      [{
        event_type: "payment.succeeded",
        payment_intent_id: "intent-1",
        provider_payment_id: "pi_same",
        amount_cents: 999,
        currency: "PLN",
      }],
      now,
      [{
        payment_attempt_id: "attempt-1",
        payment_intent_id: "intent-1",
        provider: "stripe",
        provider_payment_id: "pi_same",
        correction_status: "failed",
        checked_at: "2026-07-03T13:45:00.000Z",
        payload: { failureReason: "provider_amount_mismatch" },
      }],
    );

    expect(snapshot.amountCurrencyMismatchCount).toBe(1);
  });
});
