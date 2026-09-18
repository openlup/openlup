import { describe, expect, it } from "vitest";
import { createDhlTrackingRefreshPipelinePort } from "./pipelineActionPort.js";

describe("createDhlTrackingRefreshPipelinePort", () => {
  it("maps the local DHL tracking refresh runner response", async () => {
    const calls: unknown[] = [];
    const port = createDhlTrackingRefreshPipelinePort({
      accessToken: "admin-token",
      env: { CRON_SECRET: "cron-secret" },
      async runTrackingRefresh(request, env) {
        calls.push({ request, env });
        return { status: 200, body: { checked: 4, updated: 2 } };
      },
    });

    await expect(port.refreshDhlTracking({})).resolves.toEqual({ checked: 4, updated: 2 });
    expect(calls).toEqual([{
      request: {
        authorizationToken: "admin-token",
        driver: "manual_admin",
        triggerSource: "admin_pipeline_manual",
      },
      env: { CRON_SECRET: "cron-secret" },
    }]);
  });

  it("surfaces failed tracking refresh responses as errors", async () => {
    const port = createDhlTrackingRefreshPipelinePort({
      accessToken: "admin-token",
      async runTrackingRefresh() {
        return { status: 502, body: { error: "all_dhl_tracking_checks_failed" } };
      },
    });

    await expect(port.refreshDhlTracking({})).rejects.toThrow("all_dhl_tracking_checks_failed");
  });
});
