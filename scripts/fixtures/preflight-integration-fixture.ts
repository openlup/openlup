import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect } from "vitest";

import { carrierLocale } from "../agent-review-landing.mjs";
import { fixtureNpmCli, linkFixtureInstallation, localFixtureEnvironment } from "./landing-test-environment.ts";

export const PREFLIGHT_INTEGRATION_OWNERS = ["core", "platform"] as const;

export function createPreflightIntegrationFixture() {
  const source = process.cwd();
  const npmCli = fixtureNpmCli();
  const env = { ...localFixtureEnvironment(), ...carrierLocale, npm_execpath: npmCli };
  let directory = "";
  let root = "";
  let fork = "";

  const options = () => ({ cwd: root, env, encoding: "utf8" as const, timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  const run = (bin: string, ...args: string[]) => execFileSync(bin, args, options()).trim();
  const git = (...args: string[]) => run("git", ...args);
  const path = (file: string) => join(root, file);
  const put = (file: string, bytes: string) => {
    mkdirSync(dirname(path(file)), { recursive: true });
    writeFileSync(path(file), bytes);
  };
  const get = (file: string) => readFileSync(path(file), "utf8");
  const commit = (message: string) => {
    git("add", "-A");
    git("commit", "-qs", "-m", message);
    return git("rev-parse", "HEAD");
  };

  function setup() {
    directory = mkdtempSync(join(tmpdir(), "openlup-fast-preflight-"));
    root = join(directory, "fixture");
    execFileSync("git", ["clone", "--shared", "--no-hardlinks", "-q", source, root], { env, timeout: 30000 });
    git("checkout", "-q", "--detach");
    for (const file of [
      "scripts/preflight.ts",
      "scripts/settings-candidate-guard.ts",
      "scripts/agent-review-landing.mjs",
      ...["core", "outbox", "platform"].map(pkg => `packages/${pkg}/scripts/api-contract.ts`),
    ]) {
      cpSync(join(source, file), path(file));
    }
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "commit.gpgSign", "false");
    git("config", "core.hooksPath", "/dev/null");
    git("add", "-A");
    git("commit", "--allow-empty", "-qs", "-m", "Prepare fast fixture");
    fork = git("rev-parse", "HEAD");
    git("branch", "-f", "main", fork);
    git("remote", "set-url", "origin", ".");
    git("update-ref", "refs/remotes/origin/main", fork);
    linkFixtureInstallation(source, root);
  }

  function teardown() {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }

  function cold() {
    for (const owner of PREFLIGHT_INTEGRATION_OWNERS) {
      for (const leaf of ["dist", ".tsbuildinfo-build"]) {
        rmSync(path(`packages/${owner}/${leaf}`), { recursive: true, force: true });
      }
    }
  }

  function reset(warm = false) {
    git("checkout", "-q", "--detach", "--force", fork);
    git("clean", "-fd");
    cold();
    // Hosted test-prep and local pretest already built the unchanged parent inputs.
    if (warm) {
      for (const owner of PREFLIGHT_INTEGRATION_OWNERS) {
        const dist = `packages/${owner}/dist`;
        cpSync(join(source, dist), path(dist), { recursive: true });
      }
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
    expect(verdict, result.stdout + result.stderr).toEqual({
      preflight: "fast",
      result: expected.length ? "fail" : "pass",
      head: git("rev-parse", "HEAD"),
      failed: expected,
    });
    if (message && remedy) {
      expect(result.stdout).toContain(message);
      expect(result.stdout).toContain(remedy);
    }
    expect(snapshot()).toEqual(state);
    return verdict;
  }

  return { npmCli, setup, teardown, cold, reset, run, path, put, get, commit, fast };
}

export type PreflightIntegrationFixture = ReturnType<typeof createPreflightIntegrationFixture>;

export function verifyStaleApiReportRepair(fixture: PreflightIntegrationFixture, cache: "warm-seeded" | "cold", warm: boolean) {
  fixture.reset(warm);
  const entry = "packages/platform/src/portability/index.ts";
  const api = "packages/platform/api/portability.api.md";
  fixture.put(entry, fixture.get(entry) + "\nexport const fixtureFreshness = 1;\n");
  fixture.put("packages/platform/changes/fixture-freshness.md", "- Exercise the portability report owner.\n");
  fixture.commit("Add the fixture export with its original report");
  const declaration = "packages/platform/dist/portability/index.d.ts";
  if (warm) expect(fixture.get(declaration)).not.toContain("fixtureFreshness");
  else expect(existsSync(fixture.path(declaration))).toBe(false);
  fixture.fast(
    `API stale (${cache})`,
    ["api:check @openlup/platform"],
    `api:check @openlup/platform: FAIL ${api}`,
    "npm run api:update --workspace=@openlup/platform",
  );
  expect(fixture.get(declaration)).toContain("fixtureFreshness");
  fixture.run(process.execPath, "packages/platform/scripts/api-contract.ts", "--update");
  fixture.commit("Regenerate the API report");
  fixture.fast(`API repaired (${cache})`, []);
}

export function verifyStaleSettingsRepair(fixture: PreflightIntegrationFixture, cache: "warm-seeded" | "cold", warm: boolean) {
  fixture.reset(warm);
  const dataPath = "packages/platform/src/inventory/settings-data.json";
  const entries: { kind: string }[] = JSON.parse(fixture.get(dataPath));
  fixture.put(
    dataPath,
    JSON.stringify([
      ...entries,
      { ...entries.find(entry => entry.kind === "invariant"), key: "inventory.fixtureFreshness", goal: "Describe the freshness fixture." },
    ], null, 2) + "\n",
  );
  fixture.put("packages/platform/changes/fixture-freshness.md", "- Exercise the settings catalogue owner.\n");
  fixture.commit("Add the fixture setting with its original catalogue");
  fixture.fast(
    `settings stale (${cache})`,
    ["settings-catalogue"],
    "settings-catalogue: FAIL packages/platform/settings-catalog.json is stale",
    "node scripts/settings-catalogue.ts --write",
  );
  fixture.run(process.execPath, "scripts/settings-catalogue.ts", "--write");
  fixture.commit("Regenerate the settings carriers");
  fixture.fast(`settings repaired (${cache})`, []);
}
