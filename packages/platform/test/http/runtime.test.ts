import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createNodeHttpRuntime, createRequestHandler, type NodeHttpRuntimeOptions } from "../../src/http/runtime.js";
import { decorateResponse } from "../../src/http/requestAdapter.js";
import type { EntrypointLoader, HttpHandler, HttpRequest, HttpResponse } from "../../src/http/types.js";
import type { StaticAssetReader } from "../../src/http/security.js";

const serverFactory = vi.hoisted(() => vi.fn());
vi.mock("node:http", () => ({ createServer: serverFactory }));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function request(url: string, body?: string) {
  const stream = new PassThrough();
  const req = Object.assign(stream, {
    method: body === undefined ? "GET" : "POST", url, headers: { host: "example.test" },
  }) as unknown as HttpRequest;
  stream.end(body);
  return req;
}

function response() {
  const headers = new Map<string, unknown>();
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200, headersSent: false, writableEnded: false, destroyed: false, body: "",
    setHeader: vi.fn((name: string, value: unknown) => headers.set(name.toLowerCase(), value)),
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    hasHeader: (name: string) => headers.has(name.toLowerCase()),
    end: vi.fn((chunk?: unknown) => {
      if (chunk !== undefined) res.body += String(chunk);
      res.headersSent = true;
      res.writableEnded = true;
      res.emit("finish");
      return res;
    }),
    destroy: vi.fn(() => { res.destroyed = true; res.emit("close"); }),
  });
  return decorateResponse(res as never) as HttpResponse & { body: string };
}

function loader(handler: HttpHandler = (_req, res) => res.end("entrypoint")): EntrypointLoader {
  return vi.fn(async () => ({ default: handler }));
}

function options(overrides: Partial<NodeHttpRuntimeOptions> = {}): NodeHttpRuntimeOptions {
  return {
    routes: [], dispatch: vi.fn(async (_routes, _req, res) => { res.end("dispatch"); }),
    entrypoints: { cspReport: loader(), bffRouter: loader() },
    security: {
      globalHeaders: [["X-Content-Type-Options", "nosniff"]], assetCachePrefixes: ["/assets/"],
      noindexFamilies: ["/private"], noindexExacts: [], isProductionHost: (host) => host === "example.test",
    },
    onError: vi.fn(), ...overrides,
  };
}

function staticReader(files: Record<string, string> = {}): StaticAssetReader {
  return {
    read: vi.fn(async (path: string) => files[path] === undefined ? null : { body: Buffer.from(files[path]), contentType: path.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8" }),
    readIndex: vi.fn(async () => ({ body: Buffer.from("<shell/>"), contentType: "text/html; charset=utf-8" })),
  };
}

async function get(config: NodeHttpRuntimeOptions, path: string, req = request(path)) {
  const res = response();
  await createRequestHandler(config)(req, res);
  return res;
}

describe("HTTP request precedence", () => {
  it.each(["/api/csp-report///", "/api/bff-router/", "/api/bff/status/", "/document/"])(
    "redirects trailing slashes before any entrypoint for %s", async (path) => {
      const load = loader();
      const match = vi.fn(() => ({}));
      const reader = staticReader();
      const config = options({
        entrypoints: { cspReport: load, bffRouter: load },
        extraEntrypoints: [{ path, load }], pathEntrypoints: [{ match, load }], staticReader: reader,
      });
      const res = await get(config, `${path}?tag=one&tag=two`);
      expect(res.statusCode).toBe(308);
      expect(res.getHeader("location")).toBe(`${path.replace(/\/+$/, "")}?tag=one&tag=two`);
      expect(res.body).toBe("");
      expect(res.getHeader("x-content-type-options")).toBe("nosniff");
      expect(load).not.toHaveBeenCalled();
      expect(match).not.toHaveBeenCalled();
      expect(config.dispatch).not.toHaveBeenCalled();
      expect(reader.read).not.toHaveBeenCalled();
    },
  );

  it("mounts the CSP report entrypoint before extra entries and preserves its raw body", async () => {
    const extra = loader();
    const handler = vi.fn(async (req: HttpRequest, res: HttpResponse) => {
      expect(req.body).toBeUndefined();
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe("report bytes");
      res.status(204);
    });
    const config = options({ entrypoints: { cspReport: loader(handler), bffRouter: extra }, extraEntrypoints: [{ path: "/api/csp-report", load: extra }] });
    const res = await get(config, "/api/csp-report", request("/api/csp-report", "report bytes"));
    expect(res.statusCode).toBe(204);
    expect(res.writableEnded).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    expect(extra).not.toHaveBeenCalled();
    expect(config.dispatch).not.toHaveBeenCalled();
  });

  it("uses the last exact registration, ahead of router and path matching", async () => {
    const inherited = loader();
    const replacement = loader((_req, res) => res.end("replacement"));
    const router = loader();
    const match = vi.fn(() => ({}));
    const config = options({
      entrypoints: { cspReport: loader(), bffRouter: router },
      extraEntrypoints: [{ path: "/api/bff-router", load: inherited }, { path: "/api/bff-router", load: replacement }],
      pathEntrypoints: [{ match, load: loader() }],
    });
    expect((await get(config, "/api/bff-router")).body).toBe("replacement");
    expect(inherited).not.toHaveBeenCalled();
    expect(router).not.toHaveBeenCalled();
    expect(match).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledOnce();
  });

  it("matches exact registrations by pathname and passes their declared body policy", async () => {
    const handler = vi.fn(async (req: HttpRequest, res: HttpResponse) => {
      expect(req.query).toEqual({ mode: "raw" });
      expect(req.body).toBeUndefined();
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      res.end(Buffer.concat(chunks));
    });
    const load = loader(handler);
    const config = options({ extraEntrypoints: [{ path: "/api/upload", rawStream: true, load }] });
    const req = request("/api/upload?mode=raw", "x".repeat(1_048_577));
    expect((await get(config, req.url!, req)).body).toHaveLength(1_048_577);
    expect((await get(config, "/api/upload/nested")).statusCode).toBe(404);
    expect(handler).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
  });

  it("mounts the BFF router before path entries", async () => {
    const match = vi.fn(() => ({}));
    const router = loader((_req, res) => res.end("router"));
    const config = options({ entrypoints: { cspReport: loader(), bffRouter: router }, pathEntrypoints: [{ match, load: loader() }] });
    expect((await get(config, "/api/bff-router")).body).toBe("router");
    expect(router).toHaveBeenCalledOnce();
    expect(match).not.toHaveBeenCalled();
    expect(config.dispatch).not.toHaveBeenCalled();
  });

  it("uses the first path entry and merges captures over query values before BFF dispatch", async () => {
    const skipped = loader();
    const laterMatch = vi.fn(() => ({}));
    const handler = vi.fn((req: HttpRequest, res: HttpResponse) => {
      expect(req.query).toEqual({ key: "captured", tag: ["one", "two"] });
      expect(req.body).toEqual({ count: 2 });
      res.json(req.query);
    });
    const config = options({ pathEntrypoints: [
      { match: () => null, load: skipped },
      { match: (path) => path === "/api/bff/items/captured" ? { key: "captured" } : null, load: loader(handler) },
      { match: laterMatch, load: skipped },
    ] });
    const req = request("/api/bff/items/captured?key=old&tag=one&tag=two", '{"count":2}');
    await get(config, req.url!, req);
    expect(handler).toHaveBeenCalledOnce();
    expect(skipped).not.toHaveBeenCalled();
    expect(laterMatch).not.toHaveBeenCalled();
    expect(config.dispatch).not.toHaveBeenCalled();
  });

  it.each(["/api/bff", "/api/bff/status"])("injects dispatch and the exact route table at %s", async (path) => {
    const routes = [{ route: "/api/bff/status", pattern: /^\/api\/bff\/status$/, params: [], handler: vi.fn() }];
    const dispatch = vi.fn(async (seenRoutes, req: HttpRequest, res: HttpResponse) => {
      expect(seenRoutes).toBe(routes);
      expect(req.query).toEqual({ tag: ["one", "two"] });
      expect(req.cookies).toEqual({ session: "sample" });
      expect(req.body).toEqual({ count: 4 });
      res.setHeader("set-cookie", "session=kept; Path=/; HttpOnly");
      res.json({ ok: true });
    });
    const reader = staticReader();
    const config = options({ routes, dispatch, staticReader: reader });
    const req = request(`${path}?tag=one&tag=two`, '{"count":4}');
    req.headers.cookie = "session=sample";
    req.headers.host = "reference.invalid";
    const res = await get(config, req.url!, req);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(routes, req, res);
    expect(res.body).toBe('{"ok":true}');
    expect(res.getHeader("set-cookie")).toBe("session=kept; Path=/; HttpOnly");
    expect(res.getHeader("x-content-type-options")).toBe("nosniff");
    expect(res.getHeader("x-robots-tag")).toBe("noindex, nofollow, noarchive, nosnippet, noimageindex");
    expect(reader.read).not.toHaveBeenCalled();
  });

  it("serves caller-supplied robots before fallback or static and passes the host", async () => {
    const robotsTxt = vi.fn(() => "User-agent: *\nDisallow: /\n");
    const match = vi.fn(() => ({}));
    const reader = staticReader();
    const req = request("/robots.txt");
    req.headers.host = "reference.invalid";
    const res = await get(options({ robotsTxt, fallbackPathEntrypoints: [{ match, load: loader() }], staticReader: reader }), req.url!, req);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("User-agent: *\nDisallow: /\n");
    expect(robotsTxt).toHaveBeenCalledExactlyOnceWith("reference.invalid");
    expect(res.getHeader("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.getHeader("cache-control")).toBe("public, max-age=0, s-maxage=300, stale-while-revalidate=3600");
    expect(res.getHeader("x-robots-tag")).toBe("noindex, nofollow, noarchive, nosnippet, noimageindex");
    expect(match).not.toHaveBeenCalled();
    expect(reader.read).not.toHaveBeenCalled();
  });

  it("treats robots as an ordinary static path when no robots policy is supplied", async () => {
    const reader = staticReader();
    const res = await get(options({ staticReader: reader }), "/robots.txt");
    expect(res.statusCode).toBe(404);
    expect(reader.read).toHaveBeenCalledExactlyOnceWith("/robots.txt");
    expect(reader.readIndex).not.toHaveBeenCalled();
  });

  it("mounts only scheduled jobs declared by the injected resolver", async () => {
    const job = loader((_req, res) => res.status(401).json({ ok: false, error: { code: "UNAUTHORIZED" } }));
    const scheduledEntrypoint = vi.fn((id: string) => id === "nightly-report" ? job : null);
    const reader = staticReader();
    const config = options({ scheduledEntrypoint, staticReader: reader });
    const admitted = await get(config, "/api/cron/nightly-report");
    expect(admitted.statusCode).toBe(401);
    expect(job).toHaveBeenCalledOnce();
    for (const path of ["/api/cron/queue-drain", "/api/cron/", "/api/cron/nested/job"]) {
      expect((await get(config, path)).statusCode).toBe(path.endsWith("/") ? 308 : 404);
    }
    expect(scheduledEntrypoint.mock.calls).toEqual([["nightly-report"], ["queue-drain"], ["nested/job"]]);
    expect(reader.read).not.toHaveBeenCalled();
  });

  it("returns exact API 404 JSON before redirects, fallback or static", async () => {
    const match = vi.fn(() => ({}));
    const reader = staticReader();
    const config = options({
      routing: { legacyRedirects: [{ source: "/api/missing", destination: "/elsewhere", permanent: true }], ssgPaths: [], csrFallback: { exactPaths: [], routeFamilies: ["/api"] } },
      fallbackPathEntrypoints: [{ match, load: loader() }], staticReader: reader,
    });
    for (const path of ["/api/missing", "/api/bff-other", "/api/cron/queue-drain"]) {
      const res = await get(config, path);
      expect(res.statusCode).toBe(404);
      expect(res.getHeader("content-type")).toBe("application/json; charset=utf-8");
      expect(res.body).toBe('{"ok":false,"error":{"code":"NOT_FOUND","message":"Not found"}}');
    }
    expect(match).not.toHaveBeenCalled();
    expect(reader.read).not.toHaveBeenCalled();
    expect(reader.readIndex).not.toHaveBeenCalled();
  });

  it.each([
    ["/old", "/new"], ["/old/item%20one", "/new/item%20one"],
    ["/archive/a/b", "/records/a/b"], ["/archive", "/records/"],
  ])("expands the first legacy redirect for %s and preserves the query", async (path, destination) => {
    const match = vi.fn(() => ({}));
    const config = options({
      routing: { legacyRedirects: [
        { source: "/old", destination: "/new", permanent: true },
        { source: "/old/:key", destination: "/new/:key", permanent: false },
        { source: "/archive/:tail*", destination: "/records/:tail*", permanent: true },
        { source: "/old/:key", destination: "/later/:key", permanent: true },
      ], ssgPaths: [], csrFallback: { exactPaths: [], routeFamilies: [] } },
      fallbackPathEntrypoints: [{ match, load: loader() }],
    });
    const res = await get(config, `${path}?via=test&tag=one&tag=two`);
    expect(res.statusCode).toBe(308);
    expect(res.getHeader("location")).toBe(`${destination}?via=test&tag=one&tag=two`);
    expect(match).not.toHaveBeenCalled();
  });

  it("rejects partial legacy matches and uses the first fallback path entry before static", async () => {
    const reader = staticReader();
    const later = vi.fn(() => ({}));
    const config = options({
      routing: { legacyRedirects: [{ source: "/old/:key", destination: "/new/:key", permanent: true }], ssgPaths: [], csrFallback: { exactPaths: [], routeFamilies: [] } },
      fallbackPathEntrypoints: [
        { match: () => null, load: loader() },
        { match: (path) => ({ path }), load: loader((req, res) => res.json(req.query)) },
        { match: later, load: loader() },
      ], staticReader: reader,
    });
    const res = await get(config, "/old/item/extra?path=old&retained=value");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ path: "/old/item/extra", retained: "value" });
    expect(later).not.toHaveBeenCalled();
    expect(reader.read).not.toHaveBeenCalled();
  });
});

describe("runtime static documents", () => {
  it.each([
    ["/", 200, "<home/>"], ["/document", 200, "<document/>"],
    ["/client", 200, "<shell/>"], ["/client/nested", 200, "<shell/>"], ["/session", 200, "<shell/>"],
    ["/assets/app.js", 200, "export default 1;"], ["/assets/missing.js", 404, "Not Found"],
    ["/client-other", 404, "Not Found"], ["/session/nested", 404, "Not Found"],
    ["/unknown", 404, "Not Found"], ["/undeclared", 404, "Not Found"],
  ])("serves %s with the declared document policy", async (path, status, body) => {
    const reader = staticReader({ "/index.html": "<home/>", "/document/index.html": "<document/>", "/undeclared/index.html": "<undeclared/>", "/assets/app.js": "export default 1;" });
    const config = options({ staticReader: reader, routing: { legacyRedirects: [], ssgPaths: ["/document"], csrFallback: { exactPaths: ["/session"], routeFamilies: ["/client"] } } });
    const res = await get(config, path);
    expect(res.statusCode).toBe(status);
    expect(res.body).toBe(body);
    expect(reader.readIndex).toHaveBeenCalledTimes(body === "<shell/>" ? 1 : 0);
    expect(res.getHeader("x-content-type-options")).toBe("nosniff");
  });

  it("ends an unmatched request without a static reader", async () => {
    const res = await get(options(), "/unknown");
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe("Not Found");
    expect(res.writableEnded).toBe(true);
  });
});

describe("runtime deadlines and faults", () => {
  const admissions = [
    ["cspReport", "/api/csp-report", 30_000], ["bffRouter", "/api/bff-router", 30_000],
    ["bff", "/api/bff/status", 30_000], ["extra", "/api/slow", 30_000],
    ["path", "/early", 10_000], ["fallback", "/late", 10_000],
    ["scheduled", "/api/cron/nightly-report", 60_000],
  ] as const;

  for (const [kind, path, defaultDuration] of admissions) {
    it.each([false, true])(`bounds ${kind} admission before loading (explicit: %s)`, async (explicit) => {
      vi.useFakeTimers();
      const load = vi.fn(() => new Promise<{ default: HttpHandler }>(() => {}));
      const never = vi.fn(() => new Promise<void>(() => {}));
      const duration = explicit ? 17 : defaultDuration;
      const config = options({ dispatch: never });
      if (kind === "cspReport" || kind === "bffRouter") {
        config.entrypoints = { ...config.entrypoints, [kind]: load };
        if (explicit) config.durations = { [kind]: duration };
      } else if (kind === "bff") {
        if (explicit) config.durations = { bff: duration };
      } else if (kind === "extra") {
        config.extraEntrypoints = [{ path, load, ...(explicit ? { maxDurationMs: duration } : {}) }];
      } else if (kind === "scheduled") {
        config.scheduledEntrypoint = () => load;
        if (explicit) config.durations = { scheduled: (id) => { expect(id).toBe("nightly-report"); return duration; } };
      } else {
        const entry = { match: () => ({}), load, ...(explicit ? { maxDurationMs: duration } : {}) };
        if (kind === "path") config.pathEntrypoints = [entry];
        else config.fallbackPathEntrypoints = [entry];
      }
      const req = request(path);
      const res = response();
      const pending = createRequestHandler(config)(req, res);
      await vi.advanceTimersByTimeAsync(duration - 1);
      expect(res.writableEnded).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(res.statusCode).toBe(504);
      expect(res.body).toBe('{"ok":false,"error":{"code":"NODE_HTTP_TIMEOUT","message":"Request timed out"}}');
      expect(req.abortSignal?.aborted).toBe(true);
      if (kind === "bff") expect(never).toHaveBeenCalledOnce();
      else expect(load).toHaveBeenCalledOnce();
    });
  }

  it("preserves the native signal and suppresses late writes and late rejection", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    let signal: AbortSignal | undefined;
    const fault = new Error("late fault");
    const config = options({ extraEntrypoints: [{ path: "/api/slow", maxDurationMs: 9, load: loader(async (req, res) => {
      signal = req.abortSignal;
      await gate;
      res.status(202).setHeader("x-late", "ignored");
      res.end("late body");
      throw fault;
    }) }] });
    const req = request("/api/slow");
    const nativeSignal = new AbortController().signal;
    Object.defineProperty(req, "signal", { get: () => nativeSignal });
    const res = response();
    const pending = createRequestHandler(config)(req, res);
    await vi.advanceTimersByTimeAsync(9);
    await pending;
    const body = res.body;
    expect(res.statusCode).toBe(504);
    expect((req as unknown as { signal: AbortSignal }).signal).toBe(nativeSignal);
    expect(nativeSignal.aborted).toBe(false);
    expect(signal?.aborted).toBe(true);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(res.body).toBe(body);
    expect(res.getHeader("x-late")).toBeUndefined();
    expect(config.onError).toHaveBeenCalledExactlyOnceWith("/api/slow:late", fault);
  });

  it("returns one safe 413 envelope before buffered handler admission", async () => {
    const handler = vi.fn();
    const config = options({ extraEntrypoints: [{ path: "/api/bounded", load: loader(handler) }] });
    const req = request("/api/bounded", "x".repeat(1_048_577));
    const res = await get(config, req.url!, req);
    expect(res.statusCode).toBe(413);
    expect(res.getHeader("content-type")).toBe("application/json; charset=utf-8");
    expect(res.body).toBe('{"ok":false,"error":{"code":"REQUEST_BODY_TOO_LARGE","message":"Request body too large"}}');
    expect(res.end).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
    expect(req.destroyed).toBe(true);
  });

  it.each(["load", "handler", "dispatch", "static"])("contains a %s fault in a safe 500 envelope", async (stage) => {
    const fault = new Error("private fault detail");
    const fail = () => { throw fault; };
    const config = options();
    let path = "/api/fault";
    if (stage === "load") config.extraEntrypoints = [{ path, load: async () => { throw fault; } }];
    if (stage === "handler") config.extraEntrypoints = [{ path, load: loader(fail) }];
    if (stage === "dispatch") { path = "/api/bff/fault"; config.dispatch = fail; }
    if (stage === "static") { path = "/document"; config.staticReader = { read: async () => { throw fault; }, readIndex: async () => { throw fault; } }; }
    const res = await get(config, path);
    expect(res.statusCode).toBe(500);
    expect(res.getHeader("content-type")).toBe("application/json; charset=utf-8");
    expect(res.body).toBe('{"ok":false,"error":{"code":"NODE_HTTP_ERROR","message":"Internal server error"}}');
    expect(res.end).toHaveBeenCalledOnce();
    expect(config.onError).toHaveBeenCalledExactlyOnceWith(path, fault);
  });

  it("stops aborted buffered admission without an error envelope or handler call", async () => {
    const req = Object.assign(new PassThrough(), { method: "POST", url: "/api/bounded", headers: {} }) as unknown as HttpRequest;
    const handler = vi.fn();
    let loaded!: () => void;
    const admission = new Promise<void>((resolve) => { loaded = resolve; });
    const admitted = vi.fn(async () => { loaded(); return { default: handler }; });
    const config = options({ extraEntrypoints: [{ path: "/api/bounded", load: admitted }] });
    const res = response();
    const pending = createRequestHandler(config)(req, res);
    await admission;
    req.emit("aborted");
    await pending;
    expect(req.abortSignal?.aborted).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(config.onError).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
    req.destroy();
  });
});

describe("Node listener seam", () => {
  it.each([undefined, "localhost"])("creates and exposes the server using host %s", async (host) => {
    let accept!: (req: HttpRequest, res: HttpResponse) => void;
    const server = { listen: vi.fn((_port: number, _host: string, ready: () => void) => ready()) };
    serverFactory.mockReset().mockImplementation((callback) => { accept = callback; return server; });
    const invoked = vi.fn((_req: HttpRequest, res: HttpResponse) => res.status(204).end());
    const runtime = createNodeHttpRuntime(options({ extraEntrypoints: [{ path: "/api/probe", load: loader(invoked) }] }));
    expect(runtime.server).toBeNull();
    expect(typeof runtime.handle).toBe("function");
    expect(typeof runtime.listen).toBe("function");
    await runtime.listen!({ port: 4321, ...(host ? { host } : {}) });
    expect(runtime.server).toBe(server);
    expect(serverFactory).toHaveBeenCalledOnce();
    expect(server.listen).toHaveBeenCalledExactlyOnceWith(4321, host ?? "0.0.0.0", expect.any(Function));
    const req = request("/api/probe");
    const res = response();
    const finished = new Promise<void>((resolve) => res.once("finish", resolve));
    accept(req, res);
    await finished;
    expect(invoked).toHaveBeenCalledExactlyOnceWith(req, res);
    expect(res.statusCode).toBe(204);
  });
});

describe("optional platform entrypoints", () => {
  it.each(["/api/csp-report", "/api/bff-router"])("treats %s as an unknown API path without its handler", async (path) => {
    const res = await get(options({ entrypoints: undefined }), path);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: { code: "NOT_FOUND", message: "Not found" } });
  });

  it("lets an exact-path entrypoint serve a platform path that has no platform handler", async () => {
    const load = loader();
    const res = await get(options({ entrypoints: {}, extraEntrypoints: [{ path: "/api/csp-report", load }] }), "/api/csp-report");
    expect(load).toHaveBeenCalledOnce();
    expect(res.body).toBe("entrypoint");
  });
});
