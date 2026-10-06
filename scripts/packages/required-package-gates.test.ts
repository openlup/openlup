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

type FixtureOptions = { names?: string[]; missing?: string; nonWorkspace?: boolean; failingApi?: boolean; damagedExport?: boolean };
type Observation = { phase: string; name: string; commit?: string; manifest?: string; installed?: string[]; value?: string };

/** Mechanical neutral input, not a task checkout or an exact-task-candidate receipt. */
function fixture(options: FixtureOptions = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "required-package-fixture-")));
  roots.push(root);
  const names = options.names ?? ["alpha"];
  const write = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  write(".gitignore", "dist/\nout/\ntrace.jsonl\nscratch/\n");
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
    write(`packages/${name}/package.json`, JSON.stringify({ name: `@openlup/${name}`, version: "0.4.0", type: "module", license: "Apache-2.0", files: ["dist/**"],
      publishConfig: { access: "public", provenance: true, tag: "preview" }, repository: { type: "git", url: PUBLIC_REPOSITORY_URL, directory: `packages/${name}` },
      exports: { ".": "./dist/index.js" }, scripts }));
    write(`packages/${name}/src/index.ts`, `export const value = ${JSON.stringify(name)};\n`);
  }
  write("tools/phase.mjs", `
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
const phase = process.argv[2], name = basename(process.cwd()), root = resolve('../..');
if (phase === 'build') {
  mkdirSync('dist', { recursive: true });
  writeFileSync('dist/index.js', readFileSync('src/index.ts'));
} else {
  appendFileSync(join(root, 'trace.jsonl'), JSON.stringify({ phase, name }) + '\\n');
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
    expect(calls.map(({ phase, name }) => `${phase}:${name}`)).toEqual([
      "api:alpha", "api:beta", "api:gamma", "required:alpha", "consumer:alpha", "required:beta", "consumer:beta", "required:gamma", "consumer:gamma",
    ]);
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
    expect(observations(input.root)).toEqual([{ phase: "api", name: "alpha" }, { phase: "required", name: "alpha" }]);
  }, 60_000);
});
