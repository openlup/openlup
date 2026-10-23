import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { imageReference, readCiImage } from "../../scripts/ci-image-pull.mjs";

const mocks = vi.hoisted(() => ({ exec: vi.fn(), pull: vi.fn(), resolve: vi.fn(), realPg: false, connect: vi.fn(), query: vi.fn(), release: vi.fn(), end: vi.fn(), configs: [] as import("pg").PoolConfig[] }));
vi.mock("pg", async importOriginal => {
  const actual = await importOriginal<typeof import("pg")>();
  return {
    default: undefined,
    Pool: function (config: import("pg").PoolConfig) {
      if (mocks.realPg) return new actual.Pool(config);
      mocks.configs.push(config);
      return {
        on() {},
        connect() { return mocks.connect(); },
        end() { return mocks.end(); },
      };
    },
  };
});
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.exec }) };
});
vi.mock("../../scripts/ci-image-pull.mjs", async importOriginal => ({
  ...await importOriginal<typeof import("../../scripts/ci-image-pull.mjs")>(),
  pullWithRetry: mocks.pull, resolvePinnedImage: mocks.resolve,
}));
vi.mock("node:net", () => ({
  createServer: () => ({
    once: vi.fn(), listen(_port: number, _host: string, ready: () => void) { ready(); },
    address: () => ({ port: 15432 }), close(done: () => void) { done(); },
  }),
}));

const spec = { name: "offline-postgres", password: "disposable" };
const pin = readCiImage("test-postgres");
beforeEach(() => {
  vi.resetModules();
  mocks.configs.length = 0;
  mocks.realPg = false;
  mocks.release.mockReset();
  mocks.query.mockReset().mockResolvedValue({ rows: [] });
  mocks.connect.mockReset().mockImplementation(async () => ({ query: mocks.query, release: mocks.release }));
  mocks.end.mockReset().mockResolvedValue(undefined);
  mocks.exec.mockReset().mockResolvedValue({ stdout: "" });
  mocks.pull.mockReset().mockResolvedValue(imageReference(pin, pin.sources[1]));
  mocks.resolve.mockReset().mockResolvedValue(imageReference(pin));
});

describe("PostgreSQL container pinned image adoption", () => {
  it("uses the JSON default and pulls once before container creation with --pull=never", async () => {
    const { defaultPostgresImage, runPostgresContainer } = await import("../helpers/postgresContainer.js");
    expect(defaultPostgresImage).toBe(`postgres:${pin.tag}@${pin.digest}`);
    await Promise.all([runPostgresContainer(spec), runPostgresContainer({ ...spec, name: "second" })]);
    expect(mocks.pull).toHaveBeenCalledExactlyOnceWith(pin);
    expect(mocks.pull.mock.invocationCallOrder[0]).toBeLessThan(mocks.exec.mock.invocationCallOrder[0]);
    const runs = mocks.exec.mock.calls.filter(([, args]) => args[0] === "run");
    expect(runs).toHaveLength(2);
    for (const [, args] of runs) {
      expect(args).toContain("--pull=never");
      expect(args.at(-1)).toBe(imageReference(pin, pin.sources[1]));
    }
  });
  it("preserves explicit unpinned/unknown image behaviour", async () => {
    const { runPostgresContainer } = await import("../helpers/postgresContainer.js");
    for (const image of ["postgres:16", "custom/postgres:17"]) {
      await runPostgresContainer({ ...spec, image });
      const args = mocks.exec.mock.calls.at(-1)![1];
      expect(args.at(-1)).toBe(image);
      expect(args).not.toContain("--pull=never");
    }
    expect(mocks.pull).not.toHaveBeenCalled();
  });
  it("recognizes exact JSON pins passed explicitly and caches by exact input ref", async () => {
    const { defaultPostgresImage, runPostgresContainer } = await import("../helpers/postgresContainer.js");
    await runPostgresContainer({ ...spec, image: imageReference(pin) });
    await runPostgresContainer({ ...spec, image: defaultPostgresImage });
    await runPostgresContainer({ ...spec, image: imageReference(pin) });
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
    expect(mocks.pull).not.toHaveBeenCalled();
  });
  it("evicts a failed pull and never creates a container on failure", async () => {
    const { runPostgresContainer } = await import("../helpers/postgresContainer.js");
    mocks.pull.mockRejectedValueOnce(new Error("pull refused"));
    await expect(runPostgresContainer(spec)).rejects.toThrow("pull refused");
    expect(mocks.exec).not.toHaveBeenCalled();
    await runPostgresContainer(spec);
    expect(mocks.pull).toHaveBeenCalledTimes(2);
  });
  it("does not multiply pulls when a port conflict retries docker run", async () => {
    const { runPostgresContainer } = await import("../helpers/postgresContainer.js");
    let failed = false;
    mocks.exec.mockImplementation(async (_command, args) => {
      if (args[0] === "run" && !failed) { failed = true; throw new Error("port is already allocated"); }
      return { stdout: "" };
    });
    await runPostgresContainer(spec);
    expect(mocks.pull).toHaveBeenCalledTimes(1);
    expect(mocks.exec.mock.calls.filter(([, args]) => args[0] === "run")).toHaveLength(2);
  });
});

afterEach(() => { vi.useRealTimers(); });

describe("PostgreSQL lifecycle deadlines and cleanup failures", () => {
  it("bounds Docker availability and refuses a stalled daemon", async () => {
    const { dockerAvailable } = await import("../helpers/postgresContainer.js");
    mocks.exec.mockRejectedValueOnce(new Error("daemon stalled"));
    expect(await dockerAvailable()).toBe(false);
    expect(mocks.exec).toHaveBeenCalledWith("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 5_000, killSignal: "SIGKILL" });
  });

  it("reports a start timeout, attempts cleanup and does not retry it as a bind conflict", async () => {
    const { runPostgresContainer } = await import("../helpers/postgresContainer.js");
    mocks.exec.mockImplementation(async (_command, args) => {
      if (args[0] === "run") throw new Error("killed: timeout");
      return { stdout: "" };
    });
    await expect(runPostgresContainer(spec)).rejects.toThrow(`PostgreSQL Docker start ${spec.name} failed`);
    expect(mocks.exec.mock.calls.filter(([, args]) => args[0] === "run")).toHaveLength(1);
    expect(mocks.exec.mock.calls.filter(([, args]) => args[0] === "rm")).toHaveLength(2);
    expect(mocks.exec.mock.calls.every(([, , options]) => options.timeout === 30_000 && options.killSignal === "SIGKILL")).toBe(true);
  });

  it("does not hide a failed removal, while already absent containers are safe to remove", async () => {
    const { runPostgresContainer } = await import("../helpers/postgresContainer.js");
    const container = await runPostgresContainer(spec);
    mocks.exec.mockRejectedValueOnce(new Error("daemon unavailable"));
    await expect(container.remove()).rejects.toThrow(`PostgreSQL Docker remove ${spec.name} failed`);
    mocks.exec.mockRejectedValueOnce(Object.assign(new Error("missing"), { stderr: `Error response from daemon: No such container: ${spec.name}` }));
    await expect(container.remove()).resolves.toBeUndefined();
  });

  it("retains both start and cleanup failures", async () => {
    const { runPostgresContainer } = await import("../helpers/postgresContainer.js");
    let started = false;
    mocks.exec.mockImplementation(async (_command, args) => {
      if (args[0] === "run") { started = true; throw new Error("start failure"); }
      if (started) throw new Error("cleanup failure");
      return { stdout: "" };
    });
    await expect(runPostgresContainer(spec)).rejects.toMatchObject({
      message: `PostgreSQL start and cleanup failed for ${spec.name}`,
      errors: [expect.objectContaining({ cause: expect.objectContaining({ message: "start failure" }) }), expect.objectContaining({ cause: expect.objectContaining({ message: "cleanup failure" }) })],
    });
  });

  it("removes the container after pool shutdown fails and preserves both failures", async () => {
    const { closePostgres, runPostgresContainer } = await import("../helpers/postgresContainer.js");
    const container = await runPostgresContainer(spec);
    const end = vi.fn().mockRejectedValue(new Error("pool failed"));
    mocks.exec.mockRejectedValueOnce(new Error("removal failed"));
    await expect(closePostgres(container, { end, ended: false })).rejects.toMatchObject({
      message: "PostgreSQL cleanup failed",
      errors: [expect.objectContaining({ message: "pool failed" }), expect.objectContaining({ cause: expect.objectContaining({ message: "removal failed" }) })],
    });
    expect(mocks.exec.mock.calls.at(-1)![1]).toEqual(["rm", "-f", spec.name]);
  });

  it("removes the container when pool shutdown never settles, within the teardown hook", async () => {
    const { closePostgres, runPostgresContainer, postgresTeardownTimeoutMs } = await import("../helpers/postgresContainer.js");
    const container = await runPostgresContainer(spec);
    vi.useFakeTimers();
    const end = vi.fn(() => new Promise<void>(() => {}));
    const result = expect(closePostgres(container, { end, ended: false })).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: "PostgreSQL pool/store shutdown exceeded 5000ms" })],
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await result;
    expect(mocks.exec.mock.calls.at(-1)![1]).toEqual(["rm", "-f", spec.name]);
    expect(postgresTeardownTimeoutMs).toBeGreaterThan(5_000 + 30_000);
  });

  it("attempts every owned container removal after an adapter close rejects", async () => {
    const { closePostgres, runPostgresContainer } = await import("../helpers/postgresContainer.js");
    const containers = await Promise.all([runPostgresContainer(spec), runPostgresContainer({ ...spec, name: "sibling" })]);
    const adapter = vi.fn().mockRejectedValue(new Error("adapter pool failed"));
    const end = vi.fn().mockResolvedValue(undefined);
    mocks.exec.mockRejectedValueOnce(new Error("first removal failed"));
    await expect(closePostgres(containers, [{ end, ended: false }], [adapter])).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: "adapter pool failed" }), expect.objectContaining({ cause: expect.objectContaining({ message: "first removal failed" }) })],
    });
    expect(end).toHaveBeenCalledTimes(1);
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(mocks.exec.mock.calls.slice(-2).map(([, args]) => args)).toEqual([["rm", "-f", spec.name], ["rm", "-f", "sibling"]]);
  });

  it("bounds all adapter and fixture pool closes together and waits for every removal", async () => {
    const { closePostgres, runPostgresContainer } = await import("../helpers/postgresContainer.js");
    const containers = await Promise.all([runPostgresContainer(spec), runPostgresContainer({ ...spec, name: "sibling" })]);
    vi.useFakeTimers();
    const stalled = vi.fn(() => new Promise<void>(() => {}));
    const rejected = vi.fn().mockRejectedValue(new Error("other adapter failed"));
    const end = vi.fn().mockResolvedValue(undefined);
    // The first removal fails quickly; the sibling still has to finish removal.
    mocks.exec.mockImplementation(async (_command, args) => {
      if (args[2] === spec.name) throw new Error("first removal failed");
      await new Promise(resolve => setTimeout(resolve, 1_000));
      return { stdout: "" };
    });
    let settled = false;
    const result = closePostgres(containers, { end, ended: false }, [stalled, rejected]);
    const assertion = expect(result).rejects.toMatchObject({ errors: [
      expect.objectContaining({ message: "other adapter failed" }),
      expect.objectContaining({ message: "PostgreSQL pool/store shutdown exceeded 5000ms" }),
      expect.objectContaining({ cause: expect.objectContaining({ message: "first removal failed" }) }),
    ] });
    void result.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(end).toHaveBeenCalledTimes(1);
    expect(stalled).toHaveBeenCalledTimes(1);
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(settled).toBe(true);
  });

  it("uses a wall-clock readiness deadline even when each connection stalls", async () => {
    const { waitForPostgresTcpReady } = await import("../helpers/postgresContainer.js");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    mocks.connect.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error("connect timeout")), mocks.configs.at(-1)!.connectionTimeoutMillis)));
    const result = waitForPostgresTcpReady("postgres://synthetic", { timeoutMs: 100, intervalMs: 20 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBe(false);
    expect(mocks.connect.mock.calls.length).toBeLessThan(60);
    expect(mocks.end).toHaveBeenCalledTimes(mocks.connect.mock.calls.length);
  });

  it("bounds the readiness query and destroys the probe client before ending its pool", async () => {
    const { waitForPostgresTcpReady } = await import("../helpers/postgresContainer.js");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    mocks.query.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error("query timeout")), mocks.configs.at(-1)!.query_timeout!)));
    const result = waitForPostgresTcpReady("postgres://synthetic", { timeoutMs: 100, intervalMs: 20 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBe(false);
    expect(mocks.release).toHaveBeenCalledWith(true);
    expect(mocks.release.mock.invocationCallOrder[0]).toBeLessThan(mocks.end.mock.invocationCallOrder[0]);
  });

  it("returns readiness only after the TCP query and always disposes the probe", async () => {
    const { waitForPostgresTcpReady } = await import("../helpers/postgresContainer.js");
    expect(await waitForPostgresTcpReady("postgres://synthetic")).toBe(true);
    expect(mocks.query).toHaveBeenCalledWith("SELECT 1");
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });
});

// Exercise pg's actual timeout and socket disposal, not just the mock transcript.
it.each(["handshake", "query"])("closes real TCP sockets when a peer stalls the %s", async phase => {
  const { createServer } = await vi.importActual<typeof import("node:net")>("node:net");
  const sockets = new Set<import("node:net").Socket>();
  let queries = 0;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let authenticated = false;
    socket.on("data", data => {
      if (phase === "handshake") return;
      if (!authenticated) {
        authenticated = true;
        // AuthenticationOk followed by ReadyForQuery. Never answer SELECT 1.
        socket.write(Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 0, 90, 0, 0, 0, 5, 73]));
      } else if (data[0] === 81) queries += 1;
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const { port } = server.address() as import("node:net").AddressInfo;
    mocks.realPg = true;
    const { waitForPostgresTcpReady } = await import("../helpers/postgresContainer.js");
    const started = performance.now();
    expect(await waitForPostgresTcpReady(`postgres://fixture:fixture@127.0.0.1:${port}/fixture`, { timeoutMs: 200, intervalMs: 5 })).toBe(false);
    expect(performance.now() - started).toBeLessThan(2_000);
    if (phase === "query") expect(queries).toBeGreaterThan(0);
    await vi.waitFor(() => expect(sockets.size).toBe(0));
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
