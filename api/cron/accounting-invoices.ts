import type { VercelRequest, VercelResponse } from "../../server/_lib/types/vercel.js";
import { runAccountingCron } from "../_cron/accountingJobRunner.js";

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const result = await runAccountingCron(req, "invoice-issue");
  res.status(result.status).json(result.body);
}
