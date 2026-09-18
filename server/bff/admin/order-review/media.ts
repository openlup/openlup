import { withObservedRoute } from "../../../_lib/observability/route.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../../_lib/bff/response.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import {
  orderReviewCommandKeySchema,
  orderReviewMediaReferenceSchema,
} from "../../../../src/domains/commerce/orderReviewContracts.js";
import { resolveOrderReviewRuntimeBinding, type OrderReviewRuntimeBinding } from "../../../runtime/commerce/orderReviewBinding.js";
import { getBundleDescriptor, resolveBundleId } from "../../../domains/platform-runtime/platformKernel.js";
import { authorizeOrderReviewAdmin } from "./index.js";

type Env = Record<string, string | undefined>;
type Authorize = (req: VercelRequest, res: VercelResponse) => Promise<string | null>;

export function createAdminOrderReviewMediaBffHandler(options: {
  env?: Env;
  authorize: Authorize;
  resolveBinding?: () => Promise<OrderReviewRuntimeBinding | null>;
}): (req: VercelRequest, res: VercelResponse) => Promise<void> {
  const env = options.env ?? process.env;
  return async (req, res) => {
    if (getBundleDescriptor(resolveBundleId(env)).capabilities.data !== "postgres") return notFound(res);
    if (req.method !== "GET" && req.method !== "DELETE") return sendMethodNotAllowed(res, ["GET", "DELETE"]);
    const actorRef = await options.authorize(req, res);
    if (!actorRef) return;
    const mediaRef = first(req.query.mediaRef);
    if (!orderReviewMediaReferenceSchema.safeParse(mediaRef).success) return notFound(res);
    let binding: OrderReviewRuntimeBinding | null;
    try { binding = await (options.resolveBinding ?? (() => resolveOrderReviewRuntimeBinding(env)))(); } catch { return upstream(res); }
    if (!binding) return upstream(res);
    if (req.method === "DELETE") {
      const idempotencyKey = header(req, "idempotency-key");
      const parsedKey = orderReviewCommandKeySchema.safeParse(idempotencyKey);
      if (!parsedKey.success) {
        return sendBffError(res, "BAD_REQUEST", "A valid Idempotency-Key is required");
      }
      try {
        const result = await binding.deleteAdminMedia(actorRef, mediaRef!, parsedKey.data);
        return result ? sendBffSuccess(res, result) : notFound(res);
      } catch (error) {
        if (conflict(error)) return sendBffError(res, "CONFLICT", "Order review media conflicts with prior state");
        return upstream(res);
      }
    }
    let authorized: Awaited<ReturnType<OrderReviewRuntimeBinding["authorizeAdminMedia"]>>;
    try { authorized = await binding.authorizeAdminMedia(actorRef, mediaRef!); } catch { return upstream(res); }
    if (!authorized) return notFound(res);
    if (req.headers.range !== undefined) return sendBffError(res, "BAD_REQUEST", "Range requests are not supported");
    if ((authorized.media.state !== "stored" && authorized.media.state !== "confirmed")
      || !authorized.media.observedContentType || !authorized.media.observedByteLength || !authorized.media.observedDigest) return notFound(res);
    let body: AsyncIterable<Uint8Array>;
    try { body = await authorized.open(); } catch { return upstream(res); }
    res.setHeader("Content-Type", authorized.media.observedContentType);
    res.setHeader("Content-Length", String(authorized.media.observedByteLength));
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Vary", "Authorization");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.status(200);
    try { await pipe(body, res); } catch (error) { res.destroy(error as Error); }
  };
}

function first(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }
function header(req: VercelRequest, name: string): string | undefined {
  const value = req.headers[name]; return Array.isArray(value) ? value[0] : value;
}
function notFound(res: VercelResponse): void { sendBffError(res, "NOT_FOUND", "Order review media unavailable"); }
function upstream(res: VercelResponse): void { sendBffError(res, "UPSTREAM_UNAVAILABLE", "Order review media storage unavailable"); }
function conflict(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = String(error.code);
  return code === "23505" || code === "order_review_conflict";
}
async function pipe(body: AsyncIterable<Uint8Array>, res: VercelResponse): Promise<void> {
  const iterator = body[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      if (!res.write(next.value)) await waitForDrain(res);
    }
    res.end();
  } finally { await iterator.return?.(); }
}
function waitForDrain(res: VercelResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { res.off("drain", drain); res.off("close", close); res.off("error", error); };
    const drain = () => { cleanup(); resolve(); };
    const close = () => { cleanup(); reject(new Error("response_closed")); };
    const error = (cause: Error) => { cleanup(); reject(cause); };
    res.once("drain", drain); res.once("close", close); res.once("error", error);
  });
}

export default withObservedRoute({
  route: "/api/bff/admin/order-review/media/:mediaRef",
  domain: "commerce",
  surface: "admin",
  risk: "mutation",
}, createAdminOrderReviewMediaBffHandler({ authorize: authorizeOrderReviewAdmin }));
