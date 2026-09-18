import { describe, expect, it, vi } from "vitest";
import { createPostgresCommerceOmsPort } from "./omsControl.js";
import { createPostgresCommerceOmsControlPlane } from "./omsControlPlane.js";

describe("Postgres OMS control port", () => {
  it("maps the public hold response to the neutral OMS contract", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ value: {
        hold: { id: "11111111-1111-4111-8111-111111111111", orderId: "22222222-2222-4222-8222-222222222222", status: "active", reason: "risk_review", note: null },
        operationId: "33333333-3333-4333-8333-333333333333", replayed: false,
      } }] })
      .mockResolvedValueOnce({ rows: [{ created_at: new Date("2026-08-13T00:00:00Z"), released_at: null }] });
    const port = createPostgresCommerceOmsPort({ query });
    await expect(port.createHold({
      idempotencyKey: "hold-idem-1", orderId: "22222222-2222-4222-8222-222222222222",
      reason: "risk_review", actorUserId: "44444444-4444-4444-8444-444444444444",
    })).resolves.toMatchObject({ contractVersion: "commerce.v0", hold: { status: "active" } });
  });
});

describe("Postgres OMS operator projection", () => {
  it("resolves least-privilege identity and reads only the neutral spine", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("oms_control_resolve_operator")) return { rows: [{ actor_id: "44444444-4444-4444-8444-444444444444" }] };
      if (sql.includes("count(*)::integer AS total_count")) return { rows: [{ total_count: 1 }] };
      if (sql.includes("FROM public.commerce_order_holds WHERE")) return { rows: [{
        id: "11111111-1111-4111-8111-111111111111", status: "active", reason: "risk_review", note: null,
        created_at: new Date("2026-08-17T08:00:00Z"), released_at: null,
      }] };
      if (sql.includes("FROM public.commerce_order_operations WHERE")) return { rows: [{
        id: "33333333-3333-4333-8333-333333333333", operation_type: "hold_created",
        hold_id: "11111111-1111-4111-8111-111111111111", actor_id: "44444444-4444-4444-8444-444444444444",
        occurred_at: new Date("2026-08-17T08:00:00Z"),
      }] };
      return { rows: [{
        id: "22222222-2222-4222-8222-222222222222", status: "paid", source_kind: "storefront",
        source_order_ref: null, total_amount_minor: "1000", currency_code: "XTS", shipment_status: null,
        active_hold_count: 1, active_hold_reasons: ["risk_review"],
        created_at: new Date("2026-08-17T07:00:00Z"), updated_at: new Date("2026-08-17T08:00:00Z"),
      }] };
    });
    const port = createPostgresCommerceOmsControlPlane({ query } as never);

    await expect(port.resolveOperator("44444444-4444-4444-8444-444444444444"))
      .resolves.toBe("44444444-4444-4444-8444-444444444444");
    await expect(port.listOrders({ view: "control_plane_v1", page: 1, pageSize: 25 }))
      .resolves.toMatchObject({ contractVersion: "commerce.oms_control_plane.v1", totalCount: 1,
        orders: [{ status: "paid", money: { amountMinor: 1000, currency: "XTS" } }] });
    await expect(port.getOrderDetail({ view: "control_plane_v1", orderId: "22222222-2222-4222-8222-222222222222" }))
      .resolves.toMatchObject({ holds: [{ reason: "risk_review" }], operations: [{ action: "hold_created" }] });

    expect(query.mock.calls.map(([sql]) => sql).join("\n")).not.toMatch(/provider|customer|address|payment_attempt/i);
  });
});
