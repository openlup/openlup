import { expect, it, vi } from "vitest";
import { createPostgresSubscriptionAutoResume } from "../../src/subscriptions/postgresAutoResume.js";

it("runs the existing maintenance RPC with default batch and maps graceful skips", async () => {
  const query = vi.fn(async () => ({ rows: [{ response: { ok: true, scanned: 3, resumed: 2, skippedRows: 1, failed: 0 } }] }));
  const job = createPostgresSubscriptionAutoResume({ query });
  expect(query).not.toHaveBeenCalled();
  expect(await job.run()).toEqual({ ok: true, scanned: 3, resumed: 2, skippedRows: 1, failed: 0 });
  expect(query).toHaveBeenCalledWith(expect.stringContaining("public.subscription_auto_resume_due"), [100, null]);
  await job.run(7, "2026-09-01T12:00:00Z");
  expect(query).toHaveBeenLastCalledWith(expect.any(String), [7, "2026-09-01T12:00:00Z"]);
});
it("refuses invalid batches before database work and propagates database failures", async () => {
  const query = vi.fn(async () => { throw new Error("unavailable"); });
  const job = createPostgresSubscriptionAutoResume({ query });
  await expect(job.run(0)).rejects.toThrow("limit_invalid");
  expect(query).not.toHaveBeenCalled();
  await expect(job.run()).rejects.toThrow("unavailable");
});
it("refuses malformed maintenance readback", async () => {
  const job = createPostgresSubscriptionAutoResume({ query: async () => ({ rows: [{ response: { ok: true, resumed: "2" } }] }) });
  await expect(job.run()).rejects.toThrow("response_invalid");
});
