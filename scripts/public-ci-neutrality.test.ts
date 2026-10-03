import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { neutralityIncreases, unreviewedDiagnosticFixtureIncreases, validateBaseline } from "./public-ci-neutrality.mjs";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = "config/openlup-neutrality-baseline.json";
const scannerPaths = [
  "packages/core/scripts/neutrality-source-scanner.ts",
  "packages/core/scripts/neutrality-shell-fold.ts",
  "packages/core/scripts/neutrality-tree-counts.ts",
  "packages/ui/smoke/neutrality.ts",
];
const sourcePaths = ["scripts/public-ci-neutrality.mjs", ...scannerPaths];
const scratch = join(sourceRoot, ".context/scratch/neutrality-cli-tests");
const fixtures: string[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
// Runtime construction prevents the test source itself adding matcher debt.
const debt = String.fromCharCode(118, 101, 108, 105, 112, 101, 116);
const fixtureEnvironment = { ...Reflect.get(process, "env") } as NodeJS.ProcessEnv;
for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_CONFIG", "GIT_CONFIG_COUNT"]) delete fixtureEnvironment[name];

function put(root: string, path: string, bytes: string | Buffer) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
}
function git(root: string, args: string[]) {
  return execFileSync("git", args, { cwd: root, env: fixtureEnvironment, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}
function commit(root: string) {
  git(root, ["add", "--all"]);
  git(root, ["-c", "user.name=Neutrality fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Synthetic test state"]);
  return git(root, ["rev-parse", "HEAD"]);
}
function cli(root: string, base: string, ...options: string[]) {
  const result = spawnSync(process.execPath, ["scripts/public-ci-neutrality.mjs", "--base-commit", base, ...options], { cwd: root, env: fixtureEnvironment, encoding: "utf8", timeout: 20_000 });
  expect(result.error).toBeUndefined();
  return { status: result.status, output: result.stdout + result.stderr };
}
function baseline(root: string) {
  return JSON.parse(readFileSync(join(root, baselinePath), "utf8"));
}
function fixture(files: Record<string, string | Buffer> = {}) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "repo-"));
  fixtures.push(root);
  git(root, ["init", "--initial-branch=main"]);
  mkdirSync(join(root, "config"));
  put(root, "package.json", '{"type":"module"}\n');
  for (const path of sourcePaths) put(root, path, readFileSync(join(sourceRoot, path)));
  for (const [path, content] of Object.entries(files)) put(root, path, content);
  const base = commit(root);
  return { root, base };
}
function installed(files: Record<string, string | Buffer> = {}) {
  const { root, base } = fixture(files);
  const bootstrap = cli(root, base, "--write-baseline");
  expect(bootstrap.status, bootstrap.output).toBe(0);
  const installedBase = commit(root);
  expect(cli(root, installedBase).status).toBe(0);
  return { root, base: installedBase };
}
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

function validBaseline() {
  return { schemaVersion: 2, sourceCommit: "a".repeat(40), scannerPins: Object.fromEntries(scannerPaths.map((path) => [path, "c".repeat(40)])), counts: { ["b".repeat(64)]: { brand: 1 } } };
}
describe("tree-wide neutrality ratchet", () => {
  it("does not let another path or category pay for new debt", () => {
    expect(neutralityIncreases({ a: { brand: 3 }, b: { brand: 2 } }, { a: { brand: 2 }, b: { brand: 3 } })).toEqual([{ path: "b", category: "brand", before: 2, after: 3 }]);
    expect(neutralityIncreases({ a: { brand: 3 } }, { a: { brand: 2, "ui-1": 1 } })).toEqual([{ path: "a", category: "ui-1", before: 0, after: 1 }]);
  });
  it("refuses new paths and permits shrinking or deleting findings", () => {
    expect(neutralityIncreases({}, { newPath: { brand: 1 } })).toHaveLength(1);
    expect(neutralityIncreases({ a: { brand: 3 } }, { a: { brand: 2 } })).toEqual([]);
    expect(neutralityIncreases({ a: { brand: 3 } }, {})).toEqual([]);
  });
  it("refuses malformed counts", () => {
    for (const count of [-1, 1.5, NaN, "1"]) expect(() => neutralityIncreases({}, { a: { brand: count } })).toThrow("nonnegative integers");
  });
  it("validates categories, full identities and the exact complete pin set", () => {
    const value = validBaseline();
    expect(() => validateBaseline(value)).not.toThrow();
    expect(() => validateBaseline(null)).toThrow();
    expect(() => validateBaseline({ ...value, sourceCommit: "main" })).toThrow();
    expect(() => validateBaseline({ ...value, counts: { path: { brand: 1 } } })).toThrow();
    for (const counts of [{ brand: "10" }, { brand: -1 }, { unknown: 1 }]) expect(() => validateBaseline({ ...value, counts: { ["b".repeat(64)]: counts } })).toThrow();
    const missing = { ...value.scannerPins }; delete missing[scannerPaths[1]];
    for (const scannerPins of [missing, { ...value.scannerPins, extra: "c".repeat(40) }, { ...value.scannerPins, [scannerPaths[0]]: "HEAD" }]) expect(() => validateBaseline({ ...value, scannerPins })).toThrow();
  });
});

describe("neutrality CLI on synthetic Git objects", () => {
  it("bootstraps from the full measured base and refuses a candidate-derived allowance", () => {
    const { root, base } = fixture({ "existing": debt });
    const bootstrap = cli(root, base, "--write-baseline");
    expect(bootstrap.status, bootstrap.output).toBe(0);
    expect(baseline(root).sourceCommit).toBe(base);
    expect(cli(root, base).status).toBe(0);
    const value = baseline(root); value.counts[hash("existing")].brand += 1;
    put(root, baselinePath, JSON.stringify(value));
    expect(cli(root, base).output).toContain("initial neutrality baseline must equal");
    value.sourceCommit = "a".repeat(40);
    put(root, baselinePath, JSON.stringify(value));
    expect(cli(root, base).status).toBe(1);
  });
  it("refuses shrink then regrowth even with the old ceiling, and lowers deterministically", () => {
    const { root, base } = installed({ "existing": `${debt}\n`.repeat(3) });
    put(root, "existing", debt);
    expect(cli(root, base).status).toBe(0);
    const shrunk = commit(root);
    put(root, "existing", `${debt}\n`.repeat(2));
    expect(cli(root, shrunk).status).toBe(1);
    expect(cli(root, shrunk, "--write-baseline").status).toBe(1);
    put(root, "existing", debt);
    expect(cli(root, shrunk, "--write-baseline").status).toBe(0);
    const bytes = readFileSync(join(root, baselinePath), "utf8");
    expect(baseline(root).counts[hash("existing")].brand).toBe(1);
    expect(cli(root, shrunk, "--write-baseline").status).toBe(0);
    expect(readFileSync(join(root, baselinePath), "utf8")).toBe(bytes);
    expect(cli(root, shrunk).status).toBe(0);
  });
  it("refuses raised, removed and malformed established baselines", () => {
    const { root, base } = installed({ "existing": debt });
    const value = baseline(root); value.counts[hash("existing")].brand += 1;
    put(root, baselinePath, JSON.stringify(value));
    expect(cli(root, base).status).toBe(1);
    put(root, baselinePath, "{not valid");
    expect(cli(root, base).output).toContain("invalid neutrality baseline JSON");
    rmSync(join(root, baselinePath));
    expect(cli(root, base).output).toContain("baseline missing or removed");
  });
  it("refuses new extensionless debt without compensation from a deletion", () => {
    const { root, base } = installed({ "existing": debt });
    rmSync(join(root, "existing"));
    put(root, "new-extensionless", debt);
    expect(cli(root, base).status).toBe(1);
  });
  it("permits clean rename and deletion but refuses contaminated rename and reintroduction", () => {
    const { root, base } = installed({ "existing": debt, "clean": "unrelated text" });
    renameSync(join(root, "clean"), join(root, "clean-renamed"));
    expect(cli(root, base).status).toBe(0);
    renameSync(join(root, "existing"), join(root, "debt-renamed"));
    expect(cli(root, base).status).toBe(1);
    rmSync(join(root, "debt-renamed"));
    expect(cli(root, base).status).toBe(0);
    const deleted = commit(root);
    put(root, "existing", debt);
    expect(cli(root, deleted).status).toBe(1);
  });
  it("inventories binary data and refuses text-debt converted to binary", () => {
    const { root, base } = installed({ "existing": debt, "binary": Buffer.from([0, 255]) });
    expect(cli(root, base).output).toContain("1 binary files inventoried");
    put(root, "existing", Buffer.from([0, 255]));
    expect(cli(root, base).output).toContain("contaminated text became binary");
  });
  it("reads newline filenames by object identity and escapes their diagnostics", () => {
    const path = "line\nbreak";
    const { root, base } = installed({ [path]: "clean" });
    put(root, path, debt);
    const result = cli(root, base);
    expect(result.status).toBe(1);
    expect(result.output).toContain('"line\\nbreak"');
  });
  it("refuses non-UTF-8 Git paths instead of replacing their identity bytes", () => {
    const { root, base } = installed();
    // Construct raw Git objects: some filesystems cannot materialize this name.
    const options = { cwd: root, env: fixtureEnvironment, stdio: "pipe" as const };
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { ...options, input: "clean", encoding: "utf8" }).trim();
    const entries = execFileSync("git", ["ls-tree", "-z", base], options);
    const tree = execFileSync("git", ["mktree", "-z"], { ...options, input: Buffer.concat([entries, Buffer.from(`100644 blob ${blob}\t`), Buffer.from([255, 0])]), encoding: "utf8" }).trim();
    const invalidBase = git(root, ["-c", "user.name=Neutrality fixture", "-c", "user.email=fixture@example.invalid", "commit-tree", tree, "-p", base, "-m", "Synthetic unsupported pathname"]);
    expect(cli(root, invalidBase).output).toContain("unsupported or unavailable UTF-8 Git inventory");
    git(root, ["read-tree", tree]);
    expect(cli(root, base).output).toContain("unsupported or unavailable UTF-8 Git inventory");
  });
  it("refuses working symlinks, tracked symlinks and gitlinks", () => {
    const { root, base } = installed({ "regular": "clean" });
    symlinkSync("regular", join(root, "link"));
    expect(cli(root, base).output).toContain("unsupported filesystem entry");
    const symlinkBase = commit(root);
    expect(cli(root, symlinkBase).output).toContain("unsupported Git inventory object");
    rmSync(join(root, "link")); git(root, ["add", "--all"]);
    git(root, ["update-index", "--add", "--cacheinfo", `160000,${base},module`]);
    expect(cli(root, base).output).toContain("unsupported or unmerged Git index object");
  });
  it("refuses unsupported base and malformed categories without echoing JSON contents", () => {
    const { root, base } = installed();
    for (const ref of ["main", "0".repeat(40), "a".repeat(40)]) expect(cli(root, ref).status).toBe(1);
    const value = baseline(root); value.counts[hash("payload")] = { unknown: 1 };
    put(root, baselinePath, JSON.stringify(value));
    expect(cli(root, base).output).toContain("invalid neutrality baseline count");
  });
  it.each([scannerPaths[0], scannerPaths[1], scannerPaths[2], scannerPaths[3]])("refuses changed matcher-chain bytes and self-approved pins: %s", (path) => {
    const { root, base } = installed();
    put(root, path, readFileSync(join(root, path), "utf8") + "\n// changed chain\n");
    const value = baseline(root);
    value.scannerPins[path] = git(root, ["hash-object", path]);
    put(root, baselinePath, JSON.stringify(value));
    expect(cli(root, base).output).toContain("scanner pin drift");
  });
  it("refuses unchecked imports and a missing transitive scanner", () => {
    const { root, base } = installed();
    const path = scannerPaths[2];
    const original = readFileSync(join(root, path), "utf8");
    put(root, path, 'import { surprise } from "./unchecked.ts";\n' + original);
    expect(cli(root, base).output).toContain("unchecked scanner dependency");
    put(root, path, original);
    rmSync(join(root, scannerPaths[1]));
    expect(cli(root, base).output).toContain("missing scanner source");
  });
  it.each(["remove", "reorder"])("refuses matcher %s even when it would reduce counts", (operation) => {
    const { root, base } = installed({ "existing": debt });
    const path = scannerPaths[3];
    const lines = readFileSync(join(root, path), "utf8").split("\n");
    const first = lines.findIndex((line) => line.includes('label: "brand name"'));
    expect(first).toBeGreaterThan(0);
    if (operation === "remove") lines.splice(first, 1);
    else [lines[first], lines[first + 1]] = [lines[first + 1], lines[first]];
    put(root, path, lines.join("\n"));
    expect(cli(root, base).output).toContain("scanner pin drift");
  });
  it("refuses scanner execution failure instead of interpreting it as zero findings", () => {
    const { root } = installed();
    const path = scannerPaths[2];
    put(root, path, readFileSync(join(root, path), "utf8") + '\nthrow new Error("synthetic scanner failure");\n');
    const value = baseline(root); value.scannerPins[path] = git(root, ["hash-object", path]);
    put(root, baselinePath, JSON.stringify(value));
    const base = commit(root);
    const result = cli(root, base);
    expect(result.output).toContain("neutrality scanner failed");
    expect(result.output).not.toContain("throw new Error");
    expect(result.output).not.toContain(root);
  });
});

describe("exact reviewed diagnostic-fixture recalibration", () => {
  const introductionBase = "e863fe06bee931b26e0e868fbbc3d5eb2d26d16d";
  const fixtures = [
    ["supabase/tests/anon_write_privilege_revoke_test.sql", 0, 1],
    ["supabase/tests/fulfillment_replacement_sequence_test.sql", 0, 1],
    ["supabase/tests/channel_order_reaches_the_dispatch_gate_test.sql", 1, 2],
    ["supabase/tests/payment_recovery_sha256_test.sql", 1, 2],
    ["supabase/tests/subscription_starter_cycle_order_discount_test.sql", 1, 2],
  ] as const;
  const snapshots = () => new Map(fixtures.map(([path]) => [path, readFileSync(join(sourceRoot, path))]));
  const increases = () => fixtures.map(([path, before, after]) => ({ path: hash(path), category: "ui-15", before, after }));
  it("accepts only the five exact reviewed files, category and counts at introduction", () => {
    expect(unreviewedDiagnosticFixtureIncreases(increases(), snapshots(), introductionBase)).toEqual([]);
  });
  it.each(fixtures)("refuses changed bytes for %s", (path) => {
    const bytes = snapshots();
    bytes.set(path, Buffer.concat([bytes.get(path)!, Buffer.from("\n-- changed fixture\n")]));
    expect(unreviewedDiagnosticFixtureIncreases(increases(), bytes, introductionBase)).toEqual(increases().filter((row) => row.path === hash(path)));
    bytes.delete(path);
    expect(unreviewedDiagnosticFixtureIncreases(increases(), bytes, introductionBase)).toEqual(increases().filter((row) => row.path === hash(path)));
  });
  it("refuses another path, count, prior count or category", () => {
    const row = increases()[0];
    for (const rejected of [{ ...row, path: hash("supabase/tests/unreviewed_test.sql") }, { ...row, after: row.after + 1 }, { ...row, before: row.before + 1 }, { ...row, category: "ui-14" }]) {
      expect(unreviewedDiagnosticFixtureIncreases([rejected], snapshots(), introductionBase)).toEqual([rejected]);
    }
  });
  it("never excepts increases against a later or unrelated base", () => {
    expect(unreviewedDiagnosticFixtureIncreases(increases(), snapshots(), "a".repeat(40))).toEqual(increases());
  });
  it("keeps the production introduction trust anchor exact and unique", () => {
    const source = readFileSync(join(sourceRoot, "scripts/public-ci-neutrality.mjs"), "utf8");
    const anchor = `const fixtureIntroductionBase = "${introductionBase}";`;
    expect(introductionBase).toBe("e863fe06bee931b26e0e868fbbc3d5eb2d26d16d");
    expect(source.split(anchor)).toHaveLength(2);
  });
  function introductionFixture() {
    // Only copied synthetic-test checker bytes are rebound. Production has no
    // environment override, input override or mutable introduction-base API.
    const originals = Object.fromEntries(fixtures.map(([path]) => [path,
      execFileSync("git", ["show", `${introductionBase}:${path}`], { cwd: sourceRoot, env: fixtureEnvironment })]));
    const { root, base } = installed(originals);
    const checkerPath = "scripts/public-ci-neutrality.mjs";
    const source = readFileSync(join(root, checkerPath), "utf8");
    const anchor = `const fixtureIntroductionBase = "${introductionBase}";`;
    expect(source.split(anchor)).toHaveLength(2);
    put(root, checkerPath, source.replace(anchor, `const fixtureIntroductionBase = "${base}";`));
    for (const [path, bytes] of snapshots()) put(root, path, bytes);
    const value = baseline(root);
    for (const [path, before, after] of fixtures) {
      expect(value.counts[hash(path)]?.["ui-15"] ?? 0).toBe(before);
      value.counts[hash(path)] = { ...value.counts[hash(path)], "ui-15": after };
    }
    put(root, baselinePath, JSON.stringify(value));
    return { root, base };
  }
  it("checks and regenerates the exact-five introduction against actual prior fixture bytes", () => {
    const { root, base } = introductionFixture();
    expect(cli(root, base).status).toBe(0);
    expect(cli(root, base, "--write-baseline").status).toBe(0);
    expect(cli(root, base).status).toBe(0);
  });
  it.each(fixtures)("requires exact recalibration of %s rather than excepting candidate-versus-baseline", (path, before, after) => {
    const { root, base } = introductionFixture();
    const value = baseline(root);
    for (const count of [before, after + 1]) {
      value.counts[hash(path)]["ui-15"] = count;
      put(root, baselinePath, JSON.stringify(value));
      expect(cli(root, base).status).toBe(1);
    }
  });
  it.each([
    ["source", "unreviewedDiagnosticFixtureIncreases(neutralityIncreases(measuredBase.rows, current.rows), currentBytes, base)", "neutralityIncreases(measuredBase.rows, current.rows)", []],
    ["parent baseline", "unreviewedDiagnosticFixtureIncreases(neutralityIncreases(parent.counts, baseline.counts), currentBytes, base)", "neutralityIncreases(parent.counts, baseline.counts)", []],
    ["regeneration", "unreviewedDiagnosticFixtureIncreases(neutralityIncreases(parent.counts, counts), currentBytes, base)", "neutralityIncreases(parent.counts, counts)", ["--write-baseline"]],
  ] as const)("fails introduction when the required %s admission is absent", (_name, wrapped, strict, options) => {
    const { root, base } = introductionFixture();
    const path = "scripts/public-ci-neutrality.mjs";
    const source = readFileSync(join(root, path), "utf8");
    expect(source.split(wrapped)).toHaveLength(2);
    put(root, path, source.replace(wrapped, strict));
    expect(cli(root, base, ...options).status).toBe(1);
  });
  it("keeps CLI source admission and regeneration strict on an unrelated base", () => {
    const { root, base } = installed();
    for (const [path, bytes] of snapshots()) put(root, path, bytes);
    expect(cli(root, base).status).toBe(1);
    expect(cli(root, base, "--write-baseline").output).toContain("baseline regeneration would increase accepted debt");
  });
  it("accepts unchanged future files and baseline regeneration, then refuses shrink/regrowth", () => {
    const files = snapshots();
    const { root, base } = installed(Object.fromEntries(files));
    expect(cli(root, base).status).toBe(0);
    expect(cli(root, base, "--write-baseline").status).toBe(0);
    const path = fixtures[0][0];
    // Static scanner probe only; these synthetic SQL files are never executed.
    const original = files.get(path)!;
    const shrunkBytes = original.toString("utf8").replace(/'(\w+)'(?=, 'fulfillment')/, "'neutral_provider'");
    expect(shrunkBytes).not.toBe(original.toString("utf8"));
    put(root, path, shrunkBytes);
    expect(cli(root, base).status).toBe(0);
    const shrunk = commit(root);
    expect(cli(root, shrunk, "--write-baseline").status).toBe(0);
    put(root, path, original);
    expect(cli(root, shrunk).status).toBe(1);
    expect(cli(root, shrunk, "--write-baseline").status).toBe(1);
  });
  it("refuses scanner drift even with all five exact fixtures", () => {
    const { root, base } = installed(Object.fromEntries(snapshots()));
    const path = scannerPaths[0];
    put(root, path, readFileSync(join(root, path), "utf8") + "\n// changed scanner\n");
    expect(cli(root, base).output).toContain("scanner pin drift");
  });
});
