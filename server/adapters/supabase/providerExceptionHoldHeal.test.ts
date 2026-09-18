import { describe, expect, it, vi } from "vitest";
import {
  readHealableProviderExceptionHolds,
  releaseHealedProviderExceptionHold,
  type ProviderExceptionHealClient,
} from "./providerExceptionHoldHeal.js";

function query(data: unknown) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "in"]) builder[method] = () => builder;
  builder.then = (
    resolve: (value: { data: unknown; error: null }) => unknown,
  ) => Promise.resolve({ data, error: null }).then(resolve);
  return builder;
}

describe("Supabase provider exception hold healing", () => {
  it("maps candidate, delivery and order reads into a proven backfill row", async () => {
    const rpc = vi.fn(async () => ({
      data: [{
        hold_id: "hold-1",
        order_id: "order-1",
        fulfillment_order_id: "shipment-1",
        cleared_evidence_id: "evidence-1",
        cleared_provider_status: "suspended",
        cleared_provider_sub_status: null,
        cleared_occurred_at: "2026-08-01T00:00:00.000Z",
      }],
      error: null,
    }));
    const from = vi.fn((table: string) => query(
      table === "commerce_fulfillment_orders"
        ? [{ id: "shipment-1", delivered_at: "2026-08-02T00:00:00.000Z" }]
        : [{ id: "order-1", order_number: "ORDER-1" }],
    ));
    const rows = await readHealableProviderExceptionHolds({ rpc, from } as unknown as ProviderExceptionHealClient);
    expect(rows).toEqual([expect.objectContaining({ hold_id: "hold-1", order_number: "ORDER-1" })]);
    expect(rpc).toHaveBeenCalledWith("commerce_oms_healable_provider_exception_holds", {
      p_fulfillment_order_id: null,
    });
  });

  it("maps delivered proof into the system-release RPC", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    await releaseHealedProviderExceptionHold({ rpc } as unknown as ProviderExceptionHealClient, {
      hold_id: "hold-1",
      order_id: "order-1",
      fulfillment_order_id: "shipment-1",
      cleared_evidence_id: "evidence-1",
      cleared_provider_status: "suspended",
      cleared_provider_sub_status: null,
      cleared_occurred_at: "2026-08-01T00:00:00.000Z",
      delivered_at: "2026-08-02T00:00:00.000Z",
      order_number: "ORDER-1",
    });
    expect(rpc).toHaveBeenCalledWith("commerce_oms_release_hold_system", expect.objectContaining({
      p_hold_id: "hold-1",
      p_proof: "delivered",
    }));
  });
});
