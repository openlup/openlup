import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import { createSupabaseDataGateway } from "../../server/adapters/supabase/dataGateway.js";
import {
  readSupabaseDataGatewayEnv,
  type SupabaseDataGatewayEnv,
} from "../../server/adapters/supabase/dataGatewayClientFactory.js";
import {
  runCommunicationSyncDispatchForProviders,
  type CommunicationSyncRunResult,
} from "../../server/domains/communications/communicationSyncWorker.js";
import { createNewsletterSyncProviderRegistry } from "../../server/domains/communications/newsletterProviderRegistry.js";
import { createSupabaseCommunicationSyncStore } from "../../server/adapters/supabase/communications/communicationSync.js";
import type { DataGatewayPort } from "../../src/domains/platform-runtime/ports.js";
import { claimJobRun, finishJobRun } from "./platformJobRunner.js";

type Env = Record<string, string | undefined> & {
  CRON_SECRET?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_URL?: string;
  VITE_SUPABASE_URL?: string;
  COMMUNICATION_SYNC_DISPATCH_ENABLED?: string;
};
type GatewayFactory = (env: SupabaseDataGatewayEnv) => DataGatewayPort;

export const COMMUNICATION_SYNC_DISPATCH_JOB_NAME = "communication-sync-dispatch";
const JOB_LEASE_SECONDS = 120;

export async function runCommunicationSyncDispatchCron(
  req: VercelRequest,
  env: Env = process.env,
  gatewayFactory: GatewayFactory = createSupabaseDataGateway,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (req.method !== "GET" && req.method !== "POST") {
    return { status: 405, body: { ok: false, error: "method_not_allowed" } };
  }
  if (!env.CRON_SECRET) return { status: 503, body: { ok: false, error: "cron_secret_required" } };
  if (bearerToken(req) !== env.CRON_SECRET) return { status: 401, body: { ok: false, error: "unauthorized" } };

  if (env.COMMUNICATION_SYNC_DISPATCH_ENABLED !== "true") {
    return {
      status: 200,
      body: { ok: true, skipped: true, reason: "communication_sync_dispatch_disabled", checked: 0, updated: 0, failures: 0 },
    };
  }

  const gatewayEnv = readSupabaseDataGatewayEnv(env);
  if (!gatewayEnv) {
    return { status: 503, body: { ok: false, error: "supabase_env_required" } };
  }

  return gatewayFactory(gatewayEnv).asService(async (client) => {
    const lease = await claimJobRun(client as never, COMMUNICATION_SYNC_DISPATCH_JOB_NAME, "vercel_cron", JOB_LEASE_SECONDS);
    if (!lease.acquired || !lease.runId) {
      return { status: 200, body: { ok: true, skipped: true, reason: lease.reason, run_id: lease.runId } };
    }

    const result = await runSafely(() =>
      runCommunicationSyncDispatchForProviders({
        store: createSupabaseCommunicationSyncStore(client as never),
        providers: createNewsletterSyncProviderRegistry(env),
      })
    );

    await finishSafely(client as never, lease.runId, result);
    return { status: result.ok ? 200 : 502, body: result as unknown as Record<string, unknown> };
  });
}

async function runSafely(
  operation: () => Promise<CommunicationSyncRunResult>,
): Promise<CommunicationSyncRunResult> {
  try {
    return await operation();
  } catch (error) {
    return {
      ok: false,
      checked: 0,
      updated: 0,
      failures: 1,
      skipped: false,
      reason: safeMessage(error),
      providerKind: "provider_registry",
      sent: 0,
      retried: 0,
      skippedEvents: 0,
    };
  }
}

async function finishSafely(
  client: Parameters<typeof finishJobRun>[0],
  runId: string,
  result: CommunicationSyncRunResult,
): Promise<void> {
  try {
    await finishJobRun(
      client,
      COMMUNICATION_SYNC_DISPATCH_JOB_NAME,
      runId,
      result.ok ? "success" : "failed",
      result,
      {
        driver: "vercel_cron",
        providerKind: result.providerKind,
        sent: result.sent,
        retried: result.retried,
        skippedEvents: result.skippedEvents,
      },
    );
  } catch (error) {
    console.error("[communication-sync-dispatch] finish_job_run_failed", safeMessage(error));
  }
}

function bearerToken(req: VercelRequest): string | null {
  const auth = req.headers.authorization;
  const header = Array.isArray(auth) ? auth[0] : auth;
  return header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 180);
}
