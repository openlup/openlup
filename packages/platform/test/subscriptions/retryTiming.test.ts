import { expect, it, vi } from "vitest";
import { createPostgresRetryLifecycleBinding, createPostgresRetryStore, type NativeRetryLifecycleBinding } from "../../src/subscriptions/postgresRetryStore.js";

it("refuses invalid timing before any initial handoff or SQL", () => {
  const query = vi.fn(), settlement = vi.fn();
  for (const backoffHours of [[0], [-1], [Number.NaN], [Infinity], ["2"], null]) {
    const timing = { backoffHours } as unknown as NativeRetryLifecycleBinding["retryCadence"];
    expect(() => createPostgresRetryStore({ query }, timing)).toThrow("cadence_invalid");
    expect(() => createPostgresRetryLifecycleBinding({ executor: { query }, settlement, retryCadence: timing } as unknown as NativeRetryLifecycleBinding)).toThrow("cadence_invalid");
  }
  expect(query).not.toHaveBeenCalled(); expect(settlement).not.toHaveBeenCalled();
});
