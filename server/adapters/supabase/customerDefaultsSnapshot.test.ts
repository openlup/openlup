import { describe, expect, it, vi } from "vitest";
import { createSupabaseCustomerDefaultsSnapshotPort } from "./customerDefaultsSnapshot.js";

describe("Supabase customer defaults snapshot adapter", () => {
  it("executes all characterized reads and returns redacted neutral hints", async () => {
    const rows: Record<string, unknown[]> = {
      customer_payment_preferences: [{ scope: "one_time", method_kind: "card", last_selected_at: "2030-01-01T00:00:00.000Z" }],
      addresses: [{ id: "11111111-1111-4111-8111-111111111111", kind: "both", is_default: true, updated_at: "2030-01-01T00:00:00.000Z" }],
      customer_orderer_profiles: [{ id: "22222222-2222-4222-8222-222222222222", is_default: true, updated_at: "2030-01-01T00:00:00.000Z" }],
    };
    const from = vi.fn((table: string) => {
      const chain: Record<string, unknown> = {};
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.order = vi.fn(() => chain);
      chain.then = (resolve: (value: unknown) => unknown) => resolve({ data: rows[table], error: null });
      return chain;
    });

    const result = await createSupabaseCustomerDefaultsSnapshotPort({ from } as never)
      .getCustomerDefaultsSnapshot({
        clientId: "33333333-3333-4333-8333-333333333333",
        checkoutKind: "one_time",
      });

    expect(from.mock.calls.map(([table]) => table)).toEqual([
      "customer_payment_preferences", "addresses", "customer_orderer_profiles",
    ]);
    expect(result).toMatchObject({
      payment: { available: true, methodKind: "card", applied: false },
      addresses: { hasDefaultShippingAddress: true, hasDefaultOrdererProfile: true },
    });
  });
});
