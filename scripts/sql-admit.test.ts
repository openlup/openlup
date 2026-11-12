import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { needsForwardApproval } from "./agent-review-queue.mjs";
import { assertAppendOnlyMigrationHistory } from "./oss-published-tree-check.ts";
import { assertAdmittedPlatformForward } from "./oss-source-release-contract.ts";
import { PLATFORM_BASELINE_FILE, PLATFORM_MIGRATION_MANIFEST, sha256 } from "./platform-migration-manifest.ts";
import { assertCoLocatedForwardApproval, readReviewedForwardRegistry, REVIEWED_FORWARD_PATH, sqlSha256, type NativeStoreSlot, type ReviewedForwardRegistry } from "./reviewed-platform-forward.ts";
import { capabilityHint } from "./sql-admit.ts";

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
  const put = (path: string, value: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
  const commit = () => { git("add", "--all"); git("commit", "-qm", "SQL admission fixture"); return git("rev-parse", "HEAD"); };
  git("init", "-q", "-b", "main");
  put(PLATFORM_BASELINE_FILE, baseline); put(MANAGED_BASELINE, "-- Synthetic managed baseline.\n");
  put(PLATFORM_MIGRATION_MANIFEST, manifest([])); put(REVIEWED_FORWARD_PATH, encode(registry()));
  return { root, git, put, commit, base: commit() };
}
function cli(root: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--experimental-strip-types", CLI, ...args], { cwd: root, encoding: "utf8", timeout: 60_000, env: { ...process.env, ...env } });
}
const verdictLines = (stdout: string) => stdout.split("\n").flatMap((line) => {
  const match = /^(PASS|REFUSED) +(.+?) \[(.+?)\](?:: (.*))?$/u.exec(line);
  return match ? [match[4] === undefined ? [match[1]!] : [match[1]!, match[4]]] : [];
});

// The underlying checks, called directly on the same commits: the self-check on main and the PR merge commit,
// then the queue guard on the PR's own fork point and on the merge-group head.
function directVerdicts(f: Fixture, base: string, head: string): string[][] {
  expect(() => f.git("merge-base", "--is-ancestor", base, head)).not.toThrow();
  const merge = f.git("commit-tree", `${head}^{tree}`, "-p", base, "-p", head, "-m", "Synthetic pull-request merge");
  f.git("checkout", "-q", "--detach", merge);
  const verdict = (action: () => void) => { try { action(); return ["PASS"]; } catch (error) { return ["REFUSED", (error as Error).message]; } };
  const added = f.git("diff", "--name-only", "--no-renames", "--diff-filter=A", base, merge, "--", ...RAILS).split("\n").filter((path) => path.endsWith(".sql"));
  const verdicts = added.map((path) => verdict(() => assertAdmittedPlatformForward(f.root, base, merge, path, readFileSync(join(f.root, path)))));
  verdicts.push(verdict(() => assertAppendOnlyMigrationHistory(f.root, base, merge)));
  expect(needsForwardApproval(f.git("diff", "--name-only", "--no-renames", base, head).split("\n"))).toBe(true);
  verdicts.push(verdict(() => assertCoLocatedForwardApproval(f.root, base, head)), verdict(() => assertCoLocatedForwardApproval(f.root, base, merge)));
  return verdicts;
}

const nativePath = "db/platform/migrations/20271106100000_future.sql", nativeText = "CREATE TABLE public.future (id uuid);\n";
function stageNativeForward(f: Fixture) {
  const value = registry();
  value.nativeStoreForwardClass!.slots.push(slot(nativePath)); value.nativeStoreForwards!.push({ path: nativePath, sha256: sqlSha256(nativeText), functions: [] });
  f.put(REVIEWED_FORWARD_PATH, encode(value)); f.put(PLATFORM_MIGRATION_MANIFEST, manifest([{ file: nativePath, sha256: sha256(nativeText) }])); f.put(nativePath, nativeText);
}
const cases: { name: string; exit: number; refusal?: string; hint?: string; build: (f: Fixture) => { base: string; head: string } }[] = [
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
];

describe("sql:admit", () => {
  // The slowest case measured 3.7 s on an idle laptop; the bound is four times that.
  it.each(cases)("reports the hosted verdict for $name", async ({ exit, refusal, hint, build }) => {
    const f = fixture(), { base, head } = build(f);
    const result = cli(f.root, ["--base", base, "--head", head]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(exit);
    const reported = verdictLines(result.stdout);
    expect(reported).toEqual(directVerdicts(f, base, head));
    if (refusal === undefined) expect(reported.every(([status]) => status === "PASS")).toBe(true);
    else {
      expect(reported.filter(([status]) => status === "REFUSED").map(([, message]) => message)).toEqual(expect.arrayContaining([expect.stringContaining(refusal)]));
      expect(result.stdout).toContain(`capability needed: ${capabilityHint(refusal)}`);
      expect(capabilityHint(refusal)).toContain(hint);
    }
  }, 15_000);

  // Measured 2.2 s on an idle laptop; the bound is four times that.
  it("checks the working tree and leaves refs, the index, the worktree and the object store unchanged", () => {
    const f = fixture();
    stageNativeForward(f);
    f.git("add", REVIEWED_FORWARD_PATH); // staged registry, unstaged manifest, untracked forward
    const files = [REVIEWED_FORWARD_PATH, PLATFORM_MIGRATION_MANIFEST, nativePath];
    const snapshot = () => ({
      refs: f.git("for-each-ref", "--format=%(refname) %(objectname)"), head: f.git("symbolic-ref", "HEAD"), commit: f.git("rev-parse", "HEAD"),
      index: createHash("sha256").update(readFileSync(join(f.root, ".git/index"))).digest("hex"),
      status: f.git("--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"), objects: f.git("count-objects", "-v"),
      files: files.map((path) => readFileSync(join(f.root, path), "utf8")),
    });
    const before = snapshot();
    const scratch = mkdtempSync(join(tmpdir(), "openlup-sql-admit-tmp-")); roots.push(scratch);
    const result = cli(f.root, ["--base", f.base], { TMPDIR: scratch });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("(working tree)");
    expect(result.stdout).toContain(`PASS     ${nativePath} [self-check forward admission]`);
    expect(result.stdout).toContain("PASS     co-located approval [queue pull request, fork..head]");
    expect(snapshot()).toEqual(before);
    expect(readdirSync(scratch)).toEqual([]);
  }, 9_000);

  it("refuses usage and Git errors with exit code 2", () => {
    const f = fixture();
    for (const args of [["--unknown"], ["--base"], ["--base", "missing-revision"]]) {
      const result = cli(f.root, args);
      expect(result.status, args.join(" ")).toBe(2);
      expect(result.stdout).toBe("");
    }
  });
});
