import {
  readEmailOriginConfiguration,
  resolveEmailOrigin,
} from "../../src/domains/communications/email/originPolicy.js";
import { APP_PRODUCTION_EMAIL_HOSTS, APP_SITE_ORIGIN } from "../../src/lib/brand/appBrand.js";

// Both arms declare all four keys. The narrowing is unchanged where narrowing
// works; declaring the absent halves is what keeps this union readable from the
// loose `scripts/**` project, whose proofs compose the crons that consume it.
export type EmailBaseUrlResult =
  | { ok: true; baseUrl: string; source: "explicit" | "default"; error?: undefined }
  | {
    ok: false;
    baseUrl?: undefined;
    source?: undefined;
    error: "hidden_preview_origin_required" | "hidden_preview_origin_must_not_be_production" | "invalid_email_origin";
  };

export interface EmailBaseUrlEnv {
  APP_BASE_URL?: string;
  openlup_BASE_URL?: string;
  CUSTOMER_AUTH_REDIRECT_ORIGIN?: string;
  SITE_URL?: string;
  HIDDEN_SANDBOX_PREVIEW_ENABLED?: string;
  EMAIL_ENVIRONMENT?: string;
  VERCEL_ENV?: string;
  EMAIL_DEFAULT_ORIGIN?: string;
  EMAIL_PRODUCTION_ORIGIN_HOSTS?: string;
}

export function resolveCronEmailBaseUrl(env: EmailBaseUrlEnv): EmailBaseUrlResult {
  const resolved = resolveEmailOrigin({
    ...readEmailOriginConfiguration({
      EMAIL_DEFAULT_ORIGIN: env.EMAIL_DEFAULT_ORIGIN,
      EMAIL_PRODUCTION_ORIGIN_HOSTS: env.EMAIL_PRODUCTION_ORIGIN_HOSTS,
    }, {
      defaultOrigin: APP_SITE_ORIGIN,
      productionEmailHosts: APP_PRODUCTION_EMAIL_HOSTS,
    }),
    explicitBaseUrl: env.APP_BASE_URL?.trim() || env.openlup_BASE_URL,
    customerAuthRedirectOrigin: env.CUSTOMER_AUTH_REDIRECT_ORIGIN,
    siteUrl: env.SITE_URL,
    hiddenPreviewEnabled: env.HIDDEN_SANDBOX_PREVIEW_ENABLED === "true",
    environment: env.EMAIL_ENVIRONMENT ?? env.VERCEL_ENV,
  });
  if (resolved.ok === false) return resolved;
  return { ok: true, baseUrl: resolved.origin, source: resolved.source };
}
