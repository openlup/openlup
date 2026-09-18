import { withObservedRoute } from "../../../_lib/observability/route.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../../_lib/bff/response.js";
import { readBearerToken } from "../../../_lib/admin-domain/auth.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { resolveAdminAuthBinding } from "../../../runtime/auth/adminAuthBinding.js";
import { resolveOrderReviewRuntimeBinding, type OrderReviewRuntimeBinding } from "../../../runtime/commerce/orderReviewBinding.js";
import { getBundleDescriptor, resolveBundleId } from "../../../domains/platform-runtime/platformKernel.js";

type Env = Record<string, string | undefined>;
type Authorize = (req: VercelRequest, res: VercelResponse) => Promise<string | null>;

export function createAdminOrderReviewBffHandler(options: {
  env?: Env;
  authorize?: Authorize;
  resolveBinding?: () => Promise<OrderReviewRuntimeBinding | null>;
} = {}) {
  const env = options.env ?? process.env;
  return async function adminOrderReview(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (!direct(env)) return notFound(res);
    if (!["GET", "PATCH", "DELETE"].includes(req.method ?? "")) return sendMethodNotAllowed(res, ["GET", "PATCH", "DELETE"]);
    const actorRef = await (options.authorize ?? ((request, response) => authorizeOrderReviewAdmin(request, response, env)))(req, res);
    if (!actorRef) return;
    let binding: OrderReviewRuntimeBinding | null;
    try { binding = await (options.resolveBinding ?? (() => resolveOrderReviewRuntimeBinding(env)))(); }
    catch { return upstream(res); }
    if (!binding) return upstream(res);

    if (req.method === "GET") {
      const reviewRef = first(req.query.reviewRef);
      const result = reviewRef
        ? await binding.admin.read(actorRef, reviewRef)
        : await binding.admin.list(actorRef, { cursor: first(req.query.cursor), limit: integer(first(req.query.limit)) });
      if (result.ok === false) return failure(res, result.error.kind);
      return sendBffSuccess(res, result.value);
    }
    const result = req.method === "PATCH"
      ? await binding.admin.moderate(actorRef, req.body)
      : await binding.admin.revoke(actorRef, record(req.body) ?? {});
    if (result.ok === false) return failure(res, result.error.kind);
    return sendBffSuccess(res, req.method === "PATCH"
      ? { review: result.value, replayed: result.replayed === true }
      : { replayed: result.replayed === true });
  };
}

export async function authorizeOrderReviewAdmin(
  req: VercelRequest,
  res: VercelResponse,
  env: Env = process.env,
): Promise<string | null> {
  const resolved = resolveAdminAuthBinding(env);
  if (!resolved.binding) { sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed"); return null; }
  const token = readBearerToken(req);
  try {
    const result = await resolved.binding.run(token, (auth) => auth.authorize(token, { allowedRoles: ["admin"] }));
    if (result.ok === false) { sendBffError(res, result.code, result.message); return null; }
    return result.principalId;
  } catch { sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed"); return null; }
}
function direct(env: Env): boolean { return getBundleDescriptor(resolveBundleId(env)).capabilities.data === "postgres"; }
function first(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }
function integer(value: string | undefined): number | undefined { const parsed = Number(value); return Number.isInteger(parsed) ? parsed : undefined; }
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function notFound(res: VercelResponse): void { sendBffError(res, "NOT_FOUND", "Order review unavailable"); }
function upstream(res: VercelResponse): void { sendBffError(res, "UPSTREAM_UNAVAILABLE", "Order review service unavailable"); }
function failure(res: VercelResponse, kind: "invalid" | "conflict" | "unavailable"): void {
  if (kind === "invalid") return sendBffError(res, "BAD_REQUEST", "Invalid order review request");
  if (kind === "conflict") return sendBffError(res, "CONFLICT", "Order review request conflicts with prior state");
  notFound(res);
}

export default withObservedRoute({
  route: "/api/bff/admin/order-review",
  domain: "commerce",
  surface: "admin",
  risk: "mutation",
}, createAdminOrderReviewBffHandler());
