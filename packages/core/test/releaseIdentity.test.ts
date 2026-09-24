import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson<Parsed>(path: string): Parsed {
  return JSON.parse(readFileSync(path, "utf8")) as Parsed;
}

describe("preview-channel release identity", () => {
  it("keeps the standalone manifest, release policy, and lockfile aligned", () => {
    const manifest = readJson<{ version: string }>(join(packageRoot, "package.json"));
    const packageLock = readJson<{
      version: string;
      packages: Record<string, { version?: string }>;
    }>(join(packageRoot, "package-lock.json"));
    const releaseGates = readJson<{ packageRelease: { versionRule: string } }>(
      join(packageRoot, "release-gates.json"),
    );

    expect(releaseGates.packageRelease.versionRule).toBe("0.<n>.0");
    expect(manifest.version).toMatch(/^0\.[1-9]\d*\.0$/);
    expect(packageLock.version).toBe(manifest.version);
    expect(packageLock.packages[""].version).toBe(manifest.version);
  });
});
