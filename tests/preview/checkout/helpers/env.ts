import type { Page } from "@playwright/test";

/**
 * Shared preview-environment resolution for the checkout E2E suite.
 *
 * Mirrors the base-URL / bypass-token precedence baked into
 * `playwright.config.ts` (admin-oms) so the two suites stay aligned, and adds a
 * dedicated `CHECKOUT_PREVIEW_BASE_URL` override that takes first precedence —
 * letting the checkout suite point at its own preview deployment without
 * disturbing the admin smoke configuration.
 */

/** Base URL precedence: checkout override first, then the shared preview chain. */
export const baseURL: string = origin(
  process.env.CHECKOUT_PREVIEW_BASE_URL ??
    process.env.ADMIN_OMS_PREVIEW_SMOKE_BASE_URL ??
    process.env.HIDDEN_PREVIEW_HEALTH_BASE_URL ??
    process.env.ACCOUNTING_PREVIEW_SMOKE_BASE_URL ??
    "http://127.0.0.1:4173",
);

/** Vercel protection-bypass token, resolved from the same env chain as the admin suite. */
export const bypassToken: string | undefined =
  process.env.ADMIN_OMS_PREVIEW_VERCEL_BYPASS_TOKEN ??
  process.env.HIDDEN_ROUTE_SMOKE_VERCEL_BYPASS_TOKEN ??
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

/** Absolute URL for `path` resolved against the resolved preview `baseURL`. */
export function appUrl(path: string): string {
  return new URL(path, baseURL).toString();
}

/**
 * Attach the Vercel protection-bypass header to the page's browser context so
 * every request (navigations + XHR) carries it. No-op when no token is set
 * (e.g. local preview runs).
 */
export async function setBypassHeader(page: Page): Promise<void> {
  if (!bypassToken) return;
  await page.context().setExtraHTTPHeaders({ "x-vercel-protection-bypass": bypassToken });
}

function origin(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return raw;
  }
}
