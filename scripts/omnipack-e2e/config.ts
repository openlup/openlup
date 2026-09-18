// Runtime configuration for the OmniPack live-verification harness (W4). All values
// come from the hidden-preview secrets; nothing is hardcoded. `readE2eConfig` returns a
// typed config with the list of missing keys so the preflight can fail closed before any
// live call.

export type EnvLike = Record<string, string | undefined>;

export interface E2eConfig {
  baseUrl: string;
  vercelEnv: string;
  hiddenSandboxEnabled: boolean;
  supabaseUrl: string;
  serviceRoleKey: string;
  cronSecret: string;
  omnipackWebhookToken: string;
  omnipackAccountKind: string;
  omnipackTestAccountConfirmed: boolean;
  stripeSecretKey: string;
  safeRecipient: string;
  flavorSlug: string;
  sku: string;
  runId: string;
  occurredAt: string;
  remoteDispatchBatchLimit: number;
  vercelBypassToken: string | null;
}

export interface ReadConfigResult {
  config: E2eConfig;
  missing: string[];
}

function required(env: EnvLike, key: string, missing: string[]): string {
  const value = env[key]?.trim();
  if (!value) {
    missing.push(key);
    return "";
  }
  return value;
}

export function readE2eConfig(env: EnvLike): ReadConfigResult {
  const missing: string[] = [];
  const config: E2eConfig = {
    baseUrl: required(env, "OMNIPACK_E2E_BASE_URL", missing),
    vercelEnv: env.VERCEL_ENV?.trim() ?? "",
    hiddenSandboxEnabled: env.HIDDEN_SANDBOX_PREVIEW_ENABLED === "true",
    supabaseUrl: required(env, "SUPABASE_URL", missing),
    serviceRoleKey: required(env, "SUPABASE_SERVICE_ROLE_KEY", missing),
    cronSecret: required(env, "CRON_SECRET", missing),
    omnipackWebhookToken: required(env, "OMNIPACK_WEBHOOK_TOKEN", missing),
    omnipackAccountKind: env.OMNIPACK_ACCOUNT_KIND?.trim() ?? "",
    omnipackTestAccountConfirmed: env.OMNIPACK_TEST_ACCOUNT_CONFIRMED === "true",
    stripeSecretKey: required(env, "STRIPE_SECRET_KEY", missing),
    safeRecipient: required(env, "OMNIPACK_E2E_SAFE_RECIPIENT", missing).toLowerCase(),
    flavorSlug: required(env, "OMNIPACK_E2E_FLAVOR_SLUG", missing),
    sku: required(env, "OMNIPACK_E2E_SKU", missing),
    runId: required(env, "OMNIPACK_E2E_RUN_ID", missing).toLowerCase(),
    occurredAt: required(env, "OMNIPACK_E2E_OCCURRED_AT", missing),
    remoteDispatchBatchLimit: Number(required(env, "OMNIPACK_E2E_REMOTE_DISPATCH_BATCH_LIMIT", missing)),
    vercelBypassToken:
      env.OMNIPACK_E2E_VERCEL_BYPASS_TOKEN?.trim() ??
      env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() ??
      null,
  };
  return { config, missing };
}
