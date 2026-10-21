import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { neutralityIncreases, validateBaseline } from "./public-ci-neutrality.mjs";

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
  it("admits only the approved adoption prose and screenshot references without raising the baseline", () => {
    const { root, base } = installed();
    const before = readFileSync(join(root, baselinePath), "utf8");
    for (const path of ["README.md", "docs/platform/DOCUMENTATION.md", "config/openlup-publication-catalog.json"]) {
      const lines = readFileSync(join(sourceRoot, path), "utf8").split("\n")
        .filter((line) => line.toLowerCase().includes(debt));
      expect(lines.length).toBeGreaterThan(0);
      put(root, path, `${lines.join("\n")}\n`);
    }
    const image = `docs/platform/assets/${debt}-storefront-en.png`;
    put(root, image, Buffer.from([0, 1, 2, 3]));
    const accepted = cli(root, base);
    expect(accepted.status, accepted.output).toBe(0);
    expect(readFileSync(join(root, baselinePath), "utf8")).toBe(before);
  }, 30_000);

  it("still refuses the approved prose in code or any other documentation path", () => {
    const { root, base } = installed();
    const approved = readFileSync(join(sourceRoot, "README.md"), "utf8").split("\n")
      .find((line) => line.startsWith("Shaped by real subscription-commerce work"))!;
    for (const path of ["src/example.ts", "server/example.ts", "packages/core/src/example.ts", "docs/example.md"]) {
      put(root, path, `${approved}\n`);
      const refused = cli(root, base);
      expect(refused.status, refused.output).toBe(1);
      expect(refused.output).toContain("brand increased");
      rmSync(join(root, path));
    }
  }, 30_000);

  it("refuses changed or duplicated prose and unrelated categories at an approved carrier", () => {
    const { root, base } = installed();
    const approved = readFileSync(join(sourceRoot, "README.md"), "utf8").split("\n")
      .find((line) => line.startsWith("Shaped by real subscription-commerce work"))!;
    for (const contents of [`${approved} changed\n`, `${approved}\n${approved}\n`,
      `${approved}\nconst brand = "${debt}";\n`,
      `${approved}\n${debt.toUpperCase()}_TOKEN\n`,
      `${approved}\n${String.fromCharCode(112, 114, 111, 116, 101, 105, 110, 101)}\n`]) {
      put(root, "README.md", contents);
      const refused = cli(root, base);
      expect(refused.status, refused.output).toBe(1);
    }
    put(root, "README.md", `${approved}\n`);
    expect(cli(root, base).status).toBe(0);
  }, 30_000);

  it("limits changelog and fragment vocabulary to complete adapter subpaths in the platform carriers", () => {
    const { root, base } = installed();
    const vendor = String.fromCharCode(114, 101, 115, 101, 110, 100);
    const carriers = ["packages/platform/CHANGELOG.md", "packages/platform/changes/a-one.md"];
    for (const path of carriers) put(root, path, `- Add communications/${vendor}.\n`);
    expect(cli(root, base).status).toBe(0);
    for (const wrong of ["packages/core/CHANGELOG.md", "packages/core/changes/a-one.md", "packages/platform/changes/nested/a.md", "packages/platform/changes/a.txt"]) {
      put(root, wrong, `- Add communications/${vendor}.\n`);
      const refused = cli(root, base); expect(refused.status, refused.output).toBe(1); rmSync(join(root, wrong));
    }
    for (const path of carriers) {
      put(root, path, `- Bare ${vendor}.\n`); expect(cli(root, base).status).toBe(1);
      put(root, path, `- Add communications/${vendor}.\n`);
    }
  });

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
  it("preserves large Unicode scanner input and cleans temporary files on success and failure", () => {
    const contents = `${'雪🐾 "quoted" \\ line\n'.repeat(4096)}${debt} ${debt}\n`;
    expect(Buffer.byteLength(JSON.stringify([{ path: "unicode-data", contents }]), "utf8")).toBeGreaterThan(64 * 1024);
    const { root, base } = fixture({ "unicode-data": contents });
    const temporary = join(root, "temporary-input");
    mkdirSync(temporary);
    const temporaryEnvironment = { ...fixtureEnvironment, TMPDIR: temporary, TMP: temporary, TEMP: temporary };
    // macOS's Git launcher can create its own xcrun database in TMPDIR.
    // Initialize that dependency before observing files owned by the CLI.
    execFileSync("git", ["--version"], { env: temporaryEnvironment, timeout: 20_000, stdio: "pipe" });
    const initialFiles = readdirSync(temporary);
    const run = (...options: string[]) => {
      const result = spawnSync(process.execPath, ["scripts/public-ci-neutrality.mjs", "--base-commit", base, ...options], {
        cwd: root, env: temporaryEnvironment, encoding: "utf8", timeout: 20_000,
      });
      expect(result.error).toBeUndefined();
      expect(readdirSync(temporary)).toEqual(initialFiles);
      return { status: result.status, output: result.stdout + result.stderr };
    };
    const bootstrap = run("--write-baseline");
    expect(bootstrap.status, bootstrap.output).toBe(0);
    expect(baseline(root).counts[hash("unicode-data")]).toEqual({ "ui-0": 2, brand: 2 });
    const unchanged = run();
    expect(unchanged.status, unchanged.output).toBe(0);
    put(root, "unicode-data", `${contents}${debt}\n`);
    const growth = run();
    expect(growth.status, growth.output).toBe(1);
    expect(growth.output).toContain("brand increased 2 -> 3");
    expect(growth.output).toContain("ui-0 increased 2 -> 3");
    put(root, "package.json", '{"type":"commonjs"}\n');
    const failed = run();
    expect(failed.status, failed.output).toBe(1);
    expect(failed.output).toContain("neutrality scanner failed");
  }, 30_000);
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
  }, 30_000);
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
  }, 30_000);
  it("refuses raised, removed and malformed established baselines", () => {
    const { root, base } = installed({ "existing": debt });
    const value = baseline(root); value.counts[hash("existing")].brand += 1;
    put(root, baselinePath, JSON.stringify(value));
    expect(cli(root, base).status).toBe(1);
    put(root, baselinePath, "{not valid");
    expect(cli(root, base).output).toContain("invalid neutrality baseline JSON");
    rmSync(join(root, baselinePath));
    expect(cli(root, base).output).toContain("baseline missing or removed");
  }, 30_000);
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
  }, 30_000);
  it("inventories binary data and refuses text-debt converted to binary", () => {
    const { root, base } = installed({ "existing": debt, "binary": Buffer.from([0, 255]) });
    expect(cli(root, base).output).toContain("1 binary files inventoried");
    put(root, "existing", Buffer.from([0, 255]));
    expect(cli(root, base).output).toContain("contaminated text became binary");
  }, 30_000);
  it("reads newline filenames by object identity and escapes their diagnostics", () => {
    const path = "line\nbreak";
    const { root, base } = installed({ [path]: "clean" });
    put(root, path, debt);
    const result = cli(root, base);
    expect(result.status).toBe(1);
    expect(result.output).toContain('"line\\nbreak"');
  }, 30_000);
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

describe("neutrality scan reuse", () => {
  it("reuses scanner results only for exact complete inventories within one invocation", () => {
    const { root } = fixture({ "ordinary.txt": "alpha\n", "binary.dat": Buffer.from([0, 1, 2]) });
    const checker = "scripts/public-ci-neutrality.mjs";
    const source = readFileSync(join(root, checker), "utf8");
    const anchor = "const invoke = (path, input, args = []) => {";
    expect(source.split(anchor)).toHaveLength(2);
    // Instrument only the copied checker. Real scanner argv, code and pins stay
    // unchanged; .git is outside its inventory and belongs to fixture cleanup.
    const log = ".git/neutrality-invocations";
    put(root, checker, source.replace(anchor, `${anchor}\n    writeFileSync(join(root, ${JSON.stringify(log)}), JSON.stringify(path) + "\\n", { flag: "a" });`));
    const instrumentedBase = commit(root);
    const bootstrap = cli(root, instrumentedBase, "--write-baseline");
    expect(bootstrap.status, bootstrap.output).toBe(0);
    const base = commit(root);
    const pair = [scannerPaths[3], scannerPaths[2]];
    const run = (expected: string[], label: string, ...options: string[]) => {
      put(root, log, "");
      const result = cli(root, base, ...options);
      expect(result.status, `${label}: ${result.output}`).toBe(0);
      const calls = readFileSync(join(root, log), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(calls, label).toEqual(expected);
    };
    run(pair, "identical check");
    run(pair, "identical regeneration", "--write-baseline");
    const differences: Array<[string, () => void]> = [
      ["same-length clean content", () => put(root, "ordinary.txt", "omega\n")],
      ["addition", () => put(root, "added.txt", "new\n")],
      ["deletion", () => rmSync(join(root, "ordinary.txt"))],
      ["same-byte rename", () => renameSync(join(root, "ordinary.txt"), join(root, "renamed.txt"))],
      ["same-size replaced path", () => {
        rmSync(join(root, "ordinary.txt"));
        put(root, "replacement.txt", "other\n");
      }],
      ["binary-only content", () => put(root, "binary.dat", Buffer.from([0, 1, 3]))],
      ["baseline-only formatting", () => put(root, baselinePath, `${JSON.stringify(baseline(root))}\n\n`)],
    ];
    for (const [difference, change] of differences) {
      git(root, ["checkout", "--", "."]);
      for (const path of ["added.txt", "renamed.txt", "replacement.txt"]) rmSync(join(root, path), { force: true });
      change();
      run([...pair, ...pair], difference);
    }
  });

});
