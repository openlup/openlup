import { execFileSync, spawnSync } from "node:child_process";
import { env as processEnvironment } from "node:process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(packageRoot, "../..");
const runner = join(packageRoot, "scripts/core-package-consumer-smoke.ts");
const environment = { ...processEnvironment };
delete environment.NODE_OPTIONS;
delete environment.NODE_PATH;
delete environment.npm_config_node_options;
delete environment.NPM_CONFIG_NODE_OPTIONS;
delete environment.OPENLUP_PACK_MANIFEST;
delete environment.OPENLUP_PACK_COMMIT;
let scratch: string;
let manifestPath: string;
let coreFilename: string;
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", env: environment }).trim();

function invoke(manifest = manifestPath, candidate = commit, overrides: NodeJS.ProcessEnv = {}, poisonChildOptions = false) {
  const script = `import { env as processEnvironment } from "node:process"; const { runCorePackageConsumerSmoke } = await import(${JSON.stringify(runner)}); processEnvironment.NODE_OPTIONS = "--require ./unavailable-preload.cjs"; processEnvironment.npm_config_node_options = processEnvironment.NODE_OPTIONS; runCorePackageConsumerSmoke();`;
  const args = poisonChildOptions
    ? ["--experimental-strip-types", "--input-type=module", "-e", script]
    : ["--experimental-strip-types", runner];
  return spawnSync(process.execPath, args, {
    cwd: packageRoot,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...environment, OPENLUP_PACK_MANIFEST: manifest, OPENLUP_PACK_COMMIT: candidate, ...overrides },
  });
}

function updateDigest(path: string): void {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  for (const entry of manifest.packages) {
    const bytes = readFileSync(join(dirname(path), entry.filename));
    entry.sha256 = createHash("sha256").update(bytes).digest("hex");
    entry.integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  }
  writeFileSync(path, JSON.stringify(manifest));
}

beforeAll(() => {
  // Warm, owned test inputs; exact cold-candidate evidence is produced after signing.
  scratch = mkdtempSync(join(tmpdir(), "supplied-core-test-"));
  const packs = join(scratch, "packs");
  mkdirSync(packs);
  const config = JSON.parse(readFileSync(join(root, "config/openlup-packages.json"), "utf8"));
  const packages = config.packages.filter((entry: { publish: boolean }) => entry.publish).map((entry: { name: string; directory: string }) => {
    const source = join(root, entry.directory);
    const metadata = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    const [packed] = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--workspaces=false", "--cache", join(scratch, "cache"), "--pack-destination", packs], { cwd: source, encoding: "utf8", env: environment }));
    if (entry.name === "@openlup/core") coreFilename = packed.filename;
    return { name: entry.name, version: metadata.version, filename: packed.filename, sha256: "", integrity: "" };
  });
  manifestPath = join(packs, "packages-manifest.json");
  writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 2, commit, packages }));
  updateDigest(manifestPath);
}, 30_000);

afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

it("runs audit, runtime, both typechecks and Vite using the supplied artifact without rebuilding source", () => {
  const tools = join(scratch, "tools");
  mkdirSync(tools);
  const npm = execFileSync("which", ["npm"], { encoding: "utf8", env: environment }).trim();
  // Actual accidental own-package build/pack exits nonzero; Zod packing is allowed.
  writeFileSync(join(tools, "npm"), '#!/bin/sh\nif [ "$PWD" = "$SUPPLIED_TEST_CORE_ROOT" ]; then exit 93; fi\nexec "$SUPPLIED_TEST_REAL_NPM" "$@"\n', { mode: 0o755 });
  const result = invoke(manifestPath, commit, {
    PATH: `${tools}:${environment.PATH}`,
    SUPPLIED_TEST_CORE_ROOT: packageRoot,
    SUPPLIED_TEST_REAL_NPM: npm,
    NODE_PATH: tools,
  }, true);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("core consumer artifact sha256=");
  expect(result.stdout).toContain("core package tarball consumer smoke ok");
}, 30_000);

it.each(["manifest", "commit"])("refuses a missing supplied %s instead of falling back", (missing) => {
  const result = invoke(manifestPath, commit, missing === "manifest" ? { OPENLUP_PACK_MANIFEST: undefined } : { OPENLUP_PACK_COMMIT: undefined });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("must be supplied together");
});

it("refuses changed tarball bytes before any consumer installation", () => {
  const changed = join(scratch, "changed");
  cpSync(dirname(manifestPath), changed, { recursive: true });
  writeFileSync(join(changed, coreFilename), "damaged tarball");
  const result = invoke(join(changed, "packages-manifest.json"));
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("digest mismatch");
  expect(result.stdout).not.toContain("core consumer artifact");
});

it("a digest-consistent missing runtime export fails the actual supplied consumer", () => {
  const damaged = join(scratch, "missing-export");
  cpSync(dirname(manifestPath), damaged, { recursive: true });
  const extracted = join(scratch, "extracted");
  mkdirSync(extracted);
  execFileSync("tar", ["-xzf", join(damaged, coreFilename), "-C", extracted], { env: environment });
  writeFileSync(join(extracted, "package/dist/subscription/index.js"), "export {};\n");
  execFileSync("tar", ["-czf", join(damaged, coreFilename), "-C", extracted, "package"], { env: environment });
  const changedManifest = join(damaged, "packages-manifest.json");
  updateDigest(changedManifest);
  const result = invoke(changedManifest);
  expect(result.status).not.toBe(0);
  expect(result.stdout).toContain("core consumer artifact sha256=");
  expect(result.stderr).toContain("does not provide an export named");
}, 30_000);

it("refuses an ambient temporary root inside the checkout", () => {
  const result = invoke(manifestPath, commit, { TMPDIR: packageRoot });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("temporary directory must be outside the checkout");
});
