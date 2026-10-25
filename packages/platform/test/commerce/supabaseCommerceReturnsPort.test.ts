import { describe, expect, it, vi } from "vitest";
import { createSupabaseCommerceReturnsPort, type CommerceReturnsRpcClient } from "../../src/commerce/server/supabaseCommerceReturnsPort.js";

type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };
const OK: RpcResult = { data: { returnRequestId: "ret-1", status: "requested", replayed: false }, error: null };

function client(result: RpcResult = OK): { port: ReturnType<typeof createSupabaseCommerceReturnsPort>; rpc: ReturnType<typeof vi.fn> } {
  const rpc = vi.fn(async () => result);
  return { port: createSupabaseCommerceReturnsPort({ rpc } as unknown as CommerceReturnsRpcClient), rpc };
}

describe("supabase commerce returns port", () => {
  it("createRequest maps args to commerce_return_request_create + parses envelope", async () => {
    const { port, rpc } = client();
    const out = await port.createRequest({
      idempotencyKey: "ret-idem-0001",
      orderId: "11111111-1111-4111-8111-111111111111",
      reasonCode: "damaged",
      lines: [{ orderItemId: "22222222-2222-4222-8222-222222222222", quantity: 2 }],
      customerNote: "box crushed",
      requestedBy: null,
    });
    expect(out).toEqual({ returnRequestId: "ret-1", status: "requested", replayed: false });
    expect(rpc).toHaveBeenCalledWith("commerce_return_request_create", expect.objectContaining({
      p_idempotency_key: "ret-idem-0001",
      p_reason_code: "damaged",
      p_lines: [expect.objectContaining({ orderItemId: "22222222-2222-4222-8222-222222222222", quantity: 2, restockDisposition: "restock" })],
    }));
  });

  it("approve maps refund mode + amount", async () => {
    const { port, rpc } = client({ data: { returnRequestId: "ret-1", status: "approved", replayed: false }, error: null });
    const out = await port.approve({ idempotencyKey: "appr-0001", returnRequestId: "ret-1", refundMode: "partial", refundAmountCents: 1490, actorUserId: "admin-1" });
    expect(out.status).toBe("approved");
    expect(rpc).toHaveBeenCalledWith("commerce_return_approve", expect.objectContaining({
      p_refund_mode: "partial", p_refund_amount_cents: 1490, p_approved_by: "admin-1",
    }));
  });

  it("reject maps args", async () => {
    const { port, rpc } = client({ data: { returnRequestId: "ret-1", status: "rejected", replayed: false }, error: null });
    await port.reject({ idempotencyKey: "rej-0001", returnRequestId: "ret-1", adminNote: "not eligible", actorUserId: "admin-1" });
    expect(rpc).toHaveBeenCalledWith("commerce_return_reject", expect.objectContaining({ p_admin_note: "not eligible" }));
  });

  it("throws a sanitized error on rpc error", async () => {
    const { port } = client({ data: null, error: { code: "22023" } });
    await expect(port.createRequest({
      idempotencyKey: "ret-idem-0002", orderId: "11111111-1111-4111-8111-111111111111",
      reasonCode: "other", lines: [{ orderItemId: "22222222-2222-4222-8222-222222222222", quantity: 1 }],
    })).rejects.toThrow("commerce_return_request_create_failed:22023");
  });
});

const REQUEST = { idempotencyKey: "request-key", orderId: "11111111-1111-4111-8111-111111111111",
  reasonCode: "other" as const, lines: [{ orderItemId: "22222222-2222-4222-8222-222222222222", quantity: 2 }] };
describe("returns RPC conformance", () => {
  it.each([undefined, null, "principal-1"])("preserves ordered request arguments and principal %s", async (requestedBy) => {
    const { port, rpc } = client();
    await port.createRequest({ ...REQUEST, requestedBy });
    expect(rpc.mock.calls).toStrictEqual([["commerce_return_request_create", {
      p_idempotency_key: "request-key", p_order_id: REQUEST.orderId,
      p_lines: [{ orderItemId: REQUEST.lines[0].orderItemId, sku: null, quantity: 2, restockDisposition: "restock" }],
      p_reason_code: "other", p_customer_note: null, p_requested_by: requestedBy ?? null,
    }]]);
    expect(JSON.stringify(rpc.mock.calls[0])).toBe(JSON.stringify(["commerce_return_request_create", {
      p_idempotency_key: "request-key", p_order_id: REQUEST.orderId,
      p_lines: [{ orderItemId: REQUEST.lines[0].orderItemId, sku: null, quantity: 2, restockDisposition: "restock" }],
      p_reason_code: "other", p_customer_note: null, p_requested_by: requestedBy ?? null,
    }]));
  });
  it("preserves explicit request intent fields and exact approve/reject arguments", async () => {
    const { port, rpc } = client();
    await port.createRequest({ ...REQUEST, customerNote: "Example", requestedBy: "principal-1",
      lines: [{ ...REQUEST.lines[0], sku: "SKU-1", restockDisposition: "quarantine" }] });
    await port.approve({ idempotencyKey: "approve-key", returnRequestId: "return-1", refundMode: "partial", refundAmountCents: 100,
      adminNote: "Example", actorUserId: "operator-1" });
    await port.reject({ idempotencyKey: "reject-key", returnRequestId: "return-1" });
    expect(rpc.mock.calls).toStrictEqual([
      ["commerce_return_request_create", { p_idempotency_key: "request-key", p_order_id: REQUEST.orderId,
        p_lines: [{ orderItemId: REQUEST.lines[0].orderItemId, sku: "SKU-1", quantity: 2, restockDisposition: "quarantine" }],
        p_reason_code: "other", p_customer_note: "Example", p_requested_by: "principal-1" }],
      ["commerce_return_approve", { p_idempotency_key: "approve-key", p_return_request_id: "return-1", p_approved_by: "operator-1",
        p_refund_mode: "partial", p_refund_amount_cents: 100, p_admin_note: "Example" }],
      ["commerce_return_reject", { p_idempotency_key: "reject-key", p_return_request_id: "return-1", p_approved_by: null, p_admin_note: null }],
    ]);
  });
  it.each([true, false, undefined, "true"])("maps replayed %s only from boolean true", async (replayed) => {
    const { port } = client({ data: { returnRequestId: "return-1", status: "requested", replayed }, error: null });
    expect(await port.createRequest(REQUEST)).toStrictEqual({ returnRequestId: "return-1", status: "requested", replayed: replayed === true });
  });
  it.each([null, {}, { returnRequestId: 1, status: "requested" }, { returnRequestId: "return-1" }])("refuses invalid result %s", async (data) => {
    const { port } = client({ data, error: null });
    await expect(port.createRequest(REQUEST)).rejects.toThrow("commerce_return_request_create_unexpected_result");
  });
  it("uses unknown SQLSTATE when absent and keeps upstream details private", async () => {
    const { port } = client({ data: null, error: { message: "private upstream detail" } });
    await expect(port.createRequest(REQUEST)).rejects.toThrow("commerce_return_request_create_failed:unknown");
  });
});
