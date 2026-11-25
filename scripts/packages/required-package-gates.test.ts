import { execFileSync, spawnSync } from "node:child_process";
import { env as processEnvironment } from "node:process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isolatedConsumerEnv } from "./pack-manifest-input.ts";
import { PUBLIC_REPOSITORY_URL } from "./package-manifest-policy.ts";
import { runRequiredPackageGates } from "./required-package-gates.ts";

const source = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const git = (root: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: root, env: isolatedConsumerEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

type FixtureOptions = { names?: string[]; peerDependencies?: Record<string, Record<string, string>>; missing?: string; nonWorkspace?: boolean; failingApi?: boolean; damagedExport?: boolean };
type Observation = { phase: string; name: string; commit?: string; manifest?: string; installed?: string[]; value?: string; distReady?: string };

/** Mechanical neutral input, not a task checkout or an exact-task-candidate receipt. */
function fixture(options: FixtureOptions = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "required-package-fixture-")));
  roots.push(root);
  const names = options.names ?? ["alpha"];
  const write = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  write(".gitignore", "dist/\nout/\ntrace.jsonl\nbuilds.jsonl\nscratch/\n");
  write("config/openlup-packages.json", JSON.stringify({ schemaVersion: 2, packages: names.map(name => ({ name: `@openlup/${name}`, directory: `packages/${name}`, publish: true })), unreleased: [] }));
  write("package.json", JSON.stringify({ private: true, type: "module", workspaces: options.nonWorkspace ? [] : names.map(name => `packages/${name}`), scripts: {
    "packages:check": `${shellQuote(process.execPath)} --experimental-strip-types ${shellQuote(join(source, "packages-check.ts"))}`,
  } }));
  for (const name of names) {
    const scripts: Record<string, string> = {
      build: "node ../../tools/phase.mjs build",
      "api:check": "node ../../tools/phase.mjs api",
      "ci:required": "node ../../tools/phase.mjs required && npm run test:consumer",
      "test:consumer": "node ../../tools/consumer.mjs",
    };
    if (options.missing) delete scripts[options.missing];
    const peerDeps = options.peerDependencies?.[name];
    write(`packages/${name}/package.json`, JSON.stringify({ name: `@openlup/${name}`, version: "0.4.0", type: "module", license: "Apache-2.0", files: ["dist/**"],
      ...(peerDeps ? { peerDependencies: peerDeps } : {}),
      publishConfig: { access: "public", provenance: true, tag: "preview" }, repository: { type: "git", url: PUBLIC_REPOSITORY_URL, directory: `packages/${name}` },
      exports: { ".": "./dist/index.js" }, scripts }));
    write(`packages/${name}/release-gates.json`, JSON.stringify({ pack: { code: { maxPackedBytes: 1000000, maxFiles: 1000 }, docs: { maxPackedBytes: 1000000, maxFiles: 1000 }, maxPackedBytes: 2000000, maxUnpackedBytes: 4000000, maxFiles: 2000, baseline: { version: "0.4.0", packedBytes: 1000000 }, browserEntries: {} } }));
    write(`packages/${name}/CHANGELOG.md`, "## [0.4.0]\n\n- Initial fixture.\n");
    write(`packages/${name}/src/index.ts`, `export const value = ${JSON.stringify(name)};\n`);
  }
  write("tools/phase.mjs", `
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { env as processEnvironment } from 'node:process';
const phase = process.argv[2], name = basename(process.cwd()), root = resolve('../..');
if (phase === 'build') {
  appendFileSync(join(root, 'builds.jsonl'), JSON.stringify({ phase, name }) + '\\n');
  mkdirSync('dist', { recursive: true });
  writeFileSync('dist/index.js', readFileSync('src/index.ts'));
} else {
  appendFileSync(join(root, 'trace.jsonl'), JSON.stringify({ phase, name, ...(phase === 'required' ? { distReady: processEnvironment.OPENLUP_DIST_READY } : {}) }) + '\\n');
  if (phase === 'api') {
    assert.equal(readFileSync('dist/index.js', 'utf8'), readFileSync('src/index.ts', 'utf8'));
    if (${Boolean(options.failingApi)}) throw new Error('synthetic API failure');
    if (${Boolean(options.damagedExport)}) {
      const path = join(root, 'out/packages-manifest.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      const entry = manifest.packages.find(item => item.name === '@openlup/' + name);
      const archive = join(root, 'out', entry.filename);
      mkdirSync(join(root, 'scratch'), { recursive: true });
      const extracted = mkdtempSync(join(root, 'scratch/damaged-'));
      try {
        execFileSync('tar', ['-xzf', archive, '-C', extracted]);
        writeFileSync(join(extracted, 'package/dist/index.js'), 'export const other = 1;\\n');
        execFileSync('tar', ['-czf', archive, '-C', extracted, 'package']);
      } finally { rmSync(extracted, { recursive: true, force: true }); }
      const bytes = readFileSync(archive);
      entry.sha256 = createHash('sha256').update(bytes).digest('hex');
      entry.integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
      writeFileSync(path, JSON.stringify(manifest));
    }
  }
}
`);
  write("tools/consumer.mjs", `
import { env as processEnvironment } from 'node:process';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { isolatedConsumerEnv, readCurrentPackManifest, assertInstalledPackages } from ${JSON.stringify(pathToFileURL(join(source, "pack-manifest-input.ts")).href)};
const root = resolve('../..'), name = basename(process.cwd());
const manifest = processEnvironment.OPENLUP_PACK_MANIFEST, commit = processEnvironment.OPENLUP_PACK_COMMIT;
assert.equal(commit, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', env: isolatedConsumerEnv() }).trim());
const packs = readCurrentPackManifest(root, manifest, commit);
const consumer = realpathSync(mkdtempSync(join(tmpdir(), 'required-artifact-consumer-')));
assert.ok(!consumer.startsWith(root + sep));
try {
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--workspaces=false', '--package-lock=false', '--no-audit', '--fund=false', '--cache', join(consumer, 'cache'), ...[...packs.values()].map(item => item.path)], { cwd: consumer, env: isolatedConsumerEnv(), stdio: 'pipe' });
  const installed = [...packs.keys()];
  assertInstalledPackages(consumer, installed);
  for (const item of installed) assert.ok(!lstatSync(join(consumer, 'node_modules', item)).isSymbolicLink());
  writeFileSync(join(consumer, 'proof.mjs'), 'import { value } from ' + JSON.stringify('@openlup/' + name) + '; console.log(JSON.stringify(value));');
  const value = JSON.parse(execFileSync(process.execPath, ['proof.mjs'], { cwd: consumer, env: isolatedConsumerEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim());
  assert.equal(value, name);
  appendFileSync(join(root, 'trace.jsonl'), JSON.stringify({ phase: 'consumer', name, commit, manifest: createHash('sha256').update(readFileSync(manifest)).digest('hex'), installed, value }) + '\\n');
} finally { rmSync(consumer, { recursive: true, force: true }); }
`);
  git(root, "init", "-q"); git(root, "add", "-A"); git(root, "commit", "-qm", "Neutral required package fixture");
  const commit = git(root, "rev-parse", "HEAD").trim();
  return { root, commit, output: join(root, "out") };
}

function observations(root: string): Observation[] {
  const path = join(root, "trace.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
}

function builds(root: string): Observation[] {
  const path = join(root, "builds.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
}

function invoke(input: ReturnType<typeof fixture>, commit = input.commit) {
  const started = performance.now();
  const result = spawnSync(process.execPath, ["--experimental-strip-types", join(source, "required-package-gates.ts"), "--out", input.output, "--expected-commit", commit], {
    cwd: input.root, env: { ...isolatedConsumerEnv(), npm_config_cache: join(input.root, "scratch/npm-cache") }, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  console.log(`Neutral required package fixture ${Math.round(performance.now() - started)} ms`);
  expect(result.error).toBeUndefined();
  return result;
}

describe("inventory-driven required package gates", () => {
  it("cold-packs three future peers and executes all APIs before exactly one installed proof each", () => {
    const input = fixture({ names: ["alpha", "beta", "gamma"] });
    // A warm pack would retain this untracked output with no producing source.
    for (const name of ["alpha", "beta", "gamma"]) {
      mkdirSync(join(input.root, "packages", name, "dist"));
      writeFileSync(join(input.root, "packages", name, "dist/stale.js"), "export const stale = true;\n");
    }
    const result = invoke(input);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const calls = observations(input.root);
    const phases = calls.map(({ phase, name }) => `${phase}:${name}`);
    expect(phases.slice(0, 3)).toEqual(["api:alpha", "api:beta", "api:gamma"]);
    for (const name of ["alpha", "beta", "gamma"]) {
      const reqIdx = phases.indexOf(`required:${name}`);
      const conIdx = phases.indexOf(`consumer:${name}`);
      expect(reqIdx).toBeGreaterThanOrEqual(3);
      expect(conIdx).toBeGreaterThan(reqIdx);
    }
    expect(phases).toHaveLength(9);
    const manifestBytes = readFileSync(join(input.output, "packages-manifest.json"));
    const manifest = JSON.parse(manifestBytes.toString());
    expect(manifest.commit).toBe(input.commit);
    expect(manifest.packages.map((entry: { name: string }) => entry.name)).toEqual(["@openlup/alpha", "@openlup/beta", "@openlup/gamma"]);
    const consumers = calls.filter(({ phase }) => phase === "consumer");
    expect(consumers).toHaveLength(3);
    for (const consumer of consumers) {
      expect(consumer.commit).toBe(input.commit);
      expect(consumer.manifest).toBe(createHash("sha256").update(manifestBytes).digest("hex"));
      expect(consumer.installed).toEqual(manifest.packages.map((entry: { name: string }) => entry.name));
      expect(consumer.value).toBe(consumer.name);
    }
    expect(new Set(consumers.map(({ manifest: digest }) => digest)).size).toBe(1);
  }, 60_000);

  it.each(["api:check", "ci:required", "test:consumer"])("refuses absent %s before creating cold artifacts", missing => {
    const input = fixture({ missing });
    expect(() => runRequiredPackageGates(input.root, input.output, input.commit)).toThrow(`needs executable ${missing}`);
    expect(existsSync(input.output)).toBe(false);
    expect(observations(input.root)).toEqual([]);
  });

  it("refuses an inventory member outside actual workspace discovery before packing", () => {
    const input = fixture({ nonWorkspace: true });
    expect(() => runRequiredPackageGates(input.root, input.output, input.commit)).toThrow("is not an actual workspace");
    expect(existsSync(input.output)).toBe(false);
  });

  it("refuses a different full commit before packing", () => {
    const input = fixture(), result = invoke(input, "f".repeat(40));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("expected commit differs from the actual checkout");
    expect(existsSync(input.output)).toBe(false);
  });

  it("propagates actual API failure before any required consumer", () => {
    const input = fixture({ failingApi: true }), result = invoke(input);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("synthetic API failure");
    expect(observations(input.root)).toEqual([{ phase: "api", name: "alpha" }]);
  }, 60_000);

  it("fails an installed consumer on a digest-consistent missing runtime export", () => {
    const input = fixture({ damagedExport: true }), result = invoke(input);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not provide an export named 'value'");
    expect(observations(input.root)).toEqual([{ phase: "api", name: "alpha" }, { phase: "required", name: "alpha", distReady: "1" }]);
  }, 60_000);

  it("reuses freshly built dist in @openlup/core build:cached only when OPENLUP_DIST_READY=1 and dist exists", () => {
    const coreManifest = JSON.parse(readFileSync(join(source, "../../packages/core/package.json"), "utf8")) as { scripts: Record<string, string> };
    const root = realpathSync(mkdtempSync(join(tmpdir(), "core-build-cached-")));
    roots.push(root);
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(
      join(root, "scripts/build-if-missing.ts"),
      readFileSync(join(source, "../../packages/core/scripts/build-if-missing.ts")),
    );
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "synthetic-core-build-cached",
      private: true,
      scripts: {
        build: "node -e \"const fs=require('node:fs'); fs.mkdirSync('dist',{recursive:true}); fs.appendFileSync('build-count.log','built\\n');\"",
        "build:cached": coreManifest.scripts["build:cached"],
      },
    }));
    const runCached = (env: Record<string, string | undefined>) => spawnSync("npm", ["run", "build:cached"], {
      cwd: root, env: { ...isolatedConsumerEnv(), ...env }, encoding: "utf8", timeout: 15_000,
    });
    const buildCount = () => existsSync(join(root, "build-count.log")) ? readFileSync(join(root, "build-count.log"), "utf8").trim().split("\n").length : 0;

    // 1. OPENLUP_DIST_READY=1 without dist/ still builds (fail-safe).
    expect(runCached({ OPENLUP_DIST_READY: "1" }).status).toBe(0);
    expect(buildCount()).toBe(1);
    expect(existsSync(join(root, "dist"))).toBe(true);

    // 2. OPENLUP_DIST_READY=1 with existing dist/ skips redundant rebuild.
    expect(runCached({ OPENLUP_DIST_READY: "1" }).status).toBe(0);
    expect(buildCount()).toBe(1);

    // 3. Standalone invocation without OPENLUP_DIST_READY always runs build.
    expect(runCached({}).status).toBe(0);
    expect(buildCount()).toBe(2);
  }, 30_000);

  it("restores shared prerequisites once in topological order after cold packing and signals OPENLUP_DIST_READY to ci:required", () => {
    const input = fixture({
      names: ["alpha", "beta", "gamma"],
      peerDependencies: {
        beta: { "@openlup/alpha": "0.4.0" },
        gamma: { "@openlup/alpha": "0.4.0" },
      },
    });
    for (const name of ["alpha", "beta", "gamma"]) {
      mkdirSync(join(input.root, "packages", name, "dist"));
      writeFileSync(join(input.root, "packages", name, "dist/stale.js"), "export const stale = true;\n");
    }
    const result = invoke(input);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    // Cold pack builds: [alpha], [alpha, beta], [alpha, gamma] (5 builds, 3 for alpha).
    // Single topological restoration before api:check: [alpha, beta, gamma] (3 builds, 1 for alpha).
    expect(builds(input.root).map(({ name }) => name)).toEqual([
      "alpha",
      "alpha", "beta",
      "alpha", "gamma",
      "alpha", "beta", "gamma",
    ]);
    for (const name of ["alpha", "beta", "gamma"]) {
      expect(existsSync(join(input.root, "packages", name, "dist/stale.js"))).toBe(false);
    }
    const calls = observations(input.root);
    const phases = calls.map(({ phase, name }) => `${phase}:${name}`);
    expect(phases.slice(0, 3)).toEqual(["api:alpha", "api:beta", "api:gamma"]);
    for (const name of ["alpha", "beta", "gamma"]) {
      const reqIdx = phases.indexOf(`required:${name}`);
      const conIdx = phases.indexOf(`consumer:${name}`);
      expect(reqIdx).toBeGreaterThanOrEqual(3);
      expect(conIdx).toBeGreaterThan(reqIdx);
    }
    expect(phases).toHaveLength(9);
    const requiredCalls = calls.filter(({ phase }) => phase === "required");
    expect(requiredCalls.map(({ distReady }) => distReady)).toEqual(["1", "1", "1"]);
  }, 60_000);

  it("verifies and consumes prepacked tarballs with --packages without re-running cold packages:check", () => {
    const input = fixture({ names: ["alpha", "beta"], peerDependencies: { beta: { "@openlup/alpha": "0.4.0" } } });
    // Cold-pack once as install-pack does, then clear dist/ and builds.jsonl to simulate a fresh install-packages runner.
    execFileSync("npm", ["run", "packages:check", "--", "--cold", "--out", input.output], {
      cwd: input.root, env: { ...isolatedConsumerEnv(), npm_config_cache: join(input.root, "scratch/npm-cache") }, stdio: "pipe",
    });
    for (const name of ["alpha", "beta"]) rmSync(join(input.root, "packages", name, "dist"), { recursive: true, force: true });
    rmSync(join(input.root, "builds.jsonl"), { force: true });

    const prepacked = spawnSync(
      process.execPath,
      ["--experimental-strip-types", join(source, "required-package-gates.ts"), "--packages", input.output, "--expected-commit", input.commit],
      { cwd: input.root, env: { ...isolatedConsumerEnv(), npm_config_cache: join(input.root, "scratch/npm-cache") }, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
    );
    expect(prepacked.status, prepacked.stdout + prepacked.stderr).toBe(0);
    // Only topological preparation builds run (no cold repack).
    expect(builds(input.root).map(({ name }) => name)).toEqual(["alpha", "beta"]);
    const prepackedPhases = observations(input.root).map(({ phase, name }) => `${phase}:${name}`);
    expect(prepackedPhases.slice(0, 2)).toEqual(["api:alpha", "api:beta"]);
    for (const name of ["alpha", "beta"]) {
      const reqIdx = prepackedPhases.indexOf(`required:${name}`);
      const conIdx = prepackedPhases.indexOf(`consumer:${name}`);
      expect(reqIdx).toBeGreaterThanOrEqual(2);
      expect(conIdx).toBeGreaterThan(reqIdx);
    }
    expect(prepackedPhases).toHaveLength(6);

    // Fail-closed: tampered manifest digest is rejected before api:check or consumer proofs run.
    const manifestPath = join(input.output, "packages-manifest.json");
    const tampered = JSON.parse(readFileSync(manifestPath, "utf8")) as { commit: string };
    tampered.commit = "0".repeat(40);
    writeFileSync(manifestPath, JSON.stringify(tampered));
    const refused = spawnSync(
      process.execPath,
      ["--experimental-strip-types", join(source, "required-package-gates.ts"), "--packages", input.output, "--expected-commit", input.commit],
      { cwd: input.root, env: { ...isolatedConsumerEnv(), npm_config_cache: join(input.root, "scratch/npm-cache") }, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
    );
    expect(refused.status).not.toBe(0);
  }, 60_000);

  it("settles concurrent sibling package proofs and flushes failure diagnostics when one package fails", () => {
    const input = fixture({ names: ["alpha", "beta"] });
    const betaManifestPath = join(input.root, "packages/beta/package.json");
    const betaManifest = JSON.parse(readFileSync(betaManifestPath, "utf8")) as { scripts: Record<string, string> };
    betaManifest.scripts["test:consumer"] = "node -e \"console.error('synthetic-beta-consumer-failure'); process.exit(1)\"";
    writeFileSync(betaManifestPath, JSON.stringify(betaManifest));
    git(input.root, "add", "-A");
    git(input.root, "commit", "-qm", "Break beta consumer");
    const commit = git(input.root, "rev-parse", "HEAD").trim();

    const result = invoke(input, commit);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("synthetic-beta-consumer-failure");
    expect(result.stderr).toContain("Package proof @openlup/beta FAILED");
    const phases = observations(input.root).map(({ phase, name }) => `${phase}:${name}`);
    expect(phases.slice(0, 2)).toEqual(["api:alpha", "api:beta"]);
    expect(phases).toContain("required:alpha");
    expect(phases).toContain("consumer:alpha");
    expect(phases).toContain("required:beta");
  }, 60_000);
});
