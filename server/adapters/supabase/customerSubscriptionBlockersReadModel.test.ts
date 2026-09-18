import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readSubscriptionBlockers } from "./customerSubscriptionBlockersReadModel.js";

const subscriptionId = "11111111-1111-4111-8111-111111111111";
const nextCycleAt = "2026-07-15T10:00:00.000Z";

describe("customer subscription blockers read model", () => {
  it("returns no blockers and avoids queries when there are no subscription ids", async () => {
    const from = vi.fn();
    const result = await readSubscriptionBlockers({ from } as unknown as SupabaseClient, []);

    expect(from).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });

  it("keeps dunning higher priority than locked cycles and orders", async () => {
    const result = await readSubscriptionBlockers(
      serviceClient({
        subscription_dunning_cases: [{ subscription_id: subscriptionId }],
        subscription_cycles: [
          { id: "cycle-next", subscription_id: subscriptionId, scheduled_at: nextCycleAt, status: "payment_pending" },
        ],
        commerce_orders: [
          { subscription_id: subscriptionId, subscription_cycle_id: "cycle-next", status: "paid" },
        ],
      }),
      [subscriptionId],
      new Map([[subscriptionId, nextCycleAt]]),
    );

    expect(result.get(subscriptionId)).toBe("payment_blocked");
  });

  it("ignores historical locked evidence outside the upcoming cycle", async () => {
    const result = await readSubscriptionBlockers(
      serviceClient({
        subscription_dunning_cases: [],
        subscription_cycles: [
          { id: "cycle-old", subscription_id: subscriptionId, scheduled_at: "2026-06-01T10:00:00.000Z", status: "paid" },
        ],
        commerce_orders: [
          { subscription_id: subscriptionId, subscription_cycle_id: "cycle-old", status: "fulfilled" },
        ],
      }),
      [subscriptionId],
      new Map([[subscriptionId, nextCycleAt]]),
    );

    expect(result.has(subscriptionId)).toBe(false);
  });
});

function serviceClient(rows: Record<string, Record<string, unknown>[]>): SupabaseClient {
  return {
    from(table: string) {
      const builder = {
        select: () => builder,
        in: () => builder,
        eq: () => builder,
        then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
          return Promise.resolve(resolve({ data: rows[table] ?? [], error: null }));
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}
