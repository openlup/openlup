import type { VercelRequest, VercelResponse } from "../../server/_lib/types/vercel.js";
import { createSupabaseDataGateway } from "../../server/adapters/supabase/dataGateway.js";
import {
  readSupabaseDataGatewayEnv,
  type SupabaseDataGatewayEnv,
} from "../../server/adapters/supabase/dataGatewayClientFactory.js";
import { createSupabasePaymentEventSweepPort } from "../../server/adapters/supabase/commerce/paymentEventSweep.js";
import { resolveSweepConfig } from "../../server/_lib/sweeps/sweepConfig.js";
import type { DataGatewayPort } from "../../src/domains/platform-runtime/ports.js";
import { claimJobRun, finishJobRun } from "../_cron/platformJobRunner.js";

export const config = { maxDuration: 60 };

const BATCH_LIMIT = 200;
const JOB_NAME = "commerce-payment-event-sweep";

type Env = Record<string, string | undefined> & {
  CRON_SECRET?: string;
  COMMERCE_PAYMENT_EVENT_SWEEP_ENABLED?: string;
  COMMERCE_PAYMENT_EVENT_SWEEP_GRACE_MINUTES?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_URL?: string;
  VITE_SUPABASE_URL?: string;
};

type GatewayFactory = (env: SupabaseDataGatewayEnv) => DataGatewayPort;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const result = await runCommercePaymentEventSweepCron(req, process.env, createSupabaseDataGateway);
  if (result.headers?.allow) res.setHeader("Allow", result.headers.allow);
  res.status(result.status).json(result.body);
}

export async function runCommercePaymentEventSweepCron(
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
  if (!sweep.paymentEvent.enabled) {
    return { status: 200, body: { ok: true, skipped: "sweep_disabled", eventsIgnored: 0 } };
  }

  const gatewayEnv = readSupabaseDataGatewayEnv(env);
  if (!gatewayEnv) {
    return { status: 503, body: { ok: false, error: "supabase_env_missing" } };
  }

  return gatewayFactory(gatewayEnv).asService(async (client) => {
    const lease = await claimJobRun(client as never, JOB_NAME, "vercel_cron", 10 * 60);
    if (!lease.acquired || !lease.runId) {
      return { status: 200, body: { ok: true, skipped: true, reason: lease.reason } };
    }

    const now = new Date().toISOString();
    const grace = sweep.paymentEvent.graceMinutes;

    try {
      const { eventsIgnored, staleSetupReceived } = await createSupabasePaymentEventSweepPort(client as never).sweep({
        now,
        graceMinutes: grace,
        limit: BATCH_LIMIT,
      });
      if (staleSetupReceived > 0) {
        // Non-paging anomaly: an aged setup.* event whose webhook pipeline
        // never completed (see the Supabase payment-event sweep adapter).
        console.error("[cron/commerce-payment-event-sweep] stale received setup events", {
          staleSetupReceived,
          graceMinutes: grace,
        });
      }
      await finishJobRun(client as never, JOB_NAME, lease.runId, "success", {
        checked: eventsIgnored,
        updated: eventsIgnored,
        failures: 0,
        skipped: false,
      }, { driver: "vercel_cron", eventsIgnored, staleSetupReceived });

      return { status: 200, body: { ok: true, graceMinutes: grace, eventsIgnored, staleSetupReceived } };
    } catch (unexpected) {
      const reason = safeMessage(unexpected);
      console.error("[cron/commerce-payment-event-sweep] unexpected error", { reason });
      await finishJobRun(client as never, JOB_NAME, lease.runId, "failed", {
        checked: 0,
        updated: 0,
        failures: 1,
        skipped: false,
        reason,
      }, { driver: "vercel_cron" });
      return { status: 500, body: { ok: false, error: unexpected instanceof Error ? "rpc_failed" : "unexpected_error" } };
    }
  });
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240);
}
