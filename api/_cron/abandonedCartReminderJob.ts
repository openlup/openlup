// Abandoned-cart reminder cron. Mirrors the outbox-dispatch / renewal-reminder
// cron contract: bearer CRON_SECRET, env kill-switch BEFORE any persistence
// work, and a platform job lease (claim/finish). This job does ONE thing — ask
// the active bundle's checkout-recovery port to insert reminder outbox_events.
// The existing outbox dispatcher and handlers do the consent gate, render, and
// send. No provider key is needed here.

import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import {
  type AbandonedCartReminderEnqueueResult,
} from "../../server/domains/commerce/checkoutRecoveryOperations.js";
import {
  claimCheckoutRecoveryOperationsRun,
  finishCheckoutRecoveryOperationsRun,
  resolveCheckoutRecoveryOperationsBinding,
  type CheckoutRecoveryOperationsGatewayFactory as GatewayFactory,
} from "../../server/runtime/commerce/checkoutRecoveryOperationsBinding.js";
import { createSupabaseDataGateway } from "../../server/adapters/supabase/dataGateway.js";
import { claimJobRun, finishJobRun } from "./platformJobRunner.js";
import type { PlatformJobInvocation } from "../../server/domains/platform/platformJobRunLedger.js";

type Env = Record<string, string | undefined> & {
  CRON_SECRET?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_URL?: string;
  VITE_SUPABASE_URL?: string;
  VERCEL_ENV?: string;
  COMMERCE_ABANDONED_CART_ENABLED?: string;
};

export const ABANDONED_CART_REMINDER_JOB_NAME = "abandoned-cart-reminder";

// Short lease so a crashed run mutes the job for <= 2 minutes, not the runner
// default 900s (the cron runs every 30 min, but the lease still bounds re-claim).
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

function isProductionVercelRuntime(env: Env): boolean {
  return env.VERCEL_ENV === "production";
}

export async function runAbandonedCartReminderCron(
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

  // Env kill-switch exits before any client/ledger work so long-duration
  // disables stay silent (zero platform_job_runs writes).
  if (env.COMMERCE_ABANDONED_CART_ENABLED !== "true") {
    return {
      status: 200,
      body: { ok: true, skipped: true, reason: "abandoned_cart_disabled" },
    };
  }

  const resolved = resolveCheckoutRecoveryOperationsBinding(env, { gatewayFactory });
  if (!resolved.binding) return { status: 503, body: { ok: false, error: resolved.error } };

  return resolved.binding.run(async (context) => {
    const lease = await claimCheckoutRecoveryOperationsRun(
      context,
      ABANDONED_CART_REMINDER_JOB_NAME,
      invocation,
      JOB_LEASE_SECONDS,
      (client, name, driver, seconds) => claimJobRun(client, name, driver, seconds),
    );
    if (!lease.acquired || !lease.runId) {
      return { status: 200, body: { ok: true, skipped: true, reason: lease.reason, run_id: lease.runId } };
    }

    let ok = true;
    let reason: string | undefined;
    let result: AbandonedCartReminderEnqueueResult = { enqueued1h: 0, enqueued24h: 0, enqueued72h: 0 };
    try {
      result = await context.abandonedReminders.enqueue(ENQUEUE_LIMIT, context.runtimeBaseUrl);
    } catch (error) {
      ok = false;
      reason = safeMessage(error);
    }

    const enqueued = result.enqueued1h + result.enqueued24h + result.enqueued72h;
    // The versioned enqueue RPC can short-circuit on the clone guard and still
    // return {ok:true, enqueued*:0} with no thrown error —
    // that must not look identical to "ran cleanly, nothing eligible" (CJ01-AB).
    const enqueueSkipped = result.skipped;
    // The only production scheduler identity is the CRON_SECRET-authenticated
    // Vercel invocation above. A request header must not downgrade a production
    // clone guard failure into a benign alternate-driver skip.
    const blockedByCloneGuard = enqueueSkipped === "clone_guard" && isProductionVercelRuntime(env);
    if (blockedByCloneGuard) {
      ok = false;
      reason = "clone_guard";
    }

    try {
      await finishCheckoutRecoveryOperationsRun(
        context,
        ABANDONED_CART_REMINDER_JOB_NAME,
        lease.runId,
        invocation,
        ok ? "success" : "failed",
        {
          checked: enqueued,
          updated: enqueued,
          failures: ok ? 0 : 1,
          skipped: Boolean(enqueueSkipped),
          reason: enqueueSkipped ?? reason,
        },
        {
          driver: invocation.invocationSource,
          enqueued1h: result.enqueued1h,
          enqueued24h: result.enqueued24h,
          enqueued72h: result.enqueued72h,
          ...(enqueueSkipped ? { skipped: enqueueSkipped } : {}),
          ...(blockedByCloneGuard ? { blocked: true, blockedReason: "clone_guard" } : {}),
        },
        (client, name, runId, status, summary, metadata) =>
          finishJobRun(client, name, runId, status, summary, metadata),
      );
    } catch (error) {
      console.error("[abandoned-cart-reminder] finish_job_run_failed", safeMessage(error));
    }

    return {
      status: blockedByCloneGuard ? 503 : ok ? 200 : 502,
      body: {
        ok,
        enqueued1h: result.enqueued1h,
        enqueued24h: result.enqueued24h,
        enqueued72h: result.enqueued72h,
        ...(blockedByCloneGuard ? { blocked: true } : {}),
        ...(enqueueSkipped ? { skipped: true, reason: enqueueSkipped } : {}),
        ...(!enqueueSkipped && reason ? { reason } : {}),
      },
    };
  });
}
