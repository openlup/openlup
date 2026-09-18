import type { VercelRequest, VercelResponse } from "../../server/_lib/types/vercel.js";
import { authorizeCron } from "../_cron/authorizeCron.js";
import {
  CUSTOMER_DIAGNOSTIC_PRUNE_BACKSTOP_HEADER,
  runCustomerDiagnosticPrune,
} from "../../server/runtime/observability/customerDiagnosticPruneRuntime.js";

export const config = { maxDuration: 60 };

// No hosted cron fires this route: `platform.hostedCron: false` keeps it out of
// vercel.json. Its clocks are the in-process Node scheduler on node-* bundles
// and the GitHub poker on the managed bundle, and on a multi-instance Node host
// the job's own platform_job_controls lease — not the node-cron advisory lock,
// which is null when DATABASE_URL is blank — is what prevents a double run.
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const denied = authorizeCron(req, process.env);
  if (denied) {
    res.status(denied.status).json(denied.body);
    return;
  }
  // `x-scheduler-source` is the only identifying header cron-poker.yml sends
  // besides the backstop one, and only on a leg that declares `scheduler_source`.
  // Relaying it is what lets an attributed run be recorded as the poker's.
  const result = await runCustomerDiagnosticPrune({
    backstopMode: firstHeader(req.headers[CUSTOMER_DIAGNOSTIC_PRUNE_BACKSTOP_HEADER]),
    schedulerSource: firstHeader(req.headers["x-scheduler-source"]),
  });
  res.status(result.status).json(result.body);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
