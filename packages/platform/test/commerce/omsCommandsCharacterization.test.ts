import { describe, expect, it, vi } from "vitest";
import { createManagedCommerceOmsPort } from "../../src/commerce/adapters/managed/commerceOmsPort.js";
import { createResponse, request, respond, createReplacementHandler } from "./omsConformanceTestKit.js";
const ORDER = "11111111-1111-4111-8111-111111111111", HOLD = "22222222-2222-4222-8222-222222222222";
const OP = "33333333-3333-4333-8333-333333333333", ACTOR = "operator-example";
const authorizeAdmin = async () => ({ ok: true as const, userId: ACTOR, isMachineActor: false });
const base = { idempotencyKey: "command-example", orderId: ORDER, reason: "operator confirmed" };
function fixture(data: unknown) {
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ data, error: null as { code: string; message: string } | null }));
  const omsPort = createManagedCommerceOmsPort({ rpc });
  return { rpc, deps: { authorizeAdmin, omsPort, mutationsEnabled: () => true, respond } };
}
async function invoke(handler: ReturnType<typeof import("../../src/commerce/server/commerceOmsCancelOrderHandler.js")["createAdminCommerceOrderCancelHandler"]>, body: unknown) {
  const res = createResponse(); await handler(request("POST", body), res);
  return { status: vi.mocked(res.status).mock.calls.at(-1)?.[0], body: vi.mocked(res.json).mock.calls.at(-1)?.[0] };
}
describe("commerce OMS commands characterization", () => {
  it("carries hold/release exact replay through the actual persistence binding", async () => {
    const { createAdminCommerceOrderHoldHandler, createAdminCommerceOrderReleaseHoldHandler } = await import("../../src/commerce/server/commerceOmsHandlers.js");
    const data = { contractVersion: "commerce.v0", hold: { id: HOLD, orderId: ORDER, status: "active", reason: "manual_support",
      note: null, createdAt: "2026-10-22T10:00:00Z", releasedAt: null }, operationId: OP, replayed: true };
    const f = fixture(data);
    for (let replay = 0; replay < 2; replay++) {
      expect(await invoke(createAdminCommerceOrderHoldHandler(f.deps), { ...base, reason: "manual_support" }))
        .toMatchObject({ status: 200, body: { ok: true, data } });
      expect(await invoke(createAdminCommerceOrderReleaseHoldHandler(f.deps), { idempotencyKey: base.idempotencyKey, holdId: HOLD }))
        .toMatchObject({ status: 200, body: { ok: true, data } });
    }
    expect(f.rpc.mock.calls[0]).toEqual(f.rpc.mock.calls[2]);
    expect(f.rpc.mock.calls[1]).toEqual(f.rpc.mock.calls[3]);
    expect(f.rpc.mock.calls.map(([name]) => name)).toEqual(["commerce_oms_create_hold", "commerce_oms_release_hold", "commerce_oms_create_hold", "commerce_oms_release_hold"]);
  });
  it("composes unpaid cancel replay and coded lock refusal", async () => {
    const { createAdminCommerceOrderCancelHandler } = await import("../../src/commerce/server/commerceOmsCancelOrderHandler.js");
    const data = { contractVersion: "commerce.v0", orderId: ORDER, status: "cancelled", replayed: true }, f = fixture(data);
    const handler = createAdminCommerceOrderCancelHandler(f.deps);
    expect(await invoke(handler, base)).toMatchObject({ status: 200, body: { ok: true, data } });
    expect(await invoke(handler, base)).toMatchObject({ status: 200, body: { ok: true, data } });
    expect(f.rpc.mock.calls[0]).toEqual(f.rpc.mock.calls[1]);
    expect(f.rpc.mock.calls[0][0]).toBe("commerce_oms_cancel_unpaid_order");
    f.rpc.mockResolvedValue({ data: null, error: { code: "55P03", message: "lock unavailable" } });
    expect(await invoke(handler, base)).toMatchObject({ status: 409, body: { error: { details: { reason: "lock_timeout" } } } });
  });
  it("routes refund marking only to the manual record RPC, including exact replay", async () => {
    const { createAdminCommerceOrderMarkRefundedHandler } = await import("../../src/commerce/server/commerceOmsMarkRefundedHandler.js");
    const data = { contractVersion: "commerce.v0", orderId: ORDER, status: "refunded", replayed: true }, f = fixture(data);
    const handler = createAdminCommerceOrderMarkRefundedHandler(f.deps);
    for (let replay = 0; replay < 2; replay++) expect(await invoke(handler, base)).toMatchObject({ status: 200, body: { ok: true, data } });
    expect(f.rpc.mock.calls).toEqual(Array.from({ length: 2 }, () => ["commerce_order_mark_refunded_manual", {
      p_idempotency_key: base.idempotencyKey, p_order_id: ORDER, p_reason: base.reason, p_actor_user_id: ACTOR, p_metadata: {} }]));
  });
  it("preserves replacement replay and the named stock refusal through the handler", async () => {
    const createAdminCommerceOrderRequestReplacementShipmentHandler = createReplacementHandler;
    const data = { contractVersion: "commerce.v0", operation: { id: OP, orderId: ORDER, type: "replacement_shipment_requested",
      holdId: null, actorUserId: null, occurredAt: "2026-10-22T10:00:00Z", payload: { reason: "lost" } },
      replacement: { fulfillmentOrderId: HOLD, orderId: ORDER, sequenceNo: 1, replacesFulfillmentOrderId: OP, reason: "lost", status: "created" }, replayed: true };
    const f = fixture(data), handler = createAdminCommerceOrderRequestReplacementShipmentHandler(f.deps);
    for (let replay = 0; replay < 2; replay++) expect(await invoke(handler, { ...base, reason: "lost" })).toMatchObject({ status: 200, body: { data: { ...data, releasedHoldIds: [] } } });
    expect(f.rpc.mock.calls[0]).toEqual(f.rpc.mock.calls[1]);
    f.rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "inventory_external_provider_insufficient_available_stock" } });
    expect(await invoke(handler, { ...base, reason: "lost" })).toMatchObject({ status: 409,
      body: { error: { details: { reason: "inventory_external_provider_insufficient_available_stock" } } } });
  });
});
