import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson<Parsed>(path: string): Parsed {
  return JSON.parse(readFileSync(path, "utf8")) as Parsed;
}

describe("release candidate identity", () => {
  it("keeps the standalone manifest, release policy, and lockfile aligned", () => {
    const manifest = readJson<{ version: string }>(join(packageRoot, "package.json"));
    const packageLock = readJson<{
      version: string;
      packages: Record<string, { version?: string }>;
    }>(join(packageRoot, "package-lock.json"));
    const releaseGates = readJson<{ privatePackage: { proofVersion: string } }>(
      join(packageRoot, "release-gates.json"),
    );

    expect(manifest.version).toBe(releaseGates.privatePackage.proofVersion);
    expect(packageLock.version).toBe(manifest.version);
    expect(packageLock.packages[""].version).toBe(manifest.version);
  });
});
