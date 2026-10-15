import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBffDispatcher, type BffDispatcherOptions, type RouteEntry } from "../../src/bff/dispatch.js";
import { lazyBffRoute } from "../../src/bff/lazyRoute.js";
import type { HttpRequest, HttpResponse } from "../../src/http/types.js";

afterEach(() => vi.unstubAllEnvs());

function request(url: string | undefined = "/api/bff/items/first", query = {}) {
  return { url, query, headers: {} } as HttpRequest;
}

function response() {
  const state = { status: 200, headers: {} as Record<string, string>, body: undefined as unknown };
  const res = {
    status(code: number) { state.status = code; return res; },
    setHeader(name: string, value: string) { state.headers[name.toLowerCase()] = value; return res; },
    json(body: unknown) { state.body = body; return res; },
  } as unknown as HttpResponse;
  return { res, state };
}

let environment: Record<string, string | undefined> = {};
beforeEach(() => {
  environment = {};
});

function dispatcher(options: Partial<BffDispatcherOptions> = {}) {
  const notFound = vi.fn((res: HttpResponse, path: string) => {
    res.setHeader("content-type", "application/json");
    res.status(404).json({ ok: false, error: { code: "NOT_FOUND", path } });
  });
  return { dispatch: createBffDispatcher({ env: () => environment, notFound, preflight: () => true, ...options }), notFound };
}

function route(handler: RouteEntry["handler"] = vi.fn()): RouteEntry {
  return { route: "/api/bff/items/:key", pattern: /^\/api\/bff\/items\/([^/]+)$/, params: ["key"], handler };
}

describe("BFF matching and hooks", () => {
  it("orders configuration, match, availability, decoded parameters, preflight and handler", async () => {
    environment = { PLATFORM_BUNDLE: "node-postgres" };
    const order: string[] = [];
    const req = request("/api/bff/items/part%20one", { key: "old", tag: ["one", "two"] });
    const entry = route((seen, res) => {
      order.push("handler");
      expect(seen).toBe(req);
      expect(res).toBe(target.res);
      return "result";
    });
    const pattern = entry.pattern;
    vi.spyOn(pattern, "exec").mockImplementation((path) => { order.push("match"); return RegExp.prototype.exec.call(pattern, path); });
    Object.defineProperty(entry, "availability", { get() { order.push("availability"); return "direct-postgres"; } });
    let query = req.query;
    Object.defineProperty(req, "query", {
      get: () => query,
      set(value) { order.push("params"); query = value; },
    });
    const preflight = vi.fn(async (seen: HttpRequest, res: HttpResponse, name: string) => {
      order.push("preflight");
      expect(seen.query).toEqual({ key: "part one", tag: ["one", "two"] });
      expect(name).toBe(entry.route);
      expect(res).toBe(target.res);
      await Promise.resolve();
      order.push("preflight settled");
      return true;
    });
    const { dispatch } = dispatcher({ beforeDispatch: () => order.push("beforeDispatch"), preflight });
    const target = response();
    await expect(dispatch([entry], req, target.res)).resolves.toBe("result");
    expect(order).toEqual(["beforeDispatch", "match", "availability", "params", "preflight", "preflight settled", "handler"]);
  });

  it("runs beforeDispatch even for misses and preserves the configured notFound outcome", async () => {
    const beforeDispatch = vi.fn();
    const preflight = vi.fn();
    const { dispatch, notFound } = dispatcher({ beforeDispatch, preflight });
    const target = response();
    await expect(dispatch([], request("/api/bff/absent///?mode=brief"), target.res)).resolves.toBeUndefined();
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(notFound).toHaveBeenCalledExactlyOnceWith(target.res, "/api/bff/absent");
    expect(preflight).not.toHaveBeenCalled();
    expect(target.state).toEqual({ status: 404, headers: { "content-type": "application/json" }, body: { ok: false, error: { code: "NOT_FOUND", path: "/api/bff/absent" } } });
  });

  it.each(["", "/", "https://example.test///"])("normalizes an empty root or root slashes (%j)", async (url) => {
    const handler = vi.fn(() => "root");
    await expect(dispatcher().dispatch([{ route: "/", pattern: /^\/$/, params: [], handler }], request(url), response().res)).resolves.toBe("root");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("matches the same path with or without a Host header", async () => {
    const handler = vi.fn();
    const entry = route(handler);
    await dispatcher().dispatch([entry], request("/api/bff/items/first///?x=1"), response().res);
    const req = request();
    req.headers.host = "example.test";
    await dispatcher().dispatch([entry], req, response().res);
    delete req.headers.host;
    await dispatcher().dispatch([entry], req, response().res);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("defaults a missing URL to the root", async () => {
    const handler = vi.fn();
    const req = request();
    delete req.url;
    await dispatcher().dispatch([{ route: "/", pattern: /^\/$/, params: [], handler }], req, response().res);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("decodes captures once and replaces colliding query values without mutating the old object", async () => {
    const old = { key: "old", retained: "value" };
    const req = request("/api/bff/items/a%2Fb%2520c", old);
    await dispatcher().dispatch([route()], req, response().res);
    expect(req.query).toEqual({ key: "a/b%20c", retained: "value" });
    expect(old).toEqual({ key: "old", retained: "value" });
  });

  it("maps missing optional captures to an empty string", async () => {
    const req = request("/api/bff/items");
    const entry = { ...route(), pattern: /^\/api\/bff\/items(?:\/([^/]+))?$/ };
    await dispatcher().dispatch([entry], req, response().res);
    expect(req.query.key).toBe("");
  });

  it("rejects malformed encoding before preflight or handler", async () => {
    const handler = vi.fn();
    const preflight = vi.fn();
    await expect(dispatcher({ preflight }).dispatch([route(handler)], request("/api/bff/items/%zz"), response().res)).rejects.toBeInstanceOf(URIError);
    expect(preflight).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("retains the query object when there are no parameters", async () => {
    const req = request();
    const query = req.query;
    await dispatcher().dispatch([{ ...route(), params: [] }], req, response().res);
    expect(req.query).toBe(query);
  });

  it("uses the first match without inspecting later routes", async () => {
    const first = vi.fn(() => 17);
    const later = route(vi.fn());
    const exec = vi.spyOn(later.pattern, "exec");
    await expect(dispatcher().dispatch([route(first), later], request(), response().res)).resolves.toBe(17);
    expect(first).toHaveBeenCalledOnce();
    expect(exec).not.toHaveBeenCalled();
  });

  it("awaits a synchronous preflight before calling the handler", async () => {
    const handler = vi.fn(() => "done");
    const preflight = vi.fn(() => true);
    const { dispatch } = dispatcher({ preflight });
    const pending = dispatch([route(handler)], request(), response().res);
    expect(preflight).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
    await expect(pending).resolves.toBe("done");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("waits for asynchronous preflight and stops after its refusal", async () => {
    let settle!: (value: boolean) => void;
    const gate = new Promise<boolean>((resolve) => { settle = resolve; });
    const handler = vi.fn();
    const { dispatch, notFound } = dispatcher({ preflight: () => gate });
    const pending = dispatch([route(handler)], request(), response().res);
    expect(handler).not.toHaveBeenCalled();
    settle(false);
    await expect(pending).resolves.toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
    expect(notFound).not.toHaveBeenCalled();
  });

  it.each(["beforeDispatch", "preflight", "handler"] as const)("propagates a %s fault", async (stage) => {
    const error = new Error("hook fault");
    const handler = vi.fn(() => { if (stage === "handler") throw error; });
    const preflight = vi.fn(() => { if (stage === "preflight") throw error; return true; });
    const { dispatch } = dispatcher({ beforeDispatch() { if (stage === "beforeDispatch") throw error; }, preflight });
    await expect(dispatch([route(handler)], request(), response().res)).rejects.toBe(error);
    expect(handler).toHaveBeenCalledTimes(stage === "handler" ? 1 : 0);
    expect(preflight).toHaveBeenCalledTimes(stage === "beforeDispatch" ? 0 : 1);
  });
});

describe("bundle availability", () => {
  it.each(["vercel-supabase", "node-supabase", "node-postgres", "unknown", undefined])(
    "checks direct-postgres before decoding and preflight for %s", async (bundle) => {
      environment = { PLATFORM_BUNDLE: bundle };
      const handler = vi.fn();
      const preflight = vi.fn(() => true);
      const { dispatch, notFound } = dispatcher({ preflight });
      const entry = { ...route(handler), availability: "direct-postgres" as const };
      const target = response();
      const req = request("/api/bff/items/%zz");
      if (bundle === "node-postgres") {
        await expect(dispatch([entry], req, target.res)).rejects.toBeInstanceOf(URIError);
        await dispatch([entry], request(), target.res);
        expect(handler).toHaveBeenCalledOnce();
        expect(preflight).toHaveBeenCalledOnce();
        expect(notFound).not.toHaveBeenCalled();
      } else {
        await dispatch([entry, route(handler)], req, target.res);
        expect(notFound).toHaveBeenCalledExactlyOnceWith(target.res, "/api/bff/items/%zz");
        expect(req.query).toEqual({});
        expect(handler).not.toHaveBeenCalled();
        expect(preflight).not.toHaveBeenCalled();
        expect(target.state.status).toBe(404);
      }
    },
  );
});

describe("refusals before deferred module faults", () => {
  it.each(["missing module", "missing default", "nonfunction default", "evaluation", "connection"])(
    "keeps refusal responses unchanged under a %s fault", async (kind) => {
      const fault = new Error(`${kind} fault`);
      const load = vi.fn(async () => {
        if (kind === "missing default") return {} as { default: RouteEntry["handler"] };
        if (kind === "nonfunction default") return { default: 7 } as unknown as { default: RouteEntry["handler"] };
        throw fault;
      });
      const entry = route(lazyBffRoute(load));
      const unrelatedLoad = vi.fn(async () => { throw new Error("unrelated fault"); });
      const unrelated = { ...route(lazyBffRoute(unrelatedLoad)), pattern: /^\/api\/bff\/other$/ };
      for (const status of [401, 403, 503]) {
        const target = response();
        const { dispatch } = dispatcher({ preflight(_req, res) {
          res.setHeader("content-type", "application/json");
          res.setHeader("cache-control", "no-store");
          res.status(status).json({ ok: false, error: { code: `REFUSED_${status}` } });
          return false;
        } });
        await dispatch([entry, unrelated], request(), target.res);
        expect(target.state).toEqual({ status, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: { ok: false, error: { code: `REFUSED_${status}` } } });
        expect(load).not.toHaveBeenCalled();
        expect(unrelatedLoad).not.toHaveBeenCalled();
      }
      const permitted = dispatcher().dispatch([entry, unrelated], request(), response().res);
      if (kind === "missing default" || kind === "nonfunction default") await expect(permitted).rejects.toBeInstanceOf(TypeError);
      else await expect(permitted).rejects.toBe(fault);
      expect(load).toHaveBeenCalledOnce();
      expect(unrelatedLoad).not.toHaveBeenCalled();
    },
  );

  it("allows healthy matched modules without loading an unrelated faulty module", async () => {
    const handler = vi.fn((_req: HttpRequest, res: HttpResponse) => res.status(207).json({ ok: true, data: "synthetic" }));
    const load = vi.fn(async () => ({ default: handler }));
    const unrelated = vi.fn(async () => { throw new Error("unrelated fault"); });
    const target = response();
    await dispatcher().dispatch([
      route(lazyBffRoute(load)),
      { ...route(lazyBffRoute(unrelated)), pattern: /^\/api\/bff\/other$/ },
    ], request(), target.res);
    expect(target.state).toEqual({ status: 207, headers: {}, body: { ok: true, data: "synthetic" } });
    expect(load).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
    expect(unrelated).not.toHaveBeenCalled();
  });
});
