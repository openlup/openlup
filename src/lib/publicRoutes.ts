import { siteRedirects, siteRoutes } from "@/lib/siteRoutes";

export interface PublicStaticRoute {
  path: string;
  locale: "en" | "pl";
  htmlLang: string;
  ogLocale: string;
  seoPath: string[];
  ogImageSlug: string;
  routeModule?: string;
  lcpAsset?: string;
}

export interface PublicLegacyRedirect {
  source: string;
  destination: string;
  permanent: boolean;
  clientPrefix?: {
    from: string;
    to: string;
  };
}

export interface PublicRoutesManifest {
  staticRoutes: PublicStaticRoute[];
  legacyRedirects: PublicLegacyRedirect[];
}

export const publicStaticRoutes: PublicStaticRoute[] = siteRoutes
  .filter((route) => route.delivery === "ssg" && route.path !== "/")
  .map((route) => ({
    path: route.path.replace(/^\//, ""),
    locale: route.locale,
    htmlLang: route.htmlLang,
    ogLocale: route.ogLocale,
    seoPath: route.seoPath,
    ogImageSlug: route.ogImageSlug,
    ...(route.routeModule ? { routeModule: route.routeModule } : {}),
    ...(route.lcpAsset ? { lcpAsset: route.lcpAsset } : {}),
  }));
export const publicLegacyRedirects = siteRedirects;
export const publicRoutes: PublicRoutesManifest = {
  staticRoutes: publicStaticRoutes,
  legacyRedirects: publicLegacyRedirects,
};

export function canonicalizeLegacyPublicPathname(pathname: string): string | null {
  const clean = normalizePublicPathname(pathname);
  for (const redirect of publicLegacyRedirects) {
    if (!redirect.source.includes(":") && normalizePublicPathname(redirect.source) === clean) {
      return redirect.destination;
    }
  }

  for (const redirect of publicLegacyRedirects) {
    const prefix = redirect.clientPrefix;
    if (prefix && clean.startsWith(prefix.from)) {
      return `${prefix.to}${clean.slice(prefix.from.length)}`;
    }
  }

  return null;
}

export function normalizePublicPathname(pathname: string): string {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path;
}
