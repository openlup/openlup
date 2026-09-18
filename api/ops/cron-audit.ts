import type { VercelRequest, VercelResponse } from "../../server/_lib/types/vercel.js";
import { runCronAudit } from "../../server/ops/cronAudit.js";

export const config = { maxDuration: 30 };

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const result = await runCronAudit(req);
  res.status(result.status).json(result.body);
}
