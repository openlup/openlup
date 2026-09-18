import { describe, expect, it, vi } from "vitest";
import { createSupabaseCommerceReturnsPort, type CommerceReturnsRpcClient } from "./commerceReturnsPort.js";

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
