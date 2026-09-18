import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import type { DhlTrackingRefreshRunner, DhlTrackingRuntimeEnv } from "../../server/adapters/dhl/trackingRefreshAdapter.js";

type CronEnv = DhlTrackingRuntimeEnv & {
  CRON_SECRET?: string;
  COMMERCE_DHL_TRACKING_ENABLED?: string;
};

export type DhlTrackingCronResult = {
  status: number;
  body: Record<string, unknown>;
};

function bearerToken(req: VercelRequest): string | null {
  const auth = req.headers.authorization;
  const header = Array.isArray(auth) ? auth[0] : auth;
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

export async function runDhlTrackingCron(
  req: VercelRequest,
  env: CronEnv = process.env,
  trackingRefresh?: DhlTrackingRefreshRunner,
): Promise<DhlTrackingCronResult> {
  if (req.method !== "GET" && req.method !== "POST") {
    return {
      status: 405,
      body: { ok: false, error: "method_not_allowed" },
    };
  }

  const cronSecret = env.CRON_SECRET;
  if (!cronSecret) {
    return {
      status: 500,
      body: { ok: false, error: "cron_secret_not_configured" },
    };
  }

  if (bearerToken(req) !== cronSecret) {
    return {
      status: 401,
      body: { ok: false, error: "unauthorized" },
    };
  }

  void env;
  void trackingRefresh;
  return {
    status: 200,
    body: { ok: true, skipped: true, reason: "direct_dhl_tracking_retired" },
  };
}
