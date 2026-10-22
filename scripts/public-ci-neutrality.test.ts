import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allowedFulfillmentAdapterWords, neutralityIncreases, scanSnapshots, unreviewedPinnedIntroductionIncreases, validateBaseline, validateReviewedPinnedIntroductions } from "./public-ci-neutrality.mjs";

vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execFileSync: vi.fn(original.execFileSync) };
});

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
const registryPath = "config/reviewed-platform-forwards.json";
const refundRail = "supabase/migrations/20261022185000_provider_refund_evidence.sql";
const refundFixture = `scripts/fixtures/reviewed-m10/${refundRail}`;
function managedPinnedSources() {
  const registryBytes = readFileSync(join(sourceRoot, registryPath));
  const pins = JSON.parse(registryBytes.toString()).batchedForwards as { path: string }[];
  const sources = new Map<string, Buffer>([[registryPath, registryBytes]]);
  for (const pin of pins.filter(pin => pin.path.startsWith("supabase/"))) {
    const path = `scripts/fixtures/reviewed-m10/${pin.path}`;
    const bytes = readFileSync(join(sourceRoot, path));
    sources.set(path, bytes); sources.set(pin.path, bytes);
  }
  return sources;
}
describe("tree-wide neutrality ratchet", () => {
  it("binds the M10 managed debt to exact measured fixture/rail counts and refuses noun-count drift", () => {
    const approved = JSON.parse(readFileSync(join(sourceRoot, baselinePath), "utf8")).counts;
    const sources = managedPinnedSources();
    const measured = scanSnapshots(sources);
    expect(Object.keys(measured.rows)).toHaveLength(13);
    for (const [path] of sources) {
      if (path.startsWith("supabase/") && !existsSync(join(sourceRoot, path))) expect(approved[hash(path)]).toBeUndefined();
      else expect(approved[hash(path)]).toEqual(measured.rows[hash(path)]);
    }
    const introductions = neutralityIncreases({}, measured.rows);
    expect(introductions).toHaveLength(15); // 13 paths; two dunning copies each have two categories.
    expect(unreviewedPinnedIntroductionIncreases(introductions, sources)).toEqual([]);
    const path = refundFixture;
    const original = sources.get(path)!;
    const noun = String.fromCharCode(115, 116, 114, 105, 112, 101);
    sources.set(path, Buffer.concat([original, Buffer.from(`\n-- ${noun}\n`)]));
    const drift = scanSnapshots(sources);
    expect(neutralityIncreases(measured.rows, drift.rows)).toEqual([
      { path: hash(path), category: "ui-13", before: 7, after: 8 },
    ]);
    expect(unreviewedPinnedIntroductionIncreases(neutralityIncreases({}, drift.rows), sources)).toEqual([
      { path: hash(path), category: "ui-13", before: 0, after: 8 },
    ]);
  });

  it("requires every present C94 baseline key to contain exactly its pinned category counts", () => {
    const measured = scanSnapshots(managedPinnedSources());
    for (const [path, counts] of Object.entries(measured.rows)) {
      const candidate = { ...validBaseline(), counts: { [path]: counts } };
      expect(() => validateBaseline(candidate)).not.toThrow();
      for (const [category, count] of Object.entries(counts)) {
        for (const wrong of [count - 1, count + 1]) {
          expect(() => validateBaseline({ ...candidate, counts: { [path]: { ...counts, [category]: wrong } } })).toThrow(/pinned introduction baseline count mismatch/);
        }
        const missing = { ...counts };
        delete missing[category];
        expect(() => validateBaseline({ ...candidate, counts: { [path]: missing } })).toThrow(/pinned introduction baseline count mismatch/);
      }
      expect(() => validateBaseline({ ...candidate, counts: { [path]: { ...counts, brand: 1 } } })).toThrow(/pinned introduction baseline count mismatch/);
    }
  });

  it.each(["changed byte", "missing file", "different before", "different count", "above pin", "other category", "other path", "same digest at other path"])("refuses a C94 introduction with %s", plant => {
    const bytes = readFileSync(join(sourceRoot, refundFixture));
    const sources = new Map([[refundFixture, bytes]]);
    const row = { path: hash(refundFixture), category: "ui-13", before: 0, after: 7 };
    expect(unreviewedPinnedIntroductionIncreases([row], sources)).toEqual([]);
    if (plant === "changed byte") sources.set(refundFixture, Buffer.concat([bytes, Buffer.from("\n")]));
    if (plant === "missing file") sources.delete(refundFixture);
    if (plant === "different before") row.before = 1;
    if (plant === "different count") row.after = 6;
    if (plant === "above pin") row.after = 8;
    if (plant === "other category") row.category = "ui-14";
    if (plant === "other path" || plant === "same digest at other path") {
      const otherPath = refundFixture.replace("185000", "185001");
      row.path = hash(otherPath);
      if (plant === "same digest at other path") sources.set(otherPath, bytes);
    }
    expect(unreviewedPinnedIntroductionIncreases([row], sources)).toEqual([row]);
  });

  it.each([
    "db/platform/migrations/20261022185000_provider_refund_evidence.sql",
    "packages/platform/sql/20261022185000_provider_refund_evidence.sql",
    "scripts/fixtures/reviewed-m10/db/platform/migrations/example.sql",
    "supabase/migrations/example.ts", "scripts/example.ts", "package.json", "docs/example.md",
    "config/another-registry.json", "supabase/migrations/../example.sql",
  ])("refuses adding a C94 entry outside the managed SQL/registry path classes: %s", path => {
    expect(() => validateReviewedPinnedIntroductions([[path, "a".repeat(64), [["ui-13", 0, 7]]]])).toThrow(/unsupported .*path/);
  });

  it("pins the exact registry COMMENT independently of unrelated registry edits", () => {
    const bytes = readFileSync(join(sourceRoot, registryPath));
    const registry = JSON.parse(bytes.toString());
    const pin = registry.batchedForwards.find(pin => pin.path.endsWith("20261022185100_m07_refund_parity.sql"));
    const statement = pin.statements.find(statement => statement.sql?.startsWith("COMMENT ON FUNCTION"));
    const row = { path: hash(registryPath), category: "ui-13", before: 0, after: 1 };
    const check = () => unreviewedPinnedIntroductionIncreases([row], new Map([[registryPath, Buffer.from(JSON.stringify(registry))]]));
    registry.unrelated = "neutral later control entry";
    expect(check()).toEqual([]);
    const comment = statement.sql;
    statement.sql += " ";
    expect(check()).toEqual([row]);
    statement.sql = comment;
    pin.statements.push({ ...statement });
    expect(check()).toEqual([row]);
    expect(unreviewedPinnedIntroductionIncreases([row], new Map([[registryPath, Buffer.from("invalid JSON")]]))).toEqual([row]);
  });

  it("admits C94 counts and regeneration on the introduction base and a later base with landed rails, retaining unrelated failures", () => {
    const { root, base } = installed();
    const sources = managedPinnedSources();
    const approved = baseline(root);
    const measured = scanSnapshots(sources);
    expect(Object.keys(measured.rows)).toHaveLength(13);
    const existing = new Map([...sources].filter(([path]) => !path.startsWith("supabase/")));
    approved.counts = { ...approved.counts, ...scanSnapshots(existing).rows };
    put(root, baselinePath, JSON.stringify(approved));
    for (const [path, bytes] of sources) if (!path.startsWith("supabase/")) put(root, path, bytes);
    let result = cli(root, base);
    expect(result.status, result.output).toBe(0);
    result = cli(root, base, "--write-baseline");
    expect(result.status, result.output).toBe(0);
    // Regeneration measures existing paths only; the original base now carries
    // fixture counts, while its next candidate introduces the exact rail copies.
    const laterBase = commit(root);
    // A landing key without its candidate file cannot consume the allowance.
    const landingBaseline = { ...baseline(root), counts: { ...baseline(root).counts, ...measured.rows } };
    put(root, baselinePath, JSON.stringify(landingBaseline));
    result = cli(root, laterBase);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(`"${hash(refundRail)}": ui-13 increased 0 -> 7`);
    for (const [path, bytes] of sources) if (path.startsWith("supabase/")) put(root, path, bytes);
    // A present rail must carry its exact baseline key.
    const missingLandingKey = { ...landingBaseline.counts };
    delete missingLandingKey[hash(refundRail)];
    put(root, baselinePath, JSON.stringify({ ...landingBaseline, counts: missingLandingKey }));
    result = cli(root, laterBase);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(`"${refundRail}": ui-13 increased 0 -> 7`);
    // Both higher and lower counts refuse despite the exact pinned file.
    for (const count of [6, 8]) {
      put(root, baselinePath, JSON.stringify({ ...landingBaseline, counts: { ...landingBaseline.counts, [hash(refundRail)]: { "ui-13": count } } }));
      result = cli(root, laterBase);
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(`pinned introduction baseline count mismatch: "${refundRail}"`);
    }
    put(root, baselinePath, JSON.stringify(landingBaseline));
    result = cli(root, laterBase);
    expect(result.status, result.output).toBe(0);
    result = cli(root, laterBase, "--write-baseline");
    expect(result.status, result.output).toBe(0);
    for (const [path, counts] of Object.entries(measured.rows)) expect(baseline(root).counts[path]).toEqual(counts);
    put(root, refundRail, Buffer.concat([sources.get(refundRail)!, Buffer.from("\n")]));
    result = cli(root, laterBase);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(`"${refundRail}": ui-13 increased 0 -> 7`);
    put(root, refundRail, sources.get(refundRail)!);
    const otherRail = refundRail.replace("185000", "185001");
    put(root, otherRail, sources.get(refundRail)!);
    put(root, baselinePath, JSON.stringify({ ...landingBaseline, counts: { ...landingBaseline.counts, [hash(otherRail)]: { "ui-13": 7 } } }));
    result = cli(root, laterBase);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(`"${otherRail}": ui-13 increased 0 -> 7`);
    rmSync(join(root, otherRail));
    put(root, baselinePath, JSON.stringify(landingBaseline));
    put(root, "src/unrelated.ts", `export const label = "${debt}";\n`);
    result = cli(root, base);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('"src/unrelated.ts": brand increased 0 -> 1');
    result = cli(root, base, "--write-baseline");
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("baseline regeneration would increase accepted debt");
  }, 60_000);

  it("subtracts only the fulfillment vendor category at its exact paths and complete carrier tokens", () => {
    const { root, base } = installed();
    const vendor = ["omni", "pack"].join("");
    const before = readFileSync(join(root, baselinePath), "utf8");
    const paths = [`packages/platform/src/fulfillment/${vendor}/client.ts`, `packages/platform/test/fulfillment/${vendor}/wire.test.ts`,
      `packages/platform/api/fulfillment-${vendor}.api.md`, "docs/platform/plans/oss-a3-fulfillment-adapter.md"];
    for (const path of paths) put(root, path, `${vendor} ${vendor.toUpperCase()}\n`);
    const carriers = ["packages/platform/package.json", "packages/platform/release-gates.json", "packages/platform/test/packageBoundary.test.ts",
      "packages/platform/README.md", "config/openlup-publication-catalog.json", "docs/platform/ARCHITECTURE_AND_EXTENSIONS.md",
      "docs/platform/CANONICAL_CONTRACTS.md", "scripts/packages/platform-cold-consumer.ts", "scripts/packages/platform-cold-consumer.test.ts",
      "packages/platform/changes/a-three.md"];
    for (const path of carriers) put(root, path, `fulfillment/${vendor}\n`);
    for (const path of [carriers[1], carriers[4]]) put(root, path, `fulfillment/${vendor} fulfillment-${vendor}.api.md\n`);
    expect(cli(root, base).status).toBe(0);
    expect(readFileSync(join(root, baselinePath), "utf8")).toBe(before);
  }, 30_000);

  it("refuses fulfillment outside-path, bare-prose, casing and lookalike plants while retaining other categories", () => {
    const vendor = ["omni", "pack"].join("");
    const plants: Array<[string, string, string]> = [
      ["src/example.ts", vendor, "ui-15"],
      [`packages/core/src/fulfillment/${vendor}/x.ts`, vendor, "ui-15"],
      [`docs/packages/platform/src/fulfillment/${vendor}/x.ts`, vendor, "ui-15"],
      [`packages/platform/lib/fulfillment/${vendor}/x.ts`, vendor, "ui-15"],
      ["docs/platform/plans/other.md", vendor, "ui-15"],
      ["packages/platform/api/other.api.md", vendor, "ui-15"],
      ["packages/platform/changes/a-three.txt", `fulfillment/${vendor}`, "ui-15"],
      ["packages/platform/README.md", `x-fulfillment/${vendor}`, "ui-15"],
      ["packages/platform/README.md", `bare ${vendor}`, "ui-15"],
      ["packages/platform/README.md", `fulfillment/${vendor}-x`, "ui-15"],
      ["packages/platform/README.md", `fulfillment/${vendor.toUpperCase()}`, "ui-15"],
      ["packages/platform/README.md", `fulfillment-${vendor}.api.md`, "ui-15"],
      [`packages/platform/src/fulfillment/${vendor}-x/client.ts`, vendor, "ui-15"],
      [`packages/platform/src/fulfillment/${vendor.toUpperCase()}/client.ts`, vendor, "ui-15"],
      ["packages/platform/changes/nested/a-three.md", `fulfillment/${vendor}`, "ui-15"],
      [`packages/platform/src/fulfillment/${vendor}/client.ts`, `${vendor} ${["str", "ipe"].join("")}`, "ui-13"],
      [`packages/platform/test/fulfillment/${vendor}/wire.test.ts`, `${vendor} ${String.fromCharCode(80, 76, 78)}`, "ui-5"],
    ];
    const cliPlants = [...plants];
    // Keep the real CLI plants above; exercise the larger matcher matrix at its
    // exported pure boundary to avoid one Git/scanner subprocess per permutation.
    const ownPaths = [`packages/platform/src/fulfillment/${vendor}/client.ts`,
      `packages/platform/test/fulfillment/${vendor}/wire.test.ts`];
    const exactPaths = [`packages/platform/api/fulfillment-${vendor}.api.md`,
      "docs/platform/plans/oss-a3-fulfillment-adapter.md"];
    for (const path of [...ownPaths, ...exactPaths, "packages/platform/changes/a-three.md"]) {
      const contents = path.includes("/changes/") ? `fulfillment/${vendor}` : vendor;
      for (const outside of [`x/${path}`, `x\n${path}`, `${path}x`, `${path}\nx`, path.toUpperCase(),
        ...path.split("/").slice(0, -1).flatMap((_segment, index) =>
          ["other", "other/nested"].map(segment => path.split("/").map((part, offset) => offset === index ? segment : part).join("/"))),
        path.replace(/\.md$/, ".txt"), path.replace(/\.api\.md$/, ".api.txt")]) {
        // Own directories intentionally allow arbitrary descendants.
        if (ownPaths.includes(path) && [`${path}x`, `${path}\nx`].includes(outside)) continue;
        if (outside !== path) plants.push([outside, contents, "ui-15"]);
      }
    }
    for (const path of exactPaths) {
      const parts = path.split("/");
      for (let index = 1; index < parts.length; index++) {
        plants.push([`${parts.slice(0, index).join("/")}/other.md`, vendor, "ui-15"],
          [`other/${parts.slice(index).join("/")}`, vendor, "ui-15"]);
      }
      for (let index = 0; index < path.length; index++) {
        if ("/.-".includes(path[index])) {
          plants.push([path.slice(0, index), vendor, "ui-15"],
            [path.slice(index + 1), vendor, "ui-15"]);
        }
      }
    }
    plants.push(["docs/platform/plans/oss-a3-other.md", vendor, "ui-15"],
      [`packages/platform/api/other-fulfillment-${vendor}.api.md`, vendor, "ui-15"],
      ["packages/platform/changes/a-three.mdx", `fulfillment/${vendor}`, "ui-15"]);
    const carriers = ["packages/platform/package.json", "packages/platform/release-gates.json", "packages/platform/test/packageBoundary.test.ts",
      "packages/platform/README.md", "config/openlup-publication-catalog.json", "docs/platform/ARCHITECTURE_AND_EXTENSIONS.md",
      "docs/platform/CANONICAL_CONTRACTS.md", "scripts/packages/platform-cold-consumer.ts", "scripts/packages/platform-cold-consumer.test.ts"];
    for (const path of carriers) {
      for (const outside of [`x/${path}`, `${path}x`, `${path}/extra`, `x\n${path}`, `${path}\nx`, path.toUpperCase()]) {
        plants.push([outside, `fulfillment/${vendor}`, "ui-15"]);
      }
      for (const contents of [`Xfulfillment/${vendor}`, `-fulfillment/${vendor}`, `fulfillment/${vendor}X`,
        `fulfillment/${vendor}-`, `FULFILLMENT/${vendor}`, `fulfillment/${vendor.toUpperCase()}`,
        `other/${vendor}`, `other/nested/${vendor}`, "fulfillment/other"]) {
        plants.push([path, contents, "ui-15"]);
      }
    }
    for (const path of ["packages/platform/release-gates.json", "config/openlup-publication-catalog.json"]) {
      const report = `fulfillment-${vendor}.api.md`;
      for (const contents of [
        ...["X", "-", "."].map(prefix => `${prefix}${report}`),
        ...["X", ".", "/", "-"].map(suffix => `${report}${suffix}`),
        report.toUpperCase(), `FULFILLMENT-${vendor}.api.md`, `fulfillment-${vendor.toUpperCase()}.api.md`,
        `fulfillment-${vendor}.API.md`, `fulfillment-${vendor}.api.MD`,
        `fulfillment-${vendor}.api.txt`, `fulfillment-${vendor}.other.md`, `other-${vendor}.api.md`,
        `fulfillment-other-${vendor}.api.md`, `fulfillment-${vendor}-other.api.md`,
        `fulfillment-${vendor}/nested.api.md`, `fulfillment-${vendor}Xapi.md`, `fulfillment-${vendor}.apiXmd`,
      ]) plants.push([path, contents, "ui-15"]);
    }
    for (const [path, contents, category] of plants) {
      if (category === "ui-15") expect(allowedFulfillmentAdapterWords(path, contents), JSON.stringify([path, contents])).toBe(0);
    }
    const { root, base } = installed();
    for (const [path, contents, category] of cliPlants) {
      put(root, path, contents);
      const result = cli(root, base);
      expect(result.status, result.output).toBe(1); expect(result.output).toContain(`${category} increased`);
      rmSync(join(root, path));
    }
  }, 30_000);

  it("fails closed when the fulfillment allowance exceeds the ui-15 scanner count", () => {
    const vendor = ["omni", "pack"].join("");
    const path = `packages/platform/src/fulfillment/${vendor}/client.ts`;
    const invoke = vi.mocked(execFileSync);
    invoke.mockReturnValueOnce(JSON.stringify({ counts: [{ path, counts: { "ui-15": 1 } }],
      policy: { rules: [{ id: "tree-brand", terms: [debt] }] } }));
    invoke.mockReturnValueOnce(JSON.stringify([]));
    try {
      expect(() => scanSnapshots(new Map([[path, Buffer.from(`${vendor} ${vendor}`)]])))
        .toThrow(`neutrality allowance over-subtracted ui-15 in ${JSON.stringify(path)}: -1`);
    } finally { invoke.mockClear(); }
  });

  it("fails closed when the communications allowance exceeds the ui-12 scanner count", () => {
    const vendor = ["res", "end"].join("");
    const path = `packages/platform/src/communications/${vendor}/index.ts`;
    const invoke = vi.mocked(execFileSync);
    invoke.mockReturnValueOnce(JSON.stringify({ counts: [{ path, counts: { "ui-12": 1 } }],
      policy: { rules: [{ id: "tree-brand", terms: [debt] }] } }));
    invoke.mockReturnValueOnce(JSON.stringify([]));
    try {
      expect(() => scanSnapshots(new Map([[path, Buffer.from(`${vendor} ${vendor}`)]])))
        .toThrow(`neutrality allowance over-subtracted ui-12 in ${JSON.stringify(path)}: -1`);
    } finally { invoke.mockClear(); }
  });

  it.each(["brand", "ui-0", "ui-2"])("fails closed when the adoption allowance exceeds the %s scanner count", category => {
    const path = "README.md";
    const display = debt[0].toUpperCase() + debt.slice(1);
    const contents = `Shaped by real subscription-commerce work at [${display}](https://${debt}.com/)\n`
      + `OpenLup's development is grounded in [${display}](https://${debt}.com/), a D2C\n`;
    const counts = { [category]: 1 };
    const invoke = vi.mocked(execFileSync);
    invoke.mockReturnValueOnce(JSON.stringify({ counts: category === "brand" ? [] : [{ path, counts }],
      policy: { rules: [{ id: "tree-brand", terms: [debt] }] } }));
    invoke.mockReturnValueOnce(JSON.stringify(category === "brand" ? [{ path, counts }] : []));
    try {
      expect(() => scanSnapshots(new Map([[path, Buffer.from(contents)]])))
        .toThrow(`neutrality allowance over-subtracted ${category} in ${JSON.stringify(path)}: ${category === "ui-2" ? -1 : -3}`);
    } finally { invoke.mockClear(); }
  });

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
