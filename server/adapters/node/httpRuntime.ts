// Native Node adapter for manifest-driven public routing and API topology.

import { createServer, type Server } from "node:http";

import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";
import type { HttpRuntimePort } from "../../../src/domains/platform-runtime/ports.js";
import { dispatch, type RouteEntry } from "../../runtime/bffDispatch.js";
import { ROBOTS_CONTENT_TYPE, robotsTxtForHost } from "../../shared/robots.js";
import {
  adaptRequest,
  decorateRequest,
  decorateResponse,
  NodeRequestAbortedError,
  NodeRequestBodyTooLargeError,
} from "./httpRequestAdapter.js";
import { closeInputAfterResponse, runWithHttpDeadline } from "./httpDeadline.js";
import {
  applySecurityHeaders,
  serveSpaStatic,
  type StaticAssetReader,
} from "./httpSecurity.js";

export { isRawStreamEntrypoint, isWebhookPath, adaptRequest, decorateResponse } from "./httpRequestAdapter.js";

/** Lazily-loaded module exposing one default-export handler. */
export type EntrypointLoader = () => Promise<{ default: HttpHandler }>;

/** Default-export handler shape shared by every physical API entrypoint. */
type HttpHandler = (req: HttpRequest, res: HttpResponse) => Promise<unknown> | unknown;

const SCHEDULED_PREFIX = "/api/cron/";
const EMPTY_ROUTING = { legacyRedirects: [], ssgPaths: [], csrFallback: { exactPaths: [], routeFamilies: [] } };

function requestUrl(req: HttpRequest): URL {
  return new URL(req.url ?? "/", "http://node.local");
}

function capturesFor(source: string, pathname: string): Record<string, string> | null {
  const sourceParts = source.split("/").slice(1);
  const pathParts = pathname.split("/").slice(1);
  const captures: Record<string, string> = {};
  let cursor = 0;
  for (const sourcePart of sourceParts) {
    if (!sourcePart.startsWith(":")) {
      if (pathParts[cursor++] !== sourcePart) return null;
      continue;
    }
    const name = sourcePart.slice(1).replace(/\*$/, "");
    if (sourcePart.endsWith("*")) {
      captures[name] = pathParts.slice(cursor).join("/");
      cursor = pathParts.length;
      break;
    }
    const value = pathParts[cursor++];
    if (!value) return null;
    captures[name] = value;
  }
  return cursor === pathParts.length ? captures : null;
}

function legacyRedirect(pathname: string, redirects: readonly NodeLegacyRedirect[]): string | null {
  for (const redirect of redirects) {
    const captures = capturesFor(redirect.source, pathname);
    if (!captures) continue;
    return redirect.destination.replace(/:([A-Za-z][A-Za-z0-9_]*)\*?/g, (_match, name: string) => captures[name] ?? "");
  }
  return null;
}

function isCsrFallback(pathname: string, csrFallback: NodeCsrFallback): boolean {
  return csrFallback.exactPaths.includes(pathname)
    || csrFallback.routeFamilies.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

function productCanonicalization(pathname: string) {
  const match = /^\/(psy|dogs)\/([^/]+)\/(.+)$/.exec(pathname);
  if (!match) return null;
  const [, family, slug, tail] = match;
  const lang = family === "psy" ? "pl" as const : "en" as const;
  return { lang, path: `${slug}/${tail}`, slug, tail };
}

/** One deployment-specific standalone entrypoint. */
export interface HttpEntrypointRegistration {
  path: string;
  rawStream?: boolean;
  maxDurationMs?: number;
  load: () => Promise<{ default: HttpHandler }>;
}

export interface NodeLegacyRedirect {
  source: string;
  destination: string;
  permanent: boolean;
}

export interface NodeCsrFallback {
  exactPaths: readonly string[];
  routeFamilies: readonly string[];
}

export interface NodeHttpRuntimeOptions {
  /** The generated BFF route table (222 entries on this baseline). */
  routes: readonly RouteEntry[];
  /** Validated public-route contract supplied by the host composition root. */
  routing?: {
    legacyRedirects: readonly NodeLegacyRedirect[];
    ssgPaths: readonly string[];
    csrFallback: NodeCsrFallback;
  };
  /** Platform-owned standalone handlers. */
  entrypoints: {
    share: () => Promise<{ default: HttpHandler }>;
    productCanonicalizer?: () => Promise<{ default: HttpHandler }>;
    cspReport: () => Promise<{ default: HttpHandler }>;
    bffRouter: () => Promise<{ default: HttpHandler }>;
    platformWatchdog: () => Promise<{ default: HttpHandler }>;
  };
  /** Deployment standalone handlers (`#extra-http-entries`). */
  extraEntrypoints?: readonly HttpEntrypointRegistration[];
  /** Registry-derived allowlist; undeclared job ids must resolve null. */
  scheduledEntrypoint?: (jobId: string) => EntrypointLoader | null;
  /** Explicit host deadlines; missing cells use the bounded defaults below. */
  durations?: {
    bff?: number;
    share?: number;
    productCanonicalizer?: number;
    cspReport?: number;
    bffRouter?: number;
    platformWatchdog?: number;
    scheduled?: (jobId: string) => number;
  };
  /** Static SPA reader; defaults to a `dist/`-backed filesystem reader. */
  staticReader?: StaticAssetReader;
  /** Structured error sink (defaults to console.error). */
  onError?: (context: string, error: unknown) => void;
}

function finalize(res: HttpResponse): void {
  if (!res.writableEnded && !res.destroyed) res.end();
}

/** Build the runtime's request handler (exported for unit tests; wraps every dispatch path). */
export function createRequestHandler(options: NodeHttpRuntimeOptions): HttpRuntimePort["handle"] {
  const onError = options.onError ?? ((ctx, err) => console.error(`[node-http] ${ctx}`, err));
  const staticReader = options.staticReader;
  const routing = options.routing ?? EMPTY_ROUTING;
  const ssgPaths = new Set(routing.ssgPaths);
  // Built once; a deployment can deliberately replace an inherited path.
  const extra = new Map((options.extraEntrypoints ?? []).map((entry) => [entry.path, entry]));

  return async function handle(req: HttpRequest, res: HttpResponse): Promise<void> {
    const url = requestUrl(req);
    const pathname = url.pathname;
    const host = req.headers.host;
    const bounded = (durationMs: number, run: () => Promise<unknown> | unknown) =>
      runWithHttpDeadline({ req, res, durationMs, run, onLateError: (error) => onError(`${pathname}:late`, error) });
    const invoke = (
      loader: EntrypointLoader,
      durationMs: number,
      rawStream?: boolean,
      query?: Record<string, string>,
    ) => bounded(durationMs, async () => {
      const [mod, vreq] = await Promise.all([loader(), adaptRequest(req, pathname, rawStream)]);
      if (query) vreq.query = { ...vreq.query, ...query };
      await mod.default(vreq, res);
    });
    try {
      applySecurityHeaders(res, pathname, host);
      if (pathname.length > 1 && pathname.endsWith("/")) {
        res.statusCode = 308;
        res.setHeader("location", `${pathname.replace(/\/+$/, "")}${url.search}`);
        return finalize(res);
      }
      // 1. Standalone entrypoints (filesystem-parity with api/*.ts).
      if (pathname === "/api/csp-report") {
        await invoke(options.entrypoints.cspReport, options.durations?.cspReport ?? 30_000);
        return finalize(res);
      }
      // 1b. Deployment entrypoints: exact path, lazy load, owner-declared body policy.
      const registered = extra.get(pathname);
      if (registered) {
        await invoke(registered.load, registered.maxDurationMs ?? 30_000, registered.rawStream);
        return finalize(res);
      }
      if (pathname === "/api/bff-router") {
        await invoke(options.entrypoints.bffRouter, options.durations?.bffRouter ?? 30_000);
        return finalize(res);
      }
      if (pathname === "/api/ops/platform-watchdog") {
        await invoke(options.entrypoints.platformWatchdog, options.durations?.platformWatchdog ?? 60_000);
        return finalize(res);
      }
      if (pathname === "/api/c" || pathname.startsWith("/api/c/") || pathname.startsWith("/c/")) {
        await invoke(options.entrypoints.share, options.durations?.share ?? 10_000, false, {
          slug: pathname.replace(/^\/(api\/)?c\//, ""),
        });
        return finalize(res);
      }

      // 2. The BFF dispatcher (same routes + dispatch as Vercel).
      if (pathname === "/api/bff" || pathname.startsWith("/api/bff/")) {
        await bounded(options.durations?.bff ?? 30_000, async () =>
          dispatch(options.routes, await adaptRequest(req, pathname), res));
        return finalize(res);
      }

      if (pathname === "/robots.txt") {
        res.statusCode = 200;
        res.setHeader("content-type", ROBOTS_CONTENT_TYPE);
        res.setHeader("cache-control", "public, max-age=0, s-maxage=300, stale-while-revalidate=3600");
        res.end(robotsTxtForHost(host));
        return;
      }

      // 3. Scheduled routes share the scheduler's single-source allowlist.
      if (pathname.startsWith(SCHEDULED_PREFIX)) {
        const jobId = pathname.slice(SCHEDULED_PREFIX.length);
        const loader = options.scheduledEntrypoint?.(jobId);
        if (loader) {
          await invoke(loader, options.durations?.scheduled?.(jobId) ?? 60_000);
          return finalize(res);
        }
      }

      // 4. Unknown /api/* => 404 JSON (never fall through to the SPA).
      if (pathname.startsWith("/api/")) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: "Not found" } }));
        return;
      }

      const legacyLocation = legacyRedirect(pathname, routing.legacyRedirects);
      if (legacyLocation) {
        res.statusCode = 308;
        res.setHeader("location", `${legacyLocation}${url.search}`);
        return finalize(res);
      }
      const product = productCanonicalization(pathname);
      if (product && options.entrypoints.productCanonicalizer) {
        await invoke(options.entrypoints.productCanonicalizer, options.durations?.productCanonicalizer ?? 10_000, false, product);
        return finalize(res);
      }

      // 5. Static documents and declared CSR fallback. Unknown extensionless routes are 404.
      if (staticReader) {
        await serveSpaStatic(
          req,
          res,
          pathname,
          staticReader,
          ssgPaths.has(pathname),
          isCsrFallback(pathname, routing.csrFallback),
        );
        return;
      }
      // No static reader configured (pure-API smoke): respond 404 rather than hang.
      res.statusCode = 404;
      res.end("Not Found");
    } catch (error) {
      if (error instanceof NodeRequestAbortedError) return;
      onError(pathname, error);
      const tooLarge = error instanceof NodeRequestBodyTooLargeError;
      if (tooLarge) closeInputAfterResponse(req, res);
      if (!res.headersSent && !res.destroyed) {
        res.statusCode = tooLarge ? 413 : 500;
        res.setHeader("content-type", "application/json; charset=utf-8");
      }
      if (!res.writableEnded && !res.destroyed) {
        res.end(JSON.stringify({ ok: false, error: {
          code: tooLarge ? "REQUEST_BODY_TOO_LARGE" : "NODE_HTTP_ERROR",
          message: tooLarge ? "Request body too large" : "Internal server error",
        } }));
      }
    }
  };
}

/** Create the Node HttpRuntimePort: `handle` for one request, `listen` to bind the server. */
export function createNodeHttpRuntime(options: NodeHttpRuntimeOptions): HttpRuntimePort & {
  server: Server | null;
} {
  const handle = createRequestHandler(options);
  let server: Server | null = null;

  return {
    server,
    handle,
    async listen({ port, host }): Promise<void> {
      server = createServer((req, res) => {
        void handle(decorateRequest(req), decorateResponse(res));
      });
      this.server = server;
      await new Promise<void>((resolve) => server!.listen(port, host ?? "0.0.0.0", resolve));
    },
  };
}
