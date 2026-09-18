// BrandConfig — the single injection seam that lets the generic core stay
// brand-free while openlup (and any future brand) supplies its own identity.
//
// Core domains define and CONSUME this contract (as a parameter); they never
// hold brand literals or read brand env. Composition roots keep importing the
// app-layer compatibility facade (`src/lib/brand/appBrand.ts`), whose values are
// selected by `#email-presentation`: the public example owner is neutral and a
// private deployment owner carries its concrete identity. Server-side env
// overlays remain in `readBrandConfig.ts`.
//
// This file is a pure contract (no literals), so importing it never reintroduces
// a brand reference into a core module.

import type { Locale } from "../i18n/resolveLocale.js";
import type { EmailTheme } from "../../domains/communications/email/theme.js";
import type { EmailChromeStrings } from "../../domains/communications/email/strings.js";
import type { AccountingSellerConfig } from "../../domains/accounting/invoiceContracts.js";

/** Brand-specific inputs the email renderer needs (look + locale chrome). */
export interface EmailBrand {
  /** Brand label used in email copy when it intentionally differs from logo rendering. */
  copyBrandName: string;
  /**
   * Softer, mixed-case brand label for in-body copy (e.g. "openlup"). Distinct from
   * the all-caps chrome/sign-off form (copyBrandName, "OPENLUP"). Optional: callers
   * fall back to copyBrandName when a brand does not define a cased variant.
   */
  copyBrandNameCased?: string;
  theme: EmailTheme;
  chrome: Record<Locale, EmailChromeStrings>;
}

/** Social profile slots understood by the shared storefront chrome. */
export type SocialNetwork = "instagram" | "facebook";

/** A brand's full identity, injected wherever the core needs brand specifics. */
export interface BrandConfig {
  /** Human brand name (e.g. used in copy, alt text). */
  brandName: string;
  /** Customer support address surfaced in UI/emails. */
  supportEmail: string;
  /**
   * Sender identity every platform email is composed with, in RFC 5322 mailbox
   * form ("Display Name <address>"). Composition roots read it here and pass it
   * to the email ports; nothing below them may compose a sender of its own.
   */
  fromEmail: string;
  /**
   * Bare address a customer reaches by replying to platform email. Split from
   * `fromEmail` because a deployment may send from an unattended mailbox while
   * still routing replies to a staffed one.
   */
  replyToEmail: string;
  /** Default public site origin used when no per-deploy origin is set. */
  siteOrigin: string;
  /** Hosts treated as production by the email origin policy. */
  productionEmailHosts: string[];
  /** Prefix for the customer-facing order reference (e.g. "OPENLUP"). */
  orderRefPrefix: string;
  /** Email look + per-locale chrome strings. */
  email: EmailBrand;
  /** Legal seller identity for invoicing. */
  seller: AccountingSellerConfig;
  /** Optional public profile URLs supplied by the deployment owner. */
  socialLinks?: Partial<Record<SocialNetwork, string>>;
}
