// Node request/response <-> Vercel-shape adaptation for the W3 HttpRuntimePort.
//
// Extracted from httpRuntime.ts (300-LOC cap). Owns the RAW-BODY INVARIANT: every buffered request
// gets the exact bytes re-exposed as an async-iterable (so readRawBody-based signature verification
// works for ANY route, including ones outside `/webhooks/` like communications/integrations/events)
// while still setting a parsed JSON req.body; stream-first standalone entrypoints keep their live
// stream and NO req.body. Productionizes scripts/local-bff/nodeVercelAdapter.ts, fixing the dev
// shim's eager JSON-parse that destroyed webhook raw bodies.

import type { IncomingMessage, ServerResponse } from "node:http";

import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";

export const DEFAULT_NODE_BUFFERED_BODY_LIMIT_BYTES = 1_048_576;

export class NodeRequestBodyTooLargeError extends Error {
  constructor() {
    super("node_request_body_too_large");
  }
}

export class NodeRequestAbortedError extends Error {
  constructor() {
    super("node_request_aborted");
  }
}

/** A path is a webhook iff it contains a `/webhooks/` segment (payment/comms/fulfillment). */
export function isWebhookPath(pathname: string): boolean {
  return pathname.includes("/webhooks/");
}

/**
 * The PLATFORM's stream-first standalone entrypoints: they read the raw stream
 * themselves, so the runtime must never pre-parse their body.
 *
 * A deployment's own stream-first endpoint is NOT listed here. It declares
 * `rawStream: true` on its `HttpEntrypointRegistration` and the runtime passes that
 * decision to `adaptRequest` directly — which is what stops this publishable list
 * from having to name a path only that deployment owns.
 */
export function isRawStreamEntrypoint(pathname: string): boolean {
  return pathname === "/api/csp-report";
}

export function pathnameOf(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://node.local").pathname;
}

function parseQuery(req: IncomingMessage): Record<string, string | string[] | undefined> {
  const url = new URL(req.url ?? "/", "http://node.local");
  const query: Record<string, string | string[] | undefined> = {};
  for (const key of url.searchParams.keys()) {
    if (key in query) continue;
    const all = url.searchParams.getAll(key);
    query[key] = all.length > 1 ? all : all[0];
  }
  return query;
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

/** Buffer the request stream once into a single Buffer (GET/HEAD => empty). */
async function bufferBody(req: HttpRequest, maxBytes: number): Promise<Buffer> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (result: Buffer | Error) => {
      if (settled) return;
      settled = true;
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.abortSignal?.removeEventListener("abort", onAbort);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const onData = (chunk: Buffer | string) => {
      const bytesChunk = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytes += bytesChunk.length;
      if (bytes > maxBytes) {
        finish(new NodeRequestBodyTooLargeError());
        return;
      }
      chunks.push(bytesChunk);
    };
    const onEnd = () => finish(Buffer.concat(chunks));
    const onError = (error: Error) => finish(error);
    const onAbort = () => finish(new NodeRequestAbortedError());
    if (req.abortSignal?.aborted) return onAbort();
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Re-expose a fixed Buffer as the request's async-iterable so readRawBody sees the EXACT bytes. */
function reexposeRawStream(req: IncomingMessage, raw: Buffer): void {
  (req as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<Buffer> })[Symbol.asyncIterator] =
    async function* () {
      yield raw;
    };
}

/** Best-effort JSON parse of a buffered body for handlers that read `req.body`. */
function parseJsonBody(raw: Buffer, contentType: string): unknown {
  if (raw.length === 0) return undefined;
  const text = raw.toString("utf8").trim();
  if (!text) return undefined;
  if (contentType.includes("application/json") || text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

/**
 * Decorate a Node response with Vercel's status/json/send/redirect sugar (productionized from the
 * dev shim's decorateResponse — identical semantics).
 */
export function decorateResponse(res: ServerResponse): HttpResponse {
  const vres = res as HttpResponse;
  vres.status = function status(code: number): HttpResponse {
    res.statusCode = code;
    return vres;
  };
  vres.json = function json(body: unknown): HttpResponse {
    if (!res.hasHeader("content-type")) {
      res.setHeader("content-type", "application/json; charset=utf-8");
    }
    res.end(JSON.stringify(body));
    return vres;
  };
  vres.send = function send(body: string | Buffer | object): HttpResponse {
    if (Buffer.isBuffer(body) || typeof body === "string") {
      res.end(body);
      return vres;
    }
    if (!res.hasHeader("content-type")) {
      res.setHeader("content-type", "application/json; charset=utf-8");
    }
    res.end(JSON.stringify(body));
    return vres;
  };
  vres.redirect = function redirect(statusOrUrl: number | string, maybeUrl?: string): HttpResponse {
    const code = typeof statusOrUrl === "number" ? statusOrUrl : 302;
    const location = typeof statusOrUrl === "number" ? maybeUrl ?? "/" : statusOrUrl;
    res.statusCode = code;
    res.setHeader("location", location);
    res.end();
    return vres;
  };
  return vres;
}

/**
 * Adapt a Node IncomingMessage into the Vercel request shape, honoring the raw-body invariant:
 *  - raw-stream entrypoints (process/csp/feedback): stream left intact, NO req.body;
 *  - everything else: raw bytes buffered + re-exposed as async-iterable (so readRawBody sees the
 *    EXACT bytes for any signature-verifying route, webhook-segment or not) AND req.body = parsed JSON.
 */
export async function adaptRequest(
  req: IncomingMessage,
  pathname: string,
  /** Explicit override for a caller that knows the entrypoint's body contract (see above). */
  rawStream: boolean = isRawStreamEntrypoint(pathname),
  bufferedBodyLimitBytes: number = DEFAULT_NODE_BUFFERED_BODY_LIMIT_BYTES,
): Promise<HttpRequest> {
  const vreq = req as HttpRequest;
  vreq.query = parseQuery(req);
  vreq.cookies = parseCookies(req);

  if (rawStream) {
    // Leave the live stream untouched; the handler reads it itself (formidable / custom readBody).
    return vreq;
  }

  const raw = await bufferBody(vreq, bufferedBodyLimitBytes);
  const contentType = String(req.headers["content-type"] ?? "");

  // Re-expose the EXACT bytes as an async-iterable for EVERY buffered request, not only
  // `/webhooks/` paths. Some signature-verifying routes live outside that segment — e.g.
  // `/api/bff/communications/integrations/events` calls readRawBody for HMAC verification.
  // readRawBody is stream-first (isAsyncIterable), so any handler that needs the raw bytes
  // works; handlers that read req.body still get parsed JSON. The re-exposed iterator is
  // simply never consumed for routes that don't call readRawBody, so this is a safe superset
  // of the old `/webhooks/`-only behavior (and not dependent on a fragile path convention).
  reexposeRawStream(req, raw);
  vreq.body = parseJsonBody(raw, contentType);
  return vreq;
}

/** Narrow a raw IncomingMessage to HttpRequest at the server boundary (query/cookies set in adapt). */
export function decorateRequest(req: IncomingMessage): HttpRequest {
  const vreq = req as HttpRequest;
  if (!vreq.query) vreq.query = {};
  return vreq;
}
