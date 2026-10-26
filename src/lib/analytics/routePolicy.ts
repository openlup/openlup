import { siteRedirects, siteRoutes } from "@/lib/siteRoutes";
import { createAnalyticsRoutePolicy } from "@openlup/platform/marketing";
export { normalizeAnalyticsPathname } from "@openlup/platform/marketing";

const policy = createAnalyticsRoutePolicy({
  publicPaths: siteRoutes.map(({ path }) => path),
  redirectSources: siteRedirects.map(({ source }) => source),
  privatePathPrefixes: ["/admin", "/konto", "/account"],
  privateAuthPaths: ["/zaloguj-sie", "/sign-in"],
  capabilityPathPrefixes: ["/moja-opinia", "/my-opinion", "/feedback", "/recenzja", "/review"],
});
export const { isSensitiveAnalyticsPath, isDeploymentAnalyticsRouteEligible,
  sanitizeDeploymentAnalyticsUrl } = policy;
export const isGtmAnalyticsRouteEligible = policy.isOptionalAnalyticsRouteEligible;
