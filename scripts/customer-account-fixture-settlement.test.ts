import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { proveCustomerFixtureSettlement } from "./customer-account-fixture-settlement.ts";

type Rows = Record<string, unknown>[];

/**
 * Snapshot reader stub: every attempt serves one scripted snapshot, so the test
 * proves the bounded poll re-reads instead of judging the first race.
 */
function snapshotService(snapshots: Array<{ paymentOutbox: Rows }>): {
  service: SupabaseClient;
  attempts: () => number;
} {
  let attempt = -1;
  const service = {
    from(table: string) {
      return {
        select() {
          return {
            async eq(column: string, value: string) {
              if (table === "commerce_payment_intents") {
                // The first table read of a snapshot; advance the scripted attempt.
                attempt += 1;
                return { data: [{ id: `intent-for-${value}` }], error: null };
              }
              if (table === "outbox_events" && column === "aggregate_id" && value.startsWith("intent-for-")) {
                const snapshot = snapshots[Math.min(attempt, snapshots.length - 1)];
                return { data: snapshot.paymentOutbox, error: null };
              }
              return { data: [], error: null };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { service, attempts: () => attempt + 1 };
}

describe("customer fixture settlement proof", () => {
  it("resolves once a later snapshot is clean", async () => {
    const { service, attempts } = snapshotService([
      { paymentOutbox: [{ status: "pending" }] },
      { paymentOutbox: [{ status: "processing" }] },
      { paymentOutbox: [{ status: "succeeded" }] },
    ]);
    const slept: number[] = [];

    await expect(proveCustomerFixtureSettlement(
      service,
      "order-1",
      async (ms) => { slept.push(ms); },
      { CUSTOMER_ACCOUNT_SETTLEMENT_ATTEMPTS: "8" } as NodeJS.ProcessEnv,
    )).resolves.toBeUndefined();

    expect(attempts()).toBe(3);
    expect(slept).toEqual([1500, 1500]);
  });

  it("throws today's message after the bounded attempts are exhausted", async () => {
    const { service, attempts } = snapshotService([{ paymentOutbox: [{ status: "pending" }] }]);
    const slept: number[] = [];

    await expect(proveCustomerFixtureSettlement(
      service,
      "order-1",
      async (ms) => { slept.push(ms); },
      { CUSTOMER_ACCOUNT_SETTLEMENT_ATTEMPTS: "4" } as NodeJS.ProcessEnv,
    )).rejects.toThrow("customer fixture settlement proof failed: active outbox");

    expect(attempts()).toBe(4);
    expect(slept).toEqual([1500, 1500, 3000]);
  });

  it("defaults to eight attempts and clamps a non-positive override to one", async () => {
    const { service: defaulted, attempts: defaultedAttempts } = snapshotService([
      { paymentOutbox: [{ status: "failed" }] },
    ]);
    await expect(proveCustomerFixtureSettlement(
      defaulted,
      "order-1",
      async () => {},
      {} as NodeJS.ProcessEnv,
    )).rejects.toThrow("customer fixture settlement proof failed");
    expect(defaultedAttempts()).toBe(8);

    const { service: clamped, attempts: clampedAttempts } = snapshotService([
      { paymentOutbox: [{ status: "failed" }] },
    ]);
    await expect(proveCustomerFixtureSettlement(
      clamped,
      "order-1",
      async () => {},
      { CUSTOMER_ACCOUNT_SETTLEMENT_ATTEMPTS: "0" } as NodeJS.ProcessEnv,
    )).rejects.toThrow("customer fixture settlement proof failed");
    expect(clampedAttempts()).toBe(1);
  });
});
