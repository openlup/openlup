import siteRoutesManifest from "../../config/site-routes.json";

export type SiteLifecycle = "prelaunch" | "storefront";
export type SiteLocale = "pl" | "en";
export type SiteDelivery = "ssg" | "csr";
export type StructuredDataKind =
  | "organization"
  | "website"
  | "product"
  | "contact"
  | "service"
  | "breadcrumb"
  | "faq";

export interface SiteRoute {
  id: string;
  path: string;
  locale: SiteLocale;
  delivery: SiteDelivery;
  indexable: boolean;
  sitemap: boolean;
  canonicalPath: string;
  alternateRouteId?: string;
  seoKey: string;
  contentSentinel: string;
  structuredData: StructuredDataKind[];
  htmlLang: string;
  ogLocale: string;
  seoPath: string[];
  ogImageSlug: string;
  routeModule?: string;
  lcpAsset?: string;
  lcpAssetWide?: string;
}

export interface SiteRedirect {
  source: string;
  destination: string;
  permanent: boolean;
  clientPrefix?: { from: string; to: string };
}

export interface SiteRouteManifest {
  schemaVersion: 1;
  siteOrigin: string;
  productionHosts: string[];
  siteLifecycle: SiteLifecycle;
  routes: SiteRoute[];
  legacyRedirects: SiteRedirect[];
  crawlPolicy: { privatePrefixes: string[] };
}

export interface HreflangLink {
  hrefLang: SiteLocale | "x-default";
  href: string;
}

export const siteRouteManifest = siteRoutesManifest as SiteRouteManifest;
export const siteOrigin = siteRouteManifest.siteOrigin.replace(/\/$/, "");
export const siteLifecycle = siteRouteManifest.siteLifecycle;
export const siteRoutes = siteRouteManifest.routes;
export const siteRedirects = siteRouteManifest.legacyRedirects;
export const ssgRoutes = siteRoutes.filter((route) => route.delivery === "ssg" && route.indexable);
export const siteRoutesByPath = new Map(siteRoutes.map((route) => [route.path, route]));
export const siteRoutesById = new Map(siteRoutes.map((route) => [route.id, route]));

export function normalizeSitePath(pathname: string): string {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return path.length > 1 ? path.replace(/\/$/, "") : path;
}

export function siteRouteForPath(pathname: string): SiteRoute | undefined {
  return siteRoutesByPath.get(normalizeSitePath(pathname));
}

export function alternateSiteRoute(route: SiteRoute): SiteRoute | undefined {
  return route.alternateRouteId ? siteRoutesById.get(route.alternateRouteId) : undefined;
}

export function absoluteSiteUrl(pathname: string): string {
  const path = normalizeSitePath(pathname);
  return path === "/" ? `${siteOrigin}/` : `${siteOrigin}${path}`;
}

export function canonicalUrlForRoute(route: SiteRoute): string {
  return absoluteSiteUrl(route.canonicalPath);
}

export function hreflangLinksForRoute(route: SiteRoute): HreflangLink[] {
  const alternate = alternateSiteRoute(route);
  if (!alternate) return [];
  const pair = [route, alternate].sort((a, b) => a.locale.localeCompare(b.locale));
  const polish = pair.find((candidate) => candidate.locale === "pl");
  return [
    ...pair.map((candidate) => ({
      hrefLang: candidate.locale,
      href: canonicalUrlForRoute(candidate),
    })),
    {
      hrefLang: "x-default" as const,
      href: canonicalUrlForRoute(polish ?? pair[0]),
    },
  ];
}
