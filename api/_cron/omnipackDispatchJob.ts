import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import {
  readOmnipackDispatchBatchLimit,
  readOmnipackDispatchMode,
  runOmnipackDispatchWorker,
  type OmnipackDispatchJobResult,
} from "../../server/domains/fulfillment/omnipackDispatchWorker.js";
import {
  createSupabaseOmnipackCronGateway,
  type SupabaseOmnipackCronGateway,
} from "../../server/runtime/fulfillment/omnipackCronGateway.js";
import {
  createOmnipackClient,
  readOmnipackClientConfig,
  type OmnipackClient,
} from "../../server/infra/omnipack/client.js";
import { readOmnipackDispatchReadiness } from "./outboxFulfillmentProvider.js";

type Env = Record<string, string | undefined> & {
  CRON_SECRET?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_URL?: string;
  VITE_SUPABASE_URL?: string;
};

export const OMNIPACK_DISPATCH_JOB_NAME = "omnipack-dispatch";

export async function runOmnipackDispatchCron(
  req: VercelRequest,
  env: Env = process.env,
  gatewayFactory: (env: Env) => SupabaseOmnipackCronGateway | null = createSupabaseOmnipackCronGateway,
  providerFactory: (env: Env) => OmnipackClient | null = createProviderClient,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (req.method !== "GET" && req.method !== "POST") {
    return { status: 405, body: { ok: false, error: "method_not_allowed" } };
  }
  if (!env.CRON_SECRET) return { status: 500, body: { ok: false, error: "cron_secret_not_configured" } };
  if (bearerToken(req) !== env.CRON_SECRET) return { status: 401, body: { ok: false, error: "unauthorized" } };

  if (env.COMMERCE_OMNIPACK_DISPATCH_ENABLED !== "true") {
    return {
      status: 200,
      body: { ok: true, skipped: true, reason: "omnipack_dispatch_disabled", checked: 0, updated: 0, failures: 0 },
    };
  }

  // Provider-I/O readiness is owned here: live destination checks and controlled
  // stage-batch limits apply to the sole external writer. The paid-event bridge
  // records its local obligation independently of provider credentials or flags.
  const readiness = readOmnipackDispatchReadiness(env);
  if (!readiness.ok) {
    return {
      status: 200,
      body: { ok: true, skipped: true, reason: readiness.error, checked: 0, updated: 0, failures: 0 },
    };
  }

  const gateway = gatewayFactory(env);
  if (!gateway) {
    return { status: 500, body: { ok: false, error: "supabase_service_role_not_configured" } };
  }

  const mode = readOmnipackDispatchMode(env);
  const providerClient = mode === "shadow" ? null : providerFactory(env);
  if (mode !== "shadow" && !providerClient) {
    return { status: 503, body: { ok: false, error: "omnipack_provider_not_configured", mode } };
  }

  const run = await gateway.runJob({
    jobName: OMNIPACK_DISPATCH_JOB_NAME,
    operation: ({ dispatch }) =>
      runSafely(mode, async () =>
        runOmnipackDispatchWorker({
          port: dispatch,
          providerClient,
          config: {
            mode,
            batchLimit: readOmnipackDispatchBatchLimit(env),
          },
        })
      ),
    finish: (result) => ({
      status: result.ok ? "success" : "failed",
      result: {
        checked: result.checked,
        updated: result.updated,
        failures: result.failures,
        skipped: result.skipped,
        reason: result.reason,
      },
    }),
  });
  if (!run.acquired) {
    return { status: 200, body: { ok: true, skipped: true, reason: run.reason } };
  }

  const result = run.result;
  return {
    status: result.ok ? 200 : 502,
    body: result as unknown as Record<string, unknown>,
  };
}

function createProviderClient(env: Env): OmnipackClient | null {
  const config = readOmnipackClientConfig(env);
  return config ? createOmnipackClient(config) : null;
}

async function runSafely(
  mode: OmnipackDispatchJobResult["mode"],
  operation: () => Promise<OmnipackDispatchJobResult>,
): Promise<OmnipackDispatchJobResult> {
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
      mode,
      replayed: 0,
      providerCalls: 0,
      readBacks: 0,
    };
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
