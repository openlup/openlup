export type EmailOriginSource = "explicit" | "default";
export type EmailEnvironment =
  | "hidden_preview"
  | "preview"
  | "staging"
  | "production"
  | "production_or_default"
  | "unknown";
export type EmailOriginPolicyError =
  | "hidden_preview_origin_required"
  | "hidden_preview_origin_must_not_be_production"
  | "invalid_email_origin";

export interface ResolvedEmailOrigin {
  origin: string;
  source: EmailOriginSource;
  environment: EmailEnvironment;
  production: boolean;
}

export type EmailOriginResolution =
  | { ok: true; origin: string; source: EmailOriginSource; resolved: ResolvedEmailOrigin }
  | { ok: false; error: EmailOriginPolicyError };

export interface EmailOriginInput {
  /** Brand/configured default origin used when no explicit origin is set. */
  defaultOrigin: string;
  /** Hosts treated as production by the policy (brand-supplied). */
  productionEmailHosts: string[];
  explicitBaseUrl?: string | null;
  customerAuthRedirectOrigin?: string | null;
  siteUrl?: string | null;
  hiddenPreviewEnabled?: boolean;
  environment?: string | null;
}

export const EMAIL_DEFAULT_ORIGIN_ENV = "EMAIL_DEFAULT_ORIGIN";
export const EMAIL_PRODUCTION_ORIGIN_HOSTS_ENV = "EMAIL_PRODUCTION_ORIGIN_HOSTS";
export const COMMS_PRODUCTION_PROJECT_REF_ENV = "COMMS_PRODUCTION_PROJECT_REF";

export interface EmailOriginConfiguration {
  defaultOrigin: string;
  productionEmailHosts: string[];
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function resolveEnvironment(input: EmailOriginInput): EmailEnvironment {
  if (input.hiddenPreviewEnabled) return "hidden_preview";
  const value = clean(input.environment)?.toLowerCase().replace(/-/g, "_");
  if (
    value === "hidden_preview" ||
    value === "preview" ||
    value === "staging" ||
    value === "production" ||
    value === "production_or_default"
  ) {
    return value;
  }
  return "production_or_default";
}

export function normalizeEmailOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname) return null;
    return url.origin.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function isProductionEmailOrigin(origin: string, productionHosts: string[]): boolean {
  try {
    return productionHosts.includes(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function readEmailOriginConfiguration(
  env: Record<string, string | undefined>,
  fallback: EmailOriginConfiguration,
): EmailOriginConfiguration {
  const configuredDefault = env[EMAIL_DEFAULT_ORIGIN_ENV];
  const configuredHosts = env[EMAIL_PRODUCTION_ORIGIN_HOSTS_ENV];
  return {
    defaultOrigin: configuredDefault === undefined ? fallback.defaultOrigin : configuredDefault,
    productionEmailHosts: configuredHosts === undefined
      ? fallback.productionEmailHosts
      : configuredHosts
        .split(/[,\s;]+/)
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
  };
}

function requiresExplicitNonProductionOrigin(environment: EmailEnvironment): boolean {
  return environment === "hidden_preview" || environment === "preview" || environment === "staging";
}

export function resolveEmailOrigin(input: EmailOriginInput): EmailOriginResolution {
  const environment = resolveEnvironment(input);
  const explicit =
    clean(input.explicitBaseUrl) ??
    clean(input.customerAuthRedirectOrigin) ??
    clean(input.siteUrl);

  if (!explicit) {
    if (requiresExplicitNonProductionOrigin(environment)) {
      return { ok: false, error: "hidden_preview_origin_required" };
    }
    const defaultOrigin = normalizeEmailOrigin(input.defaultOrigin);
    if (!defaultOrigin) return { ok: false, error: "invalid_email_origin" };
    return {
      ok: true,
      origin: defaultOrigin,
      source: "default",
      resolved: {
        origin: defaultOrigin,
        source: "default",
        environment,
        production: isProductionEmailOrigin(defaultOrigin, input.productionEmailHosts),
      },
    };
  }

  const normalized = normalizeEmailOrigin(explicit);
  if (!normalized) return { ok: false, error: "invalid_email_origin" };

  const production = isProductionEmailOrigin(normalized, input.productionEmailHosts);
  if (requiresExplicitNonProductionOrigin(environment) && production) {
    return { ok: false, error: "hidden_preview_origin_must_not_be_production" };
  }

  return {
    ok: true,
    origin: normalized,
    source: "explicit",
    resolved: {
      origin: normalized,
      source: "explicit",
      environment,
      production,
    },
  };
}
