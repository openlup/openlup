import bffRouter from "./bff/[...path].js";
import { rewriteBffRouterRequestUrl as rewritePlatformBffRouterRequestUrl } from "@openlup/platform/bff";
import type { VercelRequest, VercelResponse } from "../server/_lib/types/vercel.js";

export function rewriteBffRouterRequestUrl(req: VercelRequest): void {
  rewritePlatformBffRouterRequestUrl(req);
}

export default function bffRouterEntrypoint(
  req: VercelRequest,
  res: VercelResponse,
): unknown {
  rewriteBffRouterRequestUrl(req);
  return bffRouter(req, res);
}
