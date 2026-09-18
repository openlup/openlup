import { describe, expect, it, vi } from "vitest";
import { createSupabaseStockNotifySubscribePort } from "./stockNotifySubscribe.js";

// Characterization of the three-RPC back-in-stock subscribe sequence exactly as
// it shipped from server/domains/commerce/stockNotifySubscribePort.ts: the RPC
// names, their argument objects, their ordering, and the error labels are the
// contract the SECURITY DEFINER functions and the consent audit depend on.

type RpcResult = { data: unknown; error: { code?: string; message?: string; details?: string; hint?: string } | null };

function fakeClient(results: RpcResult[]) {
  const queue = [...results];
  const rpc = vi.fn(
    async (_fn: string, _args: Record<string, unknown>): Promise<RpcResult> =>
      queue.shift() ?? { data: null, error: null },
  );
  return { client: { rpc }, rpc };
}

const OK: RpcResult = { data: null, error: null };

describe("createSupabaseStockNotifySubscribePort", () => {
  it("touches the contact, grants marketing consent, then subscribes — with the exact RPC payloads", async () => {
    const { client, rpc } = fakeClient([
      { data: "contact-1", error: null },
      OK,
      OK,
    ]);

    await createSupabaseStockNotifySubscribePort(client).subscribe({
      sku: "OPENLUP-DOG-ADULT-2KG",
      email: "buyer@example.com",
    });

    expect(rpc.mock.calls).toEqual([
      [
        "communication_touch_contact",
        {
          p_email: "buyer@example.com",
          p_metadata: { source: "stock_notify_bff" },
        },
      ],
      [
        "communication_record_permission_event",
        {
          p_contact_id: "contact-1",
          p_purpose: "marketing_newsletter",
          p_state: "granted",
          p_source: "stock_notify_bff",
          p_source_ref: { sku: "OPENLUP-DOG-ADULT-2KG" },
          p_reason: "back_in_stock_notify_me_opt_in",
        },
      ],
      [
        "subscribe_product_stock_notification",
        {
          p_sku: "OPENLUP-DOG-ADULT-2KG",
          p_email: "buyer@example.com",
          p_contact_id: "contact-1",
          p_metadata: { source: "stock_notify_bff" },
        },
      ],
    ]);
  });

  it("passes a null contact id downstream when the touch RPC returns a non-string", async () => {
    const { client, rpc } = fakeClient([{ data: null, error: null }, OK, OK]);

    await createSupabaseStockNotifySubscribePort(client).subscribe({
      sku: "SKU-1",
      email: "buyer@example.com",
    });

    expect(rpc.mock.calls[1]?.[1]).toMatchObject({ p_contact_id: null });
    expect(rpc.mock.calls[2]?.[1]).toMatchObject({ p_contact_id: null });
  });

  it("fails closed on the contact touch before any consent or subscribe write", async () => {
    const { client, rpc } = fakeClient([
      { data: null, error: { message: "denied", details: "rls", hint: "grant" } },
    ]);

    await expect(createSupabaseStockNotifySubscribePort(client).subscribe({
      sku: "SKU-1",
      email: "buyer@example.com",
    })).rejects.toThrow("stock_notify_touch_contact_failed: denied rls grant");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("fails closed on the consent record before subscribing", async () => {
    const { client, rpc } = fakeClient([
      { data: "contact-1", error: null },
      { data: null, error: { code: "42501" } },
    ]);

    await expect(createSupabaseStockNotifySubscribePort(client).subscribe({
      sku: "SKU-1",
      email: "buyer@example.com",
    })).rejects.toThrow("stock_notify_record_consent_failed: 42501");
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("surfaces a subscribe failure with the stable label", async () => {
    const { client } = fakeClient([
      { data: "contact-1", error: null },
      OK,
      { data: null, error: {} },
    ]);

    await expect(createSupabaseStockNotifySubscribePort(client).subscribe({
      sku: "SKU-1",
      email: "buyer@example.com",
    })).rejects.toThrow("stock_notify_subscribe_failed: unknown");
  });
});
