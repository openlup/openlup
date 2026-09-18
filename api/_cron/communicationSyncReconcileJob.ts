import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import { createSupabaseDataGateway } from "../../server/adapters/supabase/dataGateway.js";
import {
  readSupabaseDataGatewayEnv,
  type SupabaseDataGatewayEnv,
} from "../../server/adapters/supabase/dataGatewayClientFactory.js";
import { runCommunicationSyncReconcile } from "../../server/domains/communications/communicationSyncWorker.js";
import { createNewsletterSyncProviderRegistry } from "../../server/domains/communications/newsletterProviderRegistry.js";
import type { DataGatewayPort } from "../../src/domains/platform-runtime/ports.js";
import { claimJobRun, finishJobRun } from "./platformJobRunner.js";

type Env = Record<string, string | undefined> & {
  CRON_SECRET?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_URL?: string;
  VITE_SUPABASE_URL?: string;
  COMMUNICATION_SYNC_RECONCILE_ENABLED?: string;
};
type GatewayFactory = (env: SupabaseDataGatewayEnv) => DataGatewayPort;

export const COMMUNICATION_SYNC_RECONCILE_JOB_NAME = "communication-sync-reconcile";

export async function runCommunicationSyncReconcileCron(
  req: VercelRequest,
  env: Env = process.env,
  gatewayFactory: GatewayFactory = createSupabaseDataGateway,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (req.method !== "GET" && req.method !== "POST") {
    return { status: 405, body: { ok: false, error: "method_not_allowed" } };
  }
  if (!env.CRON_SECRET) return { status: 503, body: { ok: false, error: "cron_secret_required" } };
  if (bearerToken(req) !== env.CRON_SECRET) return { status: 401, body: { ok: false, error: "unauthorized" } };

  if (env.COMMUNICATION_SYNC_RECONCILE_ENABLED !== "true") {
    return {
      status: 200,
      body: { ok: true, skipped: true, reason: "communication_sync_reconcile_disabled", checked: 0, updated: 0, failures: 0 },
    };
  }

  const gatewayEnv = readSupabaseDataGatewayEnv(env);
  if (!gatewayEnv) {
    return { status: 503, body: { ok: false, error: "supabase_env_required" } };
  }

  return gatewayFactory(gatewayEnv).asService(async (client) => {
    const lease = await claimJobRun(client as never, COMMUNICATION_SYNC_RECONCILE_JOB_NAME, "vercel_cron", 300);
    if (!lease.acquired || !lease.runId) {
      return { status: 200, body: { ok: true, skipped: true, reason: lease.reason, run_id: lease.runId } };
    }

    const result = await runCommunicationSyncReconcile({
      providers: createNewsletterSyncProviderRegistry(env),
    });
    await finishJobRun(client as never, COMMUNICATION_SYNC_RECONCILE_JOB_NAME, lease.runId, "success", result, {
      driver: "vercel_cron",
      mode: "provider_neutral_noop",
    });

    return { status: 200, body: result as unknown as Record<string, unknown> };
  });
}

function bearerToken(req: VercelRequest): string | null {
  const auth = req.headers.authorization;
  const header = Array.isArray(auth) ? auth[0] : auth;
  return header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;
}
