import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { validateSiteRouteManifest } from "./site-routes.mjs";

const publicReference = () => JSON.parse(readFileSync("config/public-reference-site-routes.json", "utf8"));

describe("public reference site routes", () => {
  it("keeps the bounded noindex list and detail documents valid", () => {
    const manifest = validateSiteRouteManifest(publicReference());

    expect(manifest.siteLifecycle).toBe("public-reference");
    expect(manifest.routes.map((route: { path: string }) => route.path)).toEqual(["/", "/items/field-notes"]);
    expect(manifest.routes.every((route: { delivery: string; indexable: boolean; sitemap: boolean }) =>
      route.delivery === "ssg" && !route.indexable && !route.sitemap)).toBe(true);
  });

  it("refuses public-reference drift into redirects, fallback, or indexed documents", () => {
    const redirect = publicReference();
    redirect.legacyRedirects.push({ source: "/old", destination: "/", permanent: true });
    expect(() => validateSiteRouteManifest(redirect)).toThrow(/must not declare redirects/);

    const fallback = publicReference();
    fallback.csrFallback.exactPaths = ["/account"];
    expect(() => validateSiteRouteManifest(fallback)).toThrow(/must not declare redirects/);

    const indexed = publicReference();
    indexed.routes[0].indexable = true;
    indexed.routes[0].sitemap = true;
    expect(() => validateSiteRouteManifest(indexed)).toThrow(/must remain a noindex/);
  });
});
