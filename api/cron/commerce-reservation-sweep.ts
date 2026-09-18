import type { VercelRequest, VercelResponse } from "../../server/_lib/types/vercel.js";
import { createSupabaseDataGateway } from "../../server/adapters/supabase/dataGateway.js";
import {
  readSupabaseDataGatewayEnv,
  type SupabaseDataGatewayEnv,
} from "../../server/adapters/supabase/dataGatewayClientFactory.js";
import {
  createManagedReservationSweepPort,
  type ReservationSweepCounts,
} from "../../server/adapters/managed/commerce/reservationSweepPort.js";
import type { DataGatewayPort } from "../../src/domains/platform-runtime/ports.js";
import { resolveSweepConfig } from "../../server/_lib/sweeps/sweepConfig.js";
import { claimJobRun, finishJobRun } from "../_cron/platformJobRunner.js";

export const config = { maxDuration: 60 };

const BATCH_LIMIT = 50;
const JOB_NAME = "commerce-reservation-sweep";
const MANUAL_REPAIR_DRIVER = "manual_admin";

type Env = Record<string, string | undefined> & {
  CRON_SECRET?: string;
  COMMERCE_RESERVATION_SWEEP_ENABLED?: string;
  COMMERCE_CHECKOUT_RESERVATION_TTL_MINUTES?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_URL?: string;
  VITE_SUPABASE_URL?: string;
};

type GatewayFactory = (env: SupabaseDataGatewayEnv) => DataGatewayPort;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const result = await runCommerceReservationSweepCron(req, process.env, createSupabaseDataGateway);
  if (result.headers?.allow) res.setHeader("Allow", result.headers.allow);
  res.status(result.status).json(result.body);
}

export async function runCommerceReservationSweepCron(
  req: VercelRequest,
  env: Env = process.env,
  gatewayFactory: GatewayFactory = createSupabaseDataGateway,
): Promise<{ status: number; body: Record<string, unknown>; headers?: { allow?: string } }> {
  // This route is an operator repair surface. Vercel cron invokes routes with
  // GET, so POST-only makes the absence of an automatic scheduler enforceable.
  if (req.method !== "POST") {
    return { status: 405, headers: { allow: "POST" }, body: { ok: false, error: "method_not_allowed" } };
  }

  const expected = env.CRON_SECRET;
  if (!expected) {
    return { status: 503, body: { ok: false, error: "cron_secret_required" } };
  }
  if (req.headers.authorization !== `Bearer ${expected}`) {
    return { status: 401, body: { ok: false, error: "unauthorized" } };
  }

  const sweep = resolveSweepConfig(env);
  if (!sweep.reservation.enabled) {
    return { status: 200, body: { ok: true, skipped: "sweep_disabled", ...zeroCounts() } };
  }

  const gatewayEnv = readSupabaseDataGatewayEnv(env);
  if (!gatewayEnv) {
    return { status: 503, body: { ok: false, error: "supabase_env_missing" } };
  }

  return gatewayFactory(gatewayEnv).asService(async (client) => {
    const lease = await claimJobRun(client as never, JOB_NAME, MANUAL_REPAIR_DRIVER, 10 * 60);
    if (!lease.acquired || !lease.runId) {
      return { status: 200, body: { ok: true, skipped: true, reason: lease.reason } };
    }

    const now = new Date().toISOString();

    try {
      const port = createManagedReservationSweepPort(client as never);
      const counts = await port.sweep({
        now,
        limit: BATCH_LIMIT,
      });
      const retryCounts = await port.sweepRetryHolds({ now, limit: BATCH_LIMIT });
      await finishJobRun(client as never, JOB_NAME, lease.runId, "success", {
        checked: counts.ordersChecked + retryCounts.holdsChecked,
        updated: counts.ordersExpired + retryCounts.holdsReleased,
        failures: 0,
        skipped: false,
      }, {
        driver: MANUAL_REPAIR_DRIVER,
        invocationSource: "authenticated_manual_repair",
        reservationsReleased: counts.reservationsReleased,
        skippedPaid: counts.skippedPaid,
        skippedTerminal: counts.skippedTerminal,
        skippedSubscription: counts.skippedSubscription,
        retryHoldsReleased: retryCounts.holdsReleased,
        retryHoldsSkippedPaid: retryCounts.skippedPaid,
      });

      return {
        status: 200,
        body: { ok: true, windowMinutes: sweep.reservation.windowMinutes, ...counts, retrySweep: retryCounts },
      };
    } catch (unexpected) {
      const reason = safeMessage(unexpected);
      console.error("[cron/commerce-reservation-sweep] unexpected error", { reason });
      await finishJobRun(client as never, JOB_NAME, lease.runId, "failed", {
        checked: 0,
        updated: 0,
        failures: 1,
        skipped: false,
        reason,
      }, {
        driver: MANUAL_REPAIR_DRIVER,
        invocationSource: "authenticated_manual_repair",
      });
      return { status: 500, body: { ok: false, error: unexpected instanceof Error ? "rpc_failed" : "unexpected_error" } };
    }
  });
}

function zeroCounts(): ReservationSweepCounts {
  return {
    ordersChecked: 0,
    ordersExpired: 0,
    reservationsReleased: 0,
    skippedPaid: 0,
    skippedTerminal: 0,
    skippedSubscription: 0,
  };
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240);
}
