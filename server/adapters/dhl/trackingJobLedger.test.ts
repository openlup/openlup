import { describe, expect, it, vi } from "vitest";
import {
  beginTrackingJobRun,
  finishTrackingJobRun,
  parseTrackingDriver,
  SCHEDULED_CRON_DRIVER,
  TRACKING_JOB_NAME,
} from "./trackingJobLedger.js";

describe("tracking job ledger", () => {
  it("parses only supported scheduler drivers", () => {
    expect(parseTrackingDriver("pg_cron")).toBe("pg_cron");
    expect(parseTrackingDriver(SCHEDULED_CRON_DRIVER)).toBe(SCHEDULED_CRON_DRIVER);
    expect(parseTrackingDriver("manual_admin")).toBe("manual_admin");
    expect(parseTrackingDriver("spoofed")).toBeNull();
  });

  it("uses the exact claim and finish RPC payloads", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [{ acquired: true, run_id: "run-1", reason: "claimed", lease_until: "2030-01-01T00:20:00Z" }] })
      .mockResolvedValueOnce({ data: true });
    const client = { rpc };

    await expect(beginTrackingJobRun(client, SCHEDULED_CRON_DRIVER, { triggerSource: "cron" })).resolves.toEqual({
      acquired: true, runId: "run-1", reason: "claimed", leaseExpiresAt: "2030-01-01T00:20:00Z",
    });
    await expect(finishTrackingJobRun(client, "run-1", "failed", SCHEDULED_CRON_DRIVER, 3, 1, "boom", "SUP", { errorCount: 2 }))
      .resolves.toBe(true);
    expect(rpc).toHaveBeenNthCalledWith(1, "platform_claim_job_run", {
      p_job_name: TRACKING_JOB_NAME, p_driver: SCHEDULED_CRON_DRIVER, p_lease_seconds: 1200,
      p_metadata: { driver: SCHEDULED_CRON_DRIVER, triggerSource: "cron" },
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "platform_finish_job_run_v2", {
      p_job_name: TRACKING_JOB_NAME, p_run_id: "run-1", p_status: "failed", p_checked: 3, p_updated: 1,
      p_error: "boom", p_support_code: "SUP", p_metadata: { driver: SCHEDULED_CRON_DRIVER, errorCount: 2 },
    });
  });
});
