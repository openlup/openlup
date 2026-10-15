import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpRuntimePort } from "@openlup/core/platform-runtime";
import { createNodeHost } from "../../src/composition/nodeHost.js";
import type { PlatformBundle } from "../../src/composition/composeBundle.js";
import { createNodeHttpRuntime } from "../../src/http/runtime.js";
import { decorateResponse } from "../../src/http/requestAdapter.js";
import type { HttpRequest, HttpResponse } from "../../src/http/types.js";
import { getBundleDescriptor, type PlatformBundleId } from "../../src/kernel/platformKernel.js";
import { createEnvAdvisoryLock, type AdvisoryLock } from "../../src/scheduler/advisoryLock.js";
import type { ScheduledJobHandlerRegistry } from "../../src/scheduler/handlers.js";
import type { CronScheduler } from "../../src/scheduler/nodeScheduler.js";

vi.mock("../../src/scheduler/advisoryLock.js", async (original) => {
  const actual = await original<typeof import("../../src/scheduler/advisoryLock.js")>();
  return { ...actual, createEnvAdvisoryLock: vi.fn(actual.createEnvAdvisoryLock) };
});

const files = vi.hoisted(() => new Map<string, string>());
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async (path: string) => {
    const body = files.get(String(path));
    if (body === undefined) throw new Error("missing fixture");
    return Buffer.from(body);
  }),
  stat: vi.fn(async (path: string) => {
    if (!files.has(String(path))) throw new Error("missing fixture");
    return { isFile: () => true };
  }),
}));

const jobs = [
  { jobId: "nightly-report", schedule: "0 6 * * *", path: "/api/cron/nightly-report" },
  { jobId: "queue-drain", schedule: "*/4 * * * *", path: "/api/cron/queue-drain" },
];
const env = { PLATFORM_BUNDLE: "node-supabase", APP_BASE_URL: "https://example.test", CRON_SECRET: "host-key" };

function cronFixture() {
  const callbacks: Array<() => void | Promise<void>> = [];
  const stops: Array<ReturnType<typeof vi.fn>> = [];
  const schedule = vi.fn<CronScheduler["schedule"]>((_expression, callback) => {
    callbacks.push(callback);
    const stop = vi.fn();
    stops.push(stop);
    return { stop };
  });
  return { cron: { schedule }, callbacks, stops };
}

function lockFixture() {
  return {
    tryAcquire: vi.fn<AdvisoryLock["tryAcquire"]>().mockResolvedValue(true),
    release: vi.fn<AdvisoryLock["release"]>().mockResolvedValue(undefined),
    close: vi.fn<AdvisoryLock["close"]>().mockResolvedValue(undefined),
  };
}

function hostFixture(id: PlatformBundleId = "node-supabase") {
  const runtime = { handle: vi.fn(), listen: vi.fn().mockResolvedValue(undefined) };
  const bundle: PlatformBundle = {
    id, descriptor: getBundleDescriptor(id),
    ports: { http: id === "vercel-supabase" ? null : runtime, scheduler: null, blob: null, data: null, migrations: null, analytics: null, transactional: null },
  };
  const deps = {
    composeBundle: vi.fn(() => bundle),
    createHttpRuntime: vi.fn<Parameters<typeof createNodeHost>[0]["createHttpRuntime"]>(() => runtime),
    loadSchedulerJobs: vi.fn(() => jobs),
    scheduledJobHandlers: vi.fn<() => ScheduledJobHandlerRegistry>(() => ({})),
    prepareHost: vi.fn(), admitHost: vi.fn().mockResolvedValue(undefined), log: vi.fn(),
  };
  return { host: createNodeHost(deps), deps, bundle, runtime };
}

beforeEach(() => {
  vi.clearAllMocks();
  files.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("host readiness and boot order", () => {
  it("accepts a ready Node bundle and returns its identity", () => {
    expect(hostFixture().host.assertBundleReady(env)).toEqual({ bundleId: "node-supabase" });
  });

  it.each([undefined, "", "   "])("reports the exact readiness refusal for base URL %s", (APP_BASE_URL) => {
    expect(() => hostFixture().host.assertBundleReady({ ...env, APP_BASE_URL }))
      .toThrow('[serve.node] bundle "node-supabase" not ready: APP_BASE_URL is required for self-host bundles');
  });

  it("refuses a bundle with no bound HTTP runtime", () => {
    expect(() => hostFixture("vercel-supabase").host.assertBundleReady({}))
      .toThrow('[serve.node] bundle "vercel-supabase" has no http runtime (expected node bundle)');
  });

  it("prepares first, checks readiness, admits, constructs the runtime, schedules, then listens", async () => {
    const { host, deps, bundle, runtime } = hostFixture();
    const { cron } = cronFixture();
    const order: string[] = [];
    deps.prepareHost.mockImplementation(() => { order.push("prepare"); });
    deps.composeBundle.mockImplementation(() => { order.push("compose"); return bundle; });
    bundle.descriptor = { ...bundle.descriptor, readReadiness: () => { order.push("readiness"); return { ok: true }; } };
    deps.loadSchedulerJobs.mockImplementation(() => { order.push("jobs"); return jobs; });
    deps.scheduledJobHandlers.mockImplementation(() => { order.push("handlers"); return {}; });
    deps.admitHost.mockImplementation(async () => { order.push("admit"); });
    deps.createHttpRuntime.mockImplementation(() => { order.push("runtime"); return runtime; });
    cron.schedule.mockImplementation(() => { order.push("schedule"); return { stop: vi.fn() }; });
    runtime.listen.mockImplementation(async () => { order.push("listen"); });
    const result = await host.serveNode({ env, cron, port: 0 });
    expect(order).toEqual(["prepare", "compose", "readiness", "compose", "jobs", "handlers", "admit", "runtime", "schedule", "schedule", "listen"]);
    expect(deps.prepareHost).toHaveBeenCalledExactlyOnceWith(env);
    expect(deps.composeBundle).toHaveBeenCalledWith(env);
    await result.stop();
  });

  it("propagates preparation failure before composition or timers", async () => {
    const { host, deps } = hostFixture();
    const { cron } = cronFixture();
    const failure = new Error("preparation refused");
    deps.prepareHost.mockImplementation(() => { throw failure; });
    await expect(host.serveNode({ env, cron, listen: false })).rejects.toBe(failure);
    expect(deps.composeBundle).not.toHaveBeenCalled();
    expect(deps.admitHost).not.toHaveBeenCalled();
    expect(cron.schedule).not.toHaveBeenCalled();
  });

  it("admits timers even without a listener and passes merged handlers and timed jobs", async () => {
    const { host, deps } = hostFixture();
    const { cron } = cronFixture();
    const earlier = vi.fn();
    const replacement = vi.fn();
    const independent = vi.fn();
    deps.scheduledJobHandlers.mockReturnValue({ "nightly-report": earlier, "queue-drain": independent });
    const result = await host.serveNode({ env, cron, listen: false, scheduledJobHandlers: { "nightly-report": replacement } });
    expect(deps.admitHost).toHaveBeenCalledExactlyOnceWith(env, {
      kind: "node", nodeJobs: jobs, nodeJobHandlers: { "nightly-report": replacement, "queue-drain": independent },
    });
    await result.stop();
  });

  it("passes no timed jobs when listening without cron", async () => {
    const { host, deps } = hostFixture();
    const result = await host.serveNode({ env, port: 0 });
    expect(deps.admitHost).toHaveBeenCalledExactlyOnceWith(env, { kind: "node", nodeJobs: [], nodeJobHandlers: {} });
    expect(result.registeredJobs).toEqual([]);
    await result.stop();
  });

  it("skips admission and listening when neither listener nor cron is requested", async () => {
    const { host, deps, runtime } = hostFixture();
    const result = await host.serveNode({ env, listen: false });
    expect(deps.admitHost).not.toHaveBeenCalled();
    expect(runtime.listen).not.toHaveBeenCalled();
    expect(result.httpRuntime).toBe(runtime);
    expect(result.bundleId).toBe("node-supabase");
    expect(result.registeredJobs).toEqual([]);
    expect(deps.createHttpRuntime).toHaveBeenCalledWith({ schedulerJobs: jobs, staticReader: expect.objectContaining({ read: expect.any(Function), readIndex: expect.any(Function) }) });
    await result.stop();
  });

  it("propagates admission refusal before constructing the runtime or registering timers", async () => {
    const { host, deps, runtime } = hostFixture();
    const { cron } = cronFixture();
    const failure = new Error("admission refused");
    deps.admitHost.mockRejectedValue(failure);
    await expect(host.serveNode({ env, cron, listen: false })).rejects.toBe(failure);
    expect(deps.createHttpRuntime).not.toHaveBeenCalled();
    expect(cron.schedule).not.toHaveBeenCalled();
    expect(runtime.listen).not.toHaveBeenCalled();
  });
});

describe("boot migrations and listener options", () => {
  it.each([
    ["node-postgres", true, true, true],
    ["node-postgres", false, true, false],
    ["node-supabase", true, true, false],
    ["node-postgres", true, false, false],
  ] as const)("gates migration replay for %s, listen=%s, bound=%s", async (id, listen, bound, expected) => {
    const { host, deps, bundle, runtime } = hostFixture(id);
    const order: string[] = [];
    const apply = vi.fn(async () => { order.push("apply"); return { applied: ["001", "002"] }; });
    bundle.ports.migrations = bound ? { apply, status: vi.fn() } : null;
    deps.admitHost.mockImplementation(async () => { order.push("admit"); });
    runtime.listen.mockImplementation(async () => { order.push("listen"); });
    const result = await host.serveNode({ env: { ...env, PLATFORM_BUNDLE: id }, listen, port: 0 });
    expect(apply).toHaveBeenCalledTimes(expected ? 1 : 0);
    if (expected) {
      expect(apply).toHaveBeenCalledWith();
      expect(order).toEqual(["apply", "admit", "listen"]);
      expect(deps.log).toHaveBeenNthCalledWith(1, "[serve.node] bundle=node-postgres applied 2 migration(s) before serve");
    } else {
      expect(deps.log.mock.calls.flat().some((line: string) => line.includes("migration(s)"))).toBe(false);
    }
    await result.stop();
  });

  it("propagates a migration failure before admission, runtime construction or timers", async () => {
    const { host, deps, bundle } = hostFixture("node-postgres");
    const { cron } = cronFixture();
    const failure = new Error("migration refused");
    bundle.ports.migrations = { apply: vi.fn().mockRejectedValue(failure), status: vi.fn() };
    await expect(host.serveNode({ env, cron, port: 0 })).rejects.toBe(failure);
    expect(deps.admitHost).not.toHaveBeenCalled();
    expect(deps.createHttpRuntime).not.toHaveBeenCalled();
    expect(cron.schedule).not.toHaveBeenCalled();
  });

  it.each([
    [0, "8123", "localhost", 0, "localhost"],
    [undefined, "8123", undefined, 8123, "0.0.0.0"],
    [undefined, undefined, undefined, 3000, "0.0.0.0"],
  ] as const)("resolves listener options and reports the selected port", async (port, PORT, hostName, expectedPort, expectedHost) => {
    const { host, deps, runtime } = hostFixture();
    const { cron } = cronFixture();
    const result = await host.serveNode({ env: { ...env, PORT }, port, host: hostName, cron });
    expect(runtime.listen).toHaveBeenCalledExactlyOnceWith({ port: expectedPort, host: expectedHost });
    expect(deps.log).toHaveBeenCalledWith(`[serve.node] bundle=node-supabase listening on :${expectedPort} (2 cron jobs)`);
    await result.stop();
  });
});

describe("host scheduled execution", () => {
  it("registers precisely the loaded jobs in registry order", async () => {
    const { host, deps } = hostFixture();
    const { cron } = cronFixture();
    const result = await host.serveNode({ env, cron, listen: false });
    expect(deps.loadSchedulerJobs).toHaveBeenCalledTimes(1);
    expect(result.registeredJobs).toEqual(jobs.map(({ jobId }) => jobId));
    expect(cron.schedule.mock.calls.map(([expression]) => expression)).toEqual(jobs.map(({ schedule }) => schedule));
    await result.stop();
  });

  it("uses an explicit job projection and executes the overriding direct binding without fetch", async () => {
    const { host, deps } = hostFixture();
    const { cron, callbacks } = cronFixture();
    const first = vi.fn();
    const direct = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    deps.scheduledJobHandlers.mockReturnValue({ "queue-drain": first });
    const selected = [jobs[1]];
    const result = await host.serveNode({ env, cron, listen: false, schedulerJobs: selected, scheduledJobHandlers: { "queue-drain": direct } });
    expect(deps.loadSchedulerJobs).not.toHaveBeenCalled();
    expect(result.registeredJobs).toEqual(["queue-drain"]);
    expect(deps.createHttpRuntime.mock.calls[0][0].schedulerJobs).toBe(selected);
    await callbacks[0]();
    expect(direct).toHaveBeenCalledExactlyOnceWith({ jobId: "queue-drain", invocationSource: "node_cron" });
    expect(first).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    await result.stop();
  });

  it.each(["host-key", "", undefined])("bridges with GET and only adds bearer auth for a configured secret %s", async (CRON_SECRET) => {
    const { host } = hostFixture();
    const { cron, callbacks } = cronFixture();
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetch);
    const result = await host.serveNode({ env: { ...env, CRON_SECRET }, cron, listen: false });
    for (const callback of callbacks) await callback();
    expect(fetch.mock.calls).toEqual(jobs.map(({ path }) => [
      `https://example.test${path}`, { method: "GET", headers: CRON_SECRET ? { Authorization: `Bearer ${CRON_SECRET}` } : {} },
    ]));
    await result.stop();
  });

  it("defaults the bridge origin when the descriptor permits an absent base URL", async () => {
    const { host, bundle } = hostFixture();
    bundle.descriptor = { ...bundle.descriptor, readReadiness: () => ({ ok: true }) };
    const { cron, callbacks } = cronFixture();
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetch);
    const result = await host.serveNode({ env: {}, cron, listen: false });
    await callbacks[0]();
    expect(fetch).toHaveBeenCalledWith("http://localhost:3000/api/cron/nightly-report", { method: "GET", headers: {} });
    await result.stop();
  });

  it("reports bridge HTTP failures through the scheduler and releases its lock", async () => {
    const { host } = hostFixture();
    const { cron, callbacks } = cronFixture();
    const lock = lockFixture();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502 }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await host.serveNode({ env, cron, listen: false, advisoryLock: lock });
    await callbacks[0]();
    expect(error).toHaveBeenCalledExactlyOnceWith('[node-scheduler] job "nightly-report" failed',
      new Error('node scheduler compatibility bridge for "nightly-report" returned HTTP 502'));
    expect(lock.release).toHaveBeenCalledWith("nightly-report");
    await result.stop();
  });

  it("uses the environment lock by default and gives an explicit lock precedence", async () => {
    const environmentLock = lockFixture();
    vi.mocked(createEnvAdvisoryLock).mockReturnValueOnce(environmentLock);
    const first = hostFixture();
    const firstCron = cronFixture();
    const configured = { ...env, DATABASE_URL: "postgres://localhost/runtime" };
    const direct = vi.fn();
    const result = await first.host.serveNode({ env: configured, cron: firstCron.cron, listen: false, scheduledJobHandlers: { "nightly-report": direct } });
    expect(createEnvAdvisoryLock).toHaveBeenCalledExactlyOnceWith(configured);
    await firstCron.callbacks[0]();
    expect(environmentLock.tryAcquire).toHaveBeenCalledWith("nightly-report");
    expect(environmentLock.release).toHaveBeenCalledWith("nightly-report");
    await result.stop();
    expect(environmentLock.close).toHaveBeenCalledTimes(1);

    const explicit = lockFixture();
    explicit.tryAcquire.mockResolvedValue(false);
    const secondCron = cronFixture();
    const second = await hostFixture().host.serveNode({ env: configured, cron: secondCron.cron, listen: false, advisoryLock: explicit, scheduledJobHandlers: { "nightly-report": direct } });
    await secondCron.callbacks[0]();
    expect(createEnvAdvisoryLock).toHaveBeenCalledTimes(1);
    expect(explicit.tryAcquire).toHaveBeenCalledWith("nightly-report");
    expect(direct).toHaveBeenCalledTimes(1);
    expect(explicit.release).not.toHaveBeenCalled();
    await second.stop();
    expect(explicit.close).toHaveBeenCalledTimes(1);
  });

  it("runs one overlapping replica and permits a later invocation after release", async () => {
    const held = new Set<string>();
    const lock: AdvisoryLock = {
      async tryAcquire(id) { if (held.has(id)) return false; held.add(id); return true; },
      async release(id) { held.delete(id); }, async close() {},
    };
    let finish!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolvePending) => { finish = resolvePending; });
    const started = new Promise<void>((resolveStarted) => { entered = resolveStarted; });
    const direct = vi.fn(async () => { entered(); await pending; });
    const { cron, callbacks } = cronFixture();
    const options = { env, cron, listen: false, advisoryLock: lock, schedulerJobs: [jobs[0]], scheduledJobHandlers: { "nightly-report": direct } };
    const first = await hostFixture().host.serveNode(options);
    const second = await hostFixture().host.serveNode(options);
    const running = callbacks[0]();
    await started;
    await callbacks[1]();
    expect(direct).toHaveBeenCalledTimes(1);
    finish();
    await running;
    await callbacks[1]();
    expect(direct).toHaveBeenCalledTimes(2);
    await Promise.all([first.stop(), second.stop()]);
  });
});

describe("host shutdown", () => {
  it("caches shutdown and stops all timers, the lock and the listener once", async () => {
    const { host, runtime } = hostFixture();
    const { cron, stops } = cronFixture();
    const lock = lockFixture();
    const server = { listening: true, close: vi.fn((done: (error?: Error) => void) => { server.listening = false; done(); }) };
    Object.assign(runtime, { server });
    const result = await host.serveNode({ env, cron, advisoryLock: lock, port: 0 });
    const stopping = result.stop();
    expect(result.stop()).toBe(stopping);
    await stopping;
    await result.stop();
    for (const stop of stops) expect(stop).toHaveBeenCalledTimes(1);
    expect(lock.close).toHaveBeenCalledTimes(1);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(server.listening).toBe(false);
  });

  it("closes the listener despite lock failure and rethrows the cached aggregate", async () => {
    const { host, runtime } = hostFixture();
    const { cron, stops } = cronFixture();
    const lock = lockFixture();
    const failure = new Error("lock close failed");
    lock.close.mockRejectedValue(failure);
    const server = { listening: true, close: vi.fn((done: (error?: Error) => void) => { server.listening = false; done(); }) };
    Object.assign(runtime, { server });
    const result = await host.serveNode({ env, cron, advisoryLock: lock, port: 0 });
    const stopping = result.stop();
    await expect(stopping).rejects.toMatchObject({ message: "node_host_shutdown_failed", errors: [failure] });
    expect(server.listening).toBe(false);
    expect(result.stop()).toBe(stopping);
    await expect(result.stop()).rejects.toBeInstanceOf(AggregateError);
    expect(lock.close).toHaveBeenCalledTimes(1);
    expect(server.close).toHaveBeenCalledTimes(1);
    for (const stop of stops) expect(stop).toHaveBeenCalledTimes(1);
  });

  it("aggregates timer, lock and listener failures while attempting every shutdown phase", async () => {
    const { host, runtime } = hostFixture();
    const { cron, stops } = cronFixture();
    const lock = lockFixture();
    const timerFailure = new Error("timer close failed");
    const lockFailure = new Error("lock close failed");
    const listenerFailure = new Error("listener close failed");
    lock.close.mockRejectedValue(lockFailure);
    const close = vi.fn((done: (error?: Error) => void) => { done(listenerFailure); });
    Object.assign(runtime, { server: { close } });
    const result = await host.serveNode({ env, cron, advisoryLock: lock, listen: false, schedulerJobs: [jobs[0]] });
    stops[0].mockImplementation(() => { throw timerFailure; });
    await expect(result.stop()).rejects.toMatchObject({ message: "node_host_shutdown_failed", errors: [timerFailure, lockFailure, listenerFailure] });
    expect(close).toHaveBeenCalledTimes(1);
    expect(lock.close).toHaveBeenCalledTimes(1);
    expect(stops[0]).toHaveBeenCalledTimes(1);
  });
});

describe("host static reader wiring", () => {
  function staticHost() {
    const fixture = hostFixture();
    fixture.deps.createHttpRuntime.mockImplementation(({ staticReader }) => createNodeHttpRuntime({
      routes: [], dispatch: vi.fn(), staticReader,
      security: { globalHeaders: [], assetCachePrefixes: ["/assets/"], noindexFamilies: [], noindexExacts: [], isProductionHost: () => false },
      entrypoints: { cspReport: async () => ({ default: vi.fn() }), bffRouter: async () => ({ default: vi.fn() }) },
      routing: { legacyRedirects: [], ssgPaths: ["/pages/reference"], csrFallback: { exactPaths: [], routeFamilies: ["/workspace"] } },
    }));
    return fixture;
  }

  async function get(runtime: HttpRuntimePort, path: string) {
    const stream = new PassThrough();
    const req = stream as unknown as HttpRequest;
    req.method = "GET"; req.url = path; req.headers = { host: "example.test" }; stream.end();
    const headers = new Map<string, unknown>();
    const res = {
      statusCode: 200, headersSent: false, writableEnded: false, body: "",
      setHeader(key: string, value: unknown) { headers.set(key.toLowerCase(), value); },
      getHeader(key: string) { return headers.get(key.toLowerCase()); },
      hasHeader(key: string) { return headers.has(key.toLowerCase()); },
      end(body?: unknown) { res.body += body === undefined ? "" : String(body); res.writableEnded = true; res.headersSent = true; },
    };
    await runtime.handle(req, decorateResponse(res as unknown as Parameters<typeof decorateResponse>[0]) as HttpResponse);
    return res;
  }

  it("provides a traversal-safe reader for the explicit dist directory", async () => {
    const { host, deps } = hostFixture();
    const root = resolve(process.cwd(), "synthetic-dist");
    files.set(resolve(root, "index.html"), "<root/>");
    files.set(resolve(root, "app.js"), "globalThis.ready = true");
    files.set(resolve(root, "../outside.txt"), "outside");
    const result = await host.serveNode({ env, listen: false, distDir: root });
    const reader = deps.createHttpRuntime.mock.calls[0][0].staticReader;
    const asset = await reader.read("/app.js");
    expect(asset?.body.toString()).toBe("globalThis.ready = true");
    expect(asset?.contentType).toBe("text/javascript; charset=utf-8");
    expect((await reader.readIndex()).body.toString()).toBe("<root/>");
    expect(await reader.read("/../outside.txt")).toBeNull();
    expect(await reader.read("/missing.js")).toBeNull();
    await result.stop();
  });

  it("serves distinct documents, client fallback and assets from the default dist root", async () => {
    const root = resolve(process.cwd(), "dist");
    for (const [path, body] of Object.entries({ "index.html": "<root/>", "pages/reference/index.html": "<reference/>", "spa-fallback.html": "<client/>", "assets/app.js": "globalThis.ready = true" })) files.set(resolve(root, path), body);
    const { host } = staticHost();
    const result = await host.serveNode({ env, listen: false });
    expect((await get(result.httpRuntime, "/")).body).toBe("<root/>");
    expect((await get(result.httpRuntime, "/pages/reference")).body).toBe("<reference/>");
    expect((await get(result.httpRuntime, "/workspace/entries")).body).toBe("<client/>");
    expect((await get(result.httpRuntime, "/assets/app.js")).body).toBe("globalThis.ready = true");
    expect((await get(result.httpRuntime, "/assets/missing.js")).statusCode).toBe(404);
    expect((await get(result.httpRuntime, "/unknown-page")).statusCode).toBe(404);
    await result.stop();
  });

  it("uses the root index for client fallback when no separate fallback document exists", async () => {
    files.set(resolve(process.cwd(), "dist/index.html"), "<client-root/>");
    const { host } = staticHost();
    const result = await host.serveNode({ env, listen: false });
    expect((await get(result.httpRuntime, "/workspace/entries")).body).toBe("<client-root/>");
    await result.stop();
  });
});

describe("scheduler profile hooks", () => {
  it("projects the declared jobs, layers profile bindings last and validates before and during registration", async () => {
    const { host, deps } = hostFixture();
    const { cron } = cronFixture();
    const lock = lockFixture();
    const events: string[] = [];
    const overrideBinding = vi.fn();
    const profileBinding = vi.fn();
    deps.scheduledJobHandlers.mockReturnValue({ "nightly-report": vi.fn() });
    const profile = {
      projectJobs: vi.fn((_env: unknown, declared: readonly (typeof jobs)[number][]) => {
        events.push("project");
        return [{ ...declared[1]!, schedule: "* * * * *" }];
      }),
      handlers: vi.fn(() => { events.push("handlers"); return { "queue-drain": profileBinding }; }),
      validateSchedule: vi.fn(() => { events.push("validateSchedule"); }),
      validateJob: vi.fn(() => { events.push("validateJob"); }),
    };
    deps.admitHost.mockImplementation(async () => { events.push("admit"); });
    cron.schedule.mockImplementation(() => { events.push("schedule"); return { stop: vi.fn() }; });

    const result = await host.serveNode({
      env, cron, listen: false, advisoryLock: lock, schedulerProfile: profile,
      scheduledJobHandlers: { "queue-drain": overrideBinding },
    });

    expect(profile.projectJobs).toHaveBeenCalledWith(env, jobs);
    expect(result.registeredJobs).toEqual(["queue-drain"]);
    expect(cron.schedule).toHaveBeenCalledWith("* * * * *", expect.any(Function), { timezone: undefined });
    expect(deps.admitHost).toHaveBeenCalledWith(env, expect.objectContaining({
      nodeJobs: [{ ...jobs[1], schedule: "* * * * *" }],
      nodeJobHandlers: expect.objectContaining({ "queue-drain": profileBinding }),
    }));
    expect(profile.validateSchedule).toHaveBeenCalledWith({
      lock, jobs: [{ ...jobs[1], schedule: "* * * * *" }], overrides: { "queue-drain": overrideBinding },
    });
    expect(profile.validateJob).toHaveBeenCalledWith({ ...jobs[1], schedule: "* * * * *" }, profileBinding);
    expect(events).toEqual(["project", "handlers", "admit", "validateSchedule", "validateJob", "schedule"]);
  });

  it("stops the boot when a profile hook refuses, before that job is registered", async () => {
    const { host } = hostFixture();
    const { cron } = cronFixture();
    const refusal = new Error("profile_refused");
    const profile = {
      projectJobs: (_env: unknown, declared: readonly (typeof jobs)[number][]) => [...declared],
      validateJob: vi.fn((job: (typeof jobs)[number]) => { if (job.jobId === "queue-drain") throw refusal; }),
    };
    await expect(host.serveNode({ env, cron, listen: false, advisoryLock: lockFixture(), schedulerProfile: profile }))
      .rejects.toBe(refusal);
    expect(cron.schedule).toHaveBeenCalledTimes(1);

    const lockRefusal = new Error("profile_lock_refused");
    const fresh = hostFixture();
    const second = cronFixture();
    await expect(fresh.host.serveNode({
      env, cron: second.cron, listen: false, advisoryLock: lockFixture(),
      schedulerProfile: { projectJobs: (_env, declared) => [...declared], validateSchedule: () => { throw lockRefusal; } },
    })).rejects.toBe(lockRefusal);
    expect(second.cron.schedule).not.toHaveBeenCalled();
  });

  it("does not call registration hooks when the host runs no scheduler", async () => {
    const { host } = hostFixture();
    const profile = { projectJobs: vi.fn((_env: unknown, declared: readonly (typeof jobs)[number][]) => [...declared]), validateSchedule: vi.fn(), validateJob: vi.fn() };
    await host.serveNode({ env, listen: false, schedulerProfile: profile });
    expect(profile.projectJobs).toHaveBeenCalledOnce();
    expect(profile.validateSchedule).not.toHaveBeenCalled();
    expect(profile.validateJob).not.toHaveBeenCalled();
  });
});
