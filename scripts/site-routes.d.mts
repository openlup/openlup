/** Validated route fields consumed by source tooling and its witnesses. */
export interface SiteRouteManifest {
  siteLifecycle: "prelaunch" | "storefront" | "public-reference";
  siteOrigin: string;
  routes: Array<{
    path: string;
    canonicalPath: string;
    delivery: "ssg" | "csr";
    indexable: boolean;
    sitemap: boolean;
  }>;
}

export function validateSiteRouteManifest(manifest: unknown): SiteRouteManifest;
export function loadSiteRouteManifest(root?: string): SiteRouteManifest;
