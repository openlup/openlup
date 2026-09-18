import { describe, expect, it, vi } from "vitest";
import { createSupabaseReorderReminderEnqueuePort } from "./reorderReminderEnqueue.js";

describe("createSupabaseReorderReminderEnqueuePort", () => {
  it("maps the reorder reminder enqueue RPC payload", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { enqueued: 4 }, error: null });

    await expect(createSupabaseReorderReminderEnqueuePort({ rpc }).enqueue(200)).resolves.toEqual({
      enqueued: 4,
    });
    expect(rpc).toHaveBeenCalledWith("enqueue_reorder_reminders", { p_limit: 200 });
  });

  it("throws sanitized RPC errors", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });

    await expect(createSupabaseReorderReminderEnqueuePort({ rpc }).enqueue(10)).rejects.toThrow("boom");
  });
});
