// Extracted BFF dispatch mechanism (Platform Portability, W1).
//
// The 166 handler imports + the route table stay in api/bff/[...path].ts (the maintained,
// inventory-checked route list). This module owns the platform-neutral matching loop so any
// HttpRuntimePort adapter — the Vercel default today, the Node server in W3 — can mount the SAME
// route table without duplicating dispatch logic.
//
// Behavior is byte-identical to the previous inline bffRouter (the golden-master harness is the
// regression gate; its snapshots MUST stay unchanged across this extraction).

import { preflightAdminBffRoute } from "./auth/adminAuthBinding.js";
import { bootstrapAmbientSettlementProfile } from "./settlementProfileBootstrap.js";
import { sendBffError } from "../_lib/bff/response.js";
import type { HttpRequest, HttpResponse } from "../_lib/types/http.js";
import { getBundleDescriptor, resolveBundleId } from "../domains/platform-runtime/platformKernel.js";

export type RouteEntry = {
  route: string;
  pattern: RegExp;
  params: string[];
  handler: (req: HttpRequest, res: HttpResponse) => unknown;
  /** Fail unsupported hosted bundles closed before auth without weakening direct-route auth. */
  availability?: "direct-postgres";
};

function requestPath(req: HttpRequest): string {
  const rawUrl = typeof req.url === "string" ? req.url : "/";
  const host = typeof req.headers?.host === "string" ? req.headers.host : "openlup.local";
  return new URL(rawUrl, "https://" + host).pathname.replace(/\/+$/, "") || "/";
}

export async function dispatch(
  routes: readonly RouteEntry[],
  req: HttpRequest,
  res: HttpResponse,
): Promise<unknown> {
  // Every mounted route reaches the ambient currency schema through its response
  // or request contract, and this is the one funnel they all pass through — the
  // serverless entrypoint, its rewrite wrapper, the self-hosted server and the
  // development plugin alike. Resolving the profile here rather than in each of
  // them is what keeps "which routes are covered" from being a review question.
  bootstrapAmbientSettlementProfile();
  const pathname = requestPath(req);
  for (const entry of routes) {
    const match = entry.pattern.exec(pathname);
    if (!match) continue;
    if (entry.availability === "direct-postgres"
      && getBundleDescriptor(resolveBundleId(process.env)).capabilities.data !== "postgres") {
      sendBffError(res, "NOT_FOUND", "BFF route not found", { details: { path: pathname } });
      return undefined;
    }
    if (entry.params.length > 0) {
      const query = { ...(req.query ?? {}) };
      entry.params.forEach((param, index) => {
        query[param] = decodeURIComponent(match[index + 1] ?? "");
      });
      req.query = query;
    }
    if (!(await preflightAdminBffRoute(req, res, entry.route))) return undefined;
    return entry.handler(req, res);
  }
  sendBffError(res, "NOT_FOUND", "BFF route not found", { details: { path: pathname } });
  return undefined;
}
