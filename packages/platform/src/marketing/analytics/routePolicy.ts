import type { AnalyticsRoutePolicyInput } from "../contracts/analytics.js";
export type { AnalyticsRoutePolicyInput } from "../contracts/analytics.js";
const CAMPAIGN_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;
const CAMPAIGN_VALUE = /^[A-Za-z0-9_-]{1,100}$/;
const NO_ADDITIONAL_PATHS: ReadonlySet<string> = new Set();

export function normalizeAnalyticsPathname(pathname: string): string {
  const withLeadingSlash = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const withoutTrailingSlash = withLeadingSlash.length > 1
    ? withLeadingSlash.replace(/\/+$/, "") : withLeadingSlash;
  return withoutTrailingSlash.toLowerCase();
}

/** Route manifests and sensitive paths are explicit host policy. */
export function createAnalyticsRoutePolicy(input: AnalyticsRoutePolicyInput) {
  const manifestPaths = new Set(input.publicPaths.map(normalizeAnalyticsPathname));
  const redirectPaths = new Set(input.redirectSources.filter(source => !source.includes(":"))
    .map(normalizeAnalyticsPathname));
  function isSensitiveAnalyticsPath(pathname: string): boolean {
    const capabilityPath = pathname.toLowerCase();
    return input.privatePathPrefixes.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`))
      || input.privateAuthPaths.includes(pathname)
      || input.capabilityPathPrefixes.some(prefix => capabilityPath === prefix || capabilityPath.startsWith(`${prefix}/`));
  }
  function isOptionalAnalyticsRouteEligible(pathname: string): boolean {
    return !isSensitiveAnalyticsPath(pathname);
  }
  function isDeploymentAnalyticsRouteEligible(pathname: string,
    additionalPublicPaths: ReadonlySet<string> = NO_ADDITIONAL_PATHS): boolean {
    const path = normalizeAnalyticsPathname(pathname);
    if (isSensitiveAnalyticsPath(path)) return false;
    return manifestPaths.has(path) || redirectPaths.has(path) || additionalPublicPaths.has(path);
  }
  function sanitizeDeploymentAnalyticsUrl(rawUrl: string, currentOrigin: string,
    additionalPublicPaths?: ReadonlySet<string>): string | null {
    let base: URL;
    let url: URL;
    try { base = new URL(currentOrigin); url = new URL(rawUrl, base); } catch { return null; }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password
      || url.origin !== base.origin) return null;
    const pathname = normalizeAnalyticsPathname(url.pathname);
    if (!isDeploymentAnalyticsRouteEligible(pathname, additionalPublicPaths)) return null;
    const campaign = new URLSearchParams();
    for (const key of CAMPAIGN_KEYS) {
      const values = url.searchParams.getAll(key);
      if (values.length === 1 && CAMPAIGN_VALUE.test(values[0]!)) campaign.set(key, values[0]!);
    }
    url.pathname = pathname;
    url.search = campaign.toString();
    url.hash = "";
    return url.href;
  }
  return { isSensitiveAnalyticsPath, isOptionalAnalyticsRouteEligible,
    isDeploymentAnalyticsRouteEligible, sanitizeDeploymentAnalyticsUrl };
}
