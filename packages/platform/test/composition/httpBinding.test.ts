import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { bindNodeHttpPort, createScheduledEntrypointResolver } from "../../src/composition/httpBinding.js";
import type { NodeHttpRuntimeOptions } from "../../src/http/runtime.js";
import { decorateResponse } from "../../src/http/requestAdapter.js";
import type { HttpRequest, HttpResponse } from "../../src/http/types.js";

const jobs = [
  { jobId: "nightly-report", schedule: "0 4 * * *", path: "/api/cron/nightly-report" },
  { jobId: "queue-drain", schedule: "*/2 * * * *", path: "/api/cron/queue-drain" },
];

function options(): NodeHttpRuntimeOptions {
  const load = async () => ({ default: (_req: HttpRequest, res: HttpResponse) => { res.status(503).json({ error: "not_ready" }); } });
  return {
    routes: [], dispatch: vi.fn(),
    security: { globalHeaders: [], assetCachePrefixes: [], noindexFamilies: [], noindexExacts: [], isProductionHost: () => false },
    entrypoints: { cspReport: load, bffRouter: load },
    scheduledEntrypoint: createScheduledEntrypointResolver(jobs, load),
    extraEntrypoints: [{ path: "/api/status", load }],
  };
}

function request(path: string): HttpRequest {
  const stream = new PassThrough();
  const req = stream as unknown as HttpRequest;
  req.method = "GET";
  req.url = path;
  req.headers = { host: "example.test" };
  stream.end();
  return req;
}

function response(): HttpResponse {
  const headers = new Map<string, unknown>();
  const res = {
    statusCode: 200, headersSent: false, writableEnded: false,
    setHeader(key: string, value: unknown) { headers.set(key.toLowerCase(), value); },
    getHeader(key: string) { return headers.get(key.toLowerCase()); },
    hasHeader(key: string) { return headers.has(key.toLowerCase()); },
    end() { res.headersSent = true; res.writableEnded = true; },
  };
  return decorateResponse(res as unknown as Parameters<typeof decorateResponse>[0]);
}

describe("scheduled entrypoint resolution", () => {
  it("returns lazy loaders for declared ids without eagerly loading modules", async () => {
    const module = { default: vi.fn() };
    const load = vi.fn().mockResolvedValue(module);
    const resolve = createScheduledEntrypointResolver(jobs, load);
    const loaders = jobs.map(({ jobId }) => resolve(jobId));
    expect(loaders.every((loader) => typeof loader === "function")).toBe(true);
    expect(load).not.toHaveBeenCalled();
    for (const [index, loader] of loaders.entries()) {
      expect(await loader!()).toBe(module);
      expect(load).toHaveBeenNthCalledWith(index + 1, jobs[index].jobId);
    }
    expect(load).toHaveBeenCalledTimes(jobs.length);
  });

  it.each(["unknown-task", "../entrypoint", "", "toString"])("returns null for undeclared id %s", (id) => {
    const load = vi.fn();
    expect(createScheduledEntrypointResolver(jobs, load)(id)).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it("propagates a declared entrypoint loading failure when invoked", async () => {
    const failure = new Error("entrypoint unavailable");
    const resolve = createScheduledEntrypointResolver(jobs, vi.fn().mockRejectedValue(failure));
    await expect(resolve("queue-drain")!()).rejects.toBe(failure);
  });
});

describe("Node HTTP binding", () => {
  it("constructs the Node port from caller options without listening", () => {
    const configure = vi.fn(options);
    const port = bindNodeHttpPort("node", configure);
    expect(configure).toHaveBeenCalledTimes(1);
    expect(port?.handle).toBeTypeOf("function");
    expect(port?.listen).toBeTypeOf("function");
    expect((port as unknown as { server: unknown }).server).toBeNull();
  });

  it.each(["vercel", "", "unknown-runtime"])("leaves capability %s unbound without evaluating options", (capability) => {
    const configure = vi.fn(options);
    expect(bindNodeHttpPort(capability, configure)).toBeNull();
    expect(configure).not.toHaveBeenCalled();
  });

  it("mounts declared scheduled paths and caller entrypoints; undeclared paths remain 404", async () => {
    const port = bindNodeHttpPort("node", options)!;
    for (const path of [...jobs.map(({ path }) => path), "/api/status"]) {
      const res = response();
      await port.handle(request(path), res);
      expect(res.statusCode).toBe(503);
    }
    const res = response();
    await port.handle(request("/api/cron/unknown-task"), res);
    expect(res.statusCode).toBe(404);
  });
});
