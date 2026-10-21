import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_EXECUTION_ENTRYPOINTS } from "./oss-publication-contract.ts";
import { PUBLIC_PACKAGE_COMMANDS, PUBLIC_PACKAGE_EXECUTION_SURFACES, createPublicPublicationCatalog } from "./oss-publication-policy.ts";
import * as sourceContract from "./oss-source-release-contract.ts";
import { SOURCE_RELEASE_CONTRACT_PATH, assertSourceReleaseSnapshot, createSourceReleaseContract } from "./oss-source-release-contract.ts";
import { policyVerdict, publicInventoryVerdict } from "./oss-published-tree-check.ts";
import { prepareSourceRelease } from "./source-release-preparation.ts";
import { packageReleaseInputs, preflightPackageRelease, preflightSetRelease, preparePackageRelease, setReleaseInputs } from "./packages/package-release.ts";
import { bumpSet } from "./packages/release-bump.ts";

const ROOT = resolve(import.meta.dirname, "..");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const zero = `sha256-${"0".repeat(64)}`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "carry-source-")); roots.push(root);
  const write = (path: string, text: string | Buffer) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: root, encoding: "utf8" }).trim();
  git("init", "-qb", "main");
  for (const path of PUBLIC_EXECUTION_ENTRYPOINTS) write(path, "public fixture\n");
  for (const { path } of PUBLIC_PACKAGE_EXECUTION_SURFACES) write(path, path === "package.json" ? JSON.stringify({ workspaces: JSON.parse(readFileSync(join(ROOT, path), "utf8")).workspaces, scripts: Object.fromEntries(PUBLIC_PACKAGE_COMMANDS.map(({ name, command }) => [name, command])) }) : readFileSync(join(ROOT, path)));
  write("README.md", "# Fixture\n");
  write("docs/platform/adopter-kit/dependabot.template.yml", 'groups:\n  openlup:\n    patterns:\n      - "@openlup/*"\n');
  write("packages/platform/src/middle/index.ts", "export const middle = 1;\n");
  write("package-lock.json", "{}\n"); write("packages/core/package-lock.json", "{}\n");
  write("src/integrations/supabase/types.ts", "export type Database = never;\n");
  const baseline = "db/platform/migrations/00000000000000_platform_baseline.sql", sql = "select 1;\n";
  write(baseline, sql);
  write("config/platform-migration-manifest.json", JSON.stringify({ schemaVersion: 1, baseline: { file: baseline, sha256: createHash("sha256").update(sql).digest("hex") }, forward: [], objectInventorySha256: "0".repeat(64) }));
  write("config/openlup-policy-registry.json", JSON.stringify({ schemaVersion: 1, activePaths: ["README.md"], contracts: [{ id: "fixture", owners: ["README.md"] }] }));
  write("config/openlup-packages.json", JSON.stringify({ schemaVersion: 2, packages: [{ name: "@openlup/core", directory: "packages/core", publish: true }], unreleased: [] }));
  write("packages/core/CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n\n## [0.17.0]\n\n- Previous.\n");
  write(SOURCE_RELEASE_CONTRACT_PATH, createSourceReleaseContract({ inventoryDigest: zero, classDigest: zero, packageDigest: zero, rootLockDigest: zero, coreLockDigest: zero, migrationManifestDigest: zero, databaseTypesDigest: zero, policyRegistryDigest: zero, publicationCatalogDigest: zero }).contents);
  write("config/openlup-publication-catalog.json", "{}"); git("add", ".");
  const paths = git("ls-files").split("\n");
  write("config/openlup-publication-catalog.json", createPublicPublicationCatalog(paths.map((path) => ({ path, class: "public-output" })), []).contents);
  const commit = () => { git("add", "."); git("commit", "-qm", "fixture"); return git("rev-parse", "HEAD"); };
  commit();
  return { root, read, write, git, commit };
}

describe("release-only source snapshots", () => {
  it("bump stages only consumed fragment deletions, then preparation write and check succeed", () => {
    const f = fixture(), fragments = ["packages/core/changes/a-one.md", "packages/core/changes/z-two.md"];
    f.write("package-lock.json", JSON.stringify({ packages: { "packages/core": { version: "0.17.0" } } }, null, 2));
    f.write("packages/core/package-lock.json", JSON.stringify({ version: "0.17.0", packages: { "": { version: "0.17.0" } } }, null, 2));
    for (const path of fragments) f.write(path, "- A change.\n");
    f.commit();
    f.write("README.md", "# Unrelated edit\n");
    f.write("packages/platform/changes/not-consumed.md", "- Another package.\n");
    f.git("add", "packages/platform/changes/not-consumed.md");
    const staged = f.git("diff", "--cached", "--binary");
    f.write(fragments[0]!, "## Invalid fragment\n");
    expect(() => bumpSet(f.root, "0.18.0")).toThrow(/fragment/);
    expect(f.git("diff", "--cached", "--binary")).toBe(staged);
    f.write(fragments[0]!, "- A change.\n");
    bumpSet(f.root, "0.18.0");
    expect(f.git("diff", "--cached", "--name-status").split("\n")).toEqual([...fragments.map((path) => `D\t${path}`), "A\tpackages/platform/changes/not-consumed.md"]);
    for (const path of fragments) expect(f.git("ls-files", "--", path)).toBe("");
    expect(f.git("diff", "--cached", "--binary", "--", "packages/platform")).toBe(staged);
    expect(prepareSourceRelease(f.root, "--write", () => {})).toBe(true);
    expect(prepareSourceRelease(f.root, "--check", () => {})).toBe(false);
  });
  it("bump stages consumed fragment names literally, never as glob pathspecs", () => {
    const f = fixture(), consumed = "packages/core/changes/a[1].md", sibling = "packages/core/changes/a1.md";
    f.write("package-lock.json", JSON.stringify({ packages: { "packages/core": { version: "0.17.0" } } }, null, 2));
    f.write("packages/core/package-lock.json", JSON.stringify({ version: "0.17.0", packages: { "": { version: "0.17.0" } } }, null, 2));
    f.write(consumed, "- A change.\n"); f.write(sibling, "- Another change.\n");
    f.commit();
    rmSync(join(f.root, sibling));
    bumpSet(f.root, "0.18.0");
    expect(f.git("diff", "--cached", "--name-status").split("\n")).toEqual([`D\t${consumed}`]);
    expect(f.git("ls-files", "--", sibling)).toContain(sibling);
  });
  it("PR policy/inventory recompute stale bindings; write is idempotent; check is strict and read-only", () => {
    const f = fixture(), stale = f.read(SOURCE_RELEASE_CONTRACT_PATH), lines: string[] = [];
    expect(policyVerdict(f.root, (line) => lines.push(line))).toBe(true);
    expect(publicInventoryVerdict(f.root, (line) => lines.push(line))).toBe(true);
    expect(lines.join("\n")).toContain("computed bindings ok; committed snapshot stale (refreshed at release prep)");
    expect(() => prepareSourceRelease(f.root, "--check", () => {})).toThrow(/byte-for-byte/);
    expect(f.read(SOURCE_RELEASE_CONTRACT_PATH)).toBe(stale);
    expect(prepareSourceRelease(f.root, "--write", () => {})).toBe(true);
    const fresh = f.read(SOURCE_RELEASE_CONTRACT_PATH); expect(fresh).not.toBe(stale);
    expect(prepareSourceRelease(f.root, "--write", () => {})).toBe(false);
    expect(prepareSourceRelease(f.root, "--check", () => {})).toBe(false);
    const head = f.commit(); expect(() => assertSourceReleaseSnapshot(f.root, head)).not.toThrow();
    f.write("package.json", f.read("package.json") + "\n"); const changed = f.commit();
    expect(() => assertSourceReleaseSnapshot(f.root, changed)).toThrow(/byte-for-byte/);
    expect(() => assertSourceReleaseSnapshot(f.root, head)).not.toThrow();
  });
  it("refuses missing catalog rows, invalid authored fields and generator failure without writing", () => {
    const f = fixture(), before = f.read(SOURCE_RELEASE_CONTRACT_PATH);
    f.write("packages/platform/src/new.ts", "export const value = 1;\n"); f.git("add", ".");
    expect(() => policyVerdict(f.root, () => {})).toThrow(/inventory mismatch/);
    expect(() => prepareSourceRelease(f.root, "--write", () => {})).toThrow(/inventory mismatch/);
    expect(f.read(SOURCE_RELEASE_CONTRACT_PATH)).toBe(before);
    f.git("rm", "-f", "packages/platform/src/new.ts");
    const raw = JSON.parse(before); raw.runtime.node = "1.x"; f.write(SOURCE_RELEASE_CONTRACT_PATH, JSON.stringify(raw));
    expect(() => policyVerdict(f.root, () => {})).toThrow(/release posture/);
    f.write(SOURCE_RELEASE_CONTRACT_PATH, before); rmSync(join(f.root, "package-lock.json"));
    expect(() => prepareSourceRelease(f.root, "--write", () => {})).toThrow(); expect(f.read(SOURCE_RELEASE_CONTRACT_PATH)).toBe(before);
  });
  it("a broken generator refuses PR policy/inventory and preparation before any snapshot write", () => {
    const f = fixture(), before = f.read(SOURCE_RELEASE_CONTRACT_PATH);
    const broken = vi.spyOn(sourceContract, "deriveSourceReleaseContract").mockImplementation(() => { throw new Error("planted generator failure"); });
    try {
      for (const run of [() => policyVerdict(f.root, () => {}), () => publicInventoryVerdict(f.root, () => {}), () => prepareSourceRelease(f.root, "--write", () => {})]) expect(run).toThrow("planted generator failure");
      expect(f.read(SOURCE_RELEASE_CONTRACT_PATH)).toBe(before);
    } finally { broken.mockRestore(); }
  });
  it("package preflight/protected prepare/set and resume refuse stale exact targets before reads or writes; fresh passes", async () => {
    const f = fixture(), head = f.git("rev-parse", "HEAD"), input = packageReleaseInputs("core", "0.17.0", head, "note\n");
    const out = mkdtempSync(join(tmpdir(), "carry-notes-")); roots.push(out);
    const network = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(preflightPackageRelease(f.root, input, undefined, network, () => {})).rejects.toThrow(/byte-for-byte/);
    await expect(preparePackageRelease(f.root, input, out, undefined, network, () => {})).rejects.toThrow(/byte-for-byte/);
    expect(() => preflightSetRelease(f.root, setReleaseInputs("0.17.0", head, "note"), () => {})).toThrow(/byte-for-byte/);
    expect(network).not.toHaveBeenCalled(); expect(existsSync(join(out, "notes.md"))).toBe(false);
    const fetchStub = join(out, "fetch.mjs");
    writeFileSync(fetchStub, "globalThis.fetch = async () => new Response(null, { status: 404 });\n");
    const resume = () => spawnSync(process.execPath, ["--import", fetchStub, "--experimental-strip-types", join(ROOT, "scripts/packages/package-release.ts"), "registry"], { cwd: f.root, encoding: "utf8", env: { ...Reflect.get(process, "env"), RELEASE_TAG: input.tag }, timeout: 10000 });
    expect(resume()).toMatchObject({ status: 1, stderr: expect.stringContaining("byte-for-byte") });
    prepareSourceRelease(f.root, "--write", () => {}); const fresh = f.commit(), ready = { ...input, target: fresh };
    await expect(preflightPackageRelease(f.root, ready, undefined, network, () => {})).resolves.toBeUndefined();
    await expect(preparePackageRelease(f.root, ready, out, undefined, network, () => {})).resolves.toBeUndefined();
    expect(() => preflightSetRelease(f.root, setReleaseInputs("0.17.0", fresh, "note"), () => {})).not.toThrow();
    expect(resume()).toMatchObject({ status: 0 });
    f.write("packages/core/CHANGELOG.md", f.read("packages/core/CHANGELOG.md") + "- Worktree drift.\n");
    expect(resume()).toMatchObject({ status: 1, stderr: expect.stringContaining("target commit without tracked changes") });
    await expect(preparePackageRelease(f.root, ready, out, undefined, network, () => {})).rejects.toThrow(/target commit without tracked changes/);
    f.git("restore", "packages/core/CHANGELOG.md");
    f.write("package.json", f.read("package.json") + "\n"); const changed = f.commit();
    await expect(preflightPackageRelease(f.root, { ...ready, target: changed }, undefined, network, () => {})).rejects.toThrow(/byte-for-byte/);
    expect(resume()).toMatchObject({ status: 1, stderr: expect.stringContaining("byte-for-byte") });
  });
  it("disjoint module branches merge cleanly on CHANGELOG, contract and catalog and pass live policy/inventory", () => {
    const f = fixture(); prepareSourceRelease(f.root, "--write", () => {}); const base = f.commit();
    const add = (name: string) => {
      f.write(`packages/platform/src/${name}/index.ts`, `export const ${name} = 1;\n`);
      f.write(`packages/platform/changes/${name}-one.md`, `- Add ${name}.\n`);
      const catalog = JSON.parse(f.read("config/openlup-publication-catalog.json"));
      catalog.publicPaths.push({ path: `packages/platform/src/${name}/index.ts`, class: "public-output" }); catalog.publicPaths.sort((a: { path: string }, b: { path: string }) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      f.write("config/openlup-publication-catalog.json", `${JSON.stringify(catalog, null, 2)}\n`); return f.commit();
    };
    f.git("checkout", "-qb", "left"); const left = add("alpha"); f.git("checkout", "-qb", "right", base); const right = add("zeta");
    const merge = f.git("merge-tree", "--write-tree", left, right); expect(merge).toMatch(/^[a-f0-9]{40}$/);
    f.git("read-tree", "--reset", "-u", merge);
    expect(f.read(SOURCE_RELEASE_CONTRACT_PATH)).toBe(f.git("show", `${base}:${SOURCE_RELEASE_CONTRACT_PATH}`) + "\n");
    expect(f.read("packages/core/CHANGELOG.md")).toBe(f.git("show", `${base}:packages/core/CHANGELOG.md`) + "\n");
    expect(policyVerdict(f.root, () => {})).toBe(true); expect(publicInventoryVerdict(f.root, () => {})).toBe(true);
    for (const path of ["packages/platform/changes/alpha-one.md", "packages/platform/changes/zeta-one.md"]) {
      chmodSync(join(f.root, path), 0o755); expect(() => policyVerdict(f.root, () => {})).toThrow(/non-executable/); chmodSync(join(f.root, path), 0o644);
    }
  });
});
