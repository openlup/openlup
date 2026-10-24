import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { env as processEnvironment } from "node:process";
import { delimiter, dirname, join } from "node:path";
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


describe("admission and full release checks", () => {
  const roots: string[] = [];
  afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "openlup-core-check-mode-")); roots.push(root);
    const manifest = readJson<{ name: string; version: string; exports: Record<string, Record<string, string>> }>(join(packageRoot, "package.json"));
    const gates = readJson<{ requiredRepositoryArtifacts: string[]; packageSurface: Record<string, { snapshot: string; packageSmokeEvidence: string[] }> }>(join(packageRoot, "release-gates.json"));
    cpSync(join(packageRoot, "scripts"), join(root, "scripts"), { recursive: true });
    cpSync(join(packageRoot, ".github"), join(root, ".github"), { recursive: true });
    for (const path of ["package.json", "package-lock.json", "release-gates.json", "repository-policy.json", ...gates.requiredRepositoryArtifacts]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      copyFileSync(join(packageRoot, path), join(root, path));
    }
    const packed = [...new Set([
      ...readJson<{ pack: { requiredFiles: string[] } }>(join(packageRoot, "release-gates.json")).pack.requiredFiles,
      ...Object.values(manifest.exports).flatMap(conditions => Object.values(conditions).map(path => path.slice(2))),
    ])];
    const surfaces = Object.values(gates.packageSurface).flatMap(surface => [surface.snapshot, ...surface.packageSmokeEvidence]);
    for (const path of [...packed, ...surfaces]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      if (!existsSync(join(root, path))) writeFileSync(join(root, path), "fixture\n");
    }
    writeFileSync(join(root, "pack-fixture.json"), JSON.stringify(packed));
    const bin = join(root, "bin"); mkdirSync(bin);
    const npmFixture = join(bin, "npm-fixture.mjs");
    writeFileSync(join(bin, "npm"), '#!/bin/sh\nexec "$OPENLUP_TEST_NODE" "$OPENLUP_TEST_NPM" "$@"\n', { mode: 0o755 });
    writeFileSync(npmFixture, `import { appendFileSync, readFileSync } from "node:fs";
const command = Reflect.get(process, "argv")[2];
appendFileSync("npm-calls.log", command + "\\n");
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
if (command === "sbom") console.log(JSON.stringify({ bomFormat: "CycloneDX", metadata: { component: { "bom-ref": manifest.name + "@" + manifest.version, name: manifest.name, version: manifest.version, purl: "pkg:npm/%40openlup/core@" + manifest.version } }, components: [{ name: "zod" }] }));
else if (command === "audit") { console.log(JSON.stringify({ metadata: { vulnerabilities: { high: 1 } } })); process.exitCode = 1; }
else if (command === "pack") console.log(JSON.stringify([{ size: 1, unpackedSize: 1, entryCount: 1, files: JSON.parse(readFileSync("pack-fixture.json", "utf8")).map(path => ({ path })) }]));
else throw new Error("unexpected npm command " + command);
`);
    return {
      root,
      run: (mode?: string) => spawnSync(process.execPath, ["--experimental-strip-types", "./scripts/release-check.ts", ...(mode === undefined ? [] : [mode])], {
        cwd: root, encoding: "utf8", env: { ...processEnvironment, PATH: bin + delimiter + processEnvironment.PATH, OPENLUP_TEST_NODE: process.execPath, OPENLUP_TEST_NPM: npmFixture },
      }),
      calls: () => readFileSync(join(root, "npm-calls.log"), "utf8").trim().split("\n"),
    };
  }

  it("runs every deterministic release control without querying a mutable audit in admission", () => {
    const f = fixture(); const result = f.run("admission");
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    for (const message of ["package surface inventory ok", "package release identity ok", "standalone lock and release artifacts ok", "production licenses ok", "production CycloneDX SBOM ok", "pack budget ok", "directory-publish refusal ok", "package policy and local security automation ok"]) expect(result.stdout).toContain(message);
    expect(f.calls()).toEqual(["sbom", "pack"]);
  });
  it.each([undefined, "all", "audit"])("retains absolute audit refusal for %s mode", mode => {
    const f = fixture(); const result = f.run(mode);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("production audit budget exceeded:");
    expect(result.stderr).toContain("high: 1 > 0");
    expect(f.calls()).toContain("audit");
  });
  it("still refuses a mismatched standalone lock before any npm command in admission", () => {
    const f = fixture(); const lock = readJson<{ version: string }>(join(f.root, "package-lock.json"));
    writeFileSync(join(f.root, "package-lock.json"), JSON.stringify({ ...lock, version: "0.12.0" }));
    const result = f.run("admission");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("lock version differs from package.json");
    expect(existsSync(join(f.root, "npm-calls.log"))).toBe(false);
  });
});
