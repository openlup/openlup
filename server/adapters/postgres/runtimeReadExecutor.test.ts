import { afterEach, describe, expect, it, vi } from "vitest";

type RuntimeReadExecutor = typeof import("./runtimeReadExecutor.js");

const loadedModules: RuntimeReadExecutor[] = [];

async function loadRuntimeReadExecutor(pgModule: Record<string, unknown>): Promise<RuntimeReadExecutor> {
  vi.resetModules();
  vi.doMock("pg", () => pgModule);
  const runtime = await import("./runtimeReadExecutor.js");
  loadedModules.push(runtime);
  return runtime;
}

function fakePool(result = { rows: [{ id: "runtime-read" }] }) {
  const query = vi.fn(async (text: string, values?: unknown[]) => result);
  const end = vi.fn(async () => undefined);
  const configurations: Array<{ connectionString: string }> = [];

  class Pool {
    constructor(options: { connectionString: string }) {
      configurations.push(options);
    }

    query = query;
    end = end;
  }

  return { Pool, configurations, end, query, result };
}

afterEach(async () => {
  try {
    await Promise.all(loadedModules.splice(0).map((runtime) => runtime.closeRuntimeDatabaseReadExecutor()));
  } finally {
    vi.doUnmock("pg");
    vi.resetModules();
    vi.clearAllMocks();
  }
});

describe("runtime read executor", () => {
  it("refuses a blank database URL before constructing a pool", async () => {
    const pg = fakePool();
    const runtime = await loadRuntimeReadExecutor({ default: { Pool: pg.Pool } });

    expect(runtime.resolveRuntimeDatabaseReadExecutor({})).toBeNull();
    expect(runtime.resolveRuntimeDatabaseReadExecutor({ DATABASE_URL: "  \n  " })).toBeNull();
    expect(pg.configurations).toEqual([]);
  });

  it("uses a trimmed URL once, forwards queries, and resets after close", async () => {
    const pg = fakePool();
    const runtime = await loadRuntimeReadExecutor({ default: { Pool: pg.Pool } });

    const first = runtime.resolveRuntimeDatabaseReadExecutor({ DATABASE_URL: "  postgres://runtime/read  " });
    const reused = runtime.resolveRuntimeDatabaseReadExecutor({ DATABASE_URL: "postgres://runtime/read" });

    expect(first).not.toBeNull();
    expect(reused).toBe(first);
    if (!first || !reused) throw new Error("expected a runtime read executor");
    await expect(first.query("select $1", ["proof"])).resolves.toEqual(pg.result);
    expect(pg.configurations).toEqual([{ connectionString: "postgres://runtime/read" }]);
    expect(pg.query).toHaveBeenCalledWith("select $1", ["proof"]);

    await runtime.closeRuntimeDatabaseReadExecutor();
    expect(pg.end).toHaveBeenCalledTimes(1);

    const reset = runtime.resolveRuntimeDatabaseReadExecutor({ DATABASE_URL: "postgres://runtime/read" });
    if (!reset) throw new Error("expected reset to create a runtime read executor");
    expect(reset).not.toBe(first);
    await expect(reset.query("select $1", ["reset"])).resolves.toEqual(pg.result);
    expect(pg.configurations).toEqual([
      { connectionString: "postgres://runtime/read" },
      { connectionString: "postgres://runtime/read" },
    ]);
  });

  it("accepts pg's named Pool export when default is undefined", async () => {
    const pg = fakePool();
    const runtime = await loadRuntimeReadExecutor({ default: undefined, Pool: pg.Pool });

    const executor = runtime.resolveRuntimeDatabaseReadExecutor({ DATABASE_URL: "postgres://runtime/named" });

    if (!executor) throw new Error("expected named Pool fallback to create a runtime read executor");
    await expect(executor.query("select named", [])).resolves.toEqual(pg.result);
    expect(pg.configurations).toEqual([{ connectionString: "postgres://runtime/named" }]);
    await runtime.closeRuntimeDatabaseReadExecutor();
    expect(pg.end).toHaveBeenCalledTimes(1);
  });

  it("attaches a non-throwing error listener when the Pool exposes EventEmitter.on", async () => {
    const listeners = new Map<string, (error: Error) => void>();
    const on = vi.fn((event: string, listener: (error: Error) => void) => {
      listeners.set(event, listener);
    });
    const pg = fakePool();
    class EventedPool extends pg.Pool {
      on = on;
    }
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const runtime = await loadRuntimeReadExecutor({ default: { Pool: EventedPool } });
      const executor = runtime.resolveRuntimeDatabaseReadExecutor({ DATABASE_URL: "postgres://runtime/events" });
      if (!executor) throw new Error("expected evented Pool to create a runtime read executor");
      await expect(executor.query("select 1", [])).resolves.toEqual(pg.result);

      expect(on).toHaveBeenCalledWith("error", expect.any(Function));
      const errorListener = listeners.get("error");
      expect(errorListener).toBeDefined();
      expect(() => errorListener?.(new Error("connection reset"))).not.toThrow();
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("connection reset"));
      await runtime.closeRuntimeDatabaseReadExecutor();
    } finally {
      consoleError.mockRestore();
    }
  });
});
