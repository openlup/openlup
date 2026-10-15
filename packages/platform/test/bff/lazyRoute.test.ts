import { describe, expect, it, vi } from "vitest";

import { lazyBffRoute } from "../../src/bff/lazyRoute.js";
import type { RouteEntry } from "../../src/bff/dispatch.js";

type Handler = RouteEntry["handler"];
const request = (name: string) => ({ url: `/api/bff/${name}` }) as Parameters<Handler>[0];
const response = () => ({}) as Parameters<Handler>[1];

function pendingModule() {
  let resolve!: (value: { default: Handler }) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<{ default: Handler }>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("lazy route loading", () => {
  it("does no work at registration, then forwards arguments and returns synchronous results after loading", async () => {
    const result = { marker: 42 };
    const handler = vi.fn(() => result);
    const load = vi.fn(async () => ({ default: handler }));
    const route = lazyBffRoute(load);
    const req = request("first");
    const res = response();
    expect(load).not.toHaveBeenCalled();
    const first = route(req, res);
    expect(first).toBeInstanceOf(Promise);
    await expect(first).resolves.toBe(result);
    const next = request("next");
    expect(route(next, res)).toBe(result);
    expect(handler.mock.calls).toEqual([[req, res], [next, res]]);
    expect(load).toHaveBeenCalledOnce();
  });

  it("shares the first pending load and invokes requests in arrival order", async () => {
    const module = pendingModule();
    const load = vi.fn(() => module.promise);
    const handler = vi.fn((req: Parameters<Handler>[0]) => req.url);
    const route = lazyBffRoute(load);
    const res = response();
    const requests = [request("first"), request("second"), request("third")];
    const outcomes = requests.map((req) => route(req, res));
    expect(load).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
    module.resolve({ default: handler });
    await expect(Promise.all(outcomes)).resolves.toEqual(requests.map((req) => req.url));
    expect(handler.mock.calls).toEqual(requests.map((req) => [req, res]));
    expect(load).toHaveBeenCalledOnce();
  });

  it("rejects all waiters with the same failure and retries the next admission", async () => {
    const module = pendingModule();
    const fault = new Error("load fault");
    const handler = vi.fn(() => "ready");
    const load = vi.fn().mockImplementationOnce(() => module.promise).mockResolvedValue({ default: handler });
    const route = lazyBffRoute(load);
    const settled = Promise.allSettled([route(request("first"), response()), route(request("second"), response())]);
    module.reject(fault);
    expect(await settled).toEqual([{ status: "rejected", reason: fault }, { status: "rejected", reason: fault }]);
    expect(handler).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledOnce();
    await expect(route(request("retry"), response())).resolves.toBe("ready");
    expect(route(request("loaded"), response())).toBe("ready");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("propagates first-call rejection and later synchronous handler throws without reloading", async () => {
    const fault = new Error("handler fault");
    const load = vi.fn(async () => ({ default: () => { throw fault; } }));
    const route = lazyBffRoute(load);
    await expect(route(request("first"), response())).rejects.toBe(fault);
    expect(() => route(request("next"), response())).toThrow(fault);
    expect(load).toHaveBeenCalledOnce();
  });

  it("returns the loaded handler's own promise unchanged", async () => {
    const result = Promise.resolve("async result");
    const route = lazyBffRoute(async () => ({ default: () => result }));
    await expect(route(request("first"), response())).resolves.toBe("async result");
    expect(route(request("next"), response())).toBe(result);
  });

  it.each([{}, { default: 7 }])("lets an invalid module fail at invocation: %j", async (module) => {
    const route = lazyBffRoute(async () => module as unknown as { default: Handler });
    await expect(route(request("first"), response())).rejects.toBeInstanceOf(TypeError);
  });

  it("defers a native ESM module and calls its function default", async () => {
    const source = "export default function(req) { return req.url; }";
    const url = `data:text/javascript,${encodeURIComponent(source)}`;
    const load = vi.fn(async () => await import(/* @vite-ignore */ url) as { default: Handler });
    const route = lazyBffRoute(load);
    expect(load).not.toHaveBeenCalled();
    await expect(route(request("native"), response())).resolves.toBe("/api/bff/native");
    expect(route(request("loaded"), response())).toBe("/api/bff/loaded");
    expect(load).toHaveBeenCalledOnce();
  });

  it.each([
    ["evaluation", "throw new Error('evaluation fault'); export default function() {}", "evaluation fault"],
    ["linking", "import { missingExport } from 'node:fs'; export default function() { return missingExport; }", "does not provide an export named"],
  ])("preserves native %s failure on retry", async (_kind, source, message) => {
    const url = `data:text/javascript,${encodeURIComponent(source)}`;
    const load = vi.fn(async () => await import(/* @vite-ignore */ url) as { default: Handler });
    const route = lazyBffRoute(load);
    expect(load).not.toHaveBeenCalled();
    await expect(route(request("first"), response())).rejects.toThrow(message);
    await expect(route(request("retry"), response())).rejects.toThrow(message);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
