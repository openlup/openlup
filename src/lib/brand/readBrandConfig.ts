// Server-side brand resolver: openlup's static identity with env overlays
// applied (the ACCOUNTING_SELLER_* seller fields and the sender identity). Kept
// separate from appBrand.ts so the static, FE-safe constants never drag the
// accounting env reader into the browser bundle. This is the app-edge entry
// point the core's brand-agnostic seam is wired to.

import { readAccountingSellerConfig } from "../../domains/accounting/invoiceContracts.js";
import type { BrandConfig } from "./brandConfig.js";
import {
  APP_BRAND_NAME,
  APP_DEFAULT_SELLER,
  APP_EMAIL_BRAND,
  APP_FROM_EMAIL,
  APP_ORDER_REF_PREFIX,
  APP_PRODUCTION_EMAIL_HOSTS,
  APP_REPLY_TO_EMAIL,
  APP_SITE_ORIGIN,
  APP_SUPPORT_EMAIL,
} from "./appBrand.js";

/**
 * Env names that override the sender identity, in resolution order — first
 * non-blank wins, otherwise the app default applies.
 *
 * `FROM_EMAIL` is the shared name every server email runtime reads, and since
 * 2026-08-30 it is the only one. The older, provider-prefixed alias was read
 * directly by a single hosted function; PR 3233 retired that function and dropped
 * the alias from `config/environment-variables.json` in the same change on
 * 2026-08-30, so this seam has no second name left to resolve and no ceiling
 * token left to spend on one. `FROM_EMAIL` is catalogued in that same file.
 */
export const BRAND_SENDER_ENV_NAMES = ["FROM_EMAIL"] as const;

/**
 * The env shape the sender seam reads. Derived from the name list above rather
 * than hand-written, and declared as a plain optional-key type (not a `Record`
 * with an index signature) so composition roots can pass their own env
 * interfaces straight in.
 */
export type BrandSenderEnv = Partial<
  Record<(typeof BRAND_SENDER_ENV_NAMES)[number], string>
>;

/**
 * Resolve the sender identity for platform email. A value that is present but
 * blank counts as unset, so a misconfigured empty override falls back to a
 * usable sender instead of composing an empty `From:` header.
 */
export function readBrandFromEmail(env: BrandSenderEnv = {}): string {
  for (const name of BRAND_SENDER_ENV_NAMES) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return APP_FROM_EMAIL;
}

/** The app-edge brand resolver: openlup identity with env overlays applied. */
export function readBrandConfig(env: Record<string, string | undefined> = {}): BrandConfig {
  return {
    brandName: APP_BRAND_NAME,
    supportEmail: APP_SUPPORT_EMAIL,
    fromEmail: readBrandFromEmail(env),
    replyToEmail: APP_REPLY_TO_EMAIL,
    siteOrigin: APP_SITE_ORIGIN,
    productionEmailHosts: APP_PRODUCTION_EMAIL_HOSTS,
    orderRefPrefix: APP_ORDER_REF_PREFIX,
    email: APP_EMAIL_BRAND,
    seller: readAccountingSellerConfig(env, APP_DEFAULT_SELLER),
  };
}
