import { siteRedirects, siteRoutes } from "@/lib/siteRoutes";

const PRIVATE_PATH_PREFIXES = ["/admin", "/konto", "/account"];
const PRIVATE_AUTH_PATHS = ["/zaloguj-sie", "/sign-in"];
const CAPABILITY_PATH_PREFIXES = [
  "/moja-opinia",
  "/my-opinion",
  "/feedback",
  "/recenzja",
  "/review",
];
const CAMPAIGN_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
] as const;
const CAMPAIGN_VALUE = /^[A-Za-z0-9_-]{1,100}$/;
const NO_ADDITIONAL_PATHS: ReadonlySet<string> = new Set();

const MANIFEST_PATHS = new Set(siteRoutes.map(({ path }) => normalizeAnalyticsPathname(path)));
const MANIFEST_REDIRECT_PATHS = new Set(
  siteRedirects
    .filter(({ source }) => !source.includes(":"))
    .map(({ source }) => normalizeAnalyticsPathname(source)),
);

export function normalizeAnalyticsPathname(pathname: string): string {
  const withLeadingSlash = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const withoutTrailingSlash = withLeadingSlash.length > 1
    ? withLeadingSlash.replace(/\/+$/, "")
    : withLeadingSlash;
  return withoutTrailingSlash.toLowerCase();
}

export function isSensitiveAnalyticsPath(pathname: string): boolean {
  const capabilityPath = pathname.toLowerCase();
  return PRIVATE_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  ) ||
    PRIVATE_AUTH_PATHS.includes(pathname) ||
    CAPABILITY_PATH_PREFIXES.some(
      (prefix) => capabilityPath === prefix || capabilityPath.startsWith(`${prefix}/`),
    );
}

/** Preserve the existing GTM contract: every route except its sensitive set is eligible. */
export function isGtmAnalyticsRouteEligible(pathname: string): boolean {
  return !isSensitiveAnalyticsPath(pathname);
}

export function isDeploymentAnalyticsRouteEligible(
  pathname: string,
  additionalPublicPaths: ReadonlySet<string> = NO_ADDITIONAL_PATHS,
): boolean {
  const path = normalizeAnalyticsPathname(pathname);
  if (isSensitiveAnalyticsPath(path)) return false;
  return MANIFEST_PATHS.has(path) || MANIFEST_REDIRECT_PATHS.has(path) || additionalPublicPaths.has(path);
}

export function sanitizeDeploymentAnalyticsUrl(
  rawUrl: string,
  currentOrigin: string,
  additionalPublicPaths?: ReadonlySet<string>,
): string | null {
  let base: URL;
  let url: URL;
  try {
    base = new URL(currentOrigin);
    url = new URL(rawUrl, base);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.origin !== base.origin
  ) return null;
  const pathname = normalizeAnalyticsPathname(url.pathname);
  if (!isDeploymentAnalyticsRouteEligible(pathname, additionalPublicPaths)) return null;

  const campaign = new URLSearchParams();
  for (const key of CAMPAIGN_KEYS) {
    const values = url.searchParams.getAll(key);
    if (values.length === 1 && CAMPAIGN_VALUE.test(values[0]!)) {
      campaign.set(key, values[0]!);
    }
  }
  url.pathname = pathname;
  url.search = campaign.toString();
  url.hash = "";
  return url.href;
}
