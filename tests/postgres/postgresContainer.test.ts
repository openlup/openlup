import { beforeEach, describe, expect, it, vi } from "vitest";
import { imageReference, readCiImage } from "../../scripts/ci-image-pull.mjs";

const mocks = vi.hoisted(() => ({ exec: vi.fn(), pull: vi.fn(), resolve: vi.fn() }));
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
