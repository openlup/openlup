// BFF response envelope.
//
// Every BFF response is JSON `{ ok: true, data, meta? }` or `{ ok: false, error: { code, message,
// details? }, meta? }`. A private response carries the request reference in the `x-request-id`
// header and, for errors or responses with meta, in `meta.requestId`; a shared-cache response
// (public or s-maxage) carries neither. `undefined` members are stripped before serialization.

import type { HttpResponse } from "../http/index.js";

export const BFF_REQUEST_REFERENCE_HEADER = "x-request-id";

export const BFF_ERROR_CODES = [
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "CONFLICT",
  "RATE_LIMITED",
  "UPSTREAM_UNAVAILABLE",
  "INTERNAL",
  "INVALID_RESPONSE",
] as const;

export type BffErrorCode = (typeof BFF_ERROR_CODES)[number];

export type BffMeta = { requestId?: string; contractVersion?: string; [key: string]: unknown };

export type BffError = { code: BffErrorCode; message: string; details?: unknown };

export type BffSuccessResponse<T> = { ok: true; data: T; meta?: BffMeta };

export type BffErrorResponse = { ok: false; error: BffError; meta?: BffMeta };

export type BffResponse<T> = BffSuccessResponse<T> | BffErrorResponse;

/** The HTTP status each error code answers with unless the caller names another. */
export const BFF_ERROR_STATUS: Readonly<Record<BffErrorCode, number>> = {
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

export interface BffErrorOptions {
  status?: number;
  details?: unknown;
  meta?: BffMeta;
}

export interface BffSuccessOptions {
  cacheControl?: string;
}

export interface BffResponderOptions {
  /** The request reference observed for this response, if the deployment records one. */
  responseRequestId?: (res: HttpResponse) => string | undefined;
}

export interface BffResponder {
  sendBffSuccess<T>(res: HttpResponse, data: T, meta?: BffMeta, options?: BffSuccessOptions): void;
  sendBffError(res: HttpResponse, code: BffErrorCode, message: string, options?: BffErrorOptions): void;
  sendMethodNotAllowed(res: HttpResponse, allowedMethods: readonly string[]): void;
}

/** Build the envelope writers a deployment's handlers share. */
export function createBffResponder(options: BffResponderOptions = {}): BffResponder {
  function sendBffSuccess<T>(
    res: HttpResponse,
    data: T,
    meta?: BffMeta,
    successOptions: BffSuccessOptions = {},
  ): void {
    sendJson(res, 200, { ok: true, data, meta }, successOptions.cacheControl);
  }

  function sendBffError(
    res: HttpResponse,
    code: BffErrorCode,
    message: string,
    errorOptions: BffErrorOptions = {},
  ): void {
    sendJson(res, errorOptions.status ?? BFF_ERROR_STATUS[code], {
      ok: false,
      error: { code, message, details: errorOptions.details },
      meta: errorOptions.meta,
    });
  }

  function sendMethodNotAllowed(res: HttpResponse, allowedMethods: readonly string[]): void {
    res.setHeader("Allow", allowedMethods.join(", "));
    sendBffError(res, "METHOD_NOT_ALLOWED", "Method not allowed", { status: 405 });
  }

  function sendJson<T>(
    res: HttpResponse,
    status: number,
    body: BffResponse<T>,
    cacheControl = "no-store",
  ): void {
    const shared = /(?:^|,)\s*(?:public\b|s-maxage\s*=)/i.test(cacheControl);
    const requestId = shared ? undefined : options.responseRequestId?.(res);
    const responseBody = withRequestReference(body, requestId, shared);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", cacheControl);
    if (shared && typeof res.removeHeader === "function") res.removeHeader(BFF_REQUEST_REFERENCE_HEADER);
    else if (requestId) res.setHeader(BFF_REQUEST_REFERENCE_HEADER, requestId);
    res.status(status).json(stripUndefined(responseBody));
  }

  return { sendBffSuccess, sendBffError, sendMethodNotAllowed };
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
