import { execFileSync, spawn, spawnSync, type ChildProcess, type SpawnOptions, type SpawnSyncOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env as processEnvironment } from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync), spawn: vi.fn(actual.spawn), spawnSync: vi.fn(actual.spawnSync) };
});

import {
  CLIENT_SECRET_BOUNDARY_TRIGGER, SITE_ROUTES_TRIGGER,
  addedLines, affectedTestCandidates, areaGuardTests, formatCheckLine, inventoryClosureDigest, isTestEntry, isTestFile, missingFragments, nearDates,
  parseNameStatus, main, neutralityVerdict, releasedPackageSource, separateTestFiles, shortExpiries,
  sqlTreeChanges, testDiscoveryVerdict, vitestFiles, type AddedLine, type Change,
} from "./preflight.ts";
import {
  assertCarrierBuildOutputs, assertCarrierToolchain, assertLockedInstall, carrierPlan, readReportOwners, runUnselectedBuild,
} from "./agent-review-landing.mjs";
import { localFixtureEnvironment } from "./fixtures/landing-test-environment.ts";

type FakeSpawnResult = { status: number | null; stdout?: string; stderr?: string; error?: NodeJS.ErrnoException };
function mockChildProcesses(handler: (bin: string, args: readonly string[] | undefined, options: SpawnSyncOptions | SpawnOptions | undefined) => FakeSpawnResult): void {
  vi.mocked(spawnSync).mockImplementation(((bin: string, args?: readonly string[], options?: SpawnSyncOptions) => {
    const res = handler(bin, args, options);
    return { pid: 0, output: [], signal: null, status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", error: res.error };
  }) as typeof spawnSync);
  vi.mocked(spawn).mockImplementation(((bin: string, args?: readonly string[], options?: SpawnOptions) => {
    const res = handler(bin, args, options);
    const child = new EventEmitter() as ChildProcess;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    (child as unknown as { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean }).stdout = stdout;
    (child as unknown as { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean }).stderr = stderr;
    (child as unknown as { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean }).kill = () => true;
    queueMicrotask(() => {
      if (res.stdout) stdout.emit("data", res.stdout);
      if (res.stderr) stderr.emit("data", res.stderr);
      if (res.error) child.emit("error", res.error);
      else child.emit("close", res.status);
    });
    return child;
  }) as typeof spawn);
}

afterEach(() => {
  vi.mocked(execFileSync).mockReset();
  vi.mocked(spawn).mockReset();
  vi.mocked(spawnSync).mockReset();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const changed = (...paths: string[]): Change[] => paths.map((path) => ({ path, deleted: false }));
const line = (text: string): AddedLine[] => [{ path: "scripts/example.test.ts", line: 7, text }];
// An injected clock; the window is measured from it, never from the real clock.
const now = new Date("2040-01-01T00:00:00Z");

describe("carrier guards on Git fixtures", () => {
  let git: (...args: string[]) => string, root: string;
  const tracked = "packages/platform/dist/fixture-tracked.txt";
  const readme = "README.md";
  const bytes = "Committed fixture bytes\n";
  const path = (file: string) => join(root, file);
  const snapshot = () => ({
    tracked: git("ls-files", "-z").split("\0").filter(Boolean).map(file => [file, readFileSync(path(file))]),
    index: readFileSync(path(".git/index")),
  });

  beforeEach(async () => {
    const childProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    root = mkdtempSync(join(tmpdir(), "openlup-carrier-guard-"));
    const env = localFixtureEnvironment();
    git = (...args) => childProcess.execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
    git("init", "-q");
    writeFileSync(path(".gitignore"), "dist/\nnode_modules/\n");
    mkdirSync(path("packages/platform/dist"), { recursive: true });
    writeFileSync(path(tracked), bytes);
    writeFileSync(path(readme), bytes);
    git("add", "--", ".gitignore", readme);
    git("add", "-f", "--", tracked);
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "-qm", "Track a build output");
  });
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  it("refuses a tracked dist file with its exact path and index remedy", async () => {
    const before = snapshot();
    await expect(assertCarrierBuildOutputs(root, ["packages/platform"]))
      .rejects.toThrow(`carrier build would overwrite or remove tracked path ${tracked}; remove it from the index with git rm --cached -- <path>`);
    expect(snapshot()).toEqual(before);
  });

  it("refuses a mismatched installed dependency with the npm ci remedy", () => {
    const locked = { "node_modules/zod": { version: "4.0.0" } };
    writeFileSync(path("package-lock.json"), JSON.stringify({ packages: locked }));
    git("add", "--", "package-lock.json");
    mkdirSync(path("node_modules"));
    writeFileSync(path("node_modules/.package-lock.json"), JSON.stringify({ packages: { "node_modules/zod": { version: "3.0.0" } } }));
    const before = snapshot();
    const committed = JSON.parse(readFileSync(path("package-lock.json"), "utf8"));
    expect(() => assertLockedInstall(root, committed.packages))
      .toThrow("carrier build: installed npm tree does not match package-lock.json (node_modules/zod); run npm ci in this checkout");
    expect(snapshot()).toEqual(before);
  });

  it.each(["unstaged", "staged"])("refuses an unselected build with a %s tracked change", async change => {
    const before = snapshot();
    let planted: ReturnType<typeof snapshot> | undefined;
    await expect(runUnselectedBuild(root, "@openlup/core", new Set(), () => {
      writeFileSync(path(readme), "Fixture build side effect.\n");
      if (change === "staged") {
        git("add", "--", readme);
        writeFileSync(path(readme), bytes);
      }
      planted = snapshot();
    })).rejects.toThrow(`landing: unselected build @openlup/core changed tracked paths: ${readme}`);
    expect(planted).toBeDefined();
    expect(snapshot()).toEqual(planted);
    const after = snapshot();
    if (change === "staged") {
      expect(after.tracked).toEqual(before.tracked);
      expect(after.index).not.toEqual(before.index);
    } else {
      expect(after.tracked).not.toEqual(before.tracked);
      expect(after.index).toEqual(before.index);
    }
  });
});

it.each([undefined, "npm-cli.js"])("refuses landing carrier checks with npm_execpath %s", npmCli => {
  vi.stubEnv("npm_execpath", npmCli);
  expect(() => assertCarrierToolchain(process.cwd())).toThrow("run through npm run landing:merge");
});

it.each([
  { path: "README.md", builds: [], reports: [], settings: false },
  { path: "packages/outbox/src/index.ts", builds: ["core", "outbox"], reports: ["outbox"], settings: false },
  { path: "packages/platform/api/portability.api.md", builds: ["core", "platform"], reports: ["platform"], settings: true },
  { path: "packages/platform/src/inventory/settings-data.json", builds: ["core", "platform"], reports: [], settings: true },
  { path: "packages/platform/settings-catalog.json", builds: ["core", "platform"], reports: [], settings: true },
  { path: "packages/platform/settings-refusals.json", builds: ["core", "platform"], reports: [], settings: true },
  { path: "packages/core/docs/guide/how-to/operate/settings-catalogue.md", builds: ["core", "platform"], reports: [], settings: true },
  { path: "packages/core/package.json", builds: ["core", "outbox", "platform"], reports: ["core", "outbox", "platform"], settings: true },
  { path: "package-lock.json", builds: ["core", "outbox", "platform"], reports: ["core", "outbox", "platform"], settings: true },
])("selects the dependency closure and check owners for $path", ({ path, builds, reports, settings }) => {
  const plan = carrierPlan(readReportOwners(process.cwd()), [path]);
  expect(plan.builds.map(({ name }) => name)).toEqual(builds.map(name => `@openlup/${name}`));
  expect(plan.reports.map(({ name }) => name)).toEqual(reports.map(name => `@openlup/${name}`));
  expect(plan.settings).toBe(settings);
});

describe("fast preflight", () => {
  const npmCli = join(process.cwd(), "fixture-npm-cli.js");
  const npm = `${process.execPath} ${npmCli}`;
  const carrierNpmRun = (args: readonly string[] | undefined) =>
    args?.[0] === npmCli && args[1] === "run" && ["build", "api:check"].includes(args[2]);
  const clean = { dirty: false, offline: false, warnings: false, failures: [], exit: 0 };
  beforeEach(() => { vi.stubEnv("npm_execpath", npmCli); });
  it.each([
    { ...clean, name: "clean" },
    { ...clean, name: "clean with an npm version timeout", npmVersion: "unavailable (timed out after 5 s)",
      versionProbe: { status: null, stdout: "", error: Object.assign(new Error("npm version timed out"), { code: "ETIMEDOUT" }) } },
    { ...clean, name: "clean with a non-zero npm version exit", npmVersion: "unavailable (exit status 1)",
      versionProbe: { status: 1, stdout: "11.19.1\n" } },
    { ...clean, name: "clean with empty npm version output", npmVersion: "unavailable (empty output)",
      versionProbe: { status: 0, stdout: " \n" } },
    { ...clean, name: "clean when launching the npm version probe throws", npmVersion: "unavailable (probe failed)",
      versionProbe: new Error("npm version probe could not launch") },
    { name: "clean with Git stderr warnings", dirty: false, offline: false, warnings: true, failures: [], exit: 0 },
    { name: "dirty with a failed fetch", dirty: true, offline: true, warnings: false, failures: ["clean"], exit: 1 },
    { name: "multiple failures", dirty: false, offline: false, warnings: false, failures: ["merge-clean", "neutrality", "publication", "dco"], exit: 1 },
  ])("reports every check and ends with JSON for a $name fixture", async ({ dirty, offline, warnings, failures, exit, npmVersion = "11.19.1", versionProbe }) => {
    const head = "a".repeat(40), fork = "b".repeat(40), upstream = "c".repeat(40);
    const increase = '"scripts/example.ts": brand increased 0 -> 1';
    const conflict = "CONFLICT (content): Merge conflict in example.ts";
    const mismatch = "example.ts: missing from the publication inventory";
    const closing = "the tree is not the inventory the manifest describes.";
    const expected = [
      "git rev-parse --show-toplevel",
      "git rev-parse HEAD",
      "git fetch origin main",
      "git status --porcelain --untracked-files=all",
      "git merge-tree --write-tree origin/main HEAD",
      "git merge-base HEAD origin/main",
      `${process.execPath} scripts/public-ci-neutrality.mjs --base-commit ${fork}`,
      `${process.execPath} --experimental-strip-types packages/ui/smoke/neutrality.ts`,
      "npx --no -- ast-grep scan --error=no-suppress-all --error=unused-suppression",
      `${process.execPath} scripts/ast-grep/check-filewide-ignore.mjs`,
      "npx --no -- ast-grep test --skip-snapshot-tests",
      `${npm} --version`,
      `${npm} run oss:published-tree -- --self-check --docs-base ${fork}`,
      `git diff --name-status --no-renames -z ${fork} HEAD`,
      "gitleaks version",
      "git rev-parse origin/main",
    ];
    const calls: string[] = [];
    const outputs = new Map([
      [expected[0], process.cwd()], [expected[1], head], [expected[3], dirty ? "?? local.txt\n" : ""],
      [expected[4], conflict], [expected[5], fork], [expected[6], increase],
      [expected[11], "11.19.1\n"], [expected[12], `${mismatch}\n${closing}`], [expected[15], upstream],
    ]);
    mockChildProcesses((bin, args, options) => {
      const call = `${bin} ${(args ?? []).join(" ")}`;
      calls.push(call);
      if (bin === "git") expect(processEnvironment.GIT_OPTIONAL_LOCKS).toBe("0");
      if (bin === "npx") {
        expect(options?.env).toMatchObject({ npm_config_offline: "true", npm_config_update_notifier: "false" });
      }
      if (call === expected[11] && versionProbe) {
        expect(options?.timeout).toBe(5_000);
        if (versionProbe instanceof Error) throw versionProbe;
        return { ...versionProbe, stderr: "" };
      }
      if (bin === "gitleaks") {
        return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("missing"), { code: "ENOENT" }) };
      }
      const status = Number((call === expected[2] && offline)
        || (call === expected[4] && failures.includes("merge-clean"))
        || (call === expected[6] && failures.includes("neutrality"))
        || (call === expected[12] && failures.includes("publication")));
      const stderr = warnings && [expected[0], expected[1], expected[3], expected[5], expected[13], expected[15]].includes(call)
        ? "warning: fixture Git warning\n" : "";
      return { status, stdout: outputs.get(call) ?? "", stderr };
    });
    const signed = "change\n\nSigned-off-by: Test Fixture <fixture@example.invalid>";
    const message = failures.includes("dco") ? "unsigned commit" : signed;
    vi.mocked(execFileSync).mockReturnValue(`${head}\x1f${fork}\x1f${message}\0${upstream}\x1f${head} ${fork}\x1f${signed}\0`);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await main(now, ["--fast"])).toBe(exit);
    expect([...calls].sort()).toEqual([...expected].sort());
    expect(execFileSync).toHaveBeenCalledWith("git", expect.arrayContaining([`${upstream}..${head}`]), expect.anything());
    const lines = log.mock.calls.map(([value]) => String(value));
    expect(JSON.parse(lines.pop()!)).toEqual({ preflight: "fast", result: exit === 0 ? "pass" : "fail", head, failed: failures });
    const reasons: Record<string, string> = {
      clean: "worktree has uncommitted changes. Commit or remove them.",
      "merge-clean": conflict,
      neutrality: "1 neutrality count increase(s) against the fork point; the required self-check job refuses them",
      publication: closing,
      dco: `missing Signed-off-by on ${head.slice(0, 12)}`,
    };
    const skipLines: Record<string, string> = {
      "carrier toolchain": `carrier toolchain: Node ${process.versions.node}, npm ${npmVersion}, ICU ${process.versions.icu}`,
      fragments: "fragments: skip no released package source changed",
      "settings-candidates": "settings-candidates: skip no packages/platform/src/**/*.ts files changed",
      "test dates": "test dates: skip no new or changed test files",
      "test expiries": "test expiries: skip no new or changed test files",
      gitleaks: "gitleaks: skip gitleaks is not on PATH; the required gitleaks job still scans the pull request",
      "eslint-changed": "eslint-changed: skip no changed JS/TS files",
      "client-secret-boundary": "client-secret-boundary: skip no client-secret-boundary inputs changed",
      "site-routes": "site-routes: skip no site route inputs changed",
      "guide-check": "guide-check: skip no guide or rule files changed",
      carriers: `carriers: skip ${dirty ? "clean committed checkout required" : "no report or settings inputs changed"}`,
      ...(dirty ? { "migration projection": "migration projection: skip clean committed checkout required" } : {}),
      "package-manifest": "package-manifest: skip no package manifests or config/openlup-packages.json changed",
    };
    expect(lines.filter((line) => !line.startsWith("    ")).map((line) => line.replace(/ \(\d+ s\)$/u, "")))
      .toEqual([
        "clean", "merge-clean", "neutrality", "ui-neutrality", "ast-grep", "ast-grep-hygiene",
        "eslint-changed", "client-secret-boundary", "site-routes",
        "carrier toolchain", "publication", "carriers", "migration projection",
        "fragments", "settings-candidates", "test dates", "test expiries", "gitleaks", "guide-check", "package-manifest", "dco",
      ].map((name) => skipLines[name] ?? `${name}: ${failures.includes(name) ? `FAIL ${reasons[name]}` : "ok"}`));
    expect(lines.filter((line) => line.startsWith("    "))).toEqual(
      failures.includes("publication") ? [conflict, increase, mismatch, closing].map((line) => `    ${line}`) : [],
    );
    expect(stderr.mock.calls).toEqual(offline ? [["preflight: git fetch origin main failed. Using local origin/main."]] : []);
  });

  it("checks merge commits for DCO and passes when HEAD equals origin/main (0 commits)", async () => {
    const head = "a".repeat(40), fork = "b".repeat(40), upstream = "c".repeat(40);
    const setupMocks = async (gitLogOutput: string, sameHead = false) => {
      mockChildProcesses((bin, args) => {
        const call = `${bin} ${(args ?? []).join(" ")}`;
        if (call === "git rev-parse --show-toplevel") return { status: 0, stdout: process.cwd(), stderr: "" };
        if (call === "git rev-parse HEAD") return { status: 0, stdout: sameHead ? upstream : head, stderr: "" };
        if (call === "git merge-base HEAD origin/main") return { status: 0, stdout: sameHead ? upstream : fork, stderr: "" };
        if (call === "git rev-parse origin/main") return { status: 0, stdout: upstream, stderr: "" };
        if (bin === "gitleaks") return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("missing"), { code: "ENOENT" }) };
        return { status: 0, stdout: "", stderr: "" };
      });
      vi.mocked(execFileSync).mockReturnValue(gitLogOutput);
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((value) => { lines.push(String(value)); });
      vi.spyOn(console, "error").mockImplementation(() => {});
      return { exit: await main(now, ["--fast"]), lines };
    };

    const mergeSha = "e".repeat(40);
    const signed = "change\n\nSigned-off-by: Test Fixture <fixture@example.invalid>";
    const unsignedMerge = await setupMocks(`${head}\x1f${fork}\x1f${signed}\0${mergeSha}\x1f${head} ${fork}\x1fMerge branch 'main'\0`);
    expect(unsignedMerge.exit).toBe(1);
    expect(JSON.parse(unsignedMerge.lines.at(-1)!)).toEqual({
      preflight: "fast", result: "fail", head, failed: ["dco"],
    });
    expect(unsignedMerge.lines).toContain(`dco: FAIL missing Signed-off-by on ${mergeSha.slice(0, 12)}`);

    const zeroCommits = await setupMocks("", true);
    expect(zeroCommits.exit).toBe(0);
    expect(JSON.parse(zeroCommits.lines.at(-1)!)).toEqual({
      preflight: "fast", result: "pass", head: upstream, failed: [],
    });
    expect(zeroCommits.lines).toContain("dco: ok");
  });

  it("handles OPENLUP_STACK_BASE for publication and merge-clean ancestry", async () => {
    const head = "a".repeat(40), fork = "b".repeat(40), upstream = "c".repeat(40), stackBase = "d".repeat(40);
    const runWithStackBase = async (value: string, headCode: number, mainCode: number) => {
      vi.stubEnv("OPENLUP_STACK_BASE", value);
      const calls: string[] = [];
      mockChildProcesses((bin, args) => {
        const call = `${bin} ${(args ?? []).join(" ")}`;
        calls.push(call);
        if (call === "git rev-parse --show-toplevel") return { status: 0, stdout: process.cwd(), stderr: "" };
        if (call === "git rev-parse HEAD") return { status: 0, stdout: head, stderr: "" };
        if (call === "git merge-base HEAD origin/main") return { status: 0, stdout: fork, stderr: "" };
        if (call === `git merge-base --is-ancestor ${value} HEAD`) return { status: headCode, stdout: "", stderr: "" };
        if (call === `git merge-base --is-ancestor ${value} origin/main`) return { status: mainCode, stdout: "", stderr: "" };
        if (call === "git rev-parse origin/main") return { status: 0, stdout: upstream, stderr: "" };
        if (bin === "gitleaks") return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("missing"), { code: "ENOENT" }) };
        return { status: 0, stdout: "", stderr: "" };
      });
      vi.mocked(execFileSync).mockReturnValue(`${head}\x1f${fork}\x1fchange\n\nSigned-off-by: Test Fixture <fixture@example.invalid>\0`);
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((value) => { lines.push(String(value)); });
      vi.spyOn(console, "error").mockImplementation(() => {});
      const exit = await main(now, ["--fast"]);
      return { exit, calls, lines };
    };

    const unlanded = await runWithStackBase(stackBase, 0, 1);
    expect(unlanded.exit).toBe(0);
    expect(unlanded.calls).toContain(`git merge-base --is-ancestor ${stackBase} HEAD`);
    expect(unlanded.calls).toContain(`git merge-base --is-ancestor ${stackBase} origin/main`);
    expect(unlanded.calls).not.toContain("git merge-tree --write-tree origin/main HEAD");
    expect(unlanded.calls).toContain(`${npm} run oss:published-tree -- --self-check`);
    expect(unlanded.calls.some((call) => call.includes("--docs-base"))).toBe(false);
    expect(unlanded.lines).toContain("merge-clean: skip unlanded OPENLUP_STACK_BASE; merge-tree skipped");

    const landed = await runWithStackBase(stackBase, 0, 0);
    expect(landed.exit).toBe(0);
    expect(landed.calls).toContain(`git merge-base --is-ancestor ${stackBase} origin/main`);
    expect(landed.calls).toContain("git merge-tree --write-tree origin/main HEAD");

    const fatalMainCheck = await runWithStackBase(stackBase, 0, 128);
    expect(fatalMainCheck.exit).toBe(0);
    expect(fatalMainCheck.calls).toContain("git merge-tree --write-tree origin/main HEAD");

    const notHeadAncestor = await runWithStackBase(stackBase, 1, 1);
    expect(notHeadAncestor.exit).toBe(0);
    expect(notHeadAncestor.calls).toContain("git merge-tree --write-tree origin/main HEAD");

    for (const bad of ["D".repeat(40), "not-a-sha"]) {
      const rejected = await runWithStackBase(bad, 0, 1);
      expect(rejected.exit).toBe(0);
      expect(rejected.calls.some((call) => call.includes("--is-ancestor"))).toBe(false);
      expect(rejected.calls).toContain("git merge-tree --write-tree origin/main HEAD");
    }
  });

  it("surfaces WARN/SKIP without failing --fast and runs conditional guide/manifest checks", async () => {
    const head = "a".repeat(40), fork = "b".repeat(40), upstream = "c".repeat(40);
    const calls: string[] = [];
    const nameStatus = [
      "M\0packages/core/src/index.ts\0",
      "M\0scripts/example.test.ts\0",
      "M\0packages/core/docs/guide/README.md\0",
      "M\0packages/core/package.json\0",
    ].join("");
    mockChildProcesses((bin, args, options) => {
      const call = `${bin} ${(args ?? []).join(" ")}`;
      calls.push(call);
      if (call === "npm run packages:check -- --manifest-only") {
        expect(options?.env).toMatchObject({ npm_config_offline: "true", npm_config_update_notifier: "false" });
      }
      if (bin === process.execPath && carrierNpmRun(args)) {
        expect([options?.env?.GIT_OPTIONAL_LOCKS, options?.env?.LC_ALL, options?.env?.LANG]).toEqual(["0", "en_US.UTF-8", "en_US.UTF-8"]);
      }
      if (call === "git rev-parse --show-toplevel") return { status: 0, stdout: process.cwd(), stderr: "" };
      if (call === "git rev-parse HEAD") return { status: 0, stdout: head, stderr: "" };
      if (call === "git merge-base HEAD origin/main") return { status: 0, stdout: fork, stderr: "" };
      if (call === `git diff --name-status --no-renames -z ${fork} HEAD`) return { status: 0, stdout: nameStatus, stderr: "" };
      if (call === `git diff -U0 --no-color --no-ext-diff ${fork} HEAD -- scripts/example.test.ts`) {
        return { status: 0, stdout: '@@ -1,0 +7,1 @@\n+const at = "2040-03-01";', stderr: "" };
      }
      if (call === "git rev-list --count bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb..HEAD") return { status: 0, stdout: "1\n", stderr: "" };
      if (call === "git rev-parse origin/main") return { status: 0, stdout: upstream, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.mocked(execFileSync).mockReturnValue(`${head}\x1f${fork}\x1fchange\n\nSigned-off-by: Test Fixture <fixture@example.invalid>\0`);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => { lines.push(String(value)); });
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await main(now, ["--fast"])).toBe(0);
    const owners = ["core", "outbox", "platform"];
    expect(calls.filter(call => call.startsWith(`${npm} run build --workspace=`) || call.startsWith(`${npm} run api:check --workspace=`))).toEqual(
      ["build", "api:check"].flatMap(command => owners.map(owner => `${npm} run ${command} --workspace=@openlup/${owner}`)),
    );
    expect(calls).toContain(`${process.execPath} --experimental-strip-types packages/core/scripts/documentation-contract.ts --check-guide packages/core`);
    expect(calls).toContain("npm run packages:check -- --manifest-only");
    expect(calls).toContain("gitleaks git . --config config/gitleaks.toml --gitleaks-ignore-path .gitleaksignore --redact --no-banner --no-color --log-opts bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb..HEAD");
    expect(lines).toContain("fragments: warn source changed without a changes/*.md fragment in packages/core");
    expect(lines).toContain("test dates: warn 1 added line(s) with a calendar date within 400 days of now; prefer an injected clock or a far date");
    expect(lines).toContain('    scripts/example.test.ts:7: 2040-03-01 within 400 days of now: const at = "2040-03-01";');
    expect(lines).toContain("test expiries: ok");
    expect(lines).toContain("gitleaks: ok");
    expect(lines).toContain("guide-check: ok");
    expect(lines).toContain("package-manifest: ok");
    expect(JSON.parse(lines.at(-1)!)).toEqual({ preflight: "fast", result: "pass", head, failed: [] });
  });

  it("fails --fast when an unaccounted settings candidate constant is added in packages/platform/src/<domain>/ and passes when annotated", async () => {
    const head = "a".repeat(40), fork = "b".repeat(40), upstream = "c".repeat(40);
    const targetPath = "packages/platform/src/commerce/policy.ts";
    const runFastWithDiff = async (diffBody: string) => {
      mockChildProcesses((bin, args) => {
        const call = `${bin} ${(args ?? []).join(" ")}`;
        if (call === "git rev-parse --show-toplevel") return { status: 0, stdout: process.cwd(), stderr: "" };
        if (call === "git rev-parse HEAD") return { status: 0, stdout: head, stderr: "" };
        if (call === "git merge-base HEAD origin/main") return { status: 0, stdout: fork, stderr: "" };
        if (call === `git diff --name-status --no-renames -z ${fork} HEAD`) return { status: 0, stdout: `M\0${targetPath}\0`, stderr: "" };
        if (call === `git diff --unified=2 --no-color --no-ext-diff --src-prefix=a/ --dst-prefix=b/ ${fork} HEAD -- ${targetPath}`) {
          return {
            status: 0,
            stdout: `diff --git a/${targetPath} b/${targetPath}\n+++ b/${targetPath}\n@@ -1,1 +1,3 @@\n${diffBody}\n`,
            stderr: "",
          };
        }
        if (call === "git rev-parse origin/main") return { status: 0, stdout: upstream, stderr: "" };
        if (bin === "gitleaks") return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("missing"), { code: "ENOENT" }) };
        return { status: 0, stdout: "", stderr: "" };
      });
      vi.mocked(execFileSync).mockReturnValue(`${head}\x1f${fork}\x1fchange\n\nSigned-off-by: Test Fixture <fixture@example.invalid>\0`);
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((value) => { lines.push(String(value)); });
      vi.spyOn(console, "error").mockImplementation(() => {});
      return { exit: await main(now, ["--fast"]), lines };
    };

    const unaccounted = await runFastWithDiff(" export const existing = 1;\n+export const CHECKOUT_GRACE_MINUTES = 15;");
    expect(unaccounted.exit).toBe(1);
    expect(JSON.parse(unaccounted.lines.at(-1)!)).toEqual({
      preflight: "fast", result: "fail", head, failed: ["settings-candidates"],
    });
    expect(unaccounted.lines).toContain("settings-candidates: FAIL 1 unaccounted settings candidate(s); evaluate against CONTRIBUTING.md#add-a-setting");

    const annotated = await runFastWithDiff("+// settings-candidate: excluded (internal transport timeout)\n+export const CHECKOUT_GRACE_MINUTES = 15;");
    expect(annotated.exit).toBe(0);
    expect(JSON.parse(annotated.lines.at(-1)!)).toEqual({
      preflight: "fast", result: "pass", head, failed: [],
    });
    expect(annotated.lines).toContain("settings-candidates: ok");
  });
});

describe("area preflight", () => {
  const excludedHeavyOrDocker = [
    "scripts/agent-review-derived-inventory.test.ts",
    "scripts/packages/outbox-consumer-proof.test.ts",
    "scripts/packages/distribution-cli-proof.test.ts",
    "scripts/packages/distribution-cli-settings.test.ts",
    "scripts/packages/platform-cold-consumer.test.ts",
    "scripts/packages/reference-delegation-consumer.test.ts",
    "tests/postgres/nativeStoreForwardCatalog.serviceRole.test.ts",
    "tests/postgres/nativeStoreForwardCatalog.noServiceRole.test.ts",
    "tests/postgres/reviewedBatchForwards.test.ts",
  ];

  it("selects Docker-free, consumer-pack-free area tooling guards from ci-test-scope and catalog boundary triggers", () => {
    expect(areaGuardTests([])).toEqual([]);
    expect(areaGuardTests(["tests/unit/example.test.ts"])).toEqual([]);
    expect(areaGuardTests(["src/app.tsx"])).toEqual(["scripts/packages/eslint-import-map.test.ts"]);
    expect(areaGuardTests(["docs/platform/README.md"])).toEqual(["scripts/catalog-document-boundary.test.ts"]);
    for (const path of [
      "src/domains/catalog/example.ts",
      "server/domains/catalog/example.ts",
      "db/platform/schema.sql",
      "server/adapters/postgres/example.ts",
    ]) {
      expect(areaGuardTests([path])).toContain("scripts/catalog-document-boundary.test.ts");
    }

    const sqlGuards = areaGuardTests(["db/platform/migrations/20400101000000_example.sql"]);
    expect(sqlGuards).toEqual([
      "scripts/catalog-document-boundary.test.ts",
      "scripts/qualified-migration-admission.test.ts",
      "scripts/reviewed-batch-forward.test.ts",
      "scripts/reviewed-native-store-forward.test.ts",
    ]);

    const catalogGuards = areaGuardTests(["packages/platform/src/catalog/example.ts"]);
    expect(catalogGuards).toContain("scripts/catalog-document-boundary.test.ts");
    expect(catalogGuards).toContain("scripts/packages/package-manifest-policy.test.ts");
    for (const heavy of excludedHeavyOrDocker) expect(catalogGuards).not.toContain(heavy);

    const sharedScriptGuards = areaGuardTests(["scripts/preflight.ts"]);
    expect(sharedScriptGuards).toContain("scripts/catalog-document-boundary.test.ts");
    expect(sharedScriptGuards).toContain("scripts/sql-admit.test.ts");
    for (const heavy of excludedHeavyOrDocker) expect(sharedScriptGuards).not.toContain(heavy);
  });

  it("rejects mutually exclusive --fast and --area with exit code 2", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(now, ["--fast", "--area"])).toBe(2);
    expect(stderr).toHaveBeenCalledWith("preflight: --fast, --area, and --affected are mutually exclusive");
  });

  it("runs eslint, area tooling guards via test-hosted, and sql admit without Docker or typecheck", async () => {
    const runArea = async (options: { nameStatus?: string; untracked?: string; guardCode?: number }) => {
      const calls: string[] = [];
      mockChildProcesses((command, args) => {
        const call = `${command} ${(args ?? []).join(" ")}`;
        calls.push(call);
        if (command === "git") {
          if (args?.includes("--show-toplevel")) return { status: 0, stdout: process.cwd(), stderr: "warning: git warning\n" };
          if (args?.includes("merge-base")) return { status: 0, stdout: "a".repeat(40), stderr: "" };
          if (args?.includes("--name-status")) return { status: 0, stdout: options.nameStatus ?? "", stderr: "" };
          if (args?.includes("--others")) return { status: 0, stdout: options.untracked ?? "", stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args?.[0] === "scripts/test-hosted.mjs") return { status: options.guardCode ?? 0, stdout: "hosted ok", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      });
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((value) => { lines.push(String(value)); });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      return { exit: await main(now, ["--area"]), calls, lines };
    };

    const skipped = await runArea({ nameStatus: "M\0tests/unit/example.test.ts\0" });
    expect(skipped.exit).toBe(0);
    expect(skipped.lines).toContainEqual(expect.stringMatching(/^PASS eslint changed: 1 changed file\(s\) passed eslint/u));
    expect(skipped.lines).toContain("SKIP area guards: no area tooling guard tests triggered");
    expect(skipped.lines).toContain("SKIP sql admit: no SQL under db/ or packages/*/sql/ changed");

    const triggered = await runArea({ nameStatus: "A\0db/platform/migrations/20400101000000_example.sql\0M\0src/example.ts\0" });
    expect(triggered.exit).toBe(0);
    expect(triggered.calls).toContain("npx --no -- eslint -- src/example.ts");
    expect(triggered.calls).toContain(
      `${process.execPath} scripts/test-hosted.mjs scripts/catalog-document-boundary.test.ts scripts/packages/eslint-import-map.test.ts scripts/qualified-migration-admission.test.ts scripts/reviewed-batch-forward.test.ts scripts/reviewed-native-store-forward.test.ts`,
    );
    expect(triggered.calls).toContain("npm run sql:admit");
    expect(triggered.calls.some((call) => call.includes("prelint") || call.includes("docker") || call.includes("inventory"))).toBe(false);

    const failed = await runArea({ nameStatus: "M\0docs/platform/README.md\0", guardCode: 1 });
    expect(failed.exit).toBe(1);
    expect(failed.lines).toContainEqual(expect.stringMatching(/^FAIL area guards: npm run test:hosted -- scripts\/catalog-document-boundary\.test\.ts exited 1/u));
  });
});

describe("preflight report", () => {
  it("confirms a real root test while leaving a wrong suffix undiscovered", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    vi.mocked(spawnSync).mockImplementation(actual.spawnSync);
    expect(vitestFiles(["scripts/preflight.test.ts", "scripts/preflight.test.tsx"]))
      .toEqual(["scripts/preflight.test.ts"]);
    expect(vitestFiles(["packages/core/test/agent-context-cli.test.ts", "packages/core/test/agent-context-cli.test.tsx"], "packages/core/vitest.config.ts"))
      .toEqual(["packages/core/test/agent-context-cli.test.ts"]);
  });
  it("reports cheap failures before package builds and still retains the build failure", async () => {
    const calls: string[] = [];
    mockChildProcesses((command, args) => {
      const call = `${command} ${(args ?? []).join(" ")}`; calls.push(call);
      let stdout = ""; let status = 0;
      if (command === "git") {
        if (args?.includes("--show-toplevel")) stdout = process.cwd();
        else if (args?.includes("merge-base")) stdout = "a".repeat(40);
      } else if (call.includes("ast-grep")) { stdout = "planted structural fault"; status = 1; }
      else if (call.includes("public-ci-neutrality")) { stdout = '"scripts/example.ts": brand increased 0 -> 1'; status = 1; }
      else if (call === "npm run prelint") { stdout = "broken package build"; status = 9; }
      else if (command === "gitleaks") return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("missing"), { code: "ENOENT" }) };
      return { status, stdout, stderr: "" };
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await main(now)).toBe(1);
    const build = calls.indexOf("npm run prelint");
    expect(build).toBeGreaterThan(calls.findIndex((call) => call.includes("ast-grep")));
    expect(build).toBeGreaterThan(calls.findIndex((call) => call.includes("public-ci-neutrality")));
    expect(log.mock.calls.flat().join("\n")).toContain("FAIL typecheck: package build (npm run prelint) failed");
    expect(calls.some((call) => call.includes("--typecheck"))).toBe(false);
  });

  it("runs ast-grep hygiene, skips eslint/sql when inapplicable, and stops on hygiene failures", async () => {
    const runWith = async (options: { filewideFail?: boolean; ruleTestsFail?: boolean; nameStatus?: string }) => {
      const calls: string[] = [];
      mockChildProcesses((command, args) => {
        const call = `${command} ${(args ?? []).join(" ")}`;
        calls.push(call);
        if (command === "git") {
          if (args?.includes("--show-toplevel")) return { status: 0, stdout: process.cwd(), stderr: "" };
          if (args?.includes("merge-base")) return { status: 0, stdout: "a".repeat(40), stderr: "" };
          if (args?.includes("--name-status")) return { status: 0, stdout: options.nameStatus ?? "", stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        }
        if (call.includes("check-filewide-ignore.mjs") && options.filewideFail) {
          return { status: 1, stdout: "", stderr: "scripts/bad.ts:1: first-line ast-grep-ignore" };
        }
        if (call.includes("ast-grep test --skip-snapshot-tests") && options.ruleTestsFail) {
          return { status: 1, stdout: "", stderr: "FAIL domain-no-country-literals" };
        }
        if (command === "gitleaks") return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("missing"), { code: "ENOENT" }) };
        return { status: 0, stdout: "", stderr: "" };
      });
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((value) => { lines.push(String(value)); });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const exit = await main(now);
      return { exit, calls, lines };
    };

    const clean = await runWith({ nameStatus: "M\0README.md\0D\0scripts/removed.ts\0" });
    expect(clean.exit).toBe(0);
    expect(clean.calls).toContain(`${process.execPath} scripts/ast-grep/check-filewide-ignore.mjs`);
    expect(clean.calls).toContain("npx --no -- ast-grep test --skip-snapshot-tests");
    expect(clean.calls.some((call) => call.includes("eslint"))).toBe(false);
    expect(clean.calls.some((call) => call.includes("sql:admit"))).toBe(false);
    expect(clean.lines).toContainEqual(expect.stringMatching(/^PASS ast-grep hygiene: /u));
    expect(clean.lines).toContainEqual("SKIP eslint changed: no changed JS/TS files");
    expect(clean.lines).toContainEqual("SKIP sql admit: no SQL under db/ or packages/*/sql/ changed");

    const filewideFail = await runWith({ filewideFail: true });
    expect(filewideFail.exit).toBe(1);
    expect(filewideFail.calls.some((call) => call.includes("ast-grep test"))).toBe(false);
    expect(filewideFail.lines).toContainEqual(expect.stringMatching(/^FAIL ast-grep hygiene: file-wide ast-grep-ignore check failed/u));

    const ruleTestFail = await runWith({ ruleTestsFail: true });
    expect(ruleTestFail.exit).toBe(1);
    expect(ruleTestFail.lines).toContainEqual(expect.stringMatching(/^FAIL ast-grep hygiene: ast-grep rule tests failed/u));
  });

  it("lints only changed non-deleted JS/TS files with eslint before typecheck", async () => {
    const runEslint = async (eslintExit: number) => {
      const calls: string[] = [];
      mockChildProcesses((command, args) => {
        const call = `${command} ${(args ?? []).join(" ")}`;
        calls.push(call);
        if (command === "git") {
          if (args?.includes("--show-toplevel")) return { status: 0, stdout: process.cwd(), stderr: "" };
          if (args?.includes("merge-base")) return { status: 0, stdout: "a".repeat(40), stderr: "" };
          if (args?.includes("--name-status")) return { status: 0, stdout: "M\0scripts/a.ts\0A\0src/b.tsx\0D\0scripts/deleted.ts\0M\0docs/guide.md\0", stderr: "" };
          if (args?.includes("--others")) return { status: 0, stdout: "scripts/untracked.mjs\0", stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        }
        if (command === "npx" && args?.includes("eslint")) return { status: eslintExit, stdout: eslintExit === 0 ? "" : "lint error", stderr: "" };
        if (command === "gitleaks") return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("missing"), { code: "ENOENT" }) };
        return { status: 0, stdout: "", stderr: "" };
      });
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((value) => { lines.push(String(value)); });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const exit = await main(now);
      return { exit, calls, lines };
    };

    const pass = await runEslint(0);
    expect(pass.exit).toBe(0);
    const eslintCall = pass.calls.indexOf("npx --no -- eslint -- scripts/a.ts src/b.tsx scripts/untracked.mjs");
    expect(eslintCall).toBeGreaterThan(-1);
    expect(eslintCall).toBeLessThan(pass.calls.indexOf("npm run prelint"));
    expect(pass.lines).toContainEqual(expect.stringMatching(/^PASS eslint changed: 3 changed file\(s\) passed eslint/u));

    const fail = await runEslint(1);
    expect(fail.exit).toBe(1);
    expect(fail.lines).toContainEqual("FAIL eslint changed: eslint failed on 3 changed file(s)");
  });

  it("handles sql admit across dirty, untracked, passing and failing SQL changes", async () => {
    const runSql = async (options: { baseDiff: string; status?: string; untracked?: string; admitCode?: number }) => {
      vi.stubEnv("OPENLUP_PREFLIGHT_NO_CACHE", "1");
      const calls: string[] = [];
      mockChildProcesses((command, args) => {
        const call = `${command} ${(args ?? []).join(" ")}`;
        calls.push(call);
        if (command === "git") {
          if (args?.includes("--show-toplevel")) return { status: 0, stdout: process.cwd(), stderr: "" };
          if (args?.includes("merge-base")) return { status: 0, stdout: "a".repeat(40), stderr: "" };
          if (args?.[0] === "status") return { status: 0, stdout: options.status ?? "", stderr: "" };
          if (args?.includes("--name-status")) return { status: 0, stdout: options.baseDiff, stderr: "" };
          if (args?.includes("--others")) return { status: 0, stdout: options.untracked ?? "", stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        }
        if (call === "npm run sql:admit") return { status: options.admitCode ?? 0, stdout: options.admitCode ? "REFUSED migration" : "PASS", stderr: "" };
        if (command === "docker") return { status: 1, stdout: "", stderr: "" };
        if (command === "gitleaks") return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("missing"), { code: "ENOENT" }) };
        return { status: 0, stdout: "", stderr: "" };
      });
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((value) => { lines.push(String(value)); });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const exit = await main(now);
      return { exit, calls, lines };
    };

    const sqlPath = "db/platform/migrations/20400101000000_example.sql";
    const dirtyTracked = await runSql({ baseDiff: `A\0${sqlPath}\0`, status: ` M ${sqlPath}\0` });
    expect(dirtyTracked.exit).toBe(0);
    expect(dirtyTracked.calls).not.toContain("npm run sql:admit");
    expect(dirtyTracked.lines).toContainEqual("WARN sql admit: commit or stash uncommitted changes to run npm run sql:admit");

    const dirtyUntracked = await runSql({ baseDiff: "", untracked: `${sqlPath}\0`, status: `?? ${sqlPath}\0` });
    expect(dirtyUntracked.exit).toBe(0);
    expect(dirtyUntracked.calls).not.toContain("npm run sql:admit");
    expect(dirtyUntracked.lines).toContainEqual("WARN sql admit: commit or stash uncommitted changes to run npm run sql:admit");

    const dirtyNonSql = await runSql({ baseDiff: `A\0${sqlPath}\0`, status: " M README.md\0" });
    expect(dirtyNonSql.exit).toBe(0);
    expect(dirtyNonSql.calls).not.toContain("npm run sql:admit");
    expect(dirtyNonSql.lines).toContainEqual("WARN sql admit: commit or stash uncommitted changes to run npm run sql:admit");

    const committedPass = await runSql({ baseDiff: `A\0${sqlPath}\0`, admitCode: 0 });
    expect(committedPass.exit).toBe(0);
    expect(committedPass.calls).toContain("npm run sql:admit");
    expect(committedPass.lines).toContainEqual(expect.stringMatching(/^PASS sql admit: SQL admission passed/u));

    const committedFail = await runSql({ baseDiff: `A\0${sqlPath}\0`, admitCode: 1 });
    expect(committedFail.exit).toBe(1);
    expect(committedFail.lines).toContainEqual("FAIL sql admit: npm run sql:admit exited 1");
  });

  it("caches clean local inventory measurements, bypasses cache in CI, and preserves dirty WARN", async () => {
    const cacheFile = join(process.cwd(), ".context/scratch/inventory-cache.json");
    const priorCache = existsSync(cacheFile) ? readFileSync(cacheFile, "utf8") : null;
    try {
      rmSync(cacheFile, { force: true });
      const runInventoryCase = async (options: { ci?: string; dirtyInventory?: boolean }) => {
        if (options.ci !== undefined) vi.stubEnv("CI", options.ci);
        else vi.stubEnv("CI", "");
        const calls: string[] = [];
        mockChildProcesses((command, args) => {
          const call = `${command} ${(args ?? []).join(" ")}`;
          calls.push(call);
          if (command === "git") {
            if (args?.includes("--show-toplevel")) return { status: 0, stdout: process.cwd(), stderr: "" };
            if (args?.includes("merge-base")) return { status: 0, stdout: "a".repeat(40), stderr: "" };
            if (args?.includes("--name-status")) return { status: 0, stdout: "A\0db/platform/migrations/20400101000000_example.sql\0", stderr: "" };
            if (args?.[0] === "status" && args.includes("tests/postgres/current-installation-inventory.json")) {
              return { status: 0, stdout: options.dirtyInventory ? " M tests/postgres/current-installation-inventory.json\n" : "", stderr: "" };
            }
            return { status: 0, stdout: "", stderr: "" };
          }
          if (command === "gitleaks") return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("missing"), { code: "ENOENT" }) };
          return { status: 0, stdout: "", stderr: "" };
        });
        const lines: string[] = [];
        vi.spyOn(console, "log").mockImplementation((value) => { lines.push(String(value)); });
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const exit = await main(now);
        return { exit, calls, lines };
      };

      const first = await runInventoryCase({});
      expect(first.exit).toBe(0);
      expect(first.calls).toContain("npm run inventory:refresh");
      expect(existsSync(cacheFile)).toBe(true);
      expect(JSON.parse(readFileSync(cacheFile, "utf8"))).toEqual({ digest: inventoryClosureDigest() });

      const cachedClean = await runInventoryCase({});
      expect(cachedClean.exit).toBe(0);
      expect(cachedClean.calls).not.toContain("npm run inventory:refresh");
      expect(cachedClean.lines).toContainEqual(expect.stringMatching(/^PASS inventory: .*cached clean measurement/u));

      const cachedDirty = await runInventoryCase({ dirtyInventory: true });
      expect(cachedDirty.exit).toBe(0);
      expect(cachedDirty.calls).not.toContain("npm run inventory:refresh");
      expect(cachedDirty.lines).toContainEqual(expect.stringMatching(/^WARN inventory: .*not committed/u));

      const ciBypass = await runInventoryCase({ ci: "true" });
      expect(ciBypass.exit).toBe(0);
      expect(ciBypass.calls).toContain("npm run inventory:refresh");

      writeFileSync(cacheFile, "{not-valid-json", "utf8");
      const corruptCache = await runInventoryCase({});
      expect(corruptCache.exit).toBe(0);
      expect(corruptCache.calls).toContain("npm run inventory:refresh");

      writeFileSync(cacheFile, JSON.stringify({ digest: "stale-digest" }), "utf8");
      const staleCache = await runInventoryCase({});
      expect(staleCache.exit).toBe(0);
      expect(staleCache.calls).toContain("npm run inventory:refresh");
    } finally {
      if (priorCache === null) rmSync(cacheFile, { force: true });
      else writeFileSync(cacheFile, priorCache, "utf8");
    }
  });

  it("reports packages/platform release-gates headroom PASS, WARN (<10% or unreadable), SKIP (failed typecheck) and FAIL (>cap)", async () => {
    const gates = JSON.parse(readFileSync("packages/platform/release-gates.json", "utf8")) as {
      pack: { maxFiles: number; maxUnpackedBytes: number };
    };
    const runHeadroom = async (options: { packStdout?: string; failTypecheck?: boolean }) => {
      const packArgs: string[][] = [];
      mockChildProcesses((command, args) => {
        if (command === "git") {
          if (args?.includes("--show-toplevel")) return { status: 0, stdout: process.cwd(), stderr: "" };
          if (args?.includes("merge-base")) return { status: 0, stdout: "a".repeat(40), stderr: "" };
          if (args?.includes("--name-status")) return { status: 0, stdout: "M\0packages/platform/sql/20400101000000_example.sql\0", stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        }
        if (options.failTypecheck && command === "npm" && args?.[0] === "run" && args?.[1] === "prelint") {
          return { status: 1, stdout: "", stderr: "prelint failed" };
        }
        if (command === "npm" && args?.[0] === "pack") {
          packArgs.push([...args]);
          return { status: 0, stdout: options.packStdout ?? "[]", stderr: "" };
        }
        if (command === "docker") return { status: 1, stdout: "", stderr: "" };
        if (command === "gitleaks") return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("missing"), { code: "ENOENT" }) };
        return { status: 0, stdout: "", stderr: "" };
      });
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((value) => { lines.push(String(value)); });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const exit = await main(now);
      return { exit, lines, packArgs };
    };

    const ok = await runHeadroom({
      packStdout: JSON.stringify([{ entryCount: Math.floor(gates.pack.maxFiles * 0.5), unpackedSize: Math.floor(gates.pack.maxUnpackedBytes * 0.5) }]),
    });
    expect(ok.exit).toBe(0);
    expect(ok.packArgs).toEqual([["pack", "--dry-run", "--json", "--ignore-scripts", "--workspaces=false"]]);
    expect(ok.lines).toContainEqual(expect.stringMatching(/^PASS release-gates headroom: /u));

    const warn = await runHeadroom({
      packStdout: JSON.stringify([{ entryCount: Math.ceil(gates.pack.maxFiles * 0.95), unpackedSize: Math.floor(gates.pack.maxUnpackedBytes * 0.5) }]),
    });
    expect(warn.exit).toBe(0);
    expect(warn.lines).toContainEqual(expect.stringMatching(/^WARN release-gates headroom: packages\/platform pack headroom under 10%/u));

    const unreadable = await runHeadroom({ packStdout: "> prepack banner\nnot json" });
    expect(unreadable.exit).toBe(0);
    expect(unreadable.lines).toContainEqual("WARN release-gates headroom: npm pack --json --dry-run output unreadable");

    const skipped = await runHeadroom({ failTypecheck: true });
    expect(skipped.exit).toBe(1);
    expect(skipped.packArgs).toEqual([]);
    expect(skipped.lines).toContainEqual("SKIP release-gates headroom: typecheck build did not complete");

    const fail = await runHeadroom({
      packStdout: JSON.stringify([{ entryCount: gates.pack.maxFiles + 1, unpackedSize: Math.floor(gates.pack.maxUnpackedBytes * 0.5) }]),
    });
    expect(fail.exit).toBe(1);
    expect(fail.lines).toContainEqual(expect.stringMatching(/^FAIL release-gates headroom: packages\/platform pack budget exceeded/u));
  });

  it("distinguishes undiscovered tests from confirmed separate suites and discovered files", () => {
    const report = testDiscoveryVerdict({ files: ["scripts/collected.test.ts"],
      separate: [{ path: "packages/core/test/separate.test.ts", command: "owning discovery command" }],
      unknown: ["scripts/misnamed.test.tsx", "tests/unowned/new.test.ts"] });
    expect(report).toMatchObject({ check: "test discovery", status: "WARN" });
    expect(report.detail).toContain("execution remains missing proof");
    expect(report.notes?.join("\n")).toContain("check the suffix/location");
    expect(report.notes?.join("\n")).toContain("separate runner confirmed");
    expect(testDiscoveryVerdict({ files: ["scripts/collected.test.ts"], separate: [], unknown: [] })).toMatchObject({ status: "PASS" });
    expect(testDiscoveryVerdict({ files: [], separate: [], unknown: [] })).toMatchObject({ status: "SKIP" });
  });

  it("uses actual discovery results for package and browser ownership without executing their tests", () => {
    const commands: string[] = [];
    vi.mocked(spawnSync).mockImplementation(((command, args) => {
      commands.push(`${command} ${(args ?? []).join(" ")}`);
      if (command === "git") return { status: 0, stdout: "vitest.config.ts\0packages/core/vitest.config.ts\0playwright.checkout.config.ts\0", stderr: "" };
      if (args?.includes("vitest")) {
        const output = args.find((arg) => arg.startsWith("--json="))!.slice("--json=".length);
        writeFileSync(output, JSON.stringify([{ file: `${process.cwd()}/packages/core/test/separate.test.ts` }]));
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: JSON.stringify({ config: { rootDir: `${process.cwd()}/tests/preview/checkout` }, suites: [{ file: "journey.spec.ts" }] }), stderr: "" };
    }) as typeof spawnSync);
    const candidates = ["packages/core/test/separate.test.ts", "packages/core/test/misnamed.test.tsx", "tests/preview/checkout/journey.spec.ts", "tests/unowned/new.test.ts"];
    expect(separateTestFiles(candidates).map(({ path }) => path)).toEqual(["packages/core/test/separate.test.ts", "tests/preview/checkout/journey.spec.ts"]);
    expect(commands.filter((command) => command.includes("npx")).every((command) => command.includes(" list ") || command.includes(" --list "))).toBe(true);
    expect(commands.join("\n")).not.toContain("npm test");
  });

  it("keeps a separate runner's unavailable setup explicit as unconfirmed discovery", () => {
    vi.mocked(spawnSync).mockImplementation(((command) => command === "git"
      ? { status: 0, stdout: "playwright.checkout.config.ts\0", stderr: "" }
      : { status: 1, stdout: "", stderr: "owned profile setup required" }) as typeof spawnSync);
    expect(separateTestFiles(["tests/preview/checkout/journey.spec.ts"])).toEqual([]);
  });
  it("prints one status line per check", () => {
    expect(formatCheckLine({ check: "typecheck", status: "PASS", detail: "the tree compiles to its signed debt. (27 s)" }))
      .toBe("PASS typecheck: the tree compiles to its signed debt. (27 s)");
    expect(formatCheckLine({ check: "gitleaks", status: "SKIP", detail: "gitleaks is not on PATH", notes: ["ignored"] }))
      .toBe("SKIP gitleaks: gitleaks is not on PATH");
    expect(formatCheckLine({ check: "fragments", status: "WARN", detail: "x" })).toBe("WARN fragments: x");
    expect(formatCheckLine({ check: "hosted tests", status: "FAIL", detail: "y" })).toBe("FAIL hosted tests: y");
  });

  it("turns the neutrality ratchet's exit and output into one check line", () => {
    expect(neutralityVerdict(0, "Neutrality: 7410 text files, 57 binary files inventoried; 0 increases.", 12))
      .toEqual({ check: "neutrality", status: "PASS", detail: "no neutrality count increase against the fork point (12 s)" });
    // The ratchet can report one raised category twice; the line lists it once.
    const raised = ['"scripts/a.ts": ui-9 increased 0 -> 1', '"scripts/b.mjs": brand increased 2 -> 3', '"scripts/a.ts": ui-9 increased 0 -> 1',
      "Neutrality: 7416 text files, 57 binary files inventoried; 3 increases."].join("\n");
    expect(neutralityVerdict(1, raised, 13)).toEqual({
      check: "neutrality", status: "FAIL",
      detail: "2 neutrality count increase(s) against the fork point; the required self-check job refuses them (13 s)",
      notes: ['"scripts/a.ts": ui-9 increased 0 -> 1', '"scripts/b.mjs": brand increased 2 -> 3'],
    });
    expect(neutralityVerdict(1, "\nbaseline scanner pin drift: \"packages/ui/smoke/neutrality.ts\"\n", 2)).toEqual({
      check: "neutrality", status: "FAIL", detail: "the neutrality ratchet failed (2 s)", notes: ['baseline scanner pin drift: "packages/ui/smoke/neutrality.ts"'],
    });
  });

  it("reads name-status output with deletions and unusual names", () => {
    expect(parseNameStatus("M\0a b.ts\0D\0old.sql\0A\0new\ttab.ts\0")).toEqual([
      { path: "a b.ts", deleted: false }, { path: "old.sql", deleted: true }, { path: "new\ttab.ts", deleted: false },
    ]);
    expect(parseNameStatus("")).toEqual([]);
  });
});

describe("change-set triggers", () => {
  it("triggers the inventory refresh only for migration and package SQL", () => {
    expect(sqlTreeChanges([...changed(
      "db/platform/migrations/20400101000000_example.sql",
      "db/bootstrap/vanilla-pg/roles.sql",
      "packages/platform/sql/subscriptions/example.sql",
      "supabase/tests/example_test.sql",
      "scripts/fixtures/reviewed-m10/example.sql",
      "tests/postgres/managed-compat/adapter.sql",
      "db/platform/README.md",
    ), { path: "db/platform/migrations/20400101000001_removed.sql", deleted: true }])).toEqual([
      "db/platform/migrations/20400101000000_example.sql",
      "db/bootstrap/vanilla-pg/roles.sql",
      "packages/platform/sql/subscriptions/example.sql",
      "db/platform/migrations/20400101000001_removed.sql",
    ]);
  });

  it("asks for a fragment per released package whose source changed", () => {
    expect(missingFragments(changed("packages/platform/src/index.ts", "packages/core/src/a.ts", "packages/core/test/a.test.ts")))
      .toEqual(["packages/core", "packages/platform"]);
    expect(missingFragments(changed("packages/platform/src/index.ts", "packages/platform/changes/example.md"))).toEqual([]);
    // A fragment for another package, a nested path, another extension or a deleted fragment does not count.
    expect(missingFragments([...changed("packages/outbox/src/a.ts", "packages/core/changes/example.md",
      "packages/outbox/changes/nested/example.md", "packages/outbox/changes/example.txt"),
    { path: "packages/outbox/changes/old.md", deleted: true }])).toEqual(["packages/outbox"]);
    // Unreleased packages and non-source paths take no fragment.
    expect(missingFragments(changed("packages/ui/src/index.ts", "packages/platform/README.md", "src/app.ts"))).toEqual([]);
    expect(releasedPackageSource("packages/outbox/src/a.ts")).toBe("packages/outbox");
    expect(releasedPackageSource("packages/ui/src/index.ts")).toBeUndefined();
    expect(releasedPackageSource("packages/platform/test/a.test.ts")).toBeUndefined();
  });

  it("classifies test entries and test-directory helpers", () => {
    for (const path of ["scripts/a.test.ts", "src/b.spec.tsx", "packages/core/test/c.test.mjs", "tests/postgres/cases.ts", "packages/platform/test/helpers/fixture.ts"]) {
      expect(isTestFile(path)).toBe(true);
    }
    for (const path of ["scripts/preflight.ts", "tests/postgres/inventory.json", "supabase/tests/example_test.sql", "docs/testing.md"]) {
      expect(isTestFile(path)).toBe(false);
    }
    expect(isTestEntry("tests/postgres/cases.ts")).toBe(false);
    expect(isTestEntry("scripts/a.test.ts")).toBe(true);
  });

  it("reads added lines with their new line numbers from a zero-context diff", () => {
    const diff = [
      "diff --git a/x.test.ts b/x.test.ts", "index 1..2 100644", "--- a/x.test.ts", "+++ b/x.test.ts",
      "@@ -3 +3 @@ describe", "-old", "+new", "@@ -10,0 +11,2 @@", "+first", "++second", "\\ No newline at end of file",
    ].join("\n");
    expect(addedLines("x.test.ts", diff)).toEqual([
      { path: "x.test.ts", line: 3, text: "new" },
      { path: "x.test.ts", line: 11, text: "first" },
      { path: "x.test.ts", line: 12, text: "+second" },
    ]);
  });
});

describe("dates near the injected clock", () => {
  it("warns within 400 days either side, inclusive", () => {
    expect(nearDates(line('const at = "2040-03-01T10:00:00Z";'), now)).toEqual([
      { path: "scripts/example.test.ts", line: 7, text: 'const at = "2040-03-01T10:00:00Z";', reason: "2040-03-01 within 400 days of now" },
    ]);
    expect(nearDates(line("2041-02-04 and 2038-11-27"), now)[0]?.reason).toBe("2041-02-04, 2038-11-27 within 400 days of now");
    expect(nearDates(line("2041-02-05 2038-11-26"), now)).toEqual([]);
  });

  it("ignores far dates, impossible dates and non-date digit runs", () => {
    for (const text of ["2001-02-03T04:05:06Z", "9999-12-31", "2040-02-30", "v2040-01-02", "2040-01-02-suffix", "20400102", "1.2040-01-02", "id 2040-12ab"]) {
      expect(nearDates(line(text), now)).toEqual([]);
    }
  });
});

describe("short expiries", () => {
  it.each([
    ["new SignJWT({}).setExpirationTime('5m')", "setExpirationTime 300 s"],
    ['sign(payload, key, { expiresIn: "60s" })', "expiresIn 60 s"],
    ["{ ttl: 300 }", "ttl 300 s"],
    ['"expires_in": 30,', "expires_in 30 s"],
    ["cacheTtlMs: 30_000,", "cacheTtlMs 30 s"],
    ["const TTL_SECONDS = 60;", "TTL_SECONDS 60 s"],
    ["maxAge: 9 * 60,", "maxAge 540 s"],
    ["cookieMaxAge: '2 minutes'", "cookieMaxAge 120 s"],
    ["expiresInMs: 500", "expiresInMs 0.5 s"],
  ])("warns on %s", (text, reason) => {
    expect(shortExpiries(line(text))[0]?.reason).toBe(`${reason} under 600 s`);
  });

  it.each([
    "setExpirationTime('2h')", "expiresIn: '10 minutes'", "ttl: 600,", "ttlMs: 15 * 60 * 1000,", "maxAge: 0,",
    "maxAge: 5 * MINUTE,", "settle: 5,", "subtitle: 3,", "expiresAt: Date.now() + 1000,", "ttl: '5 parsecs'",
    // A bare number followed by text is not evaluated.
    "token_expiry = 1500 ms",
  ])("does not warn on %s", (text) => {
    expect(shortExpiries(line(text))).toEqual([]);
  });
});

describe("shift-left preflight guards and --affected discovery", () => {
  it("triggers client-secret-boundary and site-routes guards on their actual scanned inputs", () => {
    for (const path of [
      "src/pages/Home.tsx",
      "server/adapters/postgres/connectedStoreRestore.ts",
      "api/health.ts",
      "config/environment-variables.json",
      "scripts/check-client-secret-boundary.ts",
    ]) {
      expect(CLIENT_SECRET_BOUNDARY_TRIGGER.test(path), path).toBe(true);
    }
    for (const path of ["packages/core/src/index.ts", "docs/platform/README.md"]) {
      expect(CLIENT_SECRET_BOUNDARY_TRIGGER.test(path), path).toBe(false);
    }

    for (const path of [
      "config/site-routes.json",
      "config/public-reference-site-routes.json",
      "scripts/site-routes.mjs",
    ]) {
      expect(SITE_ROUTES_TRIGGER.test(path), path).toBe(true);
    }
    for (const path of ["src/App.tsx", "server/adapters/postgres/connectedStoreRestore.ts"]) {
      expect(SITE_ROUTES_TRIGGER.test(path), path).toBe(false);
    }
  });

  it("executes eslint-changed (with offlineNpm), client-secret-boundary, and site-routes in --fast and surfaces PASS/FAIL", async () => {
    vi.stubEnv("npm_execpath", join(process.cwd(), "fixture-npm-cli.js"));
    const head = "a".repeat(40), fork = "b".repeat(40), upstream = "c".repeat(40);
    const runFastCase = async (failGuards: boolean) => {
      const seenCalls: Array<{ bin: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
      mockChildProcesses((bin, args, options) => {
        const list = [...(args ?? [])];
        const call = `${bin} ${list.join(" ")}`;
        seenCalls.push({ bin, args: list, env: options?.env });
        if (call === "git rev-parse --show-toplevel") return { status: 0, stdout: process.cwd(), stderr: "" };
        if (call === "git rev-parse HEAD") return { status: 0, stdout: head, stderr: "" };
        if (call === "git merge-base HEAD origin/main") return { status: 0, stdout: fork, stderr: "" };
        if (call === "git rev-parse origin/main") return { status: 0, stdout: upstream, stderr: "" };
        if (call === `git diff --name-status --no-renames -z ${fork} HEAD`) {
          return { status: 0, stdout: "M\0src/pages/Home.tsx\0M\0config/site-routes.json\0", stderr: "" };
        }
        if (bin === "gitleaks") {
          return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("missing"), { code: "ENOENT" }) };
        }
        if (bin === "npx" && list.includes("eslint")) {
          expect(options?.env).toMatchObject({ npm_config_offline: "true", npm_config_update_notifier: "false" });
          return failGuards
            ? { status: 1, stdout: "src/pages/Home.tsx:1:1 error no-unused-vars\n", stderr: "" }
            : { status: 0, stdout: "", stderr: "" };
        }
        if (bin === process.execPath && list.includes("scripts/check-client-secret-boundary.ts")) {
          expect(options?.env).toMatchObject({ npm_config_offline: "true", npm_config_update_notifier: "false" });
          return failGuards
            ? { status: 1, stdout: "", stderr: "src/pages/Home.tsx:2: client secret boundary violation fixture\n" }
            : { status: 0, stdout: "Client secret boundary guard passed.\n", stderr: "" };
        }
        if (bin === process.execPath && list.includes("scripts/site-routes.mjs")) {
          expect(options?.env).toMatchObject({ npm_config_offline: "true", npm_config_update_notifier: "false" });
          return failGuards
            ? { status: 1, stdout: "", stderr: "Error: Invalid site lifecycle\n" }
            : { status: 0, stdout: "site routes hold: public-reference, 2 route(s)\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      });
      const signed = "change\n\nSigned-off-by: Test Fixture <fixture@example.invalid>";
      vi.mocked(execFileSync).mockReturnValue(`${head}\x1f${fork}\x1f${signed}\0`);
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((value) => { lines.push(String(value)); });
      vi.spyOn(console, "error").mockImplementation(() => {});
      const exit = await main(now, ["--fast"]);
      return { exit, lines, seenCalls };
    };

    const pass = await runFastCase(false);
    expect(pass.exit).toBe(0);
    expect(pass.lines).toContain("eslint-changed: ok");
    expect(pass.lines).toContain("client-secret-boundary: ok");
    expect(pass.lines).toContain("site-routes: ok");
    expect(pass.seenCalls.some(({ bin, args }) => bin === "npx" && args.includes("eslint") && args.includes("src/pages/Home.tsx"))).toBe(true);
    expect(pass.seenCalls.some(({ bin, args }) => bin === process.execPath && args.includes("scripts/check-client-secret-boundary.ts"))).toBe(true);
    expect(pass.seenCalls.some(({ bin, args }) => bin === process.execPath && args.includes("scripts/site-routes.mjs") && args.includes("--public-reference"))).toBe(true);

    const fail = await runFastCase(true);
    expect(fail.exit).toBe(1);
    expect(JSON.parse(fail.lines.at(-1)!)).toEqual({
      preflight: "fast",
      result: "fail",
      head,
      failed: ["eslint-changed", "client-secret-boundary", "site-routes"],
    });
    expect(fail.lines.some((line) => line.includes("no-unused-vars"))).toBe(true);
    expect(fail.lines.some((line) => line.includes("client secret boundary violation fixture"))).toBe(true);
    expect(fail.lines.some((line) => line.includes("Invalid site lifecycle"))).toBe(true);
  });

  it("discovers reverse-import affected tests and pins contract tests on deleted migrations via affectedTestCandidates", () => {
    const candidates = affectedTestCandidates(changed("scripts/ci-vitest-shard.mjs"));
    expect(candidates).toContain("scripts/ci-vitest-shard.test.ts");
    const deletedMigration = affectedTestCandidates([{ path: "db/platform/migrations/20261121000000_example.sql", deleted: true }]);
    expect(deletedMigration).toContain("scripts/platform-migration-manifest.test.ts");
    expect(deletedMigration).toContain("scripts/sql-admit.test.ts");
    expect(affectedTestCandidates([{ path: "scripts/deleted-only.test.ts", deleted: true }])).toEqual([]);
  });

  it("runs --affected end-to-end through discoverTests and scripts/test-hosted.mjs (skip, pass, and fail exit propagation)", async () => {
    const fork = "b".repeat(40);
    const runAffected = async (diffStdout: string, hostedExit: number) => {
      const hostedCalls: string[][] = [];
      mockChildProcesses((bin, args) => {
        const list = [...(args ?? [])];
        const call = `${bin} ${list.join(" ")}`;
        if (call === "git rev-parse --show-toplevel") return { status: 0, stdout: process.cwd(), stderr: "" };
        if (call === "git merge-base HEAD origin/main") return { status: 0, stdout: fork, stderr: "" };
        if (call === "git ls-files --others --exclude-standard -z") return { status: 0, stdout: "", stderr: "" };
        if (call === `git diff --name-status --no-renames -z ${fork}`) return { status: 0, stdout: diffStdout, stderr: "" };
        if (bin === "gitleaks") return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("missing"), { code: "ENOENT" }) };
        if (bin === "npx" && list.includes("vitest") && list.includes("list")) {
          const jsonArg = list.find((arg) => arg.startsWith("--json="));
          const files = list.filter((arg) => arg.endsWith(".test.ts"));
          if (jsonArg) {
            writeFileSync(jsonArg.slice("--json=".length), JSON.stringify(files.map((file) => ({ file: join(process.cwd(), file) }))));
          }
          return { status: 0, stdout: "", stderr: "" };
        }
        if (bin === process.execPath && list[0] === "scripts/test-hosted.mjs") {
          hostedCalls.push(list);
          return { status: hostedExit, stdout: hostedExit === 0 ? "1 passed\n" : "1 failed\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      });
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((value) => { lines.push(String(value)); });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const exit = await main(now, ["--affected"]);
      return { exit, lines, hostedCalls };
    };

    const empty = await runAffected("M\0docs/platform/README.md\0", 0);
    expect(empty.exit).toBe(0);
    expect(empty.hostedCalls).toEqual([]);
    expect(empty.lines.some((line) => line.startsWith("SKIP hosted tests:"))).toBe(true);

    const passed = await runAffected("M\0scripts/ci-vitest-shard.mjs\0", 0);
    expect(passed.lines.filter((line) => line.startsWith("FAIL"))).toEqual([]);
    expect(passed.exit).toBe(0);
    expect(passed.hostedCalls).toEqual([["scripts/test-hosted.mjs", "scripts/ci-vitest-shard.test.ts"]]);
    expect(passed.lines.some((line) => line.startsWith("PASS hosted tests: 1 file(s) passed"))).toBe(true);

    const failed = await runAffected("M\0scripts/ci-vitest-shard.mjs\0", 1);
    expect(failed.exit).toBe(1);
    expect(failed.hostedCalls).toEqual([["scripts/test-hosted.mjs", "scripts/ci-vitest-shard.test.ts"]]);
    expect(failed.lines.some((line) => line.startsWith("FAIL hosted tests:"))).toBe(true);
  });

  it("refuses mutually exclusive --fast, --area, and --affected combinations", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(now, ["--fast", "--affected"])).toBe(2);
    expect(await main(now, ["--area", "--affected"])).toBe(2);
    expect(stderr).toHaveBeenCalledTimes(2);
  });
});
