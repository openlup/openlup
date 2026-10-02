import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { assertSetVersion, isSetVersion, setVersionRule } from "../scripts/public-api-config.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson<Parsed>(path: string): Parsed {
  return JSON.parse(readFileSync(path, "utf8")) as Parsed;
}

const admitted = ["0.12.0", "0.12.1", "0.13.0", "0.99.10"];
const refused = [
  "0.0.1",
  "1.0.0",
  "1.12.0",
  "0.12.0-rc.1",
  "0.12.0+build.1",
  "0.012.0",
  "0.12.01",
  "v0.12.0",
  "0.12",
  " 0.12.0",
  "0.12.0\n",
];

describe("set release identity", () => {
  it("keeps the standalone manifest, release policy, and lockfile aligned", () => {
    const manifest = readJson<{ version: string }>(join(packageRoot, "package.json"));
    const packageLock = readJson<{
      version: string;
      packages: Record<string, { version?: string }>;
    }>(join(packageRoot, "package-lock.json"));
    const releaseGates = readJson<{ packageRelease: { versionRule: string } }>(
      join(packageRoot, "release-gates.json"),
    );

    expect(releaseGates.packageRelease.versionRule).toBe("0.N.P");
    expect(isSetVersion(manifest.version)).toBe(true);
    expect(packageLock.version).toBe(manifest.version);
    expect(packageLock.packages[""].version).toBe(manifest.version);
  });

  it.each(admitted)("admits the set version %s", (version) => {
    expect(isSetVersion(version)).toBe(true);
    expect(() => assertSetVersion(setVersionRule, version)).not.toThrow();
  });

  it.each(refused)("refuses %j, which is not a set version below 1.0", (version) => {
    expect(isSetVersion(version)).toBe(false);
    expect(() => assertSetVersion(setVersionRule, version)).toThrow(
      `package version must be a set version 0.N.P below 1.0, not ${version}`,
    );
  });

  it.each([undefined, "0.<n>.0", "MAJOR.MINOR.PATCH"])("refuses the version rule %j", (versionRule) => {
    expect(() => assertSetVersion(versionRule, "0.12.0")).toThrow(/must be a set version 0\.N\.P/);
  });

  it("refuses a version that is not a string", () => {
    for (const version of [undefined, 12, null]) expect(isSetVersion(version), String(version)).toBe(false);
  });
});

// release-check.ts reads the package beside its own scripts directory, so each case runs a
// copy of that directory against a planted manifest and release policy.
describe("release:check identity", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function runIdentity(version: string, versionRule = setVersionRule) {
    const root = mkdtempSync(join(tmpdir(), "openlup-core-identity-"));
    roots.push(root);
    cpSync(join(packageRoot, "scripts"), join(root, "scripts"), { recursive: true });
    copyFileSync(join(packageRoot, "package-lock.json"), join(root, "package-lock.json"));
    const manifest = readJson<Record<string, unknown>>(join(packageRoot, "package.json"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ ...manifest, version }));
    const gates = readJson<{ packageRelease: Record<string, unknown> }>(join(packageRoot, "release-gates.json"));
    writeFileSync(
      join(root, "release-gates.json"),
      JSON.stringify({ ...gates, packageRelease: { ...gates.packageRelease, versionRule } }),
    );
    return spawnSync(
      process.execPath,
      ["--experimental-strip-types", "./scripts/release-check.ts", "identity"],
      { cwd: root, encoding: "utf8" },
    );
  }

  it.each(["0.12.0", "0.12.1", "0.13.0"])("admits %s", (version) => {
    const result = runIdentity(version);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`package release identity ok (${version}, set 0.N.P, npm-staged-preview)`);
  });

  it("refuses 1.0.0", () => {
    const result = runIdentity("1.0.0");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("package version must be a set version 0.N.P below 1.0, not 1.0.0");
  });

  it("refuses the retired version rule 0.<n>.0", () => {
    const result = runIdentity("0.12.0", "0.<n>.0");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("package version must be a set version 0.N.P");
  });
});
