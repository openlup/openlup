import type { VercelRequest, VercelResponse } from "../../server/_lib/types/vercel.js";
import { runPlatformWatchdogRoute } from "../../server/ops/platformWatchdog.js";

// 60s matches every comparable api/cron route; at 30s the persisting tick 504'd.
// Pinned by platformWatchdogGuardrails.test.ts; why in OBSERVABILITY_RUNBOOK.md.
export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const result = await runPlatformWatchdogRoute(req);
  res.status(result.status).json(result.body);
}
