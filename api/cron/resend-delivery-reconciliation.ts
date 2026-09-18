import type { VercelRequest, VercelResponse } from "../../server/_lib/types/vercel.js";
import { createSupabaseDataGateway } from "../../server/adapters/supabase/dataGateway.js";
import {
  readSupabaseDataGatewayEnv,
  type SupabaseDataGatewayEnv,
} from "../../server/adapters/supabase/dataGatewayClientFactory.js";
import { runResendDeliveryReconciliation } from "../../server/domains/communications/resendDeliveryReconciliationWorker.js";
import { getResendEmail } from "../../server/infra/resend/resendEmailClient.js";
import { resolveResendApiKey } from "../../server/infra/resend/resendApiKey.js";
import { createSupabaseResendDeliveryReconciliationPort } from "../../server/adapters/supabase/communications/resendDeliveryReconciliation.js";
import type { DataGatewayPort } from "../../src/domains/platform-runtime/ports.js";
import { claimJobRun, finishJobRun } from "../_cron/platformJobRunner.js";

export const config = { maxDuration: 60 };

const BATCH_LIMIT = 50;
// Match the email_webhook_gap detector's 30min grace, plus margin so the
// poller never races a slow-but-arriving webhook.
const GRACE_MINUTES = 45;
const JOB_NAME = "resend-delivery-reconciliation";

type Env = Record<string, string | undefined> & {
  CRON_SECRET?: string;
  COMMERCE_RESEND_DELIVERY_RECONCILIATION_ENABLED?: string;
  RESEND_API_KEY?: string;
  RESEND_PROVIDER_MODE?: string;
  RESEND_SANDBOX_API_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_URL?: string;
  VITE_SUPABASE_URL?: string;
};

type GatewayFactory = (env: SupabaseDataGatewayEnv) => DataGatewayPort;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const result = await runResendDeliveryReconciliationCron(req, process.env, createSupabaseDataGateway);
  if (result.headers?.allow) res.setHeader("Allow", result.headers.allow);
  res.status(result.status).json(result.body);
}

export async function runResendDeliveryReconciliationCron(
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

  if (env.COMMERCE_RESEND_DELIVERY_RECONCILIATION_ENABLED !== "true") {
    return { status: 200, body: { ok: true, skipped: "resend_delivery_reconciliation_disabled" } };
  }
  // Resolve the key per provider mode so staging (RESEND_PROVIDER_MODE=sandbox +
  // RESEND_SANDBOX_API_KEY; RESEND_API_KEY forbidden by hiddenSandboxPreviewGuard)
  // polls with the SAME account the message was sent with. Every sibling email
  // cron uses this resolver; this poller was the only one reading the key directly.
  const { apiKey } = resolveResendApiKey(env);
  if (!apiKey) {
    return { status: 503, body: { ok: false, error: "resend_api_key_required" } };
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
    try {
      const result = await runResendDeliveryReconciliation({
        port: createSupabaseResendDeliveryReconciliationPort(client as never),
        readEmail: (resendId) => getResendEmail({ apiKey, resendId }),
        now,
        graceMinutes: GRACE_MINUTES,
        limit: BATCH_LIMIT,
      });
      await finishJobRun(client as never, JOB_NAME, lease.runId, "success", {
        checked: result.checked,
        updated: result.reconciled,
        failures: result.failures,
        skipped: false,
      }, {
        driver: "vercel_cron",
        stillPending: result.stillPending,
        terminalPolled: result.terminalPolled,
        // Bounded diagnostics: which failure class dominates (404 stale ids vs
        // 401/403 wrong key vs 5xx/network outage) and how many un-pollable sends
        // were given up this run.
        failureBreakdown: result.failureBreakdown,
        abandoned: result.abandoned,
      });
      return { status: 200, body: { ok: true, graceMinutes: GRACE_MINUTES, ...result } };
    } catch (unexpected) {
      const reason = unexpected instanceof Error ? unexpected.message.slice(0, 200) : "unexpected_error";
      console.error("[cron/resend-delivery-reconciliation] unexpected error", { reason });
      await finishJobRun(client as never, JOB_NAME, lease.runId, "failed", {
        checked: 0,
        updated: 0,
        failures: 1,
        skipped: false,
        reason,
      }, { driver: "vercel_cron" });
      return { status: 500, body: { ok: false, error: "reconciliation_failed" } };
    }
  });
}
