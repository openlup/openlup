// BFF dispatch mechanism.
//
// The route table and its handlers belong to the deployment. This module owns the
// platform-neutral matching loop, so every HttpRuntimePort adapter (a hosted function or the Node
// runtime of this package) mounts the same route table without duplicating dispatch logic.
//
// Per request, in order: the deployment's `beforeDispatch` hook, path normalization, the first
// matching route, its availability, its decoded path parameters, the deployment's `preflight`
// hook, then the handler. An unmatched or unavailable path goes to the deployment's `notFound`.

import type { HttpRequest, HttpResponse } from "../http/index.js";
import { getBundleDescriptor, resolveBundleId } from "../kernel/index.js";

export type RouteEntry = {
  route: string;
  pattern: RegExp;
  params: string[];
  handler: (req: HttpRequest, res: HttpResponse) => unknown;
  /** Fail unsupported hosted bundles closed before auth without weakening direct-route auth. */
  availability?: "direct-postgres";
};

/** Match `routes` against one request and run the handler, or answer not found. */
export type BffDispatch = (
  routes: readonly RouteEntry[],
  req: HttpRequest,
  res: HttpResponse,
) => Promise<unknown>;

export interface BffDispatcherOptions {
  /** Environment read on each request to decide a route's bundle availability. */
  env: () => Record<string, string | undefined>;
  /** Writes the deployment's not-found response for an unmatched or unavailable path. */
  notFound: (res: HttpResponse, pathname: string) => void;
  /** Runs once per request before matching (for example, ambient request configuration). */
  beforeDispatch?: () => void;
  /**
   * Runs after matching and before the handler, for example route authorization; resolving false
   * means it already answered. Required, so no composition skips it by omission; a deployment
   * without guarded routes passes `() => true`.
   */
  preflight: (req: HttpRequest, res: HttpResponse, route: string) => Promise<boolean> | boolean;
}

// Only the pathname is read, and it does not depend on the URL base; this host only completes a
// request that carries no Host header.
const FALLBACK_HOST = "bff.invalid";

function requestPath(req: HttpRequest): string {
  const rawUrl = typeof req.url === "string" ? req.url : "/";
  const host = typeof req.headers?.host === "string" ? req.headers.host : FALLBACK_HOST;
  return new URL(rawUrl, "https://" + host).pathname.replace(/\/+$/, "") || "/";
}

/** Build the dispatcher a deployment mounts on its hosted and Node entrypoints alike. */
export function createBffDispatcher(options: BffDispatcherOptions): BffDispatch {
  return async function dispatch(routes, req, res) {
    options.beforeDispatch?.();
    const pathname = requestPath(req);
    for (const entry of routes) {
      const match = entry.pattern.exec(pathname);
      if (!match) continue;
      if (entry.availability === "direct-postgres"
        && getBundleDescriptor(resolveBundleId(options.env())).capabilities.data !== "postgres") {
        options.notFound(res, pathname);
        return undefined;
      }
      if (entry.params.length > 0) {
        const query = { ...(req.query ?? {}) };
        entry.params.forEach((param, index) => {
          query[param] = decodeURIComponent(match[index + 1] ?? "");
        });
        req.query = query;
      }
      if (!(await options.preflight(req, res, entry.route))) return undefined;
      return entry.handler(req, res);
    }
    options.notFound(res, pathname);
    return undefined;
  };
}
