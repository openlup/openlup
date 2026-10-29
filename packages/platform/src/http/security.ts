// Security headers + SPA static middleware for the Node HttpRuntimePort.
//
// Replicates, as Node middleware, a hosted response surface whose values the deployment owns:
// the global headers (HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy,
// Permissions-Policy, Reporting-Endpoints, the content security policy), the path-specific
// Cache-Control and X-Robots-Tag rules, and which hosts are production. The caller supplies all of
// them through `NodeSecurityHeaderPolicy`; this module only applies them in a fixed order.
//
// SPA fallback boundary: the runtime handles its API and entrypoint branches before static
// serving, so those paths never fall through to a document.

import { extname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { HttpResponse } from "./types.js";

/** Deployment-owned header policy applied to every response of the Node runtime. */
export interface NodeSecurityHeaderPolicy {
  /** Headers set on every response unless the handler already set them, in this order. */
  readonly globalHeaders: ReadonlyArray<readonly [string, string]>;
  /** Static-asset path prefixes that receive the long-lived asset Cache-Control. */
  readonly assetCachePrefixes: readonly string[];
  /** Path families (the path or anything below it) that receive `X-Robots-Tag: noindex, nofollow`. */
  readonly noindexFamilies: readonly string[];
  /** Exact paths that receive `X-Robots-Tag: noindex, nofollow`. */
  readonly noindexExacts: readonly string[];
  /** True for a production host; every other host receives the strict non-production X-Robots-Tag. */
  readonly isProductionHost: (host: string | undefined) => boolean;
}

const ASSET_CACHE_CONTROL =
  "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800";

function matchesNoindex(policy: NodeSecurityHeaderPolicy, pathname: string): boolean {
  if (policy.noindexExacts.includes(pathname)) return true;
  return policy.noindexFamilies.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/** Apply the deployment's global and path-specific headers for this route. */
export function applySecurityHeaders(
  res: ServerResponse,
  pathname: string,
  host: string | undefined,
  policy: NodeSecurityHeaderPolicy,
): void {
  for (const [key, value] of policy.globalHeaders) {
    if (!res.hasHeader(key)) res.setHeader(key, value);
  }
  if (policy.assetCachePrefixes.some((p) => pathname.startsWith(p))) {
    res.setHeader("Cache-Control", ASSET_CACHE_CONTROL);
  }
  if (pathname === "/.well-known/security.txt") {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
  }
  if (pathname === "/ssg-manifest.json" || pathname === "/spa-fallback.html") {
    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=0, must-revalidate");
  }
  if (matchesNoindex(policy, pathname)) {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
  }
  if (!policy.isProductionHost(host)) {
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet, noimageindex");
  }
}

/** Pluggable static reader so tests can inject an in-memory dist/ without touching the filesystem. */
export interface StaticAssetReader {
  /** Read a built asset (returns null if it does not exist). */
  read(relativePath: string): Promise<{ body: Buffer; contentType: string } | null>;
  /** The SPA fallback document (dist/index.html). */
  readIndex(): Promise<{ body: Buffer; contentType: string }>;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

export function contentTypeFor(pathname: string): string {
  return CONTENT_TYPES[extname(pathname).toLowerCase()] ?? "application/octet-stream";
}

/** A path "looks like" a built asset if it has a file extension (so we 404 missing assets, not SPA). */
export function looksLikeAsset(pathname: string): boolean {
  return extname(pathname) !== "";
}

/**
 * Try the initial asset read; return a found asset with 200. If the read misses
 * and the path looks like an asset, return 404. Otherwise, when
 * `allowRouteDocument` is true and its
 * lookup finds a route document, return that document with 200. If no route
 * document was returned, `allowFallback` true returns the SPA index with 200;
 * otherwise return 404. Both flags default to false. The host must enable these
 * options only for admitted routes; this helper does not identify application
 * routes.
 *
 * The middle step is not decoration. The build writes each pre-rendered route as
 * `<route>/index.html` and writes the HOME document to `index.html`; skipping that lookup hands
 * every admitted pre-rendered URL the home document instead of its own. The host
 * supplies the route-document and fallback decisions; this helper does not infer
 * application routes.
 */
export async function serveSpaStatic(
  _req: IncomingMessage,
  res: HttpResponse,
  pathname: string,
  reader: StaticAssetReader,
  allowRouteDocument = false,
  allowFallback = false,
): Promise<void> {
  const relative = pathname === "/" ? "/index.html" : pathname;
  const asset = await reader.read(relative);
  if (asset) {
    if (!res.hasHeader("content-type")) res.setHeader("content-type", asset.contentType);
    res.statusCode = 200;
    res.end(asset.body);
    return;
  }
  if (looksLikeAsset(pathname)) {
    // A concrete asset request that does not exist -> genuine 404 (not the SPA shell).
    res.statusCode = 404;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Not Found");
    return;
  }
  // A manifest-declared SSG route -> its own pre-rendered document.
  if (allowRouteDocument) {
    const document = await reader.read(`${pathname.replace(/\/+$/, "")}/index.html`);
    if (document) {
      if (!res.hasHeader("content-type")) res.setHeader("content-type", document.contentType);
      res.statusCode = 200;
      res.end(document.body);
      return;
    }
  }
  if (!allowFallback) {
    res.statusCode = 404;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Not Found");
    return;
  }
  // Declared client route -> SPA fallback.
  const index = await reader.readIndex();
  res.statusCode = 200;
  if (!res.hasHeader("content-type")) res.setHeader("content-type", index.contentType);
  res.end(index.body);
}
