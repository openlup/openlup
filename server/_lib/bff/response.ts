// Reference-application binding of the BFF envelope from @openlup/platform: responses carry the
// request reference this application's observed request context recorded for them.
import type { VercelResponse } from "../types/vercel.js";
import type { BffErrorCode, BffMeta } from "../../../src/lib/bff/contracts.js";
import { createBffResponder } from "@openlup/platform/bff";
import { readObservedResponseContext } from "../observability/requestContext.js";

interface ErrorOptions {
  status?: number;
  details?: unknown;
  meta?: BffMeta;
}

interface SuccessOptions {
  cacheControl?: string;
}

/** The same writers as an object, for package handlers that take a responder. */
export const bffResponder = createBffResponder({
  responseRequestId: (res) => readObservedResponseContext(res as VercelResponse)?.requestId,
});

export function sendBffSuccess<T>(
  res: VercelResponse,
  data: T,
  meta?: BffMeta,
  options: SuccessOptions = {},
): void {
  bffResponder.sendBffSuccess(res, data, meta, options);
}

export function sendBffError(
  res: VercelResponse,
  code: BffErrorCode,
  message: string,
  options: ErrorOptions = {},
): void {
  bffResponder.sendBffError(res, code, message, options);
}

export function sendMethodNotAllowed(
  res: VercelResponse,
  allowedMethods: readonly string[],
): void {
  bffResponder.sendMethodNotAllowed(res, allowedMethods);
}
