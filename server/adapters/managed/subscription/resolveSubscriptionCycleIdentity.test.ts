import { describe, expect, it, vi } from "vitest";
import { resolveSubscriptionCycleIdentity } from "./resolveSubscriptionCycleIdentity.js";
import {
  SubscriptionCycleSnapshotError,
  type SnapshotSupabaseClient,
} from "./buildSubscriptionCycleSnapshots.js";

const SUB_ID = "00000000-0000-4000-8000-000000000001";
const SCHEDULED_AT = "2026-06-09T12:00:00Z";

function clientWithCycles(result: {
  data: unknown;
  error: { message?: string } | null;
}): SnapshotSupabaseClient {
  const builder: Record<string, unknown> = {};
  for (const fn of ["select", "eq", "order"] as const) {
    builder[fn] = vi.fn().mockReturnValue(builder);
  }
  builder.then = (resolve: (value: typeof result) => unknown) => resolve(result);
  return {
    rpc: vi.fn(),
    from: vi.fn().mockImplementation((table: string) => {
      if (table !== "subscription_cycles") throw new Error(`unexpected from ${table}`);
      return builder as never;
    }),
  } as unknown as SnapshotSupabaseClient;
}

describe("resolveSubscriptionCycleIdentity", () => {
  it("mints max+1 with retryAttempt 0 for a brand-new cycle (no scheduled_at match)", async () => {
    const client = clientWithCycles({
      data: [{ cycle_number: 2, scheduled_at: "2026-05-19T12:00:00Z", retry_attempt: 0 }],
      error: null,
    });

    await expect(
      resolveSubscriptionCycleIdentity(client, SUB_ID, SCHEDULED_AT),
    ).resolves.toEqual({ cycleNumber: 3, retryAttempt: 0, providerAttemptSequence: 0 });
  });

  it("returns cycleNumber 1 / attempt 0 when there are no prior cycles", async () => {
    const client = clientWithCycles({ data: [], error: null });

    await expect(
      resolveSubscriptionCycleIdentity(client, SUB_ID, SCHEDULED_AT),
    ).resolves.toEqual({ cycleNumber: 1, retryAttempt: 0, providerAttemptSequence: 0 });
  });

  it("REUSES the persisted cycle_number + retry_attempt of the cycle matching scheduled_at (CJ01-P)", async () => {
    const client = clientWithCycles({
      data: [
        { cycle_number: 2, scheduled_at: SCHEDULED_AT, retry_attempt: 1 },
        { cycle_number: 1, scheduled_at: "2026-05-19T12:00:00Z", retry_attempt: 0 },
      ],
      error: null,
    });

    await expect(
      resolveSubscriptionCycleIdentity(client, SUB_ID, SCHEDULED_AT),
    ).resolves.toEqual({ cycleNumber: 2, retryAttempt: 1, providerAttemptSequence: 0 });
  });

  it("matches scheduled_at by epoch millis across timestamp serialization", async () => {
    const client = clientWithCycles({
      data: [{ cycle_number: 5, scheduled_at: "2026-06-09T12:00:00+00:00", retry_attempt: 3 }],
      error: null,
    });

    await expect(
      resolveSubscriptionCycleIdentity(client, SUB_ID, SCHEDULED_AT),
    ).resolves.toEqual({ cycleNumber: 5, retryAttempt: 3, providerAttemptSequence: 0 });
  });

  it("surfaces provider_attempt_sequence separately from customer retryAttempt", async () => {
    const client = clientWithCycles({
      data: [{
        cycle_number: 5,
        scheduled_at: "2026-06-09T12:00:00+00:00",
        retry_attempt: 1,
        provider_attempt_sequence: 2,
      }],
      error: null,
    });

    await expect(
      resolveSubscriptionCycleIdentity(client, SUB_ID, SCHEDULED_AT),
    ).resolves.toEqual({ cycleNumber: 5, retryAttempt: 1, providerAttemptSequence: 2 });
  });

  it("throws SubscriptionCycleSnapshotError when the read fails", async () => {
    const client = clientWithCycles({ data: null, error: { message: "boom" } });

    await expect(
      resolveSubscriptionCycleIdentity(client, SUB_ID, SCHEDULED_AT),
    ).rejects.toBeInstanceOf(SubscriptionCycleSnapshotError);
  });
});
