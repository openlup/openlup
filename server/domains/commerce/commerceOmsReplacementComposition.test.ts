import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { createSupabaseCommerceOmsPort } from "../../adapters/supabase/commerceOmsPort.js";
import { createAdminCommerceOrderRequestReplacementShipmentHandler } from "./commerceOmsReplacementShipmentHandler.js";
import { request, response } from "./commerceOmsHandlersTestKit.js";
const orderId = "11111111-1111-4111-8111-111111111111", parcelId = "22222222-2222-4222-8222-222222222222", predecessorId = "33333333-3333-4333-8333-333333333333";
it("runs replacement replay and stock refusal through the real managed adapter and M08 facade", async () => {
 const data = { contractVersion: "commerce.v0", operation: { id: predecessorId, orderId, type: "replacement_shipment_requested", holdId: null, actorUserId: null, occurredAt: "2026-10-22T10:00:00Z", payload: {} }, replacement: { fulfillmentOrderId: parcelId, orderId, sequenceNo: 1, replacesFulfillmentOrderId: predecessorId, reason: "lost", status: "created" }, releasedHoldIds: [], replayed: true };
 const rpc = vi.fn().mockResolvedValue({ data, error: null });
 const port = createSupabaseCommerceOmsPort({ rpc } as never);
 const handler = createAdminCommerceOrderRequestReplacementShipmentHandler({ omsPort: port, authorizeAdmin: async () => ({ ok: true, userId: "example-operator" }) });
 const body = { idempotencyKey: "example-replacement", orderId, reason: "lost", metadata: { source: "example" } };
 for (let replay = 0; replay < 2; replay++) { const res = response(); await handler(request("POST", body), res); expect(res.status).toHaveBeenCalledWith(200); expect(res.json).toHaveBeenCalledWith({ ok: true, data }); }
 expect(rpc.mock.calls).toEqual(Array.from({ length: 2 }, () => ["commerce_oms_request_replacement_shipment", { p_idempotency_key: body.idempotencyKey, p_order_id: orderId, p_reason: "lost", p_actor_user_id: "example-operator", p_metadata: body.metadata }]));
 rpc.mockResolvedValueOnce({ data: null, error: { code: "P0001", message: "inventory_external_provider_insufficient_available_stock" } });
 const res = response(); await handler(request("POST", body), res); expect(res.status).toHaveBeenCalledWith(409); expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ details: { reason: "inventory_external_provider_insufficient_available_stock" } }) }));
 expect(rpc.mock.calls.some(([name]) => name === "subscription_delivery_alignment_confirm_replacement")).toBe(false);
});
it("keeps the reference replacement module as a single delegation facade", () => {
 const source = readFileSync(new URL("./commerceOmsReplacementShipmentHandler.ts", import.meta.url), "utf8");
 expect(source).toContain('from "@openlup/platform/fulfillment"');
 expect(source).not.toMatch(/safeParse|sendBff|ResponseSchema|RequestSchema/);
 expect(source.match(/export function /g)).toHaveLength(1);
 expect(source).not.toContain("subscription_delivery_alignment_confirm_replacement");
});
