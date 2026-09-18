// Security headers + SPA static middleware for the Node HttpRuntimePort (Platform Portability, W3).
//
// Replicates — as Node middleware — the reference host response surface; adopters own equivalent
// provider configuration (HSTS, X-Content-Type-Options, X-Frame-Options DENY,
// Referrer-Policy, Permissions-Policy, Reporting-Endpoints, CSP-Report-Only, the path-specific
// Cache-Control + X-Robots-Tag rules) AND the SPA-fallback rewrite (non-API/non-asset routes ->
// dist/index.html). The header values are reference-host defaults so a self-hosted
// node-postgres bundle can preserve the same browser-facing policy when explicitly adopted.
//
// SPA fallback boundary (mirrors the catch-all rewrite's negative-lookahead): never fall through
// /api/, /labels/, or /c/ to index.html — those are handled by the runtime's API/share branches.

import { extname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { HttpResponse } from "../../_lib/types/http.js";
import { isProductionHost } from "../../shared/robots.js";

const GEO_WIDGET_ORIGIN = new URL("https://geowidget.inpost.pl").origin;
const PARCEL_WILDCARD_ORIGIN = new URL("https://*.inpost.pl").origin;

/** Reference-host security headers applied to every response. */
const GLOBAL_SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload"],
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["Permissions-Policy", "camera=(), microphone=(), geolocation=(self), browsing-topics=()"],
  ["Reporting-Endpoints", 'csp-endpoint="/api/csp-report"'],
  [
    "Content-Security-Policy-Report-Only",
    `default-src 'self'; script-src 'self' https://www.googletagmanager.com https://js.stripe.com ${GEO_WIDGET_ORIGIN}; style-src 'self' 'unsafe-inline' https://api.fontshare.com https://fonts.googleapis.com ${GEO_WIDGET_ORIGIN}; font-src 'self' https://fonts.gstatic.com https://api.fontshare.com https://cdn.fontshare.com; img-src 'self' data: https://*.supabase.co https://openlup.com https://www.googletagmanager.com https://*.google-analytics.com ${GEO_WIDGET_ORIGIN} ${PARCEL_WILDCARD_ORIGIN} https://*.easypack24.net; media-src 'self' https://*.supabase.co blob:; connect-src 'self' https://*.supabase.co https://js.stripe.com https://vitals.vercel-insights.com https://www.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com ${GEO_WIDGET_ORIGIN} https://*.easypack24.net ${PARCEL_WILDCARD_ORIGIN}; frame-src https://js.stripe.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; report-uri /api/csp-report; report-to csp-endpoint`,
  ],
];

const ASSET_CACHE_CONTROL =
  "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800";

/** Static-asset prefixes that get the long-lived Cache-Control (fragment per-source rules). */
const CACHE_PREFIXES = ["/hero/", "/testimonials/", "/can-images/", "/labels/", "/og/"] as const;

/** Path prefixes/exacts that get X-Robots-Tag noindex (fragment per-source rules). */
const NOINDEX_FAMILIES = [
  "/moja-opinia",
  "/my-opinion",
  "/feedback",
  "/recenzja",
  "/review",
  "/v2",
  "/en/v2",
  // robots.txt already disallows /admin, but a Disallow only asks; it does not deindex,
  // and it does not bind crawlers that ignore it.
  "/admin",
  "/skomponuj-pakiet",
  "/build-your-box",
  "/konto",
  "/account",
] as const;

const NOINDEX_EXACTS = new Set([
  "/regulamin-first-tasters",
  "/first-tasters-terms",
  "/zrob-puszke",
  "/your-dog-on-a-can",
  "/zaloguj-sie",
  "/sign-in",
  "/konto",
  "/account",
]);

function matchesNoindex(pathname: string): boolean {
  if (NOINDEX_EXACTS.has(pathname)) return true;
  return NOINDEX_FAMILIES.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/** Apply the reference-host global and path-specific headers for this route. */
export function applySecurityHeaders(res: ServerResponse, pathname: string, host?: string): void {
  for (const [key, value] of GLOBAL_SECURITY_HEADERS) {
    if (!res.hasHeader(key)) res.setHeader(key, value);
  }
  if (CACHE_PREFIXES.some((p) => pathname.startsWith(p))) {
    res.setHeader("Cache-Control", ASSET_CACHE_CONTROL);
  }
  if (pathname === "/.well-known/security.txt") {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
  }
  if (pathname === "/ssg-manifest.json" || pathname === "/spa-fallback.html") {
    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=0, must-revalidate");
  }
  if (matchesNoindex(pathname)) {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
  }
  if (!isProductionHost(host)) {
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
 * Serve a built SPA asset if present, otherwise the document the build produced for this route,
 * otherwise the declared CSR fallback for client routes. Missing real assets (a hashed bundle that
 * does not exist) and unknown extensionless paths return 404 rather than the SPA shell.
 *
 * The middle step is not decoration. The build writes each pre-rendered route as
 * `<route>/index.html` and writes the HOME document to `index.html`; skipping that lookup hands
 * every pre-rendered URL the home document instead of its own. The hosted platform does the same
 * thing declaratively, one rewrite per route, which is why this host had no equivalent code.
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
