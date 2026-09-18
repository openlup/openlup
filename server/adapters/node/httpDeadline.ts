// Bounded request/response lifecycle for the Node HTTP adapter.
//
// This owns transport cancellation only. It gives handlers a cooperative
// AbortSignal, but cannot roll back downstream work that ignores it.

import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";

export const NODE_HTTP_TIMEOUT_CODE = "NODE_HTTP_TIMEOUT";

type Destroyable = { destroy?: (error?: Error) => void };
type Evented = { once?: (event: string, listener: () => void) => unknown; removeListener?: (event: string, listener: () => void) => unknown };
type WritableResponse = HttpResponse & {
  write?: (...args: unknown[]) => boolean;
  writeHead?: (...args: unknown[]) => unknown;
  end?: (...args: unknown[]) => unknown;
  setHeader?: (...args: unknown[]) => unknown;
};

export interface HttpDeadlineOptions {
  req: HttpRequest;
  res: HttpResponse;
  durationMs: number;
  run: () => Promise<unknown> | unknown;
  onLateError?: (error: unknown) => void;
}

/**
 * Run one Node HTTP admission from the instant before lazy loading/adaptation.
 *
 * A timeout before headers commit gets one minimal JSON 504. After headers are
 * committed we cannot change the status safely, so the response is destroyed.
 * The invocation promise remains observed, preventing a late rejection from
 * becoming an unhandled rejection or a second response.
 */
export async function runWithHttpDeadline(options: HttpDeadlineOptions): Promise<void> {
  const { req, res, durationMs, run, onLateError } = options;
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > 2_147_483_647) {
    throw new Error("invalid_node_http_deadline");
  }

  const controller = new AbortController();
  // Node 24 exposes IncomingMessage.signal as a getter without a setter. Keep
  // that host-native property untouched and use the portable adapter seam.
  req.abortSignal = controller.signal;
  const eventedReq = req as HttpRequest & Evented;
  const eventedRes = res as HttpResponse & Evented;
  const abortForClose = () => controller.abort();
  eventedReq.once?.("aborted", abortForClose);
  eventedRes.once?.("close", abortForClose);

  let expired = false;
  let finishTimeout: (() => void) | undefined;
  const timeout = new Promise<void>((resolve) => { finishTimeout = resolve; });
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
    if (res.destroyed || res.writableEnded) {
      destroyInput(req);
      return finishTimeout?.();
    }
    if (!res.headersSent && !res.writableEnded) {
      closeInputAfterResponse(req, res);
      res.statusCode = 504;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: { code: NODE_HTTP_TIMEOUT_CODE, message: "Request timed out" } }));
      sealLateWrites(res);
    } else if (!res.writableEnded) {
      sealLateWrites(res);
      (res as HttpResponse & Destroyable).destroy?.();
      destroyInput(req);
    }
    finishTimeout?.();
  }, durationMs);

  const invocation = Promise.resolve().then(run);
  // Keep a late completion/rejection observed after timeout. It must never get a
  // chance to write a second envelope, and its raw value is not client output.
  void invocation.catch((error) => {
    if (expired) onLateError?.(error);
  });

  try {
    await Promise.race([invocation.then(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
    eventedReq.removeListener?.("aborted", abortForClose);
    eventedRes.removeListener?.("close", abortForClose);
  }
}

/** Send a response before closing its request input, so the status is deliverable. */
export function closeInputAfterResponse(req: HttpRequest, res: HttpResponse): void {
  const evented = res as HttpResponse & Evented;
  let closed = false;
  const destroy = () => {
    if (closed) return;
    closed = true;
    evented.removeListener?.("finish", destroy);
    evented.removeListener?.("close", destroy);
    destroyInput(req);
  };
  evented.once?.("finish", destroy);
  evented.once?.("close", destroy);
}

function destroyInput(req: HttpRequest): void {
  (req as HttpRequest & Destroyable).destroy?.();
}

/** Refuse late handler writes after a deadline response has committed. */
function sealLateWrites(res: HttpResponse): void {
  const mutable = res as WritableResponse;
  mutable.write = () => false;
  mutable.writeHead = () => mutable;
  mutable.end = () => mutable;
  mutable.setHeader = () => mutable;
}
