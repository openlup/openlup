import { useTranslation } from "react-i18next";
import { APP_SITE_ORIGIN } from "@/lib/brand/appBrand";

export type Lang = "pl" | "en";

export type LocalizedRoute = { en: string; pl?: string };

export type RouteKey =
  | "home"
  | "science"
  | "ourStory"
  | "waitlist"
  | "homeV2"
  | "configurator"
  | "configuratorThankYou"
  | "configuratorPaymentFailed"
  | "configuratorPayment"
  | "configuratorTpaySimulator"
  | "petPersonalizer"
  | "customerLogin"
  | "customerAuthCallback"
  | "customerDashboard"
  | "customerOrderStatus"
  | "customerPaymentRecovery"
  | "checkoutRecovery"
  | "terms"
  | "firstTastersTerms"
  | "privacyPolicy"
  | "cookiePolicy"
  | "returnsGuide"
  | "contact"
  | "productLamb"
  | "productVenison"
  | "productBeef"
  | "productTurkey"
  | "productSalmon"
  | "productPork"
  | "privateLabel";

export const routeMap: Record<RouteKey, LocalizedRoute> = {
  home: { pl: "/", en: "/en" },
  science: { pl: "/jak-to-dziala", en: "/how-it-works" },
  ourStory: { pl: "/nasza-historia", en: "/our-story" },
  waitlist: { pl: "/waitlist", en: "/waitlist-en" },
  homeV2: { pl: "/v2", en: "/en/v2" },
  configurator: { pl: "/skomponuj-pakiet", en: "/build-your-box" },
  configuratorThankYou: { pl: "/skomponuj-pakiet/dziekujemy", en: "/build-your-box/thank-you" },
  configuratorPaymentFailed: { pl: "/skomponuj-pakiet/platnosc-nieudana", en: "/build-your-box/payment-failed" },
  configuratorPayment: { pl: "/skomponuj-pakiet/platnosc", en: "/build-your-box/payment" },
  configuratorTpaySimulator: { pl: "/skomponuj-pakiet/tpay-simulator", en: "/build-your-box/tpay-simulator" },
  petPersonalizer: { pl: "/zrob-puszke", en: "/your-dog-on-a-can" },
  customerLogin: { pl: "/zaloguj-sie", en: "/sign-in" },
  customerAuthCallback: { pl: "/konto/auth/callback", en: "/account/auth/callback" },
  customerDashboard: { pl: "/konto", en: "/account" },
  customerOrderStatus: { pl: "/konto/zamowienie/status", en: "/account/order/status" },
  customerPaymentRecovery: { pl: "/konto/platnosc/napraw", en: "/account/payment/recover" },
  checkoutRecovery: { pl: "/konto/dokoncz-platnosc", en: "/account/complete-payment" },
  terms: { pl: "/regulamin", en: "/terms" },
  firstTastersTerms: { pl: "/regulamin-first-tasters", en: "/first-tasters-terms" },
  privacyPolicy: { pl: "/polityka-prywatnosci", en: "/privacy-policy" },
  cookiePolicy: { pl: "/polityka-cookies", en: "/cookie-policy" },
  returnsGuide: { pl: "/zwroty", en: "/returns" },
  contact: { pl: "/kontakt", en: "/contact" },
  productLamb: { pl: "/psy/jagniecina", en: "/dogs/lamb" },
  productVenison: { pl: "/psy/dziczyzna", en: "/dogs/venison" },
  productBeef: { pl: "/psy/wolowina", en: "/dogs/beef" },
  productTurkey: { pl: "/psy/indyk", en: "/dogs/turkey" },
  productSalmon: { pl: "/psy/losos", en: "/dogs/salmon" },
  productPork: { pl: "/psy/wieprzowina", en: "/dogs/pork" },
  privateLabel: { en: "/private-label" },
};

export const SITE_ORIGIN = APP_SITE_ORIGIN;

/**
 * Hash-keyed dynamic routes. NIE w `routeMap` bo `findRouteKeyByPath`
 * porównuje pathname jako string i nie ogarnia `:hash` segmentu. Te
 * routes są noindex (meta/header + robots.txt Disallow), więc używamy
 * ich tylko jako konstanty do budowania URL-i (np. admin "Copy link"
 * button, FeedbackRedirect, generowanie URL-i w mailach).
 */
export const FEEDBACK_PUBLIC_PATH: Record<Lang, string> = {
  pl: "/moja-opinia",
  en: "/my-opinion",
};

export function feedbackPublicUrl(hash: string, lang: Lang): string {
  return `${FEEDBACK_PUBLIC_PATH[lang]}/${hash}`;
}

export function localizedPath(key: RouteKey, lang: Lang): string | undefined {
  return routeMap[key][lang];
}

export function absoluteUrl(path: string): string {
  return `${SITE_ORIGIN}${path}`;
}

export function findRouteKeyByPath(pathname: string): { key: RouteKey; lang: Lang } | null {
  const clean = pathname.replace(/\/$/, "") || "/";
  for (const key of Object.keys(routeMap) as RouteKey[]) {
    for (const lang of ["pl", "en"] as Lang[]) {
      const path = routeMap[key][lang];
      if (!path) continue;
      const p = path.replace(/\/$/, "") || "/";
      if (p === clean) return { key, lang };
    }
  }
  return null;
}

export function alternatePathForLang(pathname: string, targetLang: Lang): string {
  const match = findRouteKeyByPath(pathname);
  if (match) return routeMap[match.key][targetLang] ?? routeMap[match.key].en;
  return routeMap.home[targetLang] ?? routeMap.home.en;
}

export function alternatePathForLangPreservingState(
  pathname: string,
  targetLang: Lang,
  search = "",
  hash = "",
): string {
  return appendUrlState(alternatePathForLang(pathname, targetLang), search, hash);
}

export function localizedPathWithState(
  key: RouteKey,
  lang: Lang,
  search = "",
  hash = "",
): string {
  return appendUrlState(localizedPath(key, lang) ?? routeMap[key].en, search, hash);
}

function appendUrlState(path: string, search: string, hash: string): string {
  const safeSearch = search && search.startsWith("?") ? search : search ? `?${search}` : "";
  const safeHash = hash && hash.startsWith("#") ? hash : hash ? `#${hash}` : "";
  return `${path}${safeSearch}${safeHash}`;
}

/**
 * Resolve any `LocalizedRoute` — including one this registry does not own — in
 * the active language.
 *
 * Split out of `useLocalizedPath` for routes a deployment supplies rather than
 * the registry: `#checkout-terminal-route` hands back a route object, not a
 * `RouteKey`, precisely because the platform's own terminal is not one of this
 * deployment's keys. Key-based lookup keeps going through the wrapper below, so
 * both paths share one language rule instead of growing a second one.
 */
export function useLocalizedRoute() {
  const { i18n } = useTranslation("common");
  const lang = (i18n.language === "en" ? "en" : "pl") as Lang;
  // en is always defined on every route, so the fallback guarantees string (not undefined).
  return (route: LocalizedRoute): string => route[lang] ?? route.en;
}

export function useLocalizedPath() {
  const resolveRoute = useLocalizedRoute();
  return (key: RouteKey): string => resolveRoute(routeMap[key]);
}
