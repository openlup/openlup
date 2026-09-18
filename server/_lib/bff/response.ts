import type { VercelResponse } from "../types/vercel.js";
import type {
  BffErrorCode,
  BffMeta,
  BffResponse,
} from "../../../src/lib/bff/contracts.js";
import { BFF_REQUEST_REFERENCE_HEADER as REQUEST_REFERENCE_HEADER } from "../../../src/lib/bff/contracts.js";
import { readObservedResponseContext } from "../observability/requestContext.js";

const DEFAULT_ERROR_STATUS: Record<BffErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  UPSTREAM_UNAVAILABLE: 503,
  INTERNAL: 500,
  INVALID_RESPONSE: 502,
};

interface ErrorOptions {
  status?: number;
  details?: unknown;
  meta?: BffMeta;
}

interface SuccessOptions {
  cacheControl?: string;
}

export function sendBffSuccess<T>(
  res: VercelResponse,
  data: T,
  meta?: BffMeta,
  options: SuccessOptions = {},
): void {
  sendJson(res, 200, { ok: true, data, meta }, options.cacheControl);
}

export function sendBffError(
  res: VercelResponse,
  code: BffErrorCode,
  message: string,
  options: ErrorOptions = {},
): void {
  sendJson(res, options.status ?? DEFAULT_ERROR_STATUS[code], {
    ok: false,
    error: { code, message, details: options.details },
    meta: options.meta,
  });
}

export function sendMethodNotAllowed(
  res: VercelResponse,
  allowedMethods: readonly string[],
): void {
  res.setHeader("Allow", allowedMethods.join(", "));
  sendBffError(res, "METHOD_NOT_ALLOWED", "Method not allowed", { status: 405 });
}

function sendJson<T>(
  res: VercelResponse,
  status: number,
  body: BffResponse<T>,
  cacheControl = "no-store",
): void {
  const responseContext = readObservedResponseContext(res);
  const shared = /(?:^|,)\s*(?:public\b|s-maxage\s*=)/i.test(cacheControl);
  const requestId = shared ? undefined : responseContext?.requestId;
  const responseBody = withRequestReference(body, requestId, shared);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", cacheControl);
  if (shared && typeof res.removeHeader === "function") res.removeHeader(REQUEST_REFERENCE_HEADER);
  else if (requestId) res.setHeader(REQUEST_REFERENCE_HEADER, requestId);
  res.status(status).json(stripUndefined(responseBody));
}

function withRequestReference<T>(
  body: BffResponse<T>,
  requestId: string | undefined,
  omitRequestId: boolean,
): BffResponse<T> {
  if (requestId && (body.ok === false || body.meta)) {
    return { ...body, meta: { ...body.meta, requestId } };
  }
  if (!omitRequestId || !body.meta || !("requestId" in body.meta)) return body;
  const { requestId: _omitted, ...meta } = body.meta;
  return { ...body, meta: Object.keys(meta).length > 0 ? meta : undefined };
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .map(([key, entryValue]) => [key, stripUndefined(entryValue)]),
  );
}
