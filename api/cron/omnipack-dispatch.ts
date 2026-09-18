import type { VercelRequest, VercelResponse } from "../../server/_lib/types/vercel.js";
import { runOmnipackDispatchCron } from "../_cron/omnipackDispatchJob.js";
import { bootstrapAmbientSettlementProfile } from "../../server/runtime/settlementProfileBootstrap.js";

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  // This job reaches contract schemas whose money nodes are validated against the
  // ambient settlement profile, and a plain server process has no bundled
  // environment to resolve one from. Stating it first is what stops the job from
  // refusing the currency the deployment is configured for.
  bootstrapAmbientSettlementProfile();
  const result = await runOmnipackDispatchCron(req);
  res.status(result.status).json(result.body);
}
