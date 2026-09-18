import { withObservedRoute } from "../../_lib/observability/route.js";
import { sendBffError, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { orderReviewGrantReferenceSchema, orderReviewMediaReferenceSchema } from "../../../src/domains/commerce/orderReviewContracts.js";
import { resolveOrderReviewRuntimeBinding, type OrderReviewRuntimeBinding } from "../../runtime/commerce/orderReviewBinding.js";
import { getBundleDescriptor, resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";

type Resolver = () => Promise<OrderReviewRuntimeBinding | null>;

export function createOrderReviewMediaBffHandler(resolveBinding: Resolver = () => resolveOrderReviewRuntimeBinding(), env: Record<string, string | undefined> = process.env) {
  return async function orderReviewMedia(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (getBundleDescriptor(resolveBundleId(env)).capabilities.data !== "postgres") return notFound(res);
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    const grant = bearer(req);
    const mediaRef = first(req.query.mediaRef);
    if (!orderReviewGrantReferenceSchema.safeParse(grant).success || !orderReviewMediaReferenceSchema.safeParse(mediaRef).success) {
      return notFound(res);
    }
    let binding: OrderReviewRuntimeBinding | null;
    try { binding = await resolveBinding(); } catch { return upstream(res); }
    if (!binding) return upstream(res);
    let authorized: Awaited<ReturnType<OrderReviewRuntimeBinding["authorizeCustomerMedia"]>>;
    try { authorized = await binding.authorizeCustomerMedia(grant!, mediaRef!); } catch { return upstream(res); }
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

function bearer(req: VercelRequest): string | undefined {
  const raw = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization;
  return /^Bearer ([^ ]+)$/.exec(raw ?? "")?.[1];
}
function first(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }
function notFound(res: VercelResponse): void { sendBffError(res, "NOT_FOUND", "Order review media unavailable"); }
function upstream(res: VercelResponse): void { sendBffError(res, "UPSTREAM_UNAVAILABLE", "Order review media storage unavailable"); }
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
  route: "/api/bff/order-review/media/:mediaRef",
  domain: "commerce",
  surface: "public",
  risk: "read",
}, createOrderReviewMediaBffHandler());
