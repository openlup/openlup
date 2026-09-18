import { describe, expect, it, vi } from "vitest";
import { createPostgresCommerceOmsControlPlane } from "./omsControlPlane.js";

describe("Postgres OMS control-plane adapter", () => {
  it("resolves least-privilege identity and reads only the neutral spine", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("oms_control_resolve_operator")) return { rows: [{ actor_id: "44444444-4444-4444-8444-444444444444" }] };
      if (sql.includes("count(*)::integer AS total_count")) return { rows: [{ total_count: 1 }] };
      if (sql.includes("FROM public.commerce_order_holds WHERE")) return { rows: [holdRow()] };
      if (sql.includes("FROM public.commerce_order_operations WHERE")) return { rows: [operationRow()] };
      return { rows: [orderRow()] };
    });
    const port = createPostgresCommerceOmsControlPlane({ query } as never);

    await expect(port.resolveOperator("44444444-4444-4444-8444-444444444444"))
      .resolves.toBe("44444444-4444-4444-8444-444444444444");
    await expect(port.listOrders({ view: "control_plane_v1", page: 1, pageSize: 25 }))
      .resolves.toMatchObject({ contractVersion: "commerce.oms_control_plane.v1", totalCount: 1,
        orders: [{ status: "paid", money: { amountMinor: 1000, currency: "XTS" } }] });
    await expect(port.getOrderDetail({ view: "control_plane_v1", orderId: orderRow().id }))
      .resolves.toMatchObject({ holds: [{ reason: "risk_review" }], operations: [{ action: "hold_created" }] });
    expect(query.mock.calls.map(([sql]) => sql).join("\n")).not.toMatch(/customer|address|payment_attempt|provider_/i);
    // Bundle parity: the managed queue RPC hides withdrawn checkout rows in
    // scoped_orders (20260903190000). Both the list AND the count query here
    // must carry the same predicate, or control_plane_v1 answers with different
    // rows and a different totalCount depending on which bundle serves it.
    // Only the two listOrders queries - getOrderDetail reads one order by id and
    // correctly carries no visibility scope.
    const listSql = query.mock.calls.map(([sql]) => String(sql))
      .filter((sql) => /\$1::text IS NULL OR orders\.status = \$1/.test(sql));
    expect(listSql.length).toBeGreaterThanOrEqual(2);
    for (const sql of listSql) {
      expect(sql).toMatch(/supersededByStableJourneyKey/);
      expect(sql).toMatch(/checkout_journey_consumed/);
      // Fails closed: a captured payment keeps the row visible.
      expect(sql).toMatch(/partially_refunded/);
    }
  });

  it("returns no actor when either capability ownership row is absent", async () => {
    const port = createPostgresCommerceOmsControlPlane({ query: vi.fn().mockResolvedValue({ rows: [{ actor_id: null }] }) } as never);
    await expect(port.resolveOperator("44444444-4444-4444-8444-444444444444")).resolves.toBeNull();
  });
});

function orderRow() { return { id: "22222222-2222-4222-8222-222222222222", status: "paid", source_kind: "storefront",
  source_order_ref: null, total_amount_minor: "1000", currency_code: "XTS", shipment_status: null,
  active_hold_count: 1, active_hold_reasons: ["risk_review"], created_at: new Date("2026-08-17T07:00:00Z"),
  updated_at: new Date("2026-08-17T08:00:00Z") }; }
function holdRow() { return { id: "11111111-1111-4111-8111-111111111111", status: "active", reason: "risk_review", note: null,
  created_at: new Date("2026-08-17T08:00:00Z"), released_at: null }; }
function operationRow() { return { id: "33333333-3333-4333-8333-333333333333", operation_type: "hold_created",
  hold_id: "11111111-1111-4111-8111-111111111111", actor_id: "44444444-4444-4444-8444-444444444444",
  occurred_at: new Date("2026-08-17T08:00:00Z") }; }
