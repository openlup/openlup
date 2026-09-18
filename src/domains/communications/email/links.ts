// Absolute-URL builder for email CTA links. Pure TS (no react-i18next), so the
// renderer stays importable by every Node sender; that portability was
// originally for the Deno edge senders, retired 2026-09-05.
//
// The localized paths mirror src/lib/i18nRoutes.ts `routeMap` but are duplicated
// here on purpose: importing i18nRoutes would drag react-i18next into the email
// modules. Keep this short list in sync with i18nRoutes when those routes change
// (only the handful of routes emails actually link to live here).

import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import type { RecoveryDestinationIntent } from "../../commerce/ports.js";

export type EmailRouteKey =
  | "configurator"
  | "customerDashboard"
  | "customerPaymentRecovery"
  | "checkoutRecovery"
  | "returnsGuide"
  | "terms";

const EMAIL_ROUTES: Record<EmailRouteKey, Record<Locale, string>> = {
  configurator: { pl: "/skomponuj-pakiet", en: "/build-your-box" },
  customerDashboard: { pl: "/konto", en: "/account" },
  customerPaymentRecovery: {
    pl: "/konto/platnosc/napraw",
    en: "/account/payment/recover",
  },
  checkoutRecovery: {
    pl: "/konto/dokoncz-platnosc",
    en: "/account/complete-payment",
  },
  returnsGuide: { pl: "/zwroty", en: "/returns" },
  terms: { pl: "/regulamin", en: "/terms" },
};

export function emailRouteUrl(
  baseUrl: string,
  key: EmailRouteKey,
  locale: Locale,
  query?: Record<string, string>,
): string {
  // baseUrl is the resolved public origin supplied by the caller (composition
  // root); the brand default lives in the app layer (APP_SITE_ORIGIN).
  const base = baseUrl.replace(/\/+$/, "");
  const path = EMAIL_ROUTES[key][locale];
  const entries = query
    ? Object.entries(query).filter(([, value]) => value !== "")
    : [];
  const qs =
    entries.length > 0
      ? "?" +
        entries
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join("&")
      : "";
  return `${base}${path}${qs}`;
}

export function emailRouteUrlForRecoveryDestination(
  baseUrl: string,
  intent: RecoveryDestinationIntent,
  locale: Locale,
  query?: Record<string, string>,
): string {
  return emailRouteUrl(baseUrl, emailRouteKeyForRecoveryDestination(intent), locale, query);
}

function emailRouteKeyForRecoveryDestination(intent: RecoveryDestinationIntent): EmailRouteKey {
  switch (intent) {
    case "account_payment_recovery":
      return "customerPaymentRecovery";
    case "checkout_recovery":
      return "checkoutRecovery";
    case "customer_dashboard":
      return "customerDashboard";
    case "fresh_checkout":
      return "configurator";
  }
}
