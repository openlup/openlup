import { describe, expect, it } from "vitest";
import { createSupabaseCustomerJourneySnapshotPort } from "./supabaseCustomerJourneySnapshotPort.js";

describe("supabase customer journey snapshot port", () => {
  it("exposes read-only search and snapshot operations", () => {
    const port = createSupabaseCustomerJourneySnapshotPort({} as never);

    expect(port.search).toBeTypeOf("function");
    expect(port.snapshot).toBeTypeOf("function");
  });

  it("fails closed instead of presenting a failed mandatory order read as no orders", async () => {
    const port = createSupabaseCustomerJourneySnapshotPort(mandatoryOrderFailureReader());

    await expect(port.snapshot({ clientId: "10000000-0000-4000-8000-000000000001", pageSize: 10 }))
      .rejects.toThrow("order_read_failed");
  });
});

function mandatoryOrderFailureReader() {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const same = () => chain;
      Object.assign(chain, {
        select: same, eq: same, in: same, order: same,
        range: async () => table === "commerce_orders"
          ? { data: null, error: { message: "order_read_failed" } }
          : { data: [], error: null },
        maybeSingle: async () => table === "clients"
          ? { data: { id: "10000000-0000-4000-8000-000000000001" }, error: null }
          : { data: null, error: null },
      });
      return chain;
    },
  } as never;
}
