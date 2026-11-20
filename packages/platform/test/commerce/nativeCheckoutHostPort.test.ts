import { describe, expect, it, vi } from "vitest";
import { createPostgresNativeCheckoutHostPort } from "../../src/commerce/server/native-checkout/index.js";

const ORDER_ID = "00000000-0000-4000-8000-000000000101";
const CLIENT_ID = "00000000-0000-4000-8000-000000000202";
const PRINCIPAL_ID = "00000000-0000-4000-8000-000000000303";

describe("createPostgresNativeCheckoutHostPort", () => {
  it("short-circuits invalid UUIDs on readOrder and isInitialCheckoutOrder without querying", async () => {
    const query = vi.fn();
    const port = createPostgresNativeCheckoutHostPort({ query });

    expect(await port.readOrder("not-a-uuid")).toBeNull();
    expect(await port.isInitialCheckoutOrder("not-a-uuid")).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it("reads order, order items, prior draft order, settlement intent, client email, and recurring fence", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM public.commerce_orders WHERE id=$1")) {
        return { rows: [{ id: ORDER_ID, client_id: CLIENT_ID, status: "pending_payment", total_amount_minor: 1500, currency_code: "EUR", metadata: {}, created_at: "2026-11-20T00:00:00.000Z", recreated_from_order_id: null }] };
      }
      if (sql.includes("FROM public.commerce_order_items")) {
        return { rows: [{ id: "item-1", sku_id: "sku-1", quantity: 2 }] };
      }
      if (sql.includes("FROM public.commerce_order_draft_receipts")) {
        return { rows: [{ id: ORDER_ID, status: "pending_payment", total_amount_minor: 1500, currency_code: "EUR", snapshot: { v: 1 }, completed: true }] };
      }
      if (sql.includes("FROM public.commerce_settlement_intents")) {
        return { rows: [{ id: "intent-1", status: "open", external_ref: null }] };
      }
      if (sql.includes("FROM public.clients")) {
        return { rows: [{ email: "buyer@example.test" }] };
      }
      if (sql.includes("initial_checkout")) {
        return { rows: [{ initial_checkout: true }] };
      }
      return { rows: [] };
    });

    const port = createPostgresNativeCheckoutHostPort({ query });
    expect((await port.readOrder(ORDER_ID))?.id).toBe(ORDER_ID);
    expect(await port.readOrderItems(ORDER_ID)).toEqual([{ id: "item-1", sku_id: "sku-1", quantity: 2 }]);
    expect((await port.readPriorDraftOrder({ idempotencyKey: "k1", clientId: CLIENT_ID, email: "buyer@example.test", channelKey: "sandbox" }))?.completed).toBe(true);
    await port.openSettlementIntent({ idempotencyKey: "k1:intent", orderId: ORDER_ID, channelKey: "sandbox", amountMinor: 1500, currency: "EUR", now: "2026-11-20T00:00:00.000Z" });
    expect((await port.readSettlementIntent({ orderId: ORDER_ID, channelKey: "sandbox" }))?.id).toBe("intent-1");
    expect(await port.readClientEmail({ clientId: CLIENT_ID, principalId: PRINCIPAL_ID })).toBe("buyer@example.test");
    expect(await port.isInitialCheckoutOrder(ORDER_ID)).toBe(true);
    expect(query).toHaveBeenCalledTimes(7);
  });
});
