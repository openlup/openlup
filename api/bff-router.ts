import bffRouter from "./bff/[...path].js";
import type { VercelRequest, VercelResponse } from "../server/_lib/types/vercel.js";

const INTERNAL_BFF_PATH_QUERY = "__bffPath";

function firstQueryValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function rewriteBffRouterRequestUrl(req: VercelRequest): void {
  const routedPath = firstQueryValue(req.query?.[INTERNAL_BFF_PATH_QUERY]);
  if (!routedPath) return;

  const host = typeof req.headers?.host === "string" ? req.headers.host : "openlup.local";
  const currentUrl = new URL(typeof req.url === "string" ? req.url : "/", `https://${host}`);
  currentUrl.searchParams.delete(INTERNAL_BFF_PATH_QUERY);
  currentUrl.searchParams.delete("path");

  const normalizedPath = routedPath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
    .join("/");
  req.url = `/api/bff/${normalizedPath}${currentUrl.search}`;

  const { [INTERNAL_BFF_PATH_QUERY]: _internal, path: _vercelPath, ...query } = req.query ?? {};
  req.query = query;
}

export default function bffRouterEntrypoint(
  req: VercelRequest,
  res: VercelResponse,
): unknown {
  rewriteBffRouterRequestUrl(req);
  return bffRouter(req, res);
}
