import { describe, expect, it, vi } from "vitest";

import { CommerceOmsConflictError } from "../../../src/domains/commerce/omsPorts.js";
import { createAdminCommerceOrderCancelHandler } from "./commerceOmsCancelOrderHandler.js";
import { authorize, request, response } from "./commerceOmsHandlersTestKit.js";

const cancelRequest = {
  idempotencyKey: "oms-cancel-order-1",
  orderId: "42222222-2222-4222-8222-222222222221",
  reason: "payment abandoned",
};

describe("admin commerce OMS cancel-order handler", () => {
  it("keeps order cancellation disabled by default", async () => {
    const res = response();
    const port = { cancelOrder: vi.fn() };

    await createAdminCommerceOrderCancelHandler({
      omsPort: port,
      authorizeAdmin: authorize(),
      mutationsEnabled: () => false,
    })(request("POST", cancelRequest), res);

    expect(port.cancelOrder).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("maps a cancellation conflict to the BFF conflict envelope", async () => {
    const res = response();
    await createAdminCommerceOrderCancelHandler({
      omsPort: {
        cancelOrder: vi.fn().mockRejectedValue(new CommerceOmsConflictError("Payment already moved")),
      },
      authorizeAdmin: authorize(),
      mutationsEnabled: () => true,
    })(request("POST", cancelRequest), res);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  it("cancels an unpaid order through its dedicated boundary", async () => {
    const res = response();
    const result = { contractVersion: "commerce.v0", orderId: cancelRequest.orderId, status: "cancelled", replayed: false } as const;
    const port = { cancelOrder: vi.fn().mockResolvedValue(result) };

    await createAdminCommerceOrderCancelHandler({
      omsPort: port,
      authorizeAdmin: authorize(),
      mutationsEnabled: () => true,
    })(request("POST", cancelRequest), res);

    expect(port.cancelOrder).toHaveBeenCalledWith({ ...cancelRequest, actorUserId: "admin-user-1" });
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: result });
  });
});
