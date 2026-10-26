export interface SiteRoute {
  id: string;
  locale: string;
  canonicalPath: string;
  alternateRouteId?: string;
}

export interface HreflangLink { hrefLang: string; href: string }

export function normalizeSitePath(pathname: string): string {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return path.length > 1 ? path.replace(/\/$/, "") : path;
}

export function absoluteSiteUrl(origin: string, pathname: string): string {
  const site = origin.replace(/\/$/, "");
  const path = normalizeSitePath(pathname);
  return path === "/" ? `${site}/` : `${site}${path}`;
}

export function canonicalUrlForRoute(origin: string, route: SiteRoute): string {
  return absoluteSiteUrl(origin, route.canonicalPath);
}

export function hreflangLinksForRoute(origin: string, route: SiteRoute, routes: readonly SiteRoute[], xDefaultLocale: string): HreflangLink[] {
  const alternate = route.alternateRouteId ? routes.find((candidate) => candidate.id === route.alternateRouteId) : undefined;
  if (!alternate) return [];
  const pair = [route, alternate].sort((a, b) => a.locale.localeCompare(b.locale));
  const preferred = pair.find((candidate) => candidate.locale === xDefaultLocale);
  return [
    ...pair.map((candidate) => ({ hrefLang: candidate.locale, href: canonicalUrlForRoute(origin, candidate) })),
    { hrefLang: "x-default", href: canonicalUrlForRoute(origin, preferred ?? pair[0]) },
  ];
}
