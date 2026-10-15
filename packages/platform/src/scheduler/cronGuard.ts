import type { HttpRequest } from "../http/index.js";
import { bearerToken } from "./vercelScheduler.js";

export { bearerToken };

export interface CronAuthDenied {
  status: number;
  body: Record<string, unknown>;
}

// Shared cron entrypoint guard: method allowlist + CRON_SECRET presence + bearer
// match. Returns a response to return verbatim when denied, or null when the
// request is authorized. Per-job flag kill-switches and provider/env readiness
// checks intentionally stay in each job — they differ per job and must run after
// this guard but before any ledger write.
export function authorizeCron(
  req: HttpRequest,
  env: { CRON_SECRET?: string },
): CronAuthDenied | null {
  if (req.method !== "GET" && req.method !== "POST") {
    return { status: 405, body: { ok: false, error: "method_not_allowed" } };
  }
  if (!env.CRON_SECRET) {
    return { status: 503, body: { ok: false, error: "cron_secret_required" } };
  }
  if (bearerToken(req) !== env.CRON_SECRET) {
    return { status: 401, body: { ok: false, error: "unauthorized" } };
  }
  return null;
}
