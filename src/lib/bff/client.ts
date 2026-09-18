import { z } from "../validation/zod.js";
import {
  BFF_REQUEST_REFERENCE_HEADER,
  type BffError,
  type BffResponse,
  bffResponseSchema,
  isBffRequestReference,
} from "./contracts.js";

type Fetcher = typeof fetch;

export class BffClientError extends Error {
  readonly code: BffError["code"];
  readonly status: number;
  readonly details: unknown;
  readonly requestId?: string;

  constructor(error: BffError, status: number, requestId?: string) {
    super(error.message);
    this.name = "BffClientError";
    this.code = error.code;
    this.status = status;
    this.details = error.details;
    this.requestId = requestId;
  }
}

export interface BffRequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  fetcher?: Fetcher;
  /**
   * Opt-in per-call timeout (ms). When set (and the caller passes no `signal`),
   * the request is aborted after `timeoutMs` and a transient
   * `UPSTREAM_UNAVAILABLE` / `reason: "timeout"` `BffClientError` is thrown. OFF by
   * default, so the ~83 existing callers are unchanged. Set ONLY on mutations that
   * must not hang the UI (checkout submit) — NEVER on long GET polls, whose sagas
   * legitimately run long.
   */
  timeoutMs?: number;
}

export async function requestBff<T>(
  path: string,
  dataSchema: z.ZodType<T>,
  options: BffRequestOptions = {},
): Promise<T> {
  const { body, fetcher = fetch, headers: initHeaders, timeoutMs, signal: callerSignal, ...init } = options;
  const headers = new Headers(initHeaders);

  // Per-call timeout: create an AbortController only when a timeout is requested and
  // the caller didn't supply its own signal. The caller's signal always wins.
  const controller = timeoutMs != null && callerSignal == null ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const signal = callerSignal ?? controller?.signal;

  let res: Response;
  let rawEnvelope: unknown;
  try {
    res = await fetcher(path, {
      ...init,
      headers,
      ...(signal ? { signal } : {}),
      body: body === undefined ? undefined : encodeBody(body, headers),
    });
    // The deadline covers the complete response, including a body stream that
    // stalls after headers have arrived.
    rawEnvelope = await readJson(res);
  } catch (error) {
    if (controller?.signal.aborted) {
      throw new BffClientError(
        { code: "UPSTREAM_UNAVAILABLE", message: "Request timed out", details: { reason: "timeout" } },
        0,
      );
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }

  const requestId = readResponseRequestId(res, rawEnvelope);
  const parsed = bffResponseSchema(dataSchema).safeParse(rawEnvelope);
  if (!parsed.success) {
    throw new BffClientError(
      { code: "INVALID_RESPONSE", message: "BFF response did not match contract" },
      res.status,
      requestId,
    );
  }

  const envelope = parsed.data as BffResponse<T>;
  if (envelope.ok === false) {
    throw new BffClientError(envelope.error, res.status, requestId);
  }

  return envelope.data;
}

function encodeBody(body: unknown, headers: Headers): string {
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  return typeof body === "string" ? body : JSON.stringify(body);
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new BffClientError(
      { code: "INVALID_RESPONSE", message: "BFF response was not valid JSON" },
      res.status,
      readResponseRequestId(res),
    );
  }
}

function readResponseRequestId(res: Response, body?: unknown): string | undefined {
  const headerValue = res.headers?.get(BFF_REQUEST_REFERENCE_HEADER) ?? null;
  const meta = isRecord(body) && isRecord(body.meta) ? body.meta : undefined;
  const hasMetaValue = Boolean(meta && Object.prototype.hasOwnProperty.call(meta, "requestId"));
  const metaValue = hasMetaValue ? meta?.requestId : undefined;

  if (headerValue !== null && !isBffRequestReference(headerValue)) return undefined;
  if (hasMetaValue && !isBffRequestReference(metaValue)) return undefined;
  if (headerValue !== null && hasMetaValue && headerValue !== metaValue) return undefined;
  if (isBffRequestReference(headerValue)) return headerValue;
  return isBffRequestReference(metaValue) ? metaValue : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
