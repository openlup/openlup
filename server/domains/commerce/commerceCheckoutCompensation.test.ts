import { describe, expect, it, vi } from "vitest";
import { tryCompensate, type CheckoutCompensationPort } from "./commerceCheckoutCompensation.js";

function port(): CheckoutCompensationPort {
  return {
    releaseOrderReservations: vi.fn().mockResolvedValue({ releasedCount: 1 }),
    cancelUnstartedPromotionOrder: vi.fn().mockResolvedValue({ cancelled: true }),
    cancelAbandonedOrder: vi.fn().mockResolvedValue({ cancelled: true }),
  };
}

describe("checkout compensation", () => {
  it("releases inventory and cancels only an unstarted promotion order", async () => {
    const compensation = port();
    await tryCompensate(compensation, "intent-key", "order-1");
    expect(compensation.releaseOrderReservations).toHaveBeenCalledWith({
      idempotencyKey: "intent-key:checkout-compensation",
      orderId: "order-1",
      reason: "checkout_orchestration_failed",
    });
    expect(compensation.cancelUnstartedPromotionOrder).toHaveBeenCalledWith({
      idempotencyKey: "intent-key",
      orderId: "order-1",
      reason: "checkout_orchestration_failed_before_runtime",
    });
    expect(compensation.cancelAbandonedOrder).not.toHaveBeenCalled();
  });

  it("attempts promotion cancellation even when inventory release fails", async () => {
    const compensation = port();
    vi.mocked(compensation.releaseOrderReservations).mockRejectedValue(new Error("down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await tryCompensate(compensation, "intent-key", "order-1");
    expect(compensation.cancelUnstartedPromotionOrder).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "checkout_compensation_release_failed", JSON.stringify({ orderId: "order-1" }),
    );
    warn.mockRestore();
  });

  it("falls back to canonical abandoned-order cancellation after a pre-dispatch runtime failure", async () => {
    const compensation = port();
    vi.mocked(compensation.cancelUnstartedPromotionOrder).mockResolvedValue({ cancelled: false });

    await tryCompensate(compensation, "intent-key", "order-1");

    expect(compensation.cancelAbandonedOrder).toHaveBeenCalledWith({
      idempotencyKey: "intent-key",
      orderId: "order-1",
      reason: "checkout_orchestration_failed_before_provider_dispatch",
    });
    expect(compensation.cancelAbandonedOrder).toHaveBeenCalledTimes(1);
  });

  it("preserves a typed cancellation reason across promotion and canonical cleanup", async () => {
    const compensation = port();
    vi.mocked(compensation.cancelUnstartedPromotionOrder).mockResolvedValue({ cancelled: false });

    await tryCompensate(compensation, "intent-key", "order-1", {
      cancellationReason: "checkout_stock_unavailable",
    });

    expect(compensation.cancelUnstartedPromotionOrder).toHaveBeenCalledWith({
      idempotencyKey: "intent-key",
      orderId: "order-1",
      reason: "checkout_stock_unavailable",
    });
    expect(compensation.cancelAbandonedOrder).toHaveBeenCalledWith({
      idempotencyKey: "intent-key",
      orderId: "order-1",
      reason: "checkout_stock_unavailable",
    });
    expect(compensation.cancelAbandonedOrder).toHaveBeenCalledTimes(1);
  });

  it("does not issue a second canonical cancel when typed promotion cleanup succeeds", async () => {
    const compensation = port();

    await tryCompensate(compensation, "intent-key", "order-1", {
      cancellationReason: "checkout_journey_consumed",
    });

    expect(compensation.cancelUnstartedPromotionOrder).toHaveBeenCalledWith({
      idempotencyKey: "intent-key",
      orderId: "order-1",
      reason: "checkout_journey_consumed",
    });
    expect(compensation.cancelAbandonedOrder).not.toHaveBeenCalled();
  });
});
