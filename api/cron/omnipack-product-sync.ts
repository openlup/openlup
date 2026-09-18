import type { VercelRequest, VercelResponse } from "../../server/_lib/types/vercel.js";
import { runOmnipackProductSyncCron } from "../_cron/omnipackProductSyncJob.js";

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const result = await runOmnipackProductSyncCron(req);
  res.status(result.status).json(result.body);
}
