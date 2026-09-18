import siteRoutesManifest from "../../config/site-routes.json" with { type: "json" };

export const ROBOTS_CONTENT_TYPE = "text/plain; charset=utf-8";
export const DENY_ALL_ROBOTS_TXT = "User-agent: *\nDisallow: /\n";
export const STAGING_ROBOTS_TXT = DENY_ALL_ROBOTS_TXT;

const productionHosts = new Set(siteRoutesManifest.productionHosts);
const privatePrefixes = siteRoutesManifest.crawlPolicy.privatePrefixes;

function rulesFor(agent: string, allowPublic: boolean): string {
  const lines = [`User-agent: ${agent}`];
  if (!allowPublic) return [...lines, "Disallow: /"].join("\n");
  lines.push("Allow: /");
  for (const prefix of privatePrefixes) lines.push(`Disallow: ${prefix}`);
  return lines.join("\n");
}

export const PRODUCTION_ROBOTS_TXT = [
  rulesFor("*", true),
  "# Search, user-requested retrieval and the existing training-crawler policy are explicit and separate.",
  rulesFor("OAI-SearchBot", true),
  rulesFor("ChatGPT-User", true),
  rulesFor("PerplexityBot", true),
  rulesFor("GPTBot", true),
  rulesFor("ClaudeBot", true),
  rulesFor("Google-Extended", true),
  rulesFor("CCBot", true),
  `Sitemap: ${siteRoutesManifest.siteOrigin}/sitemap.xml`,
  "",
].join("\n\n");

export function isProductionHost(host: string | string[] | undefined): boolean {
  const value = Array.isArray(host) ? host[0] : host;
  return productionHosts.has(normalizeHost(value));
}

export function isStagingHost(host: string | string[] | undefined): boolean {
  const value = Array.isArray(host) ? host[0] : host;
  return normalizeHost(value) === "staging.openlup.com";
}

export function robotsTxtForHost(host: string | string[] | undefined): string {
  return isProductionHost(host) ? PRODUCTION_ROBOTS_TXT : DENY_ALL_ROBOTS_TXT;
}

function normalizeHost(host: string | undefined): string {
  return (host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
}
