import { describe, expect, it, vi } from "vitest";
import { createSupabaseCommerceOmsPort, type CommerceOmsSupabaseClient } from "./commerceOmsPort.js";
import { createSupabaseCommerceOmsControlPlanePort } from "./commerceOmsControlPlane.js";

function fakeClient(rpcResult: { data?: unknown; error?: { code?: string; message?: string } }): CommerceOmsSupabaseClient {
  return {
    from: vi.fn(),
    rpc: vi.fn().mockResolvedValue(rpcResult),
  } as unknown as CommerceOmsSupabaseClient;
}

describe("createSupabaseCommerceOmsPort RPC-backed mutations", () => {
  it("createHold calls commerce_oms_create_hold and returns the RPC data", async () => {
    const hold = { contractVersion: "commerce.v0", hold: {}, operationId: "op-1" };
    const client = fakeClient({ data: hold });
    const port = createSupabaseCommerceOmsPort(client);

    const result = await port.createHold({
      idempotencyKey: "oms-hold-1",
      orderId: "42222222-2222-4222-8222-222222222221",
      reason: "manual_support",
      actorUserId: "admin-1",
    });

    expect(client.rpc).toHaveBeenCalledWith("commerce_oms_create_hold", expect.objectContaining({ p_order_id: "42222222-2222-4222-8222-222222222221" }));
    expect(result).toEqual(hold);
  });

  it("releaseHold calls commerce_oms_release_hold and returns the RPC data", async () => {
    const hold = { contractVersion: "commerce.v0", hold: {}, operationId: "op-2" };
    const client = fakeClient({ data: hold });
    const port = createSupabaseCommerceOmsPort(client);

    const result = await port.releaseHold({ idempotencyKey: "oms-release-1", holdId: "b1111111-1111-4111-8111-111111111111", actorUserId: "admin-1" });

    expect(client.rpc).toHaveBeenCalledWith("commerce_oms_release_hold", expect.objectContaining({ p_hold_id: "b1111111-1111-4111-8111-111111111111" }));
    expect(result).toEqual(hold);
  });

  it("markRefunded calls commerce_order_mark_refunded_manual with the expected params", async () => {
    const response = { contractVersion: "commerce.oms.v0", orderId: "42222222-2222-4222-8222-222222222221", status: "refunded", replayed: false };
    const client = fakeClient({ data: response });
    const port = createSupabaseCommerceOmsPort(client);

    const result = await port.markRefunded({
      idempotencyKey: "oms-mark-refunded-1", // gitleaks:allow
      orderId: "42222222-2222-4222-8222-222222222221",
      reason: "operator confirmed Tpay panel refund",
      actorUserId: "admin-1",
    });

    expect(client.rpc).toHaveBeenCalledWith("commerce_order_mark_refunded_manual", {
      p_idempotency_key: "oms-mark-refunded-1", // gitleaks:allow
      p_order_id: "42222222-2222-4222-8222-222222222221",
      p_reason: "operator confirmed Tpay panel refund",
      p_actor_user_id: "admin-1",
      p_metadata: {},
    });
    expect(result).toEqual(response);
  });

  it("markRefunded throws a mapped error when the RPC fails", async () => {
    const client = fakeClient({ error: { code: "22023", message: "commerce_order_mark_refunded_invalid_status" } });
    const port = createSupabaseCommerceOmsPort(client);

    await expect(
      port.markRefunded({
        idempotencyKey: "oms-mark-refunded-2", // gitleaks:allow
        orderId: "42222222-2222-4222-8222-222222222221",
        reason: "not paid",
        actorUserId: "admin-1",
      }),
    ).rejects.toThrow();
  });

  it("cancelOrder calls the dedicated unpaid-order cancellation RPC", async () => {
    const response = { contractVersion: "commerce.v0", orderId: "42222222-2222-4222-8222-222222222221", status: "cancelled", replayed: false };
    const client = fakeClient({ data: response });
    const port = createSupabaseCommerceOmsPort(client);

    const result = await port.cancelOrder({
      idempotencyKey: "oms-cancel-order-1",
      orderId: "42222222-2222-4222-8222-222222222221",
      reason: "payment abandoned",
      actorUserId: "admin-1",
    });

    expect(client.rpc).toHaveBeenCalledWith("commerce_oms_cancel_unpaid_order", {
      p_idempotency_key: "oms-cancel-order-1",
      p_order_id: "42222222-2222-4222-8222-222222222221",
      p_reason: "payment abandoned",
      p_actor_user_id: "admin-1",
      p_metadata: {},
    });
    expect(result).toEqual(response);
  });
});

describe("managed OMS control-plane projection", () => {
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
      getOrderDetail: vi.fn().mockResolvedValue({ order: {
        ...richOrder,
        holds: [{ id: "b1111111-1111-4111-8111-111111111111", status: "active", reason: "risk_review", note: null,
          createdAt: "2026-08-17T08:00:00.000Z", releasedAt: null }],
        operations: [{ id: "b2222222-2222-4222-8222-222222222222", type: "hold_created",
          holdId: "b1111111-1111-4111-8111-111111111111", actorUserId: null, occurredAt: "2026-08-17T08:00:00.000Z" }],
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

describe("replacement shipment refusals", () => {
  const ORDER_ID = "42222222-2222-4222-8222-222222222221";

  function replacementRequest() {
    return {
      idempotencyKey: "oms-replacement-1",
      orderId: ORDER_ID,
      reason: "returned_undelivered" as const,
      actorUserId: "admin-1",
    };
  }

  async function refuse(message: string): Promise<{ name: string; details: Record<string, unknown> }> {
    const port = createSupabaseCommerceOmsPort(fakeClient({ error: { code: "22023", message } }));
    try {
      await port.requestReplacementShipment(replacementRequest());
    } catch (error) {
      const failure = error as Error & { details: Record<string, unknown> };
      return { name: failure.name, details: failure.details };
    }
    throw new Error("expected the port to refuse");
  }

  it("calls commerce_oms_request_replacement_shipment with the operator identity", async () => {
    const answer = { contractVersion: "commerce.v0", replacement: {}, releasedHoldIds: [], replayed: false };
    const client = fakeClient({ data: answer });
    const result = await createSupabaseCommerceOmsPort(client).requestReplacementShipment(replacementRequest());

    expect(client.rpc).toHaveBeenCalledWith("commerce_oms_request_replacement_shipment", {
      p_idempotency_key: "oms-replacement-1",
      p_order_id: ORDER_ID,
      p_reason: "returned_undelivered",
      p_actor_user_id: "admin-1",
      p_metadata: {},
    });
    expect(result).toEqual(answer);
  });

  // The five hold reasons the command refuses rather than releasing. Each has to
  // arrive as its own code, because "blocked" alone tells the operator nothing
  // about which hold to go and resolve.
  it.each([
    ["payment_not_succeeded", "blocked_by_payment_not_succeeded_hold"],
    ["inventory_review", "blocked_by_inventory_review_hold"],
    ["risk_review", "blocked_by_risk_review_hold"],
    ["address_review", "blocked_by_address_review_hold"],
    ["manual_support", "blocked_by_manual_support_hold"],
  ])("names the %s hold that blocked the command", async (holdReason, expected) => {
    const refusal = await refuse(`commerce_oms_replacement_blocked_by_${holdReason}_hold`);
    expect(refusal.name).toBe("CommerceOmsConflictError");
    expect(refusal.details).toEqual({ reason: expected });
  });

  it.each([
    "invalid_input",
    "idempotency_conflict",
    "order_not_found",
    "order_not_replaceable",
    "missing_client",
    "missing_shipping_address",
    "shipping_address_not_found",
    "payment_not_succeeded",
    "subscription_cycle_not_paid",
    "no_parcel_to_replace",
    "missing_order_items",
    "missing_catalog_sku",
    "missing_inventory_reservation",
  ])("maps the %s precondition refusal to its own reason", async (reason) => {
    const refusal = await refuse(`commerce_oms_replacement_${reason}`);
    expect(refusal.name).toBe("CommerceOmsConflictError");
    expect(refusal.details).toEqual({ reason });
  });

  // R6: the refusal the operator is most likely to actually hit. The command reserves
  // through the external stock authority, so a stockout raises an `inventory_*` name with
  // no `commerce_oms_replacement_` prefix at all. Before this, none of these matched, the
  // handler emitted UPSTREAM_UNAVAILABLE, and the screen advised checking holds.
  it.each([
    "inventory_external_provider_insufficient_available_stock",
    "inventory_external_provider_stock_stale",
    "inventory_external_provider_stock_missing",
    "inventory_external_provider_sku_not_found",
    "inventory_external_provider_location_missing",
    "inventory_reservation_insufficient_available_stock",
    "inventory_reservation_allocation_incomplete",
    "inventory_reservation_payment_status_not_reservable",
    "inventory_reservation_invalid_quantity",
  ])("maps the %s reservation refusal to its own reason", async (reason) => {
    const refusal = await refuse(reason);
    expect(refusal.name).toBe("CommerceOmsConflictError");
    expect(refusal.details).toEqual({ reason });
  });

  it("names the second-tab fence rather than degrading it", async () => {
    const refusal = await refuse("commerce_oms_replacement_undispatched_replacement_exists");
    expect(refusal.name).toBe("CommerceOmsConflictError");
    expect(refusal.details).toEqual({ reason: "undispatched_replacement_exists" });
  });

  // The precision the reservation list buys has to survive a message that merely quotes a
  // table name: a permission failure is not something the operator can answer.
  it("keeps a failure that only mentions an inventory table an upstream error", async () => {
    const refusal = await refuse('permission denied for table "inventory_reservations"');
    expect(refusal.name).toBe("CommerceOmsPersistenceError");
  });

  // Totality. A refusal the allowlist does not know must still be a refusal, and
  // must not carry the database's own words to the operator.
  it("degrades an unknown named refusal to the generic reason", async () => {
    const refusal = await refuse("commerce_oms_replacement_some_future_rule_nobody_mapped");
    expect(refusal.name).toBe("CommerceOmsConflictError");
    expect(refusal.details).toEqual({ reason: "unspecified_refusal" });
    expect(JSON.stringify(refusal.details)).not.toContain("some_future_rule");
  });

  it("keeps a failure that named no refusal an upstream error, not a refusal", async () => {
    const refusal = await refuse('permission denied for function "commerce_oms_request_replacement_shipment"');
    expect(refusal.name).toBe("CommerceOmsPersistenceError");
    expect(refusal.details).toEqual({ code: "22023" });
  });
});
