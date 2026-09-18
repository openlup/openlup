export class ProviderDisabledError extends Error {
  constructor(providerKind: string, reason = "provider_disabled") {
    super(`${providerKind} provider is disabled: ${reason}`);
    this.name = "ProviderDisabledError";
  }
}

export class ProviderEnvMissingError extends Error {
  readonly missing: string[];

  constructor(providerKind: string, missing: string[]) {
    super(`${providerKind} provider env missing: ${missing.join(", ")}`);
    this.name = "ProviderEnvMissingError";
    this.missing = missing;
  }
}

export interface ProviderActivationConfig {
  providerKind: string;
  enabled: boolean;
  requiredEnv: string[];
  presentEnv: Record<string, boolean>;
}

export function readProviderActivationConfig(input: {
  providerKind: string;
  enabled: boolean;
  requiredEnv: string[];
  env: Record<string, string | undefined>;
}): ProviderActivationConfig {
  return {
    providerKind: input.providerKind,
    enabled: input.enabled,
    requiredEnv: input.requiredEnv,
    presentEnv: Object.fromEntries(input.requiredEnv.map((key) => [key, Boolean(input.env[key])])),
  };
}

export function assertProviderInactiveOrConfigured(config: ProviderActivationConfig): void {
  if (!config.enabled) {
    throw new ProviderDisabledError(config.providerKind);
  }
  const missing = config.requiredEnv.filter((key) => !config.presentEnv[key]);
  if (missing.length > 0) {
    throw new ProviderEnvMissingError(config.providerKind, missing);
  }
  throw new ProviderDisabledError(config.providerKind, "live_provider_calls_not_implemented");
}

export function sanitizeProviderError(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof ProviderDisabledError) {
    return { code: "provider_disabled", message: error.message, retryable: false };
  }
  if (error instanceof ProviderEnvMissingError) {
    return { code: "provider_env_missing", message: error.message, retryable: false };
  }
  return { code: "provider_error", message: "Provider request failed", retryable: true };
}

export type StripeKeyMode = "sandbox" | "live";

export class StripeLiveKeyBlockedError extends Error {
  constructor() {
    super("stripe_live_keys_blocked_without_explicit_confirmation");
    this.name = "StripeLiveKeyBlockedError";
  }
}

export function assertStripeKeyMode(
  secretKey: string,
  env: Record<string, string | undefined>,
): StripeKeyMode {
  if (secretKey.startsWith("sk_test_")) return "sandbox";
  if (secretKey.startsWith("sk_live_") && env.STRIPE_LIVE_CONFIRMED === "true") return "live";
  throw new StripeLiveKeyBlockedError();
}

export function assertProviderEnabledAndConfigured(config: ProviderActivationConfig): void {
  if (!config.enabled) {
    throw new ProviderDisabledError(config.providerKind);
  }
  const missing = config.requiredEnv.filter((key) => !config.presentEnv[key]);
  if (missing.length > 0) {
    throw new ProviderEnvMissingError(config.providerKind, missing);
  }
}
