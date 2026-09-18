/**
 * Shared preview-environment resolution for the account/marketing a11y suite.
 *
 * Mirrors the checkout suite's `tests/preview/checkout/helpers/env.ts` (same
 * bypass-token + base-URL precedence chain) so the two preview suites stay
 * aligned, and adds a dedicated `ACCOUNT_PREVIEW_BASE_URL` override that takes
 * first precedence — letting the account sweep target its own preview
 * deployment without disturbing the checkout or admin smoke configuration.
 */

/** Base URL precedence: account override first, then the shared preview chain. */
export const baseURL: string = origin(
  process.env.ACCOUNT_PREVIEW_BASE_URL ??
    process.env.CHECKOUT_PREVIEW_BASE_URL ??
    process.env.ADMIN_OMS_PREVIEW_SMOKE_BASE_URL ??
    process.env.HIDDEN_PREVIEW_HEALTH_BASE_URL ??
    process.env.ACCOUNTING_PREVIEW_SMOKE_BASE_URL ??
    "http://127.0.0.1:4173",
);

/** Vercel protection-bypass token, resolved from the same env chain as the checkout suite. */
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
