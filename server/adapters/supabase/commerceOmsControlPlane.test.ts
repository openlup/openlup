import { describe, expect, it, vi } from "vitest";
import { createSupabaseCommerceOmsControlPlanePort } from "./commerceOmsControlPlane.js";

describe("managed OMS control-plane adapter", () => {
  it("maps the rich managed result without leaking provider or customer facts", async () => {
    const richOrder = {
      orderId: "42222222-2222-4222-8222-222222222221", status: "paid", sourceKind: "storefront",
      total: { amountMinor: 1000, currency: "XTS" }, fulfillmentStatus: null,
      activeHoldCount: 1, activeHoldReasons: ["risk_review"],
      createdAt: "2026-08-17T07:00:00.000Z", updatedAt: "2026-08-17T08:00:00.000Z",
      customer: { email: "private@example.invalid" }, providerOrderId: "private-provider-id",
    };
    const managed = {
      listOrders: vi.fn().mockResolvedValue({ orders: [richOrder], totalCount: 1, page: 1, pageSize: 25 }),
      getOrderDetail: vi.fn().mockResolvedValue({ order: { ...richOrder,
        holds: [{ id: "b1111111-1111-4111-8111-111111111111", status: "active", reason: "risk_review", note: null,
          createdAt: "2026-08-17T08:00:00.000Z", releasedAt: null }],
        operations: [{ id: "b2222222-2222-4222-8222-222222222222", type: "hold_created",
          holdId: "b1111111-1111-4111-8111-111111111111", actorUserId: null,
          occurredAt: "2026-08-17T08:00:00.000Z" }],
      } }),
    };
    const port = createSupabaseCommerceOmsControlPlanePort(managed as never);
    const list = await port.listOrders({ view: "control_plane_v1", page: 1, pageSize: 25 });
    const detail = await port.getOrderDetail({ view: "control_plane_v1", orderId: richOrder.orderId });
    expect(list.orders[0]).not.toHaveProperty("customer");
    expect(list.orders[0]).not.toHaveProperty("providerOrderId");
    expect(detail).toMatchObject({ operations: [{ action: "hold_created" }] });
  });
});
