// Checkout-recovery reminder cron (W2). Mirrors the abandoned-cart cron contract:
// bearer CRON_SECRET, env kill-switch BEFORE any persistence work, and a
// platform job lease (claim/finish). It does ONE thing — ask the active bundle's
// port to mint a per-wave recovery token and enqueue reminder intents. The outbox
// dispatcher + the checkout-recovery email handler (W3) render and send.

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
  COMMERCE_CHECKOUT_RECOVERY_ENABLED?: string;
};

export const CHECKOUT_RECOVERY_DISPATCH_JOB_NAME = "checkout-recovery-dispatch";

const JOB_LEASE_SECONDS = 120;
const ENQUEUE_LIMIT = 200;
const VERCEL_INVOCATION = { triggerKind: "scheduler", invocationSource: "vercel_cron" } as const;

function bearerToken(req: VercelRequest): string | null {
  const auth = req.headers.authorization;
  const header = Array.isArray(auth) ? auth[0] : auth;
  return header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 180);
}

export async function runCheckoutRecoveryDispatchCron(
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

  // Env kill-switch exits before any client/ledger work.
  if (env.COMMERCE_CHECKOUT_RECOVERY_ENABLED !== "true") {
    return { status: 200, body: { ok: true, skipped: true, reason: "checkout_recovery_disabled" } };
  }

  const resolved = resolveCheckoutRecoveryOperationsBinding(env, { gatewayFactory });
  if (!resolved.binding) return { status: 503, body: { ok: false, error: resolved.error } };

  return resolved.binding.run(async (context) => {
    const lease = await claimCheckoutRecoveryOperationsRun(
      context,
      CHECKOUT_RECOVERY_DISPATCH_JOB_NAME,
      invocation,
      JOB_LEASE_SECONDS,
      (client, name, driver, seconds) => claimJobRun(client, name, driver, seconds),
    );
    if (!lease.acquired || !lease.runId) {
      return { status: 200, body: { ok: true, skipped: true, reason: lease.reason, run_id: lease.runId } };
    }

    let ok = true;
    let reason: string | undefined;
    let result = { enqueued1h: 0, enqueued20h: 0 };
    try {
      result = await context.recoveryReminders.enqueue(ENQUEUE_LIMIT);
    } catch (error) {
      ok = false;
      reason = safeMessage(error);
    }

    const enqueued = result.enqueued1h + result.enqueued20h;

    try {
      await finishCheckoutRecoveryOperationsRun(
        context,
        CHECKOUT_RECOVERY_DISPATCH_JOB_NAME,
        lease.runId,
        invocation,
        ok ? "success" : "failed",
        { checked: enqueued, updated: enqueued, failures: ok ? 0 : 1, skipped: false, reason },
        { driver: invocation.invocationSource, enqueued1h: result.enqueued1h, enqueued20h: result.enqueued20h },
        (client, name, runId, status, summary, metadata) =>
          finishJobRun(client, name, runId, status, summary, metadata),
      );
    } catch (error) {
      console.error("[checkout-recovery-dispatch] finish_job_run_failed", safeMessage(error));
    }

    return {
      status: ok ? 200 : 502,
      body: {
        ok,
        enqueued1h: result.enqueued1h,
        enqueued20h: result.enqueued20h,
        ...(reason ? { reason } : {}),
      },
    };
  });
}
