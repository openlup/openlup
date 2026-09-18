import { describe, expect, it, vi } from "vitest";

import { createCapturedCheckoutReminderHandler } from "./checkoutRecoveryOperations.js";

function row() {
  return {
    id: "8efaf14b-409f-4a08-b745-5110f565c18c",
    created_at: "2026-08-18T00:00:00.000Z",
    available_at: "2026-08-18T00:00:00.000Z",
    processed_at: null,
    aggregate_type: "commerce_order",
    aggregate_id: "45d3f50a-120d-44b2-a94e-2baa04c21722",
    event_type: "commerce.checkout_recovery",
    idempotency_key: "checkout_recovery:1h:order",
    status: "processing",
    attempts: 1,
    payload: {},
    error: null,
    metadata: { claimToken: "claim-token" },
  };
}

describe("captured checkout reminder handler", () => {
  it("authorizes the active claim and settles an accepted durable receipt", async () => {
    const authorize = vi.fn().mockResolvedValue({
      authorized: true,
      idempotencyKey: "checkout-reminder:event",
      recipientReference: "client:one",
      templateReference: "commerce-checkout-recovery",
    });
    const send = vi.fn().mockResolvedValue({ state: "accepted", attemptCount: 1 });
    const handler = createCapturedCheckoutReminderHandler({
      eventType: "commerce.checkout_recovery",
      authorization: { authorize }, delivery: { send },
    });
    await expect(handler.handle(row(), new AbortController().signal)).resolves.toEqual({
      kind: "processed", detail: { captured: "accepted", attempts: 1 },
    });
    expect(authorize).toHaveBeenCalledWith({ eventId: row().id, claimToken: "claim-token" });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "checkout-reminder:event",
    }));
  });

  it("acks a current-policy refusal without delivery", async () => {
    const send = vi.fn();
    const handler = createCapturedCheckoutReminderHandler({
      eventType: "commerce.checkout_recovery",
      authorization: { authorize: vi.fn().mockResolvedValue({
        authorized: false, reason: "order_not_recoverable",
      }) },
      delivery: { send },
    });
    await expect(handler.handle(row(), new AbortController().signal)).resolves.toEqual({
      kind: "processed", detail: { skipped: "order_not_recoverable" },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps unavailable delivery retryable and never fabricates acceptance", async () => {
    const handler = createCapturedCheckoutReminderHandler({
      eventType: "commerce.checkout_recovery",
      authorization: { authorize: vi.fn().mockResolvedValue({
        authorized: true,
        idempotencyKey: "checkout-reminder:event",
        recipientReference: "client:one",
        templateReference: "commerce-checkout-recovery",
      }) },
      delivery: { send: vi.fn().mockRejectedValue(new Error("unavailable")) },
    });
    await expect(handler.handle(row(), new AbortController().signal)).resolves.toEqual({
      kind: "retry", reason: "captured_transactional_delivery_unavailable",
    });
  });
});
