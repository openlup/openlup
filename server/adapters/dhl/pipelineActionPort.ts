import type { AdminPipelinePort } from "../../../src/domains/platform/ports.js";
import {
  runDhlTrackingRefresh,
  type DhlTrackingRefreshRunner,
  type DhlTrackingRuntimeEnv,
} from "./trackingRefreshAdapter.js";

interface DhlTrackingResponseBody {
  checked?: number;
  updated?: number;
  error?: string;
}

export function createDhlTrackingRefreshPipelinePort(
  options: {
    accessToken: string | null;
    env?: DhlTrackingRuntimeEnv;
    runTrackingRefresh?: DhlTrackingRefreshRunner;
  },
): Pick<AdminPipelinePort, "refreshDhlTracking"> {
  const runTrackingRefresh = options.runTrackingRefresh ?? runDhlTrackingRefresh;
  return {
    async refreshDhlTracking() {
      const result = await runTrackingRefresh({
        authorizationToken: options.accessToken,
        driver: "manual_admin",
        triggerSource: "admin_pipeline_manual",
      }, options.env);
      const data = result.body as DhlTrackingResponseBody;
      if (result.status < 200 || result.status >= 300) {
        throw new Error(data.error ?? "dhl_tracking_refresh_failed");
      }
      if (data.error) throw new Error(data.error);

      return {
        checked: data?.checked ?? 0,
        updated: data?.updated ?? 0,
      };
    },
  };
}
