// URL rewrite for a hosted BFF router entrypoint.
//
// A host rewrite can deliver every `/api/bff/*` request to one function, passing the original
// path in the internal `__bffPath` query value. This restores the request URL and query the
// dispatcher expects before it matches a route.

import type { HttpRequest } from "../http/index.js";

const INTERNAL_BFF_PATH_QUERY = "__bffPath";

function firstQueryValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

// The rewrite keeps only the path and query, which do not depend on the URL base; this host only
// completes a request that carries no Host header.
const FALLBACK_HOST = "bff.invalid";

export function rewriteBffRouterRequestUrl(req: HttpRequest): void {
  const routedPath = firstQueryValue(req.query?.[INTERNAL_BFF_PATH_QUERY]);
  if (!routedPath) return;

  const host = typeof req.headers?.host === "string" ? req.headers.host : FALLBACK_HOST;
  const currentUrl = new URL(typeof req.url === "string" ? req.url : "/", `https://${host}`);
  currentUrl.searchParams.delete(INTERNAL_BFF_PATH_QUERY);
  currentUrl.searchParams.delete("path");

  const normalizedPath = routedPath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
    .join("/");
  req.url = `/api/bff/${normalizedPath}${currentUrl.search}`;

  const { [INTERNAL_BFF_PATH_QUERY]: _internal, path: _hostPath, ...query } = req.query ?? {};
  req.query = query;
}
