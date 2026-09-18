import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Canonical production OmniPack host — mirrors OMNIPACK_PRODUCTION_BASE_URL in
// server/infra/omnipack/outboundOrderMapper.ts. Kept local so this shadow readiness
// stays an independent check of the registry rather than importing runtime infra.
const OMNIPACK_PRODUCTION_BASE_URL = "https://api.omnipack.tech";

export type EnvLike = Record<string, string | undefined>;
export type ProofCheck = { name: string; ok: boolean; details?: string };
export type ReadOverrides = Record<string, string>;
export type OmnipackPreprodProviderMatrixProof = {
  ok: boolean;
  proofScope: "omnipack_preprod_provider_matrix";
  providerCalls: false;
  networkCalls: false;
  dbWrites: false;
  blocked: string[];
  warnings: string[];
  providers: {
    registeredKinds: string[];
    defaultProvider: "simulator";
    hiddenPreviewProvider: "simulator";
    manualKnownBlocked: boolean;
    dhlApplicationRetired: boolean;
    dhlRetirementIndependentFromOmnipackStageEnv: boolean;
    omnipackShadowReadyStageGated: boolean;
    omnipackControlledStageBatchGated: boolean;
    capabilityRegistryPinned: boolean;
  };
  componentProofs: {
    hiddenPreviewMatrix: boolean;
    stageOneOrderLadderBlockedWithoutCredentials: boolean;
    stageBatchLadderBlockedWithoutProofs: boolean;
    statusPipeline: boolean;
    stockSync: boolean;
    shipmentCommunications: boolean;
  };
  isolation: {
    genericTrackingRefsPinned: boolean;
    customerTrackingTimelinePinned: boolean;
    adminDhlActionsPinned: boolean;
    omnipackRuntimeDhlAdminActionFree: boolean;
    shipmentEmailsOutboxOnly: boolean;
    stockSyncNoLocalMutation: boolean;
  };
  proofChecks: ProofCheck[];
};

export const HIDDEN_PREVIEW_ENV = {
  VERCEL_ENV: "preview",
  HIDDEN_SANDBOX_PREVIEW_ENABLED: "true",
  HIDDEN_SANDBOX_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
  HIDDEN_SANDBOX_PROVIDER_MODE: "mixed-sandbox-simulator",
  SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  VITE_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
} as const satisfies EnvLike;

export const DHL_READY_ENV = {
  DHL_LIVE_PREVIEW_CONFIRMED: "true",
  DHL_API_USERNAME: "dhl-user",
  DHL_API_PASSWORD: "dhl-pass",
  DHL_ACCOUNT_NUMBER: "123456",
} as const satisfies EnvLike;

export const DHL_ADMIN_ROUTES = [
  "/api/bff/admin/fulfillment/dhl-create-shipment",
  "/api/bff/admin/fulfillment/dhl-label",
  "/api/bff/admin/fulfillment/dhl-merge-labels",
  "/api/bff/admin/fulfillment/dhl-book-courier",
  "/api/bff/admin/fulfillment/dhl-repair-courier-pickup",
  "/api/bff/admin/fulfillment/dhl-clear-shipment-state",
] as const;

export const OMNIPACK_RUNTIME_FILES = [
  "api/_cron/omnipackDispatchJob.ts",
  "api/_cron/omnipackReconciliationJob.ts",
  "api/_cron/omnipackStockSyncJob.ts",
  "server/domains/fulfillment/omnipackDispatchWorker.ts",
  "server/domains/fulfillment/omnipackReconciliationWorker.ts",
  "server/domains/fulfillment/omnipackStockSyncWorker.ts",
  "server/domains/fulfillment/omnipackWebhookHandler.ts",
  "server/adapters/omnipack/commerceFulfillmentPort.ts",
  "server/infra/omnipack/client.ts",
] as const;

export const DHL_ADMIN_FORBIDDEN_TERMS = [
  "dhl-create-shipment",
  "dhl-label",
  "dhl-merge-labels",
  "dhl-book-courier",
  "dhl-repair-courier-pickup",
  "dhl-clear-shipment-state",
] as const;

export function filesDoNotContain(
  repoRoot: string,
  files: readonly string[],
  forbidden: readonly string[],
  overrides: ReadOverrides,
): boolean {
  return files.every((file) => {
    if (!existsSync(join(repoRoot, file)) && !(file in overrides)) return false;
    const content = read(repoRoot, file, overrides).toLowerCase();
    return forbidden.every((term) => !content.includes(term.toLowerCase()));
  });
}

export function readRegisteredProviderKinds(providerRegistry: string): string[] {
  // W8: the static descriptor registry moved to server/domains/fulfillment/fulfillmentKernel.ts
  // (`descriptor("<kind>", ...)`); pass the combined cron + kernel source so the pin
  // tracks the registry wherever it lives.
  const kinds = ["simulator", "manual", "dhl", "omnipack"];
  return kinds.filter((kind) => providerRegistry.includes(`descriptor("${kind}"`));
}

export function resolveProviderKind(env: EnvLike): string {
  const value = env.COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER?.trim().toLowerCase() ?? "";
  if (["", "simulator", "hidden_preview_fulfillment"].includes(value)) return "simulator";
  if (value === "manual") return "manual";
  if (value === "dhl") return "dhl";
  if (value === "omnipack") return "omnipack";
  return "unsupported";
}

export function readProviderReadiness(env: EnvLike): { ok: true } | { ok: false; error: string } {
  const kind = resolveProviderKind(env);
  if (kind === "simulator") return { ok: true };
  if (kind === "manual") return { ok: false, error: "manual_fulfillment_not_auto_dispatchable" };
  if (kind === "omnipack") {
    if (env.COMMERCE_OMNIPACK_DISPATCH_ENABLED !== "true") {
      return { ok: false, error: "omnipack_dispatch_disabled" };
    }
    const mode = env.COMMERCE_OMNIPACK_DISPATCH_MODE === "stage" || env.COMMERCE_OMNIPACK_DISPATCH_MODE === "live"
      ? env.COMMERCE_OMNIPACK_DISPATCH_MODE
      : "shadow";
    if (mode === "live") {
      // Live auto-dispatch carries no separate feature flag: dispatch-enabled is the
      // intent switch, and live fails closed unless a real provider client is
      // configured AND it targets the production OmniPack environment + base URL.
      // Mirrors readOmnipackComposedReadiness in api/_cron/outboxFulfillmentProvider.ts.
      if (
        env.OMNIPACK_PROVIDER_ENABLED !== "true" ||
        !env.OMNIPACK_USERNAME ||
        !env.OMNIPACK_PASSWORD ||
        !env.OMNIPACK_BASE_URL ||
        !env.OMNIPACK_ENV ||
        !env.OMNIPACK_WEBHOOK_TOKEN ||
        env.OMNIPACK_ENV !== "production" ||
        env.OMNIPACK_BASE_URL !== OMNIPACK_PRODUCTION_BASE_URL
      ) {
        return { ok: false, error: "omnipack_provider_not_configured" };
      }
      return { ok: true };
    }
    if (mode === "stage") {
      const batchLimit = intOrNull(env.COMMERCE_OMNIPACK_DISPATCH_BATCH_LIMIT);
      if (batchLimit === 1) {
        return { ok: true };
      } else {
        if (env.OMNIPACK_STAGE_BATCH_CONFIRMED !== "true") {
          return { ok: false, error: "omnipack_stage_batch_limit_must_be_1" };
        }
        if (batchLimit === null || batchLimit < 2 || batchLimit > 5) {
          return { ok: false, error: "omnipack_stage_batch_limit_must_be_between_2_and_5" };
        }
        if (intOrNull(env.OMNIPACK_STAGE_BATCH_MAX_ORDERS) !== batchLimit) {
          return { ok: false, error: "omnipack_stage_batch_max_orders_must_match_dispatch_limit" };
        }
        if (intOrNull(env.COMMERCE_OUTBOX_DISPATCH_BATCH_SIZE) !== batchLimit) {
          return { ok: false, error: "omnipack_stage_outbox_dispatch_batch_size_must_match_dispatch_batch" };
        }
      }
      if (
        env.OMNIPACK_PROVIDER_ENABLED !== "true" ||
        !env.OMNIPACK_USERNAME ||
        !env.OMNIPACK_PASSWORD ||
        !env.OMNIPACK_BASE_URL ||
        !env.OMNIPACK_ENV ||
        !env.OMNIPACK_WEBHOOK_TOKEN
      ) {
        return { ok: false, error: "omnipack_provider_not_configured" };
      }
    }
    return { ok: true };
  }
  if (kind === "dhl") {
    return { ok: false, error: "fulfillment_provider_not_supported" };
  }
  return { ok: false, error: "fulfillment_provider_not_supported" };
}

export function readinessError(result: { ok: true } | { ok: false; error: string }): string | null {
  return "error" in result ? result.error : null;
}

export function read(repoRoot: string, path: string, overrides: ReadOverrides): string {
  return overrides[path] ?? readFileSync(join(repoRoot, path), "utf8");
}

function intOrNull(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}
