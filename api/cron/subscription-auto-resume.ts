import type { VercelRequest, VercelResponse } from "../../server/_lib/types/vercel.js";
import { runSubscriptionAutoResumeCron } from "../_cron/subscriptionAutoResumeJob.js";

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const result = await runSubscriptionAutoResumeCron(req);
  res.status(result.status).json(result.body);
}
