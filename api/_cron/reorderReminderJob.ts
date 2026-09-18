// Reorder-reminder cron. Mirrors the abandoned-cart / outbox-dispatch cron
// contract: bearer CRON_SECRET, env kill-switch BEFORE any client work,
// service-role client, platform job lease (claim/finish). This job does ONE
// thing — call enqueue_reorder_reminders(p_limit) which inserts the reorder
// reminder outbox_events for one-time orders delivered ~30 days ago whose
// customer hasn't reordered or subscribed. The existing outbox dispatcher + the
// reorder-reminder handler do the consent gate, render, and send. No Resend key
// needed here.

import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import { createSupabaseDataGateway } from "../../server/adapters/supabase/dataGateway.js";
import {
  readSupabaseDataGatewayEnv,
  type SupabaseDataGatewayEnv,
} from "../../server/adapters/supabase/dataGatewayClientFactory.js";
import { createSupabaseReorderReminderEnqueuePort } from "../../server/adapters/supabase/commerce/reorderReminderEnqueue.js";
import { resolveBundleId } from "../../server/domains/platform-runtime/platformKernel.js";
import { resolveSubscriberRetentionMessagingBinding } from "../../server/runtime/subscription/subscriberRetentionMessagingBinding.js";
import type { DataGatewayPort } from "../../src/domains/platform-runtime/ports.js";
import { claimJobRun, finishJobRun } from "./platformJobRunner.js";

type Env = Record<string, string | undefined> & {
  CRON_SECRET?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_URL?: string;
  VITE_SUPABASE_URL?: string;
  COMMERCE_REORDER_REMINDER_ENABLED?: string;
  DATABASE_URL?: string;
  PLATFORM_BUNDLE?: string;
};

type GatewayFactory = (env: SupabaseDataGatewayEnv) => DataGatewayPort;

export const REORDER_REMINDER_JOB_NAME = "reorder-reminder";

// Short lease so a crashed run mutes the job for <= 2 minutes, not the runner
// default 900s (the cron runs daily, but the lease still bounds re-claim).
const JOB_LEASE_SECONDS = 120;
const ENQUEUE_LIMIT = 200;

function bearerToken(req: VercelRequest): string | null {
  const auth = req.headers.authorization;
  const header = Array.isArray(auth) ? auth[0] : auth;
  return header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 180);
}

export async function runReorderReminderCron(
  req: VercelRequest,
  env: Env = process.env,
  gatewayFactory: GatewayFactory = createSupabaseDataGateway,
  retentionBindingResolver: typeof resolveSubscriberRetentionMessagingBinding = resolveSubscriberRetentionMessagingBinding,
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
  if (env.COMMERCE_REORDER_REMINDER_ENABLED !== "true") {
    return {
      status: 200,
      body: { ok: true, skipped: true, reason: "reorder_reminder_disabled" },
    };
  }

  if (resolveBundleId(env) === "node-postgres") {
    const resolved = retentionBindingResolver(env);
    if (!resolved.binding) return { status: 503, body: { ok: false, error: resolved.error } };
    const result = await resolved.binding.run((messaging) => messaging.planAndDispatch("reorder_reminder", ENQUEUE_LIMIT));
    return { status: result.ok ? 200 : 502, body: { ...result, kind: "reorder_reminder" } };
  }

  const gatewayEnv = readSupabaseDataGatewayEnv(env);
  if (!gatewayEnv) {
    return { status: 503, body: { ok: false, error: "supabase_env_required" } };
  }

  return gatewayFactory(gatewayEnv).asService(async (client) => {
    const lease = await claimJobRun(
      client as never,
      REORDER_REMINDER_JOB_NAME,
      "vercel_cron",
      JOB_LEASE_SECONDS,
    );
    if (!lease.acquired || !lease.runId) {
      return { status: 200, body: { ok: true, skipped: true, reason: lease.reason, run_id: lease.runId } };
    }

    let ok = true;
    let reason: string | undefined;
    let result = { enqueued: 0 };
    try {
      result = await createSupabaseReorderReminderEnqueuePort(client as never).enqueue(ENQUEUE_LIMIT);
    } catch (error) {
      ok = false;
      reason = safeMessage(error);
    }

    try {
      await finishJobRun(
        client as never,
        REORDER_REMINDER_JOB_NAME,
        lease.runId,
        ok ? "success" : "failed",
        { checked: result.enqueued, updated: result.enqueued, failures: ok ? 0 : 1, skipped: false, reason },
        { driver: "vercel_cron", enqueued: result.enqueued },
      );
    } catch (error) {
      console.error("[reorder-reminder] finish_job_run_failed", safeMessage(error));
    }

    return {
      status: ok ? 200 : 502,
      body: {
        ok,
        enqueued: result.enqueued,
        ...(reason ? { reason } : {}),
      },
    };
  });
}
