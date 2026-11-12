import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { env } from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { needsForwardApproval } from "./agent-review-queue.mjs";
import { assertAppendOnlyMigrationHistory } from "./oss-published-tree-check.ts";
import { assertAdmittedPlatformForward } from "./oss-source-release-contract.ts";
import { PLATFORM_BASELINE_FILE, PLATFORM_MIGRATION_MANIFEST, sha256 } from "./platform-migration-manifest.ts";
import { assertCoLocatedForwardApproval, readReviewedForwardRegistry, REVIEWED_FORWARD_PATH, sqlSha256, type NativeStoreSlot, type ReviewedForwardRegistry } from "./reviewed-platform-forward.ts";
import { admissionRuleFiles, capabilityHint } from "./sql-admit.ts";

const CLI = resolve("scripts/sql-admit.ts");
const MANAGED_BASELINE = "supabase/migrations/00000000000000_platform_schema_baseline.sql";
const RAILS = ["db/platform/migrations/", "supabase/migrations/"];
const production = readReviewedForwardRegistry(readFileSync(REVIEWED_FORWARD_PATH));
const baseline = readFileSync("scripts/fixtures/reviewed-native-store/before.sql", "utf8");
const encode = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const slot = (path: string, row = "Future"): NativeStoreSlot => ({ row, path, replacedFunctions: [], createdFunctions: [], grantOnlyFunctions: [], dataStatements: [] });
const manifest = (forward: { file: string; sha256: string }[]) =>
  encode({ schemaVersion: 1, baseline: { file: PLATFORM_BASELINE_FILE, sha256: sha256(baseline) }, forward, objectInventorySha256: "0".repeat(64) });
// An independent synthetic registry, as in the native store witness: an empty sealed class and no issued qualified approval.
function registry(): ReviewedForwardRegistry {
  const value = structuredClone(production);
  delete value.portableReplacementForwards; delete value.portableCreationForwards; delete value.batchedForwards;
  delete value.managedCommerceForwards; delete value.supportAuthorityForwards; delete value.channelIngestForwards; delete value.qualifiedInstallations;
  value.nativeStoreForwardClass = { sealed: true, slots: [] }; value.nativeStoreForwards = [];
  return value;
}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
type Fixture = ReturnType<typeof fixture>;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openlup-sql-admit-fixture-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" }).trim();
  const put = (path: string, value: string | Buffer) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
  const commit = () => { git("add", "--all"); git("commit", "-qm", "SQL admission fixture"); return git("rev-parse", "HEAD"); };
  git("init", "-q", "-b", "main");
  put(PLATFORM_BASELINE_FILE, baseline); put(MANAGED_BASELINE, "-- Synthetic managed baseline.\n");
  put(PLATFORM_MIGRATION_MANIFEST, manifest([])); put(REVIEWED_FORWARD_PATH, encode(registry()));
  return { root, git, put, commit, base: commit() };
}
// Fixture bases hold no admission code, so the version check would refuse them; the stale-rules tests below cover that gate.
const STALE = "--allow-stale-rules";
function cli(root: string, args: string[], extra?: Record<string, string>) {
  return spawnSync(process.execPath, ["--experimental-strip-types", CLI, ...args], { cwd: root, encoding: "utf8", timeout: 60_000, ...(extra ? { env: { ...env, ...extra } } : {}) });
}
const verdictLines = (stdout: string) => stdout.split("\n").flatMap((line) => {
  const match = /^(PASS|REFUSED) +(.+?) \[(.+?)\](?:: (.*))?$/u.exec(line);
  return match ? [match[4] === undefined ? [match[1]!] : [match[1]!, match[4]]] : [];
});

// The underlying checks, called directly on the same commits: the self-check on main and the PR merge commit,
// then, when the queue's trigger applies, its guard on the PR's own fork point and on the merge-group head.
function directVerdicts(f: Fixture, base: string, head: string) {
  const fork = f.git("merge-base", base, head);
  const merge = f.git("commit-tree", f.git("merge-tree", "--write-tree", base, head).split("\n")[0]!, "-p", base, "-p", head, "-m", "Synthetic pull-request merge");
  f.git("checkout", "-q", "--detach", merge);
  const verdict = (action: () => void) => { try { action(); return ["PASS"]; } catch (error) { return ["REFUSED", (error as Error).message]; } };
  const added = f.git("diff", "--name-only", "--no-renames", "--diff-filter=A", base, merge, "--", ...RAILS).split("\n").filter((path) => path.endsWith(".sql"));
  const verdicts = added.map((path) => verdict(() => assertAdmittedPlatformForward(f.root, base, merge, path, readFileSync(join(f.root, path)))));
  verdicts.push(verdict(() => assertAppendOnlyMigrationHistory(f.root, base, merge)));
  if (!needsForwardApproval(f.git("diff", "--name-only", "--no-renames", fork, head).split("\n"))) verdicts.push(["PASS"]);
  else verdicts.push(verdict(() => assertCoLocatedForwardApproval(f.root, fork, head)), verdict(() => assertCoLocatedForwardApproval(f.root, base, merge)));
  return { verdicts, fork };
}

const nativePath = "db/platform/migrations/20271106100000_future.sql", nativeText = "CREATE TABLE public.future (id uuid);\n";
function stageNativeForward(f: Fixture) {
  const value = registry();
  value.nativeStoreForwardClass!.slots.push(slot(nativePath)); value.nativeStoreForwards!.push({ path: nativePath, sha256: sqlSha256(nativeText), functions: [] });
  f.put(REVIEWED_FORWARD_PATH, encode(value)); f.put(PLATFORM_MIGRATION_MANIFEST, manifest([{ file: nativePath, sha256: sha256(nativeText) }])); f.put(nativePath, nativeText);
}
type Case = { name: string; exit: number; refusal?: string; hint?: string; queue?: "not run"; build: (f: Fixture) => { base: string; head: string }; also?: (f: Fixture, base: string, head: string, fork: string) => void };
const cases: Case[] = [
  { name: "an admitted native forward with its slot, pin and manifest row", exit: 0, build: (f) => { stageNativeForward(f); return { base: f.base, head: f.commit() }; } },
  { name: "a replacement pin whose SQL this change does not introduce", exit: 1, refusal: "reviewed replacement pin must be approved separately unless its SQL is introduced in this PR",
    hint: "a separate approval PR", build: (f) => {
      const value = registry(); value.qualifiedInstallations = production.qualifiedInstallations!.slice(0, 4);
      f.put(REVIEWED_FORWARD_PATH, encode(value)); f.put("supabase/migrations/20271106100000_fixture.sql", "CREATE TABLE public.fixture (id uuid);\n");
      return { base: f.base, head: f.commit() };
    } },
  { name: "a new slot that is not later than every base migration", exit: 1, refusal: "reviewed native store new slot time must be later than every base migration",
    hint: "slot order", build: (f) => {
      const landed = "db/platform/migrations/20271106100000_landed.sql", text = "CREATE TABLE public.landed (id uuid);\n";
      f.put(landed, text); f.put(PLATFORM_MIGRATION_MANIFEST, manifest([{ file: landed, sha256: sha256(text) }])); const base = f.commit();
      const value = registry(); value.nativeStoreForwardClass!.slots.push(slot("db/platform/migrations/20271105100000_earlier.sql"));
      f.put(REVIEWED_FORWARD_PATH, encode(value)); return { base, head: f.commit() };
    } },
  { name: "a malformed registry slot", exit: 1, refusal: "reviewed native store slot path, row or order drifted", hint: "strict reader", build: (f) => {
    const value = registry(); value.nativeStoreForwardClass!.slots.push(slot(nativePath, "malformed row"));
    f.put(REVIEWED_FORWARD_PATH, encode(value)); return { base: f.base, head: f.commit() };
  } },
  { name: "an expand-only managed forward without a registry or reviewed-class change", exit: 0, queue: "not run", build: (f) => {
    f.put("supabase/migrations/20271106100000_fixture.sql", "CREATE TABLE public.fixture (id uuid);\n"); return { base: f.base, head: f.commit() };
  } },
  // Main changed a workflow after the fork. The queue reads the PR on its fork point; reading it on main would refuse it as machinery.
  { name: "a native forward on a branch behind a main that changed admission machinery", exit: 0, build: (f) => {
    f.git("switch", "-q", "-c", "feature"); stageNativeForward(f); const head = f.commit();
    f.git("switch", "-q", "main"); f.put(".github/workflows/fixture.yml", "name: fixture\n"); return { base: f.commit(), head };
  }, also: (f, base, head, fork) => {
    expect(fork).not.toBe(base);
    expect(() => assertCoLocatedForwardApproval(f.root, base, head)).toThrow("reviewed replacement admission machinery must be approved separately");
  } },
];

describe("sql:admit", () => {
  // The slowest case measured 4.8 s on a laptop at load average 5; the bound is four times that.
  it.each(cases)("reports the hosted verdict for $name", ({ exit, refusal, hint, queue, build, also }) => {
    const f = fixture(), { base, head } = build(f);
    const result = cli(f.root, ["--base", base, "--head", head, STALE]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(exit);
    expect(result.stdout).toContain("WARNING  admission code differs from");
    const reported = verdictLines(result.stdout), direct = directVerdicts(f, base, head);
    expect(reported).toEqual(direct.verdicts);
    also?.(f, base, head, direct.fork);
    if (queue) expect(result.stdout).toContain("PASS     co-located approval [queue: not run");
    if (refusal === undefined) expect(reported.every(([status]) => status === "PASS")).toBe(true);
    else {
      expect(reported.filter(([status]) => status === "REFUSED").map(([, message]) => message)).toEqual(expect.arrayContaining([expect.stringContaining(refusal)]));
      expect(result.stdout).toContain(`capability needed: ${capabilityHint(refusal)}`);
      expect(capabilityHint(refusal)).toContain(hint);
    }
  }, 20_000);

  // Measured 5.2 s on a laptop at load average 5; the bound is four times that.
  it("refuses admission code that differs from the base unless --allow-stale-rules is given", () => {
    const f = fixture();
    const linear = cli(f.root, ["--base", f.base, "--head", f.base]);
    expect(linear.status).toBe(2);
    expect(linear.stdout).toBe("");
    expect(linear.stderr).toContain("--allow-stale-rules");
    // A base that carries this checkout's exact admission code runs without a warning.
    const rules = admissionRuleFiles();
    expect(rules).toEqual(expect.arrayContaining(["scripts/agent-review-queue.mjs", "scripts/oss-published-tree-check.ts", "scripts/oss-source-release-contract.ts",
      "scripts/platform-migration-manifest.ts", "scripts/reviewed-platform-forward.ts", "scripts/sql-admit.ts"]));
    for (const path of rules) f.put(path, readFileSync(path));
    const current = f.commit();
    f.git("switch", "-q", "-c", "feature"); stageNativeForward(f); const head = f.commit();
    const fresh = cli(f.root, ["--base", current, "--head", head]);
    expect(fresh.stderr).toBe(""); expect(fresh.status).toBe(0); expect(fresh.stdout).not.toContain("WARNING");
    // Main then changes one admission file: the checkout is behind, so its verdict may differ from the hosted one.
    f.git("switch", "-q", "main"); f.put("scripts/platform-migration-manifest.ts", `${readFileSync("scripts/platform-migration-manifest.ts", "utf8")}// Main moved.\n`);
    const moved = f.commit();
    const refused = cli(f.root, ["--base", moved, "--head", head]);
    expect(refused.status).toBe(2); expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("differs from");
    expect(refused.stderr).toContain("in scripts/platform-migration-manifest.ts; hosted CI and the queue would judge with the base's code");
    const allowed = cli(f.root, ["--base", moved, "--head", head, STALE]);
    expect(allowed.stderr).toBe(""); expect(allowed.status).toBe(0);
    expect(allowed.stdout).toContain(`WARNING  admission code differs from ${moved} in scripts/platform-migration-manifest.ts;`);
  }, 21_000);

  // Measured 2.7 s on a laptop at load average 5; the bound is four times that.
  it("checks the working tree and leaves refs, the index, the worktree and the object store unchanged", () => {
    const f = fixture();
    stageNativeForward(f);
    f.git("add", REVIEWED_FORWARD_PATH); // staged registry, unstaged manifest, untracked forward
    f.put("ignored.log", "ignored\n"); f.put(".gitignore", "*.log\n");
    const files = [REVIEWED_FORWARD_PATH, PLATFORM_MIGRATION_MANIFEST, nativePath];
    const snapshot = () => ({
      refs: f.git("for-each-ref", "--format=%(refname) %(objectname)"), head: f.git("symbolic-ref", "HEAD"), commit: f.git("rev-parse", "HEAD"),
      index: createHash("sha256").update(readFileSync(join(f.root, ".git/index"))).digest("hex"),
      status: f.git("--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all", "--ignored"), objects: f.git("count-objects", "-v"),
      files: files.map((path) => readFileSync(join(f.root, path), "utf8")),
    });
    const before = snapshot();
    const scratch = mkdtempSync(join(tmpdir(), "openlup-sql-admit-tmp-")); roots.push(scratch);
    const result = cli(f.root, ["--base", f.base, STALE], { TMPDIR: scratch });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("(working tree)");
    expect(result.stdout).toContain(`PASS     ${nativePath} [self-check forward admission]`);
    expect(result.stdout).toContain("PASS     co-located approval [queue pull request, fork..head]");
    expect(snapshot()).toEqual(before);
    expect(readdirSync(scratch)).toEqual([]);
  }, 11_000);

  it("refuses usage errors, Git errors and a head that does not merge into the base with exit code 2", () => {
    const f = fixture();
    for (const args of [["--unknown"], ["--base"], ["--base", "missing-revision", STALE], ["--allow-stale-rules", "--allow-stale-rules"]]) {
      const result = cli(f.root, args);
      expect(result.status, args.join(" ")).toBe(2);
      expect(result.stdout).toBe("");
    }
    f.git("switch", "-q", "-c", "feature"); stageNativeForward(f); const head = f.commit();
    f.git("switch", "-q", "main");
    const other = registry(); other.nativeStoreForwardClass!.slots.push(slot("db/platform/migrations/20271107100000_other.sql", "Other"));
    f.put(REVIEWED_FORWARD_PATH, encode(other)); const base = f.commit();
    const conflict = cli(f.root, ["--base", base, "--head", head, STALE]);
    expect(conflict.status).toBe(2); expect(conflict.stdout).toBe("");
    expect(conflict.stderr).toContain("head does not merge cleanly into base");
  });
});
