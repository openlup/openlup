import type { Locale } from './config.ts';

export const routes = {
  home: { en: '/', pl: '/pl' },
  catalog: { en: '/products', pl: '/produkty' },
  builder: { en: '/build-your-box', pl: '/skomponuj-pakiet' },
  cart: { en: '/cart', pl: '/koszyk' },
  checkout: { en: '/checkout', pl: '/zamowienie' },
  account: { en: '/account', pl: '/konto' },
  repair: { en: '/account/payment/recover', pl: '/konto/platnosc/napraw' },
  completion: { en: '/account/complete-payment', pl: '/konto/dokoncz-platnosc' },
  returns: { en: '/returns', pl: '/zwroty' },
  terms: { en: '/terms', pl: '/regulamin' },
  invoices: { en: '/account/orders', pl: '/konto/zamowienia' },
  admin: { en: '/admin', pl: '/pl/admin' },
  unsubscribe: { en: '/unsubscribe', pl: '/pl/unsubscribe' },
  legacyUnsubscribe: { en: '/unsubscribe/legacy', pl: '/pl/unsubscribe/legacy' },
  auth: { en: '/auth/sign-in', pl: '/pl/auth/sign-in' },
  callback: { en: '/auth/callback', pl: '/pl/auth/callback' },
  support: { en: '/support', pl: '/pomoc' },
  tracking: { en: '/tracking', pl: '/przesylka' },
  review: { en: '/review', pl: '/opinia' },
  acquisition: { en: '/participate', pl: '/zgloszenie' },
  research: { en: '/research', pl: '/badanie' },
  partners: { en: '/partners', pl: '/partnerzy' },
  limits: { en: '/limits', pl: '/ograniczenia' },
  destinations: { en: '/destinations', pl: '/linki' },
} as const;

export type RouteKey = keyof typeof routes;

export interface ResolvedRoute {
  key: RouteKey | 'product' | 'notFound';
  locale: Locale;
  slug?: string;
}

export function resolveRoute(path: string): ResolvedRoute {
  const clean = path.length > 1 ? path.replace(/\/+$/, '') : path;
  for (const [key, locales] of Object.entries(routes)) {
    for (const locale of ['en', 'pl'] as const) {
      if (locales[locale] === clean) return { key: key as RouteKey, locale };
    }
  }
  for (const locale of ['en', 'pl'] as const) {
    const prefix = `${routes.catalog[locale]}/`;
    if (clean.startsWith(prefix)) {
      try {
        return { key: 'product', locale, slug: decodeURIComponent(clean.slice(prefix.length)) };
      } catch {
        return { key: 'notFound', locale };
      }
    }
  }
  return { key: 'notFound', locale: clean.startsWith('/pl') ? 'pl' : 'en' };
}

export function productPath(slug: string, locale: Locale): string {
  return `${routes.catalog[locale]}/${encodeURIComponent(slug)}`;
}

/** These host destinations are also used in captured demo messages. */
export const messageDestinations: readonly { id: string; route: RouteKey; query?: string; hash?: string }[] = [
  { id: 'T07-01', route: 'builder' },
  { id: 'T07-02', route: 'account' },
  { id: 'T07-03', route: 'repair', query: 'token=invalid-demo-token' },
  { id: 'T07-04', route: 'completion', query: 'order=invalid-demo-order' },
  { id: 'T07-05', route: 'returns' },
  { id: 'T07-06', route: 'terms' },
  { id: 'T07-07', route: 'invoices' },
  { id: 'T07-08', route: 'admin' },
  { id: 'T07-09', route: 'unsubscribe', query: 'token=invalid-demo-token' },
  { id: 'T07-10', route: 'legacyUnsubscribe' },
  { id: 'T07-11', route: 'auth' },
  { id: 'T07-12', route: 'admin', hash: 'partners' },
  { id: 'T07-13', route: 'support' },
  { id: 'T07-14', route: 'tracking', query: 'shipment=invalid-demo-shipment' },
  { id: 'T07-15', route: 'review', query: 'grant=invalid-demo-grant' },
];
