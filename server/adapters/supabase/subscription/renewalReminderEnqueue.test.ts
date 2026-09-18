import { describe, expect, it, vi } from "vitest";
import { createSupabaseRenewalReminderEnqueuePort } from "./renewalReminderEnqueue.js";

describe("createSupabaseRenewalReminderEnqueuePort", () => {
  it("calls the renewal reminder enqueue RPC and reads the count", async () => {
    const rpc = vi.fn(async () => ({ data: { enqueued: 3 }, error: null }));
    await expect(createSupabaseRenewalReminderEnqueuePort({ rpc }).enqueue(100)).resolves.toEqual({ enqueued: 3 });
    expect(rpc).toHaveBeenCalledWith("enqueue_subscription_renewal_reminders", { p_limit: 100 });
  });

  it("defaults malformed counts to zero and throws RPC errors", async () => {
    await expect(
      createSupabaseRenewalReminderEnqueuePort({
        rpc: vi.fn(async () => ({ data: {}, error: null })),
      }).enqueue(10),
    ).resolves.toEqual({ enqueued: 0 });

    await expect(
      createSupabaseRenewalReminderEnqueuePort({
        rpc: vi.fn(async () => ({ data: null, error: { message: "boom" } })),
      }).enqueue(10),
    ).rejects.toThrow("boom");
  });
});
