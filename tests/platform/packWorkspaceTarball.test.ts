import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  packWorkspaceTarball,
  packWorkspaceTarballSync,
  packWorkspaceTarballs,
  removeRunTarballCache,
  runTarballCacheDir,
} from "../helpers/packWorkspaceTarball.js";

function extractPackDest(args: readonly string[]): string {
  const index = args.indexOf("--pack-destination");
  if (index < 0 || !args[index + 1]) throw new Error("missing --pack-destination");
  return args[index + 1]!;
}

describe("packWorkspaceTarball", () => {
  const cleanupDirs: string[] = [];
  const cleanupRunIds: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const runId of cleanupRunIds.splice(0)) removeRunTarballCache(runId);
    for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("caches workspace package tarballs within a single run and copies fresh artifacts per destination", async () => {
    const runId = `test-pack-cache-${randomUUID()}`;
    cleanupRunIds.push(runId);
    vi.stubEnv("OPENLUP_DISPOSABLE_RUN", runId);

    const destA = mkdtempSync(join(tmpdir(), "pack-dest-a-"));
    const destB = mkdtempSync(join(tmpdir(), "pack-dest-b-"));
    cleanupDirs.push(destA, destB);

    const runPack = vi.fn(async (args: readonly string[]) => {
      const target = extractPackDest(args);
      writeFileSync(join(target, "zod-fixture.tgz"), "tarball-bytes-v1", "utf8");
      return JSON.stringify([{ filename: "zod-fixture.tgz" }]);
    });

    const first = await packWorkspaceTarball("node_modules/zod", destA, { offline: true, runPack });
    const second = await packWorkspaceTarball("node_modules/zod", destB, { offline: true, runPack });

    expect(runPack).toHaveBeenCalledTimes(1);
    expect(first).toBe(join(destA, "zod-fixture.tgz"));
    expect(second).toBe(join(destB, "zod-fixture.tgz"));
    expect(readFileSync(first, "utf8")).toBe("tarball-bytes-v1");
    expect(readFileSync(second, "utf8")).toBe("tarball-bytes-v1");

    const cacheDir = runTarballCacheDir(runId)!;
    expect(existsSync(cacheDir)).toBe(true);
    removeRunTarballCache(runId);
    expect(existsSync(cacheDir)).toBe(false);
  });

  it("deduplicates concurrent packers via lockfile and preserves order in packWorkspaceTarballs", async () => {
    const runId = `test-pack-concurrent-${randomUUID()}`;
    cleanupRunIds.push(runId);
    vi.stubEnv("OPENLUP_DISPOSABLE_RUN", runId);

    const dest = mkdtempSync(join(tmpdir(), "pack-dest-concurrent-"));
    cleanupDirs.push(dest);

    let callCount = 0;
    const runPack = vi.fn(async (args: readonly string[]) => {
      callCount++;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
      const target = extractPackDest(args);
      writeFileSync(join(target, "shared.tgz"), `bytes-${callCount}`, "utf8");
      return JSON.stringify([{ filename: "shared.tgz" }]);
    });

    const paths = await packWorkspaceTarballs(
      ["node_modules/zod", "node_modules/zod", "node_modules/zod"],
      dest,
      { concurrency: 3, runPack },
    );
    expect(runPack).toHaveBeenCalledTimes(1);
    expect(paths).toEqual([
      join(dest, "shared.tgz"),
      join(dest, "shared.tgz"),
      join(dest, "shared.tgz"),
    ]);
  });

  it("bypasses the cache for non-workspace temporary package directories", () => {
    const runId = `test-pack-bypass-${randomUUID()}`;
    cleanupRunIds.push(runId);
    vi.stubEnv("OPENLUP_DISPOSABLE_RUN", runId);

    const tempPkg = mkdtempSync(join(tmpdir(), "synthetic-pkg-"));
    const dest = mkdtempSync(join(tmpdir(), "pack-dest-bypass-"));
    cleanupDirs.push(tempPkg, dest);

    const runPackSync = vi.fn((args: readonly string[]) => {
      const target = extractPackDest(args);
      writeFileSync(join(target, "temp.tgz"), "temp-bytes", "utf8");
      return JSON.stringify([{ filename: "temp.tgz" }]);
    });

    packWorkspaceTarballSync(tempPkg, dest, { runPackSync });
    packWorkspaceTarballSync(tempPkg, dest, { runPackSync });
    expect(runPackSync).toHaveBeenCalledTimes(2);
  });
});
