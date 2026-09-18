import type { VercelRequest, VercelResponse } from "../../server/_lib/types/vercel.js";
import {
  resolvePromotionClaimsBinding,
  runPromotionClaimSweepOnce,
  type PromotionClaimsBindingResolution,
} from "../../server/runtime/commerce/promotionClaimsBinding.js";

export const config = { maxDuration: 60 };

type Env = Record<string, string | undefined> & {
  CRON_SECRET?: string;
  COMMERCE_PROMOTION_CLAIM_SWEEP_ENABLED?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_URL?: string;
  VITE_SUPABASE_URL?: string;
  HIDDEN_SANDBOX_PREVIEW_ENABLED?: string;
  openlup_ENVIRONMENT?: string;
  STAGING_SUPABASE_PROJECT_REF?: string;
  HIDDEN_SANDBOX_SUPABASE_PROJECT_REF?: string;
};
type BindingResolver = (env: Env) => PromotionClaimsBindingResolution;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const result = await runPromotionClaimSweepCron(req);
  if (result.headers?.allow) res.setHeader("Allow", result.headers.allow);
  res.status(result.status).json(result.body);
}

export async function runPromotionClaimSweepCron(
  req: VercelRequest,
  env: Env = process.env,
  bindingResolver: BindingResolver = resolvePromotionClaimsBinding,
  now: () => string = () => new Date().toISOString(),
): Promise<{ status: number; body: Record<string, unknown>; headers?: { allow?: string } }> {
  // GET is what Vercel Cron sends in production. POST is what the staging
  // pg_cron bridge sends: its invoker calls `net.http_post`, which is also the
  // only pg_net verb that can carry the JSON body the other three bridges send.
  // Until 2026-08-31 the Supabase Edge wrapper in front of this route converted
  // that POST into a GET; the retarget removed the wrapper and this route began
  // answering the bridge with 405. Accepting both makes it match
  // outbox-dispatch, omnipack-stock-sync and omnipack-reconciliation, which have
  // always accepted either. The method check stays above CRON_SECRET and the
  // bearer comparison, so POST reaches nothing GET could not already reach.
  if (req.method !== "GET" && req.method !== "POST") {
    return { status: 405, headers: { allow: "GET, POST" }, body: { ok: false, error: "method_not_allowed" } };
  }
  if (!env.CRON_SECRET) {
    return { status: 503, body: { ok: false, error: "cron_secret_required" } };
  }
  if (req.headers.authorization !== `Bearer ${env.CRON_SECRET}`) {
    return { status: 401, body: { ok: false, error: "unauthorized" } };
  }
  const driver = readPromotionClaimSweepDriver(req, env);
  if (!driver.ok) return { status: driver.status, body: driver.body };
  return runPromotionClaimSweepOnce({
    env,
    invocation: { triggerKind: "scheduler", invocationSource: driver.driver },
    now,
    resolveBinding: bindingResolver,
  });
}

function readPromotionClaimSweepDriver(
  req: VercelRequest,
  env: Env,
): { ok: true; driver: "vercel_cron" | "pg_cron" } | {
  ok: false;
  status: number;
  body: Record<string, unknown>;
} {
  const raw = req.headers["x-openlup-scheduler-driver"];
  const requested = (Array.isArray(raw) ? raw[0] : raw) ?? "vercel_cron";
  if (requested !== "vercel_cron" && requested !== "pg_cron") {
    return { ok: false, status: 400, body: { ok: false, error: "invalid_promotion_claim_sweep_driver" } };
  }
  if (requested === "pg_cron" && !isStagingRuntime(env)) {
    return { ok: false, status: 403, body: { ok: false, error: "pg_cron_driver_requires_staging" } };
  }
  return { ok: true, driver: requested };
}

function isStagingRuntime(env: Env): boolean {
  return env.HIDDEN_SANDBOX_PREVIEW_ENABLED === "true" ||
    env.openlup_ENVIRONMENT === "staging" ||
    env.STAGING_SUPABASE_PROJECT_REF === "abcdefghijklmnopqrst" ||
    env.HIDDEN_SANDBOX_SUPABASE_PROJECT_REF === "abcdefghijklmnopqrst";
}
