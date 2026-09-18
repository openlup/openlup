import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { NODE_HTTP_TIMEOUT_CODE, runWithHttpDeadline } from "./httpDeadline.js";
import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";

type DeadlineRequest = HttpRequest & EventEmitter & {
  destroyed: boolean;
  destroy: ReturnType<typeof vi.fn>;
  readonly signal: AbortSignal;
};

function request(nativeSignal: AbortSignal = new AbortController().signal): DeadlineRequest {
  const req = Object.assign(new EventEmitter(), {
    headers: {}, query: {}, destroyed: false,
    destroy: vi.fn(() => { req.destroyed = true; }),
  });
  Object.defineProperty(req, "signal", {
    configurable: false,
    enumerable: true,
    get: () => nativeSignal,
  });
  return req as unknown as DeadlineRequest;
}

function response(): HttpResponse & EventEmitter & { body: string; destroy: ReturnType<typeof vi.fn> } {
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200, headersSent: false, writableEnded: false, body: "",
    setHeader: vi.fn(),
    end: vi.fn((body?: unknown) => {
      if (body) res.body += String(body);
      res.writableEnded = true;
      res.headersSent = true;
      res.emit("finish");
    }),
    destroy: vi.fn(),
  });
  return res as unknown as HttpResponse & EventEmitter & { body: string; destroy: ReturnType<typeof vi.fn> };
}

describe("runWithHttpDeadline", () => {
  it("refuses an invalid duration before handler admission", async () => {
    const run = vi.fn();
    await expect(runWithHttpDeadline({ req: request(), res: response(), durationMs: 0, run }))
      .rejects.toThrow("invalid_node_http_deadline");
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps a getter-only native signal untouched and sends one safe pre-header 504", async () => {
    const req = request();
    const res = response();
    const end = res.end;
    const nativeSignal = req.signal;
    let observed: AbortSignal | undefined;
    await runWithHttpDeadline({
      req,
      res,
      durationMs: 5,
      run: () => new Promise<void>((resolve) => {
        observed = req.abortSignal;
        setTimeout(resolve, 30);
      }),
    });

    expect(req.signal).toBe(nativeSignal);
    expect(nativeSignal.aborted).toBe(false);
    expect(observed).toBeInstanceOf(AbortSignal);
    expect(observed?.aborted).toBe(true);
    expect(req.destroy).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(504);
    expect(res.body).toContain(NODE_HTTP_TIMEOUT_CODE);
    expect(end).toHaveBeenCalledOnce();
  });

  it("destroys a committed response instead of attempting a second envelope", async () => {
    const req = request();
    const res = response();
    const end = res.end;
    (res as unknown as { headersSent: boolean }).headersSent = true;
    await runWithHttpDeadline({
      req,
      res,
      durationMs: 5,
      run: () => new Promise<void>((resolve) => setTimeout(resolve, 30)),
    });
    expect(res.destroy).toHaveBeenCalledOnce();
    expect(req.destroy).toHaveBeenCalledOnce();
    expect(end).not.toHaveBeenCalled();
  });

  it("aborts the portable signal from the request-aborted transport event", async () => {
    const req = request();
    const res = response();
    let observed: AbortSignal | undefined;

    await runWithHttpDeadline({
      req,
      res,
      durationMs: 50,
      run: () => new Promise<void>((resolve) => {
        observed = req.abortSignal;
        observed?.addEventListener("abort", () => resolve(), { once: true });
        req.emit("aborted");
      }),
    });

    expect(observed?.aborted).toBe(true);
    expect(res.end).not.toHaveBeenCalled();
    expect(req.listenerCount("aborted")).toBe(0);
  });

  it("destroys input when a raw handler already ended its response before expiry", async () => {
    const req = request();
    const res = response();
    const end = res.end;
    (res as unknown as { writableEnded: boolean }).writableEnded = true;
    await runWithHttpDeadline({
      req,
      res,
      durationMs: 5,
      run: () => new Promise<void>((resolve) => setTimeout(resolve, 30)),
    });
    expect(req.abortSignal?.aborted).toBe(true);
    expect(req.destroy).toHaveBeenCalledOnce();
    expect(res.destroy).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });

  it("cleans its timer and close listeners after a prompt completion", async () => {
    const req = request();
    const res = response();
    await runWithHttpDeadline({ req, res, durationMs: 50, run: () => undefined });
    expect(req.abortSignal?.aborted).toBe(false);
    expect(req.listenerCount("aborted")).toBe(0);
    expect(res.listenerCount("close")).toBe(0);
    expect(res.end).not.toHaveBeenCalled();
  });
});
