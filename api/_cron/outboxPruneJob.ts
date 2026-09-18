import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import { createSupabaseDataGateway } from "../../server/adapters/supabase/dataGateway.js";
import {
  claimCheckoutRecoveryOperationsRun,
  finishCheckoutRecoveryOperationsRun,
  resolveCheckoutRecoveryOperationsBinding,
  type CheckoutRecoveryOperationsGatewayFactory as GatewayFactory,
} from "../../server/runtime/commerce/checkoutRecoveryOperationsBinding.js";
import { claimJobRun, finishJobRun } from "./platformJobRunner.js";
import type { PlatformJobInvocation } from "../../server/domains/platform/platformJobRunLedger.js";

type Env = Record<string, string | undefined> & {
  CRON_SECRET?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_URL?: string;
  VITE_SUPABASE_URL?: string;
  COMMERCE_OUTBOX_PRUNE_ENABLED?: string;
};

export const OUTBOX_PRUNE_JOB_NAME = "outbox-prune";

const JOB_LEASE_SECONDS = 300;
const PRUNE_LIMIT = 500;
const VERCEL_INVOCATION = { triggerKind: "scheduler", invocationSource: "vercel_cron" } as const;

function bearerToken(req: VercelRequest): string | null {
  const auth = req.headers.authorization;
  const header = Array.isArray(auth) ? auth[0] : auth;
  return header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 180);
}

export async function runOutboxPruneCron(
  req: VercelRequest,
  env: Env = process.env,
  gatewayFactory: GatewayFactory = createSupabaseDataGateway,
  invocation: PlatformJobInvocation = VERCEL_INVOCATION,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (req.method !== "GET" && req.method !== "POST") {
    return { status: 405, body: { ok: false, error: "method_not_allowed" } };
  }
  if (!env.CRON_SECRET) {
    return { status: 503, body: { ok: false, error: "cron_secret_required" } };
  }
  if (bearerToken(req) !== env.CRON_SECRET) {
    return { status: 401, body: { ok: false, error: "unauthorized" } };
  }
  if (env.COMMERCE_OUTBOX_PRUNE_ENABLED !== "true") {
    return { status: 200, body: { ok: true, skipped: true, reason: "outbox_prune_disabled" } };
  }

  const resolved = resolveCheckoutRecoveryOperationsBinding(env, { gatewayFactory });
  if (!resolved.binding) return { status: 503, body: { ok: false, error: resolved.error } };

  return resolved.binding.run(async (context) => {
    const lease = await claimCheckoutRecoveryOperationsRun(
      context,
      OUTBOX_PRUNE_JOB_NAME,
      invocation,
      JOB_LEASE_SECONDS,
      (client, name, driver, seconds) => claimJobRun(client, name, driver, seconds),
    );
    if (!lease.acquired || !lease.runId) {
      return { status: 200, body: { ok: true, skipped: true, reason: lease.reason, run_id: lease.runId } };
    }

    let ok = true;
    let reason: string | undefined;
    let result = { compacted: 0, processed: 0, discarded: 0 };
    let deliveries = { staleDeleted: 0, orphanDeleted: 0 };
    try {
      result = await context.outboxPrune.pruneOutbox(PRUNE_LIMIT);
    } catch (error) {
      ok = false;
      reason = safeMessage(error);
    }

    // The managed bundle also compacts its private customer email-delivery
    // timeline. The public bundle has no such private adjunct. Best-effort: an
    // adjunct failure is logged but does not fail terminal outbox compaction.
    if (context.deliveryPrune) {
      try {
        const deliveriesOutcome = await context.deliveryPrune.pruneDeliveries(PRUNE_LIMIT);
        if (deliveriesOutcome.ok === true) {
          deliveries = deliveriesOutcome.result;
        } else {
          console.error("[outbox-prune] deliveries_prune_failed", deliveriesOutcome.message);
        }
      } catch (error) {
        console.error("[outbox-prune] deliveries_prune_threw", safeMessage(error));
      }
    }

    try {
      await finishCheckoutRecoveryOperationsRun(
        context,
        OUTBOX_PRUNE_JOB_NAME,
        lease.runId,
        invocation,
        ok ? "success" : "failed",
        { checked: result.compacted, updated: result.compacted, failures: ok ? 0 : 1, skipped: false, reason },
        { driver: invocation.invocationSource, ...result, ...deliveries },
        (client, name, runId, status, summary, metadata) =>
          finishJobRun(client, name, runId, status, summary, metadata),
      );
    } catch (error) {
      console.error("[outbox-prune] finish_job_run_failed", safeMessage(error));
    }

    return {
      status: ok ? 200 : 502,
      body: { ok, ...result, ...deliveries, ...(reason ? { reason } : {}) },
    };
  });
}
