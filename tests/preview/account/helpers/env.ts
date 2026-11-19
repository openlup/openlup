/** Shared preview environment resolution for account and accessibility tests. */

/** Base URL precedence: account override first, then the shared preview chain. */
export const baseURL: string = origin(
  process.env.ACCOUNT_PREVIEW_BASE_URL ??
    process.env.CHECKOUT_PREVIEW_BASE_URL ??
    process.env.ADMIN_OMS_PREVIEW_SMOKE_BASE_URL ??
    process.env.HIDDEN_PREVIEW_HEALTH_BASE_URL ??
    process.env.ACCOUNTING_PREVIEW_SMOKE_BASE_URL ??
    "http://127.0.0.1:4173",
);

/** Optional Vercel protection-bypass token for the configured preview. */
export const bypassToken: string | undefined =
  process.env.ADMIN_OMS_PREVIEW_VERCEL_BYPASS_TOKEN ??
  process.env.HIDDEN_ROUTE_SMOKE_VERCEL_BYPASS_TOKEN ??
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

/** Absolute URL for `path` resolved against the resolved preview `baseURL`. */
export function appUrl(path: string): string {
  return new URL(path, baseURL).toString();
}

function origin(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return raw;
  }
}
