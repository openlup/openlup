import { describe, expect, it } from "vitest";
import { readActivePaymentAttempts } from "./paymentAttempts.js";

describe("supabase commerce OMS payment attempts", () => {
  it("hydrates active attempts for OMS list payment method labels", async () => {
    const client = {
      from: () => ({
        select: () => ({
          in: async () => ({
            data: [{
              id: "attempt-1",
              payment_intent_id: "intent-1",
              status: "succeeded",
              provider: "stripe",
              provider_attempt_id: "pi_1",
              next_action_kind: null,
              updated_at: "2026-06-28T10:00:00+00:00",
            }],
            error: null,
          }),
        }),
      }),
    };

    await expect(readActivePaymentAttempts(client as never, [{
      id: "intent-1",
      order_id: "order-1",
      payment_id: "payment-1",
      status: "succeeded",
      active_attempt_id: "attempt-1",
      provider_payment_id: "pi_1",
      updated_at: "2026-06-28T10:00:00+00:00",
    }])).resolves.toEqual([
      expect.objectContaining({ id: "attempt-1", provider: "stripe" }),
    ]);
  });
});
