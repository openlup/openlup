import { describe, expect, it, vi } from "vitest";
import { CommerceRuntimePersistenceError } from "../../../../src/domains/commerce/runtimePorts.js";
import {
  cancelAbandonedCheckout,
  cancelUnstartedPromotionCheckout,
} from "./checkoutCompensation.js";

function client(data: unknown, error: { code?: string } | null = null) {
  return { rpc: vi.fn().mockResolvedValue({ data, error }) };
}

describe("Supabase checkout compensation adapter", () => {
  it("maps canonical abandoned-checkout cancellation arguments", async () => {
    const rpcClient = client({ cancelled: true });
    await expect(cancelAbandonedCheckout(rpcClient, {
      idempotencyKey: "intent-1", orderId: "order-1", reason: "failed",
    })).resolves.toEqual({ cancelled: true });
    expect(rpcClient.rpc).toHaveBeenCalledWith("commerce_cancel_abandoned_checkout", {
      p_idempotency_key: "intent-1:abandon",
      p_order_id: "order-1",
      p_reason: "failed",
    });
  });

  it("maps guarded promotion cancellation and fails closed on RPC errors", async () => {
    const success = client(true);
    await expect(cancelUnstartedPromotionCheckout(success, {
      idempotencyKey: "intent-key", orderId: "order-1", reason: "failed_before_runtime",
    })).resolves.toEqual({ cancelled: true });
    expect(success.rpc).toHaveBeenCalledWith("commerce_cancel_unstarted_promotion_order", {
      p_idempotency_key: "intent-key",
      p_order_id: "order-1",
      p_reason: "failed_before_runtime",
    });

    const failed = client(null, { code: "42501" });
    await expect(cancelUnstartedPromotionCheckout(failed, {
      idempotencyKey: "intent-key", orderId: "order-1", reason: "failed_before_runtime",
    })).rejects.toBeInstanceOf(CommerceRuntimePersistenceError);
  });

  // Coverage kept from server/domains/commerce/supabaseInventoryReservationPort.test.ts,
  // which used to reach this mapping through the reservation port before the
  // compensation adapter moved here.
  it("reports cancelled=false without throwing when the order already reached a terminal state", async () => {
    const rpcClient = client({ cancelled: false, reason: "already_terminal", orderStatus: "paid" });
    await expect(cancelAbandonedCheckout(rpcClient, {
      idempotencyKey: "intent-2026-06-05-rex",
      orderId: "11111111-1111-4111-8111-111111111111",
      reason: "checkout_stock_unavailable",
    })).resolves.toEqual({ cancelled: false });
  });
});
