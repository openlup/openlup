import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import {
  runOmnipackProductSyncWorker,
  type OmnipackProductSyncProvider,
  type OmnipackProductSyncResult,
} from "../../server/domains/fulfillment/omnipackProductSyncWorker.js";
import {
  createSupabaseOmnipackCronGateway,
  type SupabaseOmnipackCronGateway,
} from "../../server/runtime/fulfillment/omnipackCronGateway.js";
import {
  createOmnipackClient,
  readOmnipackClientConfig,
  type OmnipackClient,
} from "../../server/infra/omnipack/client.js";

type Env = Record<string, string | undefined> & {
  CRON_SECRET?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_URL?: string;
  VITE_SUPABASE_URL?: string;
};

export const OMNIPACK_PRODUCT_SYNC_JOB_NAME = "omnipack-product-sync";

// PRODUCT SYNC IS PULL-ONLY ON THE CRON. The scheduled job only pulls (provider→us): it is
// read-only toward the provider (getStock + getProduct) and writes solely to our catalog_sku_eans +
// reconciliation evidence. It NEVER writes back — registering products/packs (the push) is
// a deliberate, operator-run action via scripts/omnipack-e2e/seedCatalog.ts (--execute --confirm).
// This keeps the provider the undisputed stock/owner oracle: no automated write ever leaves our side.

export async function runOmnipackProductSyncCron(
  req: VercelRequest,
  env: Env = process.env,
  gatewayFactory: (env: Env) => SupabaseOmnipackCronGateway | null = createSupabaseOmnipackCronGateway,
  providerOverride?: OmnipackProductSyncProvider,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (req.method !== "GET" && req.method !== "POST") {
    return { status: 405, body: { ok: false, error: "method_not_allowed" } };
  }
  if (!env.CRON_SECRET) return { status: 500, body: { ok: false, error: "cron_secret_not_configured" } };
  if (bearerToken(req) !== env.CRON_SECRET) return { status: 401, body: { ok: false, error: "unauthorized" } };

  if (env.COMMERCE_OMNIPACK_PRODUCT_SYNC_ENABLED !== "true") {
    return { status: 200, body: { ok: true, skipped: true, reason: "omnipack_product_sync_disabled", pushedPacks: 0, pulledSkus: 0, reconciliations: 0, failures: 0 } };
  }

  const omnipackConfig = providerOverride ? null : readOmnipackClientConfig(env);
  if (!providerOverride && !omnipackConfig) return { status: 503, body: { ok: false, error: "omnipack_provider_not_configured" } };

  const gateway = gatewayFactory(env);
  if (!gateway) {
    return { status: 500, body: { ok: false, error: "supabase_service_role_not_configured" } };
  }

  const provider = providerOverride ?? createProvider(createOmnipackClient(omnipackConfig!));

  // Pull-only: read OmniPack + write our side. The push (product/pack registration) is the
  // operator-run seed, never the cron — see the header note.
  const run = await gateway.runJob({
    jobName: OMNIPACK_PRODUCT_SYNC_JOB_NAME,
    operation: ({ productSync }) => runSafely(() => runOmnipackProductSyncWorker({ port: productSync, provider, mode: "pull" })),
    finish: (result) => ({
      status: result.ok ? "success" : "failed",
      result: {
        checked: result.pulledSkus,
        updated: result.pushedPacks + result.ingestedPacks,
        failures: result.failures,
        skipped: false,
        reason: result.reason,
      },
      extraMetadata: {
        pushedProducts: result.pushedProducts,
        pushedPacks: result.pushedPacks,
        pulledSkus: result.pulledSkus,
        ingestedPacks: result.ingestedPacks,
        reconciliations: result.reconciliations,
      },
    }),
  });
  if (!run.acquired) {
    return { status: 200, body: { ok: true, skipped: true, reason: run.reason } };
  }

  const result = run.result;
  return { status: result.ok ? 200 : 502, body: result as unknown as Record<string, unknown> };
}

// Binds the worker's provider to the OmniPack client (composition root — server/domains may not
// import server/infra). PULL-ONLY: only the read methods (getProductPacks/listStockedSkus) are
// used by the cron. The write methods are deliberately disabled — the product push is the
// operator-run seed — so no scheduled run can ever write to OmniPack.
function createProvider(client: OmnipackClient): OmnipackProductSyncProvider {
  const pushIsManualOnly = (): never => {
    throw new Error("omnipack_product_push_is_manual_only");
  };
  return {
    ensureProduct: async () => pushIsManualOnly(),
    addProductPack: async () => pushIsManualOnly(),
    async getProductPacks(sku) {
      return (await client.getProduct(sku)).packs;
    },
    async listStockedSkus() {
      return (await client.getStock()).map((item) => item.sku);
    },
  };
}

async function runSafely(operation: () => Promise<OmnipackProductSyncResult>): Promise<OmnipackProductSyncResult> {
  try {
    return await operation();
  } catch (error) {
    return {
      ok: false, pushedProducts: 0, pushedPacks: 0, skippedProducts: 0, pulledSkus: 0, ingestedPacks: 0,
      reconciliations: 0, replayed: 0, failures: 1, providerCalls: 0,
      syncRunId: "omnipack-product-sync:failed-before-run", reason: safeMessage(error),
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
