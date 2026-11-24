import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { carrierLocale } from "./agent-review-landing.mjs";
import { fixtureNpmCli, linkFixtureInstallation, localFixtureEnvironment } from "./fixtures/landing-test-environment.ts";

describe("real fast preflight", () => {
  const source = process.cwd();
  const npmCli = fixtureNpmCli();
  const env = { ...localFixtureEnvironment(), ...carrierLocale, npm_execpath: npmCli };
  const owners = ["core", "platform"];
  let directory: string, root: string, fork: string;
  const options = () => ({ cwd: root, env, encoding: "utf8" as const, timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  const run = (bin: string, ...args: string[]) => execFileSync(bin, args, options()).trim();
  const git = (...args: string[]) => run("git", ...args);
  const path = (file: string) => join(root, file);
  const put = (file: string, bytes: string) => writeFileSync(path(file), bytes);
  const get = (file: string) => readFileSync(path(file), "utf8");
  const commit = (message: string) => { git("add", "-A"); git("commit", "-qs", "-m", message); return git("rev-parse", "HEAD"); };

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "openlup-fast-preflight-"));
    root = join(directory, "fixture");
    execFileSync("git", ["clone", "--shared", "--no-hardlinks", "-q", source, root], { env, timeout: 30000 });
    for (const file of ["scripts/preflight.ts", "scripts/settings-candidate-guard.ts", "scripts/agent-review-landing.mjs", ...["core", "outbox", "platform"].map(pkg => `packages/${pkg}/scripts/api-contract.ts`)]) {
      cpSync(join(source, file), path(file));
    }
    git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    git("config", "commit.gpgSign", "false"); git("config", "core.hooksPath", "/dev/null");
    git("add", "-A"); git("commit", "--allow-empty", "-qs", "-m", "Prepare fast fixture");
    fork = git("rev-parse", "HEAD");
    git("branch", "-f", "main", fork); git("remote", "set-url", "origin", ".");
    git("update-ref", "refs/remotes/origin/main", fork);
    linkFixtureInstallation(source, root);
  }, 180000);
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  const cold = () => {
    for (const owner of owners) for (const leaf of ["dist", ".tsbuildinfo-build"]) {
      rmSync(path(`packages/${owner}/${leaf}`), { recursive: true, force: true });
    }
  };
  function reset(warm = false) {
    git("checkout", "-q", "--detach", "--force", fork);
    git("clean", "-fd");
    cold();
    // Hosted test-prep and local pretest already built the unchanged parent inputs.
    if (warm) for (const owner of owners) {
      const dist = `packages/${owner}/dist`;
      cpSync(join(source, dist), path(dist), { recursive: true });
    }
  }
  function snapshot() {
    // Verify HEAD, index bytes, and working-tree tracked content via Git
    // instead of synchronously reading and hashing every tracked file on disk.
    return {
      index: readFileSync(path(".git/index")),
      head: git("rev-parse", "HEAD"),
      lsFiles: git("ls-files", "-z"),
      diffWorktree: git("diff", "--no-ext-diff", "--binary", "HEAD"),
      diffIndex: git("diff", "--cached", "--no-ext-diff", "--binary"),
    };
  }
  function fast(label: string, expected: string[], message?: string, remedy?: string) {
    const state = snapshot();
    const started = performance.now();
    const result = spawnSync(process.execPath, [npmCli, "run", "preflight", "--", "--fast"], options());
    console.info(`D3 fast preflight ${label}: ${(performance.now() - started).toFixed(0)} ms`);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(expected.length ? 1 : 0);
    const verdict = JSON.parse(result.stdout.trimEnd().split("\n").at(-1)!);
    expect(verdict, result.stdout + result.stderr).toEqual({ preflight: "fast", result: expected.length ? "fail" : "pass", head: git("rev-parse", "HEAD"), failed: expected });
    if (message && remedy) expect(result.stdout).toContain(message).toContain(remedy);
    expect(snapshot()).toEqual(state);
    return verdict;
  }

  it.each([
    { cache: "warm-seeded", warm: true },
    { cache: "cold", warm: false },
  ])("refuses a stale API report with a $cache cache, then accepts the owner's repair", ({ cache, warm }) => {
    reset(warm);
    const entry = "packages/platform/src/portability/index.ts";
    const api = "packages/platform/api/portability.api.md";
    put(entry, get(entry) + "\nexport const fixtureFreshness = 1;\n");
    put("packages/platform/changes/fixture-freshness.md", "- Exercise the portability report owner.\n");
    commit("Add the fixture export with its original report");
    const declaration = "packages/platform/dist/portability/index.d.ts";
    if (warm) expect(get(declaration)).not.toContain("fixtureFreshness");
    else expect(existsSync(path(declaration))).toBe(false);
    fast(`API stale (${cache})`, ["api:check @openlup/platform"],
      `api:check @openlup/platform: FAIL ${api}`, "npm run api:update --workspace=@openlup/platform");
    expect(get(declaration)).toContain("fixtureFreshness");
    run(process.execPath, "packages/platform/scripts/api-contract.ts", "--update");
    commit("Regenerate the API report");
    fast(`API repaired (${cache})`, []);
  }, 300000);

  it("refuses stale settings with warm-seeded and cold caches, then accepts the owner's repair", () => {
    reset(true);
    const dataPath = "packages/platform/src/inventory/settings-data.json";
    const entries: { kind: string }[] = JSON.parse(get(dataPath));
    put(dataPath, JSON.stringify([...entries, { ...entries.find(entry => entry.kind === "invariant"), key: "inventory.fixtureFreshness", goal: "Describe the freshness fixture." }], null, 2) + "\n");
    put("packages/platform/changes/fixture-freshness.md", "- Exercise the settings catalogue owner.\n");
    commit("Add the fixture setting with its original catalogue");
    const settingsCheck = (cache: string) => fast(`settings stale (${cache})`, ["settings-catalogue"],
      "settings-catalogue: FAIL packages/platform/settings-catalog.json is stale", "node scripts/settings-catalogue.ts --write");
    const warmSettings = settingsCheck("warm");
    cold();
    expect(settingsCheck("cold")).toEqual(warmSettings);
    run(process.execPath, "scripts/settings-catalogue.ts", "--write");
    commit("Regenerate the settings carriers");
    fast("settings repaired", []);
  }, 300000);

  it("names the unregistered public path and accepts its reviewed classification", () => {
    reset();
    const extra = "packages/platform/api/fixture-freshness.md";
    put(extra, "# Fixture freshness\n"); commit("Add a public path before classification");
    fast("unregistered path", ["publication"], `extra ${extra}`, "Add the reviewed classification in config/openlup-publication-catalog.json.");
    const catalogue = "config/openlup-publication-catalog.json";
    const registration: { publicPaths: { path: string; class: string }[] } = JSON.parse(get(catalogue));
    registration.publicPaths.push({ path: extra, class: "public-output" });
    registration.publicPaths.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    put(catalogue, JSON.stringify(registration, null, 2) + "\n"); commit("Register the fixture path");
    fast("path registered", []);
    for (const owner of owners) expect(existsSync(path(`packages/${owner}/dist`))).toBe(false);
  }, 180000);

  it.each(["patch drift", "Node major mismatch", "npm major mismatch"])("checks the installed toolchain with %s", variant => {
    reset();
    const node = process.versions.node;
    const npm = run(process.execPath, npmCli, "--version");
    const differentPin = (version: string, majorMismatch: boolean) => {
      const [major, minor, patch] = version.split(".").map(Number);
      return `${majorMismatch ? major + 1 : major}.${minor}.${patch + 1}`;
    };
    const pinnedNode = differentPin(node, variant === "Node major mismatch");
    const pinnedNpm = `npm@${differentPin(npm, variant === "npm major mismatch")}`;
    put(".nvmrc", `${pinnedNode}\n`);
    put("package.json", JSON.stringify({ ...JSON.parse(get("package.json")), packageManager: pinnedNpm }));
    const check = () => run(process.execPath, "--input-type=module", "-e",
      "import { assertCarrierToolchain } from './scripts/agent-review-landing.mjs'; console.log(assertCarrierToolchain(process.cwd()));");
    if (variant === "Node major mismatch") {
      expect(check).toThrow(`requires the Node major pinned by .nvmrc (${pinnedNode}); found Node ${node}. Run nvm install && nvm use.`);
    } else if (variant === "npm major mismatch") {
      expect(check).toThrow(`requires the npm major pinned by packageManager (${pinnedNpm}); found npm@${npm}. Run npm install --global ${pinnedNpm}.`);
    } else {
      expect(check()).toBe(`carrier toolchain: Node ${node}, npm ${npm}, ICU ${process.versions.icu}`);
    }
  }, 30_000);
});
