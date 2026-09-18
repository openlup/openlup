import { withObservedRoute } from "../../_lib/observability/route.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { orderReviewGrantReferenceSchema } from "../../../src/domains/commerce/orderReviewContracts.js";
import {
  resolveOrderReviewRuntimeBinding,
  type OrderReviewRuntimeBinding,
} from "../../runtime/commerce/orderReviewBinding.js";
import { getBundleDescriptor, resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";

type Resolver = () => Promise<OrderReviewRuntimeBinding | null>;

export function createOrderReviewBffHandler(resolveBinding: Resolver = () => resolveOrderReviewRuntimeBinding(), env: Record<string, string | undefined> = process.env) {
  return async function orderReview(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (getBundleDescriptor(resolveBundleId(env)).capabilities.data !== "postgres") return unavailable(res);
    if (req.method !== "GET" && req.method !== "POST") return sendMethodNotAllowed(res, ["GET", "POST"]);
    const grant = readGrant(req);
    if (!grant) return unavailable(res);
    let binding: OrderReviewRuntimeBinding | null;
    try { binding = await resolveBinding(); } catch { return upstream(res); }
    if (!binding) return upstream(res);

    if (req.method === "GET") {
      const result = await binding.customer.read(grant);
      if (result.ok === false) return sendFailure(res, result.error.kind);
      return sendBffSuccess(res, result.value);
    }

    const command = record(req.body);
    const input = record(command?.input);
    if (!command || !input || typeof command.kind !== "string") return sendBffError(res, "BAD_REQUEST", "Invalid order review request");
    if (command.kind === "submit") {
      const result = await binding.customer.submit({ ...input, grant });
      if (result.ok === false) return sendFailure(res, result.error.kind);
      return sendBffSuccess(res, { kind: "review", review: result.value, replayed: result.replayed === true });
    }
    if (command.kind === "media_intent") {
      const result = await binding.customer.createMediaIntent({ ...input, grant });
      if (result.ok === false) return sendFailure(res, result.error.kind);
      return sendBffSuccess(res, { kind: "media_intent", result: result.value });
    }
    if (command.kind === "media_confirm") {
      const result = await binding.customer.confirmMedia({ ...input, grant });
      if (result.ok === false) return sendFailure(res, result.error.kind);
      return sendBffSuccess(res, { kind: "media", media: result.value, replayed: result.replayed === true });
    }
    return sendBffError(res, "BAD_REQUEST", "Invalid order review request");
  };
}

function readGrant(req: VercelRequest): string | null {
  const raw = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization;
  const match = /^Bearer (review-grant:[a-f0-9-]{36})$/.exec(raw ?? "");
  const parsed = orderReviewGrantReferenceSchema.safeParse(match?.[1]);
  return parsed.success ? parsed.data : null;
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function unavailable(res: VercelResponse): void { sendBffError(res, "NOT_FOUND", "Order review unavailable"); }
function upstream(res: VercelResponse): void { sendBffError(res, "UPSTREAM_UNAVAILABLE", "Order review service unavailable"); }
function sendFailure(res: VercelResponse, kind: "invalid" | "conflict" | "unavailable"): void {
  if (kind === "invalid") return sendBffError(res, "BAD_REQUEST", "Invalid order review request");
  if (kind === "conflict") return sendBffError(res, "CONFLICT", "Order review request conflicts with prior state");
  unavailable(res);
}

export default withObservedRoute({
  route: "/api/bff/order-review",
  domain: "commerce",
  surface: "public",
  risk: "validation_mutation",
}, createOrderReviewBffHandler());
