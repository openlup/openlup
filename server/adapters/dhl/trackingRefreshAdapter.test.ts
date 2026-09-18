import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { runTrackingRefresh } from "./trackingRefreshAdapter.js";
import { SCHEDULED_CRON_DRIVER } from "./trackingJobLedger.js";

const CARRIER_CREDENTIALS = {
  DHL_API_USERNAME: "carrier-user",
  DHL_API_PASSWORD: "carrier-pass",
};
const SERVICE_ROLE = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
};

describe("tracking refresh adapter", () => {
  it("uses the native tracker action and retains only the explicit status-email residual", async () => {
    const source = await readFile(new URL("./trackingRefreshAdapter.ts", import.meta.url), "utf8");
    expect(source).toContain("createTrackingRefreshAction");
    expect(source).toContain("sendStatusEmailInProcess");
    expect(source).not.toContain("check-dhl-tracking/handler.ts");
  });

  it("fails closed when service-role configuration is missing", async () => {
    const fetchImpl = vi.fn();

    await expect(
      runTrackingRefresh({
        authorizationToken: "cron-secret",
        driver: SCHEDULED_CRON_DRIVER,
        triggerSource: "scheduled_manual",
      }, {
        ...CARRIER_CREDENTIALS,
      }, fetchImpl as never),
    ).resolves.toEqual({
      status: 500,
      body: { error: "supabase_service_role_not_configured" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed when carrier credentials are missing", async () => {
    const fetchImpl = vi.fn();

    await expect(
      runTrackingRefresh({
        authorizationToken: "admin-token",
        driver: "manual_admin",
        triggerSource: "admin_pipeline_manual",
      }, SERVICE_ROLE, fetchImpl as never),
    ).resolves.toEqual({
      status: 500,
      body: { error: "dhl_credentials_not_configured" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
