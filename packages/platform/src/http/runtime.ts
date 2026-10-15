// Native Node adapter for manifest-driven public routing and API topology.
//
// The request order is fixed: trailing-slash redirect, the CSP report entrypoint, deployment
// exact-path entrypoints, the BFF router entrypoint, deployment path entrypoints, the BFF
// dispatcher, robots.txt, declared scheduled routes, the API 404, legacy redirects, deployment
// fallback path entrypoints, then static documents. Every deployment value (routes, entrypoints,
// header policy, robots policy, deadlines) is supplied by the composition root.

import { createServer, type Server } from "node:http";

import type { HttpRuntimePort } from "@openlup/core/platform-runtime";
import type { EntrypointLoader, HttpRequest, HttpResponse } from "./types.js";
import type { BffDispatch, RouteEntry } from "../bff/index.js";
import {
  adaptRequest,
  decorateRequest,
  decorateResponse,
  NodeRequestAbortedError,
  NodeRequestBodyTooLargeError,
} from "./requestAdapter.js";
import { closeInputAfterResponse, runWithHttpDeadline } from "./deadline.js";
import {
  applySecurityHeaders,
  serveSpaStatic,
  type NodeSecurityHeaderPolicy,
  type StaticAssetReader,
} from "./security.js";

const SCHEDULED_PREFIX = "/api/cron/";
const ROBOTS_CONTENT_TYPE = "text/plain; charset=utf-8";
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

/** One deployment-specific standalone entrypoint, matched by its exact path. */
export interface HttpEntrypointRegistration {
  path: string;
  rawStream?: boolean;
  maxDurationMs?: number;
  load: EntrypointLoader;
}

/**
 * One deployment-specific entrypoint matched by a path rule. `match` returns the query values the
 * entrypoint receives for this path, or null when the path is not its own. The body is buffered.
 */
export interface HttpPathEntrypoint {
  match(pathname: string): Record<string, string> | null;
  load: EntrypointLoader;
  /** Request deadline; defaults to 10 seconds. */
  maxDurationMs?: number;
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
  /** The deployment's BFF route table. */
  routes: readonly RouteEntry[];
  /** The dispatcher that matches `routes` (see `createBffDispatcher`). */
  dispatch: BffDispatch;
  /** Validated public-route contract supplied by the host composition root. */
  routing?: {
    legacyRedirects: readonly NodeLegacyRedirect[];
    ssgPaths: readonly string[];
    csrFallback: NodeCsrFallback;
  };
  /** Deployment header policy, including the content security policy. */
  security: NodeSecurityHeaderPolicy;
  /** robots.txt body for a request host; without it `/robots.txt` is served like any other path. */
  robotsTxt?: (host: string | undefined) => string;
  /**
   * Platform-path standalone handlers: the CSP report sink at `/api/csp-report` and the hosted
   * BFF router at `/api/bff-router`. A path without a handler is treated like any other path.
   */
  entrypoints?: {
    cspReport?: EntrypointLoader;
    bffRouter?: EntrypointLoader;
  };
  /**
   * Deployment exact-path handlers, checked after the CSP report entrypoint and before the BFF
   * router; a later registration replaces an earlier one with the same path.
   */
  extraEntrypoints?: readonly HttpEntrypointRegistration[];
  /** Deployment path-rule handlers checked before the BFF dispatcher, first match wins. */
  pathEntrypoints?: readonly HttpPathEntrypoint[];
  /** Deployment path-rule handlers checked after legacy redirects and before static documents. */
  fallbackPathEntrypoints?: readonly HttpPathEntrypoint[];
  /** Registry-derived allowlist; undeclared job ids must resolve null. */
  scheduledEntrypoint?: (jobId: string) => EntrypointLoader | null;
  /** Explicit host deadlines; missing cells use the bounded defaults below. */
  durations?: {
    bff?: number;
    cspReport?: number;
    bffRouter?: number;
    scheduled?: (jobId: string) => number;
  };
  /** Static SPA reader; without one, unmatched non-API paths answer 404. */
  staticReader?: StaticAssetReader;
  /** Structured error sink (defaults to console.error). */
  onError?: (context: string, error: unknown) => void;
}

function finalize(res: HttpResponse): void {
  if (!res.writableEnded && !res.destroyed) res.end();
}

function matchPathEntrypoint(
  entrypoints: readonly HttpPathEntrypoint[] | undefined,
  pathname: string,
): { entrypoint: HttpPathEntrypoint; query: Record<string, string> } | null {
  for (const entrypoint of entrypoints ?? []) {
    const query = entrypoint.match(pathname);
    if (query) return { entrypoint, query };
  }
  return null;
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
      applySecurityHeaders(res, pathname, host, options.security);
      if (pathname.length > 1 && pathname.endsWith("/")) {
        res.statusCode = 308;
        res.setHeader("location", `${pathname.replace(/\/+$/, "")}${url.search}`);
        return finalize(res);
      }
      // 1. Standalone entrypoints (filesystem-parity with api/*.ts).
      const cspReport = options.entrypoints?.cspReport;
      if (pathname === "/api/csp-report" && cspReport) {
        await invoke(cspReport, options.durations?.cspReport ?? 30_000);
        return finalize(res);
      }
      // 1b. Deployment entrypoints: exact path, lazy load, owner-declared body policy.
      const registered = extra.get(pathname);
      if (registered) {
        await invoke(registered.load, registered.maxDurationMs ?? 30_000, registered.rawStream);
        return finalize(res);
      }
      const bffRouter = options.entrypoints?.bffRouter;
      if (pathname === "/api/bff-router" && bffRouter) {
        await invoke(bffRouter, options.durations?.bffRouter ?? 30_000);
        return finalize(res);
      }
      // 1c. Deployment path-rule entrypoints, before the BFF dispatcher.
      const routed = matchPathEntrypoint(options.pathEntrypoints, pathname);
      if (routed) {
        await invoke(routed.entrypoint.load, routed.entrypoint.maxDurationMs ?? 10_000, false, routed.query);
        return finalize(res);
      }

      // 2. The BFF dispatcher (same routes + dispatch as the hosted entrypoint).
      if (pathname === "/api/bff" || pathname.startsWith("/api/bff/")) {
        await bounded(options.durations?.bff ?? 30_000, async () =>
          options.dispatch(options.routes, await adaptRequest(req, pathname), res));
        return finalize(res);
      }

      if (pathname === "/robots.txt" && options.robotsTxt) {
        res.statusCode = 200;
        res.setHeader("content-type", ROBOTS_CONTENT_TYPE);
        res.setHeader("cache-control", "public, max-age=0, s-maxage=300, stale-while-revalidate=3600");
        res.end(options.robotsTxt(host));
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
      const fallback = matchPathEntrypoint(options.fallbackPathEntrypoints, pathname);
      if (fallback) {
        await invoke(fallback.entrypoint.load, fallback.entrypoint.maxDurationMs ?? 10_000, false, fallback.query);
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
