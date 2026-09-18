import { describe, expect, it, vi } from "vitest";
import { createSupabaseSubscriptionAutoResumePort } from "./subscriptionAutoResume.js";

describe("createSupabaseSubscriptionAutoResumePort", () => {
  it("maps successful auto-resume counts from object payloads", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { ok: true, scanned: 3, resumed: 2, skipped: 1, failed: 0 },
      error: null,
    });

    await expect(createSupabaseSubscriptionAutoResumePort({ rpc }).run(100)).resolves.toMatchObject({
      ok: true,
      scanned: 3,
      resumed: 2,
      skippedRows: 1,
      failed: 0,
    });
    expect(rpc).toHaveBeenCalledWith("subscription_auto_resume_due", { p_limit: 100 });
  });

  it("maps successful auto-resume counts from row-array payloads", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ ok: true, scanned: 5, resumed: 4, skipped: 1, failed: 0 }],
      error: null,
    });

    await expect(createSupabaseSubscriptionAutoResumePort({ rpc }).run(25)).resolves.toMatchObject({
      ok: true,
      scanned: 5,
      resumed: 4,
      skippedRows: 1,
      failed: 0,
    });
  });

  it("treats missing RPC as a no-op skip", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "PGRST202", message: "Could not find the function public.subscription_auto_resume_due" },
    });

    await expect(createSupabaseSubscriptionAutoResumePort({ rpc }).run(100)).resolves.toMatchObject({
      ok: true,
      skipped: true,
      reason: "subscription_auto_resume_rpc_missing",
      scanned: 0,
      resumed: 0,
      failed: 0,
    });
  });

  it("returns a failed result with a bounded reason on non-missing RPC errors", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "database timeout" },
    });

    await expect(createSupabaseSubscriptionAutoResumePort({ rpc }).run(100)).resolves.toMatchObject({
      ok: false,
      skipped: false,
      reason: "database timeout",
      failed: 1,
    });
  });
});
