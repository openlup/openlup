import { describe, expect, it, vi } from "vitest";

import type { CheckoutRecoveryOrderSnapshot } from "./checkoutRecoveryOrderPort.js";
import { createExpiredCheckoutPaymentSafetyPort } from "./expiredCheckoutPaymentSafety.js";

const order = {
  totalMinor: 18_774,
  currency: "PLN",
  priorPaymentEvidence: {
    paymentIntentId: "10000000-0000-4000-8000-000000000001",
    paymentAttemptId: "20000000-0000-4000-8000-000000000001",
    provider: "stripe",
    providerPaymentId: "pi_old",
  },
} as CheckoutRecoveryOrderSnapshot;

describe("expired checkout prior-payment safety", () => {
  it("allows recreation only after an amount-matching provider failure", async () => {
    const readPayment = vi.fn(async () => status("failed", 18_774, "requires_payment_method"));
    const closePayment = vi.fn(async () => status("failed", 18_774, "canceled"));
    await expect(createExpiredCheckoutPaymentSafetyPort({ stripe: { readPayment, closePayment } })
      .verifyPriorPayment(order)).resolves.toBe("safe");
    expect(readPayment).toHaveBeenCalledWith({ providerPaymentId: "pi_old" });
    expect(closePayment).toHaveBeenCalledWith({ providerPaymentId: "pi_old" });
  });

  it("blocks a provider success as already paid", async () => {
    await expect(createExpiredCheckoutPaymentSafetyPort({
      stripe: { readPayment: vi.fn(async () => status("succeeded")) },
    }).verifyPriorPayment(order)).resolves.toBe("paid");
  });

  it("accepts amount-matching terminal Tpay expiry without Stripe close semantics", async () => {
    const tpayOrder = {
      ...order,
      priorPaymentEvidence: {
        ...order.priorPaymentEvidence,
        provider: "tpay",
        providerPaymentId: "tpay_sim_expired",
      },
    } as CheckoutRecoveryOrderSnapshot;
    await expect(createExpiredCheckoutPaymentSafetyPort({
      tpay: { readPayment: vi.fn(async () => status("failed", 18_774, "expired")) },
    }).verifyPriorPayment(tpayOrder)).resolves.toBe("safe");
  });

  it.each(["refunded", "chargeback"])(
    "never recreates after Tpay reports money-moved status %s",
    async (providerStatus) => {
      const tpayOrder = {
        ...order,
        priorPaymentEvidence: {
          ...order.priorPaymentEvidence,
          provider: "tpay",
          providerPaymentId: "transaction-id",
        },
      } as CheckoutRecoveryOrderSnapshot;
      await expect(createExpiredCheckoutPaymentSafetyPort({
        tpay: { readPayment: vi.fn(async () => status("unknown", 18_774, providerStatus)) },
      })
        .verifyPriorPayment(tpayOrder)).resolves.toBe("unavailable");
    },
  );

  it.each([
    ["pending", status("pending")],
    ["unknown", status("unknown")],
    ["amount mismatch", status("failed", 1, "canceled")],
  ])("fails closed for %s readback", async (_name, providerStatus) => {
    await expect(createExpiredCheckoutPaymentSafetyPort({
      stripe: { readPayment: vi.fn(async () => providerStatus) },
    }).verifyPriorPayment(order)).resolves.toBe("unavailable");
  });

  it("fails closed when provider evidence or configuration is missing", async () => {
    await expect(createExpiredCheckoutPaymentSafetyPort({})
      .verifyPriorPayment(order)).resolves.toBe("unavailable");
    await expect(createExpiredCheckoutPaymentSafetyPort({ stripe: { readPayment: vi.fn() } })
      .verifyPriorPayment({ ...order, priorPaymentEvidence: null }))
      .resolves.toBe("unavailable");
  });
});

function status(
  kind: "succeeded" | "failed" | "pending" | "unknown",
  amountMinor = 18_774,
  providerStatus: string = kind,
) {
  return {
    status: kind,
    providerStatus,
    occurredAt: null,
    failureReason: kind === "failed" ? "declined" : null,
    amountMinor,
    currency: "PLN",
    rawPayload: {},
  } as const;
}
