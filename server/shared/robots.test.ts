import { describe, expect, it } from "vitest";

import siteRoutesManifest from "../../config/site-routes.json" with { type: "json" };
import {
  DENY_ALL_ROBOTS_TXT,
  PRODUCTION_ROBOTS_TXT,
  isProductionHost,
  isStagingHost,
  robotsTxtForHost,
} from "./robots.js";

/**
 * The same manifest ./robots.ts reads, and publication PROJECTS it: the published tree carries a
 * neutral public-reference manifest with a different origin, one different production host and an
 * empty crawl policy. So the hosts, the sitemap origin and the private prefixes below are read
 * from the manifest rather than written as this deployment's literals - what this file is about is
 * the SELECTION, which is identical in both trees. What stays literal is what ./robots.ts itself
 * hardcodes and publication cannot change: the deny-all body, the staging host, and the named
 * crawler groups.
 *
 * ⛔ Not a place for facts about THIS deployment's route manifest. That `/admin`, `/account` and
 * `/personalizer` are private is a claim about `config/site-routes.json`, and it is pinned where
 * the manifest's other deployment facts already are:
 * `src/lib/hiddenRouteDeploymentGuardrails.test.ts`.
 */
const { productionHosts, siteOrigin, crawlPolicy } = siteRoutesManifest;

describe("robots.txt selection", () => {
  it("fails closed for staging, previews, local hosts and missing host headers", () => {
    for (const host of ["staging.openlup.com", "openlup-git-main.vercel.app", "localhost:5173", undefined]) {
      expect(robotsTxtForHost(host)).toBe(DENY_ALL_ROBOTS_TXT);
    }
    expect(isStagingHost("Staging.openlup.com:443")).toBe(true);
  });

  it("allows only canonical production hosts to publish the production policy", () => {
    expect(productionHosts.length).toBeGreaterThan(0);
    for (const host of productionHosts) {
      expect(isProductionHost(host)).toBe(true);
      expect(isProductionHost(`${host.toUpperCase()}:443`)).toBe(true);
      expect(robotsTxtForHost(host)).toBe(PRODUCTION_ROBOTS_TXT);
      // A near miss is not a canonical host: the match is the whole normalized name, never a suffix.
      expect(isProductionHost(`not-${host}`)).toBe(false);
      expect(isProductionHost(`${host}.example`)).toBe(false);
    }
    expect(PRODUCTION_ROBOTS_TXT).toContain(`Sitemap: ${siteOrigin}/sitemap.xml`);
  });

  it("makes search and the existing model-training crawler policy explicit", () => {
    expect(PRODUCTION_ROBOTS_TXT).toContain("User-agent: OAI-SearchBot\nAllow: /");
    expect(PRODUCTION_ROBOTS_TXT).toContain("User-agent: ChatGPT-User\nAllow: /");
    expect(PRODUCTION_ROBOTS_TXT).toContain("User-agent: GPTBot\nAllow: /");
    expect(PRODUCTION_ROBOTS_TXT).toContain("User-agent: ClaudeBot\nAllow: /");
  });

  it("renders the manifest's crawl policy into the public group, exactly and in order", () => {
    // EXACT, not one `toContain` per prefix. A per-prefix loop is vacuously true for a manifest
    // whose crawl policy is empty - which is what publication projects - and it would not notice
    // a reordered or an EXTRA rule either. Pinning the whole group says both things at once, and
    // is falsifiable in both trees.
    const rules = ["Allow: /", ...crawlPolicy.privatePrefixes.map((prefix) => `Disallow: ${prefix}`)].join("\n");
    const groups = PRODUCTION_ROBOTS_TXT.split("\n\n").filter((block) => block.startsWith("User-agent: "));
    expect(groups.length).toBeGreaterThan(1);
    // And the same rules for EVERY named crawler, not just the wildcard: a group that quietly
    // drops the private prefixes for one agent is the defect worth catching here.
    for (const group of groups) {
      const [agent, ...body] = group.split("\n");
      expect(body.join("\n"), agent).toBe(rules);
    }
  });
});
