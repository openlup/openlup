import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createManagedCommerceOmsPort } from "../../src/commerce/adapters/managed/commerceOmsPort.js";
import { createAdminCommerceOrderCancelHandler } from "../../src/commerce/server/commerceOmsCancelOrderHandler.js";
import { createAdminCommerceOrderMarkRefundedHandler } from "../../src/commerce/server/commerceOmsMarkRefundedHandler.js";
import { createAdminCommerceOrderHoldHandler } from "../../src/commerce/server/commerceOmsHandlers.js";
import { createResponse, request, respond, createReplacementHandler, type TestResponse } from "./omsConformanceTestKit.js";
import type { OmsHandlerRequest } from "../../src/commerce/server/handlerSupport.js";
import { effectiveFunctionBody, readRepository as read, repositoryRoot } from "./managedFunctionEvidence.js";
const ORDER = "11111111-1111-4111-8111-111111111111", OP = "22222222-2222-4222-8222-222222222222";
const body = { idempotencyKey: "continuity-example", orderId: ORDER, reason: "lost" };
const replacement = { contractVersion: "commerce.v0", operation: { id: OP, orderId: ORDER, type: "replacement_shipment_requested", holdId: null, actorUserId: null, occurredAt: "2026-10-22T10:00:00Z", payload: { reason: "lost" } }, replacement: { fulfillmentOrderId: OP, orderId: ORDER, sequenceNo: 1, replacesFulfillmentOrderId: ORDER, reason: "lost", status: "created" }, replayed: false };
type Handler = (req: OmsHandlerRequest & { query: Record<string, string> }, res: TestResponse) => Promise<void>;
async function onlyOrderRpc(operation: "hold" | "cancel" | "refund mark" | "replacement", allowedRpc: string, data: unknown) {
  const calls: Array<[string, Record<string, unknown>]> = [], rejected: string[] = [];
  const reject = (access: string): never => { rejected.push(access); throw new Error(`unexpected lifecycle-capable access:${access}`); };
  const client = { from(table: string): never { return reject(`table:${table}`); }, async rpc(name: string, args: Record<string, unknown>) { calls.push([name, args]); if (name !== allowedRpc) reject(name); return { data, error: null }; } };
  const omsPort = createManagedCommerceOmsPort(client);
  const deps = { omsPort, authorizeAdmin: async () => ({ ok: true as const, userId: "operator-example" }), mutationsEnabled: () => true, respond };
  const handler: Handler = operation === "hold" ? createAdminCommerceOrderHoldHandler(deps) : operation === "cancel" ? createAdminCommerceOrderCancelHandler(deps) : operation === "refund mark" ? createAdminCommerceOrderMarkRefundedHandler(deps) : createReplacementHandler(deps);
  const input = operation === "hold" ? { ...body, reason: "manual_support" } : body;
  const res = createResponse(); await handler(request("POST", input), res);
  expect(rejected).toEqual([]);
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json.mock.calls[0]?.[0]).toMatchObject({ ok: true, data });
  expect(calls).toEqual([[allowedRpc, { p_idempotency_key: body.idempotencyKey, p_order_id: ORDER, p_reason: input.reason, ...(operation === "hold" ? { p_note: null } : {}), p_actor_user_id: "operator-example", p_metadata: {} }]]);
  expect(calls.some(([name]) => name === "subscription_delivery_alignment_confirm_replacement")).toBe(false);
}
function noSubscriptionWrites(sql: string) {
  expect(sql).not.toMatch(/\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+public\.subscriptions\b/i);
  expect(sql).not.toContain("subscription_delivery_alignment_confirm_replacement");
}
describe("order mutations never suspend, pause or cancel an active subscription", () => {
  it("hold performs only its exact order RPC", async () => {
    await onlyOrderRpc("hold", "commerce_oms_create_hold", { contractVersion: "commerce.v0", hold: { id: OP, orderId: ORDER, status: "active", reason: "manual_support", note: null, createdAt: "2026-10-22T10:00:00Z", releasedAt: null }, operationId: OP, replayed: false });
  });
  it("cancel performs only its exact order RPC and retains the guarded provisional-only cleanup", async () => {
    await onlyOrderRpc("cancel", "commerce_oms_cancel_unpaid_order", { contractVersion: "commerce.v0", orderId: ORDER, status: "cancelled", replayed: false });
    noSubscriptionWrites(effectiveFunctionBody("commerce_oms_cancel_unpaid_order_sealed_v1"));
    const guard = effectiveFunctionBody("commerce_oms_cancel_unpaid_order");
    expect(guard).toContain("RETURN public.commerce_oms_cancel_unpaid_order_sealed_v1("); expect(guard).toContain("'payment_state_unknown'");
    const cleanup = effectiveFunctionBody("commerce_cancel_abandoned_checkout_sealed_v1");
    expect(cleanup).toContain("AND status = 'pending_activation'"); expect(cleanup).toContain("IF v_has_sub THEN");
  });
  it("refund marking is only an operator mark, independent of subscription lifecycle", async () => {
    await onlyOrderRpc("refund mark", "commerce_order_mark_refunded_manual", { contractVersion: "commerce.v0", orderId: ORDER, status: "refunded", replayed: false });
    const sql = effectiveFunctionBody("commerce_order_mark_refunded_manual"); noSubscriptionWrites(sql);
    expect(sql).toContain("UPDATE public.commerce_orders"); expect(sql).toContain("SET status = 'refunded'");
    expect(read("supabase/tests/refunds_preserve_subscription_lifecycle_test.sql")).toContain("active");
    expect(read("supabase/tests/refunds_preserve_subscription_lifecycle_test.sql")).toContain("full refund preserves every subscription field");
    expect(read("supabase/tests/commerce_order_mark_refunded_manual_test.sql")).toContain("cosmetic-only");
  });
  it("an undelivered replacement creates only a parcel and never confirms arrival or interrupts a subscription", async () => {
    await onlyOrderRpc("replacement", "commerce_oms_request_replacement_shipment", replacement);
    const sql = effectiveFunctionBody("commerce_oms_request_replacement_shipment"); noSubscriptionWrites(sql);
    expect(sql).toContain("'replacement_parcel_hold'"); expect(sql).toContain("commerce_oms_replacement_subscription_cycle_not_paid");
    expect(read("tests/postgres/fulfillmentDeliveryAlignment.test.ts")).toContain("an arrived ancestor cannot settle its undelivered unsuperseded replacement");
    const arrival = read("supabase/tests/subscription_delivery_alignment_test.sql");
    expect(arrival).toContain("delivered_at"); expect(arrival).toContain("protected");
    const scan = (root: string): string[] => readdirSync(join(repositoryRoot, root), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? scan(join(root, entry.name)) : entry.name.endsWith(".ts") ? [join(root, entry.name)] : []);
    for (const path of scan("packages/platform/src/commerce")) expect(read(path), path).not.toContain("subscription_delivery_alignment_confirm_replacement");
    expect(read("packages/platform/src/fulfillment/replacementShipmentHandler.ts")).not.toContain("subscription_delivery_alignment_confirm_replacement");
  });
});
