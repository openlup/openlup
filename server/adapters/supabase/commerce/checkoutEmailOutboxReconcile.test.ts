import { describe, expect, it, vi } from "vitest";
import { createSupabaseCheckoutEmailOutboxReconcilePort } from "./checkoutEmailOutboxReconcile.js";

describe("createSupabaseCheckoutEmailOutboxReconcilePort", () => {
  it("calls the checkout email reconcile RPC and normalizes counts", async () => {
    const rpc = vi.fn(async () => ({
      data: {
        checked: { paid: 2, failed: 1, expired: 1 },
        inserted: {
          commerceOrderPaid: 0,
          commerceOrderPaidEmail: 2,
          commercePaymentFailed: 1,
          commerceCheckoutExpired: 1,
        },
      },
      error: null,
    }));

    await expect(createSupabaseCheckoutEmailOutboxReconcilePort({ rpc }).reconcile(50)).resolves.toEqual({
      checked: { paid: 2, failed: 1, expired: 1 },
      inserted: { commerceOrderPaid: 0, commerceOrderPaidEmail: 2, commercePaymentFailed: 1, commerceCheckoutExpired: 1 },
    });
    expect(rpc).toHaveBeenCalledWith("commerce_reconcile_checkout_email_outbox", { p_limit: 50 });
  });

  it("surfaces RPC errors with the RPC name", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: "boom" } }));

    await expect(createSupabaseCheckoutEmailOutboxReconcilePort({ rpc }).reconcile(50))
      .rejects.toThrow("commerce_reconcile_checkout_email_outbox_failed: boom");
  });
});
