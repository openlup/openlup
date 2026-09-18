import type { VercelRequest, VercelResponse } from "../../server/_lib/types/vercel.js";
import { runOmnipackStockSyncCron } from "../_cron/omnipackStockSyncJob.js";

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const result = await runOmnipackStockSyncCron(req);
  res.status(result.status).json(result.body);
}
