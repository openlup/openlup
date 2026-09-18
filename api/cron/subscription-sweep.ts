import type { VercelRequest, VercelResponse } from "../../server/_lib/types/vercel.js";
import { createSupabaseDataGateway } from "../../server/adapters/supabase/dataGateway.js";
import {
  readSupabaseDataGatewayEnv,
  type SupabaseDataGatewayEnv,
} from "../../server/adapters/supabase/dataGatewayClientFactory.js";
import { createManagedSubscriptionSweepPort } from "../../server/adapters/managed/subscription/subscriptionSweepPort.js";
import type { DataGatewayPort } from "../../src/domains/platform-runtime/ports.js";
import { resolveSweepConfig } from "../../server/_lib/sweeps/sweepConfig.js";
import { claimJobRun, finishJobRun } from "../_cron/platformJobRunner.js";

export const config = { maxDuration: 60 };

const BATCH_LIMIT = 50;
const JOB_NAME = "subscription-activation-sweep-runtime";

type Env = Record<string, string | undefined>;
type GatewayFactory = (env: SupabaseDataGatewayEnv) => DataGatewayPort;

/**
 * Provisional-subscription abandonment sweeper (Model B A4).
 *
 * - Authenticates via `Authorization: Bearer ${CRON_SECRET}` (required, fail-closed).
 * - Fail-closed behind `COMMERCE_SUBSCRIPTION_SWEEP_ENABLED` so the schedule can be
 *   active while the wave is inert.
 * - Claims a `platform_job_runs` lease before any work; releases it `success`/`failed`
 *   with checked/updated counts so the observability evaluator detects missed runs.
 * - Delegates to `subscription_sweep_unpaid_provisional`, which atomically reaps each
 *   `pending_activation` subscription older than the on-session payment window:
 *   terminalizes the intent (closing the late-success race), releases the inventory
 *   hold, cancels the order/cycle, and sweeps the subscription to `cancelled`.
 * - Orders that already settled to paid (incl. awaiting_mandate) are never swept.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const result = await runSubscriptionSweepCron(req, process.env, createSupabaseDataGateway);
  if (result.headers?.allow) res.setHeader("Allow", result.headers.allow);
  res.status(result.status).json(result.body);
}

export async function runSubscriptionSweepCron(
  req: VercelRequest,
  env: Env = process.env,
  gatewayFactory: GatewayFactory = createSupabaseDataGateway,
): Promise<{ status: number; body: Record<string, unknown>; headers?: { allow?: string } }> {
  if (req.method !== "POST" && req.method !== "GET") {
    return { status: 405, headers: { allow: "GET, POST" }, body: { ok: false, error: "method_not_allowed" } };
  }

  const expected = env.CRON_SECRET;
  if (!expected) {
    return { status: 503, body: { ok: false, error: "cron_secret_required" } };
  }
  if (req.headers.authorization !== `Bearer ${expected}`) {
    return { status: 401, body: { ok: false, error: "unauthorized" } };
  }

  const sweep = resolveSweepConfig(env);
  if (!sweep.subscriptionActivation.enabled) {
    return { status: 200, body: { ok: true, skipped: "sweep_disabled", scanned: 0, swept: 0 } };
  }

  const gatewayEnv = readSupabaseDataGatewayEnv(env);
  if (!gatewayEnv) {
    return { status: 503, body: { ok: false, error: "supabase_env_missing" } };
  }

  return gatewayFactory(gatewayEnv).asService(async (client) => {
    const lease = await claimJobRun(client as never, JOB_NAME, "vercel_cron");
    if (!lease.acquired || !lease.runId) {
      return { status: 200, body: { ok: true, skipped: true, reason: lease.reason } };
    }

    const olderThan = new Date(Date.now() - sweep.subscriptionActivation.windowMinutes * 60_000).toISOString();

    try {
      const swept = await createManagedSubscriptionSweepPort(client as never).sweep({
        olderThan,
        limit: BATCH_LIMIT,
      });
      await finishJobRun(client as never, JOB_NAME, lease.runId, "success", {
        checked: swept.length,
        updated: swept.length,
        failures: 0,
        skipped: false,
      });

      return {
        status: 200,
        body: { ok: true, windowMinutes: sweep.subscriptionActivation.windowMinutes, swept: swept.length, subscriptions: swept },
      };
    } catch (unexpected) {
      const reason = unexpected instanceof Error ? unexpected.message.slice(0, 240) : String(unexpected);
      console.error("[cron/subscription-sweep] unexpected error", { reason });
      await finishJobRun(client as never, JOB_NAME, lease.runId, "failed", {
        checked: 0,
        updated: 0,
        failures: 1,
        skipped: false,
        reason,
      });
      return { status: 500, body: { ok: false, error: reason.startsWith("rpc_sweep:") ? "rpc_failed" : "unexpected_error" } };
    }
  });
}
