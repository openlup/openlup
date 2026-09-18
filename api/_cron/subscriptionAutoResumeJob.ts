import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import { authorizeCron } from "./authorizeCron.js";
import { createSupabaseDataGateway } from "../../server/adapters/supabase/dataGateway.js";
import {
  readSupabaseDataGatewayEnv,
  type SupabaseDataGatewayEnv,
} from "../../server/adapters/supabase/dataGatewayClientFactory.js";
import { createSupabaseSubscriptionAutoResumePort } from "../../server/adapters/supabase/subscription/subscriptionAutoResume.js";
import { resolveBundleId } from "../../server/domains/platform-runtime/platformKernel.js";
import { resolveSubscriberRetentionMessagingBinding } from "../../server/runtime/subscription/subscriberRetentionMessagingBinding.js";
import type { DataGatewayPort } from "../../src/domains/platform-runtime/ports.js";
import { claimJobRun, finishJobRun } from "./platformJobRunner.js";

type Env = Record<string, string | undefined> & {
  CRON_SECRET?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_URL?: string;
  VITE_SUPABASE_URL?: string;
  COMMERCE_SUBSCRIPTION_AUTO_RESUME_ENABLED?: string;
  DATABASE_URL?: string;
  PLATFORM_BUNDLE?: string;
};

type GatewayFactory = (env: SupabaseDataGatewayEnv) => DataGatewayPort;

export const SUBSCRIPTION_AUTO_RESUME_JOB_NAME = "subscription-auto-resume";

const JOB_LEASE_SECONDS = 120;
const BATCH_LIMIT = 100;
const RPC_NAME = "subscription_auto_resume_due";

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 180);
}

export async function runSubscriptionAutoResumeCron(
  req: VercelRequest,
  env: Env = process.env,
  gatewayFactory: GatewayFactory = createSupabaseDataGateway,
  retentionBindingResolver: typeof resolveSubscriberRetentionMessagingBinding = resolveSubscriberRetentionMessagingBinding,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const denied = authorizeCron(req, env);
  if (denied) return denied;

  if (env.COMMERCE_SUBSCRIPTION_AUTO_RESUME_ENABLED !== "true") {
    return {
      status: 200,
      body: { ok: true, skipped: true, reason: "subscription_auto_resume_disabled" },
    };
  }

  if (resolveBundleId(env) === "node-postgres") {
    const resolved = retentionBindingResolver(env);
    if (!resolved.binding) return { status: 503, body: { ok: false, error: resolved.error } };
    const result = await resolved.binding.run((messaging) => messaging.autoResumeDue(BATCH_LIMIT));
    return { status: result.ok ? 200 : 502, body: { ...result } };
  }

  const gatewayEnv = readSupabaseDataGatewayEnv(env);
  if (!gatewayEnv) {
    return { status: 503, body: { ok: false, error: "supabase_env_required" } };
  }

  return gatewayFactory(gatewayEnv).asService(async (client) => {
    const lease = await claimJobRun(
      client as never,
      SUBSCRIPTION_AUTO_RESUME_JOB_NAME,
      "vercel_cron",
      JOB_LEASE_SECONDS,
    );
    if (!lease.acquired || !lease.runId) {
      return { status: 200, body: { ok: true, skipped: true, reason: lease.reason, run_id: lease.runId } };
    }

    const result = await createSupabaseSubscriptionAutoResumePort(client as never).run(BATCH_LIMIT);
    const status = result.ok ? "success" : "failed";

    try {
      await finishJobRun(
        client as never,
        SUBSCRIPTION_AUTO_RESUME_JOB_NAME,
        lease.runId,
        status,
        {
          checked: result.scanned,
          updated: result.resumed,
          failures: result.failed,
          skipped: result.skipped === true || result.skippedRows > 0 || Boolean(result.reason),
          reason: result.reason || undefined,
        },
        {
          driver: "vercel_cron",
          resumed: result.resumed,
          skippedRows: result.skippedRows,
          rpc: RPC_NAME,
        },
      );
    } catch (error) {
      console.error("[subscription-auto-resume] finish_job_run_failed", safeMessage(error));
    }

    return { status: result.ok ? 200 : 502, body: { ...result } };
  });
}
