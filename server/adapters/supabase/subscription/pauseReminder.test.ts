import { describe, expect, it, vi } from "vitest";
import { createSupabaseSubscriptionPauseReminderPort } from "./pauseReminder.js";

describe("createSupabaseSubscriptionPauseReminderPort", () => {
  it("maps successful pause reminder dispatch counts", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { ok: true, scanned: 3, queued: 2, sent: 1, skipped: 4, failed: 0 },
      error: null,
    });

    await expect(createSupabaseSubscriptionPauseReminderPort({ rpc }).dispatch(100)).resolves.toMatchObject({
      ok: true,
      scanned: 3,
      queued: 2,
      sent: 1,
      skippedRows: 4,
      failed: 0,
    });
    expect(rpc).toHaveBeenCalledWith("subscription_dispatch_pause_reminders", { p_limit: 100 });
  });

  it("treats missing RPC as a no-op skip", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "PGRST202", message: "Could not find the function" },
    });

    await expect(createSupabaseSubscriptionPauseReminderPort({ rpc }).dispatch(100)).resolves.toMatchObject({
      ok: true,
      skipped: true,
      reason: "subscription_pause_reminder_rpc_missing",
    });
  });
});
