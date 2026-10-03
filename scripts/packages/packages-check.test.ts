import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_REPOSITORY_URL } from "./package-manifest-policy.ts";
import { PACKAGES_MANIFEST_FILE, assertMigrationBlocks, runPackagesCheck } from "./packages-check.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
const quiet = () => { vi.spyOn(console, "log").mockImplementation(() => undefined); return vi.spyOn(console, "error").mockImplementation(() => undefined); };
const git = (root: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, stdio: "ignore" });
const build = "node -e \"require('node:fs').mkdirSync('dist',{recursive:true});require('node:fs').writeFileSync('dist/a.js','export const a = 1;\\n')\"";

/** A repository with one private and one publishable package, and `extra` files; each build writes dist/a.js from src/a.ts. */
function fixture(extra: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "packages-check-"));
  roots.push(root);
  const write = (path: string, contents: string) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), contents); };
  write("config/openlup-packages.json", JSON.stringify({ schemaVersion: 2, packages: [{ name: "@openlup/demo", directory: "packages/demo", publish: false }, { name: "@openlup/pub", directory: "packages/pub", publish: true }], unreleased: [] }));
  write("packages/demo/package.json", JSON.stringify({ name: "@openlup/demo", version: "0.1.0", private: true, files: ["dist/**"], exports: { ".": "./dist/a.js" }, scripts: { build } }, null, 2));
  write("packages/pub/package.json", JSON.stringify({ name: "@openlup/pub", version: "0.4.0", license: "Apache-2.0", files: ["dist/**"], publishConfig: { access: "public", provenance: true, tag: "preview" }, repository: { type: "git", url: PUBLIC_REPOSITORY_URL, directory: "packages/pub" }, exports: { ".": "./dist/a.js" }, scripts: { build } }, null, 2));
  for (const name of ["demo", "pub"]) write(`packages/${name}/src/a.ts`, "export const a = 1;\n");
  write(".gitignore", "dist/\nout/\n");
  for (const [path, contents] of Object.entries(extra)) write(path, contents);
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "fixture");
  return root;
}

describe("packages:check", () => {
  it("passes on the committed repository and refuses malformed arguments", () => {
    quiet();
    expect(runPackagesCheck(process.cwd(), [])).toBe(0);
    expect(runPackagesCheck(process.cwd(), ["--publish"])).toBe(2);
    expect(runPackagesCheck(process.cwd(), ["--out"])).toBe(2);
    expect(runPackagesCheck(process.cwd(), ["--release-tag", "--pack"])).toBe(2);
  });
  it("packs clean packages and refuses a dirty one", () => {
    const errors = quiet();
    const root = fixture();
    expect(runPackagesCheck(root, ["--pack"])).toBe(0);
    writeFileSync(join(root, "packages/demo/src/a.ts"), "export const a = 2;\n");
    expect(runPackagesCheck(root, ["--pack"])).toBe(1);
    expect(errors.mock.calls.flat().join("\n")).toMatch(/dirty-tree/);
  }, 60_000);
  it("keeps only publishable tarballs, with a manifest of their versions and digests", () => {
    quiet();
    const root = fixture();
    expect(runPackagesCheck(root, ["--out", "out", "--release-tag", "openlup-pub-v0.4.0"])).toBe(0);
    const manifest = JSON.parse(readFileSync(join(root, "out", PACKAGES_MANIFEST_FILE), "utf8"));
    expect(manifest).toMatchObject({ schemaVersion: 2, packages: [{ name: "@openlup/pub", version: "0.4.0", filename: "openlup-pub-0.4.0.tgz" }] });
    expect(manifest).not.toHaveProperty("version");
    expect(manifest.commit).toBe(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
    const tarball = readFileSync(join(root, "out", "openlup-pub-0.4.0.tgz"));
    expect(manifest.packages[0].sha256).toBe(createHash("sha256").update(tarball).digest("hex"));
    expect(existsSync(join(root, "out", "openlup-demo-0.1.0.tgz"))).toBe(false);
    expect(runPackagesCheck(root, ["--out", "out"])).toBe(2);
    writeFileSync(join(root, "a-file"), "x");
    expect(runPackagesCheck(root, ["--out", "a-file"])).toBe(2);
  }, 60_000);
  it("keeps nothing when a check finds anything", () => {
    quiet();
    const root = fixture();
    expect(runPackagesCheck(root, ["--out", "out", "--release-tag", "openlup-pub-v1.5.0"])).toBe(1);
    expect(existsSync(join(root, "out"))).toBe(false);
  }, 60_000);
  it("packs only the package a release tag names", () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const root = fixture();
    expect(runPackagesCheck(root, ["--pack", "--release-tag", "openlup-pub-v0.4.0"])).toBe(0);
    const packed = logs.mock.calls.flat().filter((line) => String(line).startsWith("packed "));
    expect(packed).toEqual([expect.stringMatching(/^packed @openlup\/pub@0\.4\.0: openlup-pub-0\.4\.0\.tgz, /u)]);
  }, 60_000);
  it("resolves an absolute out directory as given", () => {
    quiet();
    const root = fixture();
    const outside = mkdtempSync(join(tmpdir(), "packages-out-"));
    roots.push(outside);
    expect(runPackagesCheck(root, ["--out", outside])).toBe(0);
    expect(existsSync(join(outside, PACKAGES_MANIFEST_FILE))).toBe(true);
  }, 60_000);
  it("requires a release tag to name a publishable package at its manifest version", () => {
    const errors = quiet();
    const root = fixture();
    const refusal = (tag: string) => { errors.mockClear(); expect(runPackagesCheck(root, ["--release-tag", tag]), tag).toBe(1); return errors.mock.calls.flat().join("\n"); };
    expect(runPackagesCheck(root, ["--release-tag", "openlup-pub-v0.4.0"])).toBe(0);
    expect(refusal("openlup-pub-v0.4.1")).toMatch(/^release-version openlup-pub-v0\.4\.1: @openlup\/pub is at 0\.4\.0; this release needs 0\.4\.1$/mu);
    expect(refusal("openlup-demo-v0.1.0")).toMatch(/^release-tag openlup-demo-v0\.1\.0: packages\/demo is not a publishable package/mu);
    expect(refusal("openlup-absent-v1.0.0")).toMatch(/^release-tag openlup-absent-v1\.0\.0: packages\/absent is not a publishable package/mu);
    for (const tag of ["openlup-source-preview/1", "v1.4.0", "x-openlup-pub-v1.4.0", "openlup-pub-v1.4.0-rc.1", "openlup-pub-v1.4.0x", "openlup-pub-v01.4.0"]) expect(refusal(tag)).toMatch(/^release-tag .*: a package release tag is openlup-<package>-v<MAJOR\.MINOR\.PATCH>$/mu);
  });
  it("admits only publishable packages to a release tag, a set and the kept tarballs", () => {
    const errors = quiet();
    const config = { schemaVersion: 2, packages: [{ name: "@openlup/demo", directory: "packages/demo", publish: false }, { name: "@openlup/pub", directory: "packages/pub", publish: true }], unreleased: [{ directory: "packages/next", reason: "a module still in progress" }] };
    const root = fixture({ "config/openlup-packages.json": JSON.stringify(config), "packages/next/package.json": JSON.stringify({ name: "@openlup/next", version: "0.4.0", private: true, exports: { ".": "./dist/a.js" }, scripts: { build } }) });
    const kept = (args: string[]) => { const out = mkdtempSync(join(tmpdir(), "packages-out-")); roots.push(out); expect(runPackagesCheck(root, ["--out", out, ...args]), args.join(" ")).toBe(0); return readdirSync(out).sort(); };
    for (const args of [[], ["--release-set", "0.4.0"], ["--release-tag", "openlup-pub-v0.4.0"]]) expect(kept(args), args.join(" ")).toEqual(["openlup-pub-0.4.0.tgz", PACKAGES_MANIFEST_FILE]);
    expect(runPackagesCheck(root, ["--release-tag", "openlup-next-v0.4.0"])).toBe(1);
    expect(errors.mock.calls.flat().join("\n")).toMatch(/^release-tag openlup-next-v0\.4\.0: packages\/next is not a publishable package/mu);
    const stray = fixture({ "packages/stray/package.json": JSON.stringify({ name: "@openlup/stray", version: "0.4.0", private: true }) });
    errors.mockClear();
    expect(runPackagesCheck(stray, ["--out", "out", "--release-set", "0.4.0"])).toBe(1);
    expect(errors.mock.calls.flat().join("\n")).toMatch(/^unlisted-package packages\/stray: /mu);
    expect(existsSync(join(stray, "out"))).toBe(false);
  }, 120_000);
});

describe("API snapshot Migration blocks", () => {
  const declarations = ["export declare const a: number;", "export declare const b: number;"];
  const snapshot = (lines: readonly string[], maturity = "candidate") => `# . API declaration snapshot\n\nMaturity: **${maturity}**.\n\nGenerated by \`npm run api:update\`. Every change requires explicit review.\n\n## dist/a.d.ts\n\n\`\`\`ts\n${lines.join("\n")}\n\`\`\`\n`;
  const changelog = (unreleased: string) => `# Changelog\n\n${unreleased}## [0.4.0]\n\n- An older change.\n\n  Migration: an older block, which does not count.\n`;
  const UNRELEASED = "## [Unreleased]\n\n- A change.\n\n", BLOCK = "## [Unreleased]\n\n- A change.\n\n  Migration: before `a: number`, after `a: string`.\n\n";
  const head = (root: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const gates = (surface: Record<string, string>) => JSON.stringify({ packageSurface: Object.fromEntries(Object.entries(surface).map(([key, snapshot]) => [key, { snapshot }])) });
  /** Both packages with one API snapshot, and `overrides`, at a base commit, and `change` committed on top of it as the head; the check, ready to run. */
  function compare(change: (write: (path: string, contents: string) => void, root: string) => void, overrides: Record<string, string> = {}): () => void {
    const root = fixture({ ...Object.fromEntries(["demo", "pub"].flatMap((name) => [[`packages/${name}/release-gates.json`, gates({ ".": "api/a.api.md" })], [`packages/${name}/api/a.api.md`, snapshot(declarations)], [`packages/${name}/CHANGELOG.md`, changelog(UNRELEASED)]])), ...overrides });
    const base = head(root);
    change((path, contents) => writeFileSync(join(root, path), contents), root);
    for (const args of [["add", "-A"], ["commit", "-qm", "head"]]) execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: root, stdio: "ignore" });
    return () => assertMigrationBlocks(root, base, head(root));
  }
  const SNAPSHOT = "packages/pub/api/a.api.md", removed = snapshot(declarations.slice(0, 1));
  const red = /^migration-block @openlup\/pub: packages\/pub\/api\/a\.api\.md removes or changes a declaration line since [0-9a-f]{40}, and its "## \[Unreleased\]" section has no Migration: block; /u;

  it("requires a Migration: block for a removed or changed declaration of a publishable package", () => {
    expect(compare((write) => write(SNAPSHOT, removed)), "a removed declaration").toThrow(red);
    expect(compare((write) => write(SNAPSHOT, snapshot(["export declare const a: string;", declarations[1]!]))), "a changed declaration").toThrow(red);
    expect(compare((_, root) => rmSync(join(root, SNAPSHOT))), "a removed snapshot").toThrow(red);
    for (const unreleased of ["", `${BLOCK}${BLOCK}`]) expect(compare((write) => { write(SNAPSHOT, removed); write("packages/pub/CHANGELOG.md", changelog(unreleased)); }), "not one Unreleased section").toThrow(/CHANGELOG\.md has [02] "## \[Unreleased\]" sections, not one/u);
  }, 60_000);
  it("needs no block for a pure addition, a header change or a package that is not publishable", () => {
    expect(compare((write) => { write(SNAPSHOT, removed); write("packages/pub/CHANGELOG.md", changelog(BLOCK)); }), "a removal with its block").not.toThrow();
    expect(compare((write) => write(SNAPSHOT, snapshot([...declarations, "export declare const c: number;"]))), "a pure addition").not.toThrow();
    expect(compare((write) => write(SNAPSHOT, snapshot(declarations, "experimental"))), "a header change").not.toThrow();
    expect(compare((write) => write("packages/demo/api/a.api.md", removed)), "a removal in a package that is not publishable").not.toThrow();
  }, 60_000);
  it("compares each base subpath with the head's snapshot for it, in order, and counts only a Migration: at a line start", () => {
    const GATES = "packages/pub/release-gates.json", renamed = (write: (path: string, contents: string) => void, root: string, key: string) => { write(GATES, gates({ [key]: "api/b.api.md" })); rmSync(join(root, SNAPSHOT)); write("packages/pub/api/b.api.md", snapshot(declarations)); };
    expect(compare((write) => write(GATES, gates({}))), "a subpath removed, its snapshot left in place").toThrow(red);
    expect(compare((_, root) => rmSync(join(root, GATES))), "the head release-gates.json removed").toThrow(red);
    expect(compare((write, root) => renamed(write, root, "./b")), "a subpath renamed with its snapshot").toThrow(red);
    expect(compare((write, root) => { renamed(write, root, "./b"); write("packages/pub/CHANGELOG.md", changelog(BLOCK)); }), "a renamed subpath with its block").not.toThrow();
    expect(compare((write, root) => renamed(write, root, ".")), "a snapshot moved under the same subpath").not.toThrow();
    expect(compare((write) => write(SNAPSHOT, snapshot([...declarations].reverse()))), "a reordered snapshot").toThrow(red);
    expect(compare((write) => { write(SNAPSHOT, removed); write("packages/pub/CHANGELOG.md", changelog("## [Unreleased]\n\n- Mentions a Migration: later\n\n")); }), "a mid-line Migration:").toThrow(red);
  }, 60_000);
  it("normalises base snapshot paths and refuses a base gates file or snapshot it cannot read or that lies outside the package", () => {
    const touch = (write: (path: string, contents: string) => void) => write("packages/pub/CHANGELOG.md", changelog(BLOCK));
    for (const spelling of ["api/./a.api.md", "api//a.api.md"]) expect(compare((write) => write(SNAPSHOT, removed), { "packages/pub/release-gates.json": gates({ ".": spelling }) }), spelling).toThrow(red);
    expect(compare((write) => write(SNAPSHOT, removed), { "packages/pub/release-gates.json": gates({ ".": "../demo/api/a.api.md" }) }), "outside").toThrow(/^migration-block: packages\/pub\/release-gates\.json lists the snapshot \.\.\/demo\/api\/a\.api\.md, which is not a path inside packages\/pub$/u);
    expect(compare(touch, { "packages/pub/release-gates.json": gates({ ".": "api/a.api.md", "./gone": "api/gone.api.md" }) }), "a snapshot absent at the base").toThrow(/^migration-block: packages\/pub\/api\/gone\.api\.md cannot be read at the base [0-9a-f]{40}$/u);
    expect(compare(touch, { "packages/pub/release-gates.json": "{}" }), "a base gates file without packageSurface").toThrow(/^migration-block: packages\/pub\/release-gates\.json at [0-9a-f]{40} has no packageSurface object$/u);
    const config = JSON.stringify({ schemaVersion: 2, packages: [{ name: "@openlup/pub", directory: "packages/pub", publish: true }, { name: "@openlup/gone", directory: "packages/gone", publish: true }], unreleased: [{ directory: "packages/demo", reason: "a fixture" }] });
    expect(compare(touch, { "config/openlup-packages.json": config }), "a gates file absent at the base").toThrow(/^migration-block: packages\/gone\/release-gates\.json cannot be read at the base [0-9a-f]{40}$/u);
  }, 60_000);
  it("checks the packages publishable at the base", () => {
    const config = (demo: boolean, pub: boolean) => JSON.stringify({ schemaVersion: 2, packages: [{ name: "@openlup/demo", directory: "packages/demo", publish: demo }, ...(pub ? [{ name: "@openlup/pub", directory: "packages/pub", publish: true }] : [])], unreleased: pub ? [] : [{ directory: "packages/pub", reason: "withdrawn" }] });
    expect(compare((write) => { write(SNAPSHOT, removed); write("config/openlup-packages.json", config(false, false)); }), "un-admitted at the head").toThrow(red);
    expect(compare((write) => { write("packages/demo/api/a.api.md", removed); write("config/openlup-packages.json", config(true, true)); }), "admitted at the head").not.toThrow();
  }, 60_000);
  it("ignores doc comments and reads each specifier of a one-line export list as its own line", () => {
    const listed = (names = "a, b, c", doc = "/** The first. */", added: readonly string[] = []) => snapshot([doc, declarations[0]!, `${declarations[1]} /* trailing */`, ...added, `export { ${names}, } from "./x.js";`, 'export type { T } from "./t.js";']);
    const from = (after: string) => compare((write) => write(SNAPSHOT, after), { [SNAPSHOT]: listed() });
    expect(from(listed("a, b, c, d")), "a name added at the end").not.toThrow();
    expect(from(listed("a, d, b, c")), "a name added in the middle").not.toThrow();
    expect(from(listed(undefined, "/** The first, reworded. */")), "a reworded doc comment").not.toThrow();
    expect(from(listed(undefined, "/**\n * The first,\n * over three lines.\n */", ["/** @beta */"])), "doc comments added").not.toThrow();
    expect(from(listed("a, b, normalize, c", "/** The first, reworded. */", ["/** Normalises a request. */", "export declare function normalize(request: string): string;"])), "a reworded comment, a new declaration and its name in the list").not.toThrow();
    for (const names of ["a, c", "a, b"]) expect(from(listed(names)), `a name removed: ${names}`).toThrow(red);
    expect(from(listed("a as d, b, c")), "a specifier renamed").toThrow(red);
    expect(from(listed().replace('export type { T } from "./t.js";', 'export { T } from "./t.js";')), "the type keyword dropped").toThrow(red);
    expect(from(listed().replace('"./x.js"', '"./y.js"')), "the from clause changed").toThrow(red);
    expect(from(listed().replace(declarations[0]!, "export declare const a: string;")), "a declaration changed under an unchanged comment").toThrow(red);
    expect(from(listed().replace(`${declarations[1]} /* trailing */`, "export declare const b: string; /* trailing */")), "a declaration with a trailing comment changed").toThrow(red);
  }, 120_000);
  it("refuses, block or not, a head the next pull request could not read as its base", () => {
    const both = JSON.stringify({ schemaVersion: 2, packages: ["demo", "pub"].map((name) => ({ name: `@openlup/${name}`, directory: `packages/${name}`, publish: true })), unreleased: [] });
    const blocked = (write: (path: string, contents: string) => void) => { write(SNAPSHOT, removed); for (const name of ["demo", "pub"]) write(`packages/${name}/CHANGELOG.md`, changelog(BLOCK)); };
    const admitted = (write: (path: string, contents: string) => void) => { blocked(write); write("config/openlup-packages.json", both); };
    expect(compare((write, root) => { blocked(write); rmSync(join(root, "config/openlup-packages.json")); }), "no config at the head").toThrow(/^migration-block: config\/openlup-packages\.json cannot be read or parsed at the head [0-9a-f]{40}$/u);
    expect(compare((write, root) => { admitted(write); rmSync(join(root, "packages/demo/release-gates.json")); }), "newly publishable without a gates file").toThrow(/^migration-block: packages\/demo\/release-gates\.json cannot be read at the head [0-9a-f]{40}$/u);
    expect(compare((write) => { admitted(write); write("packages/demo/release-gates.json", "{}"); }), "newly publishable without packageSurface").toThrow(/^migration-block: packages\/demo\/release-gates\.json at [0-9a-f]{40} has no packageSurface object$/u);
    expect(compare((write) => { blocked(write); write("packages/pub/release-gates.json", gates({ ".": "api/a.api.md", "./more": "api/more.api.md" })); }), "a head snapshot missing").toThrow(/^migration-block: packages\/pub\/api\/more\.api\.md cannot be read at the head [0-9a-f]{40}$/u);
    expect(compare((write) => { blocked(write); write("packages/pub/release-gates.json", gates({ ".": "api/a.api.md", "./out": "../demo/api/a.api.md" })); }), "a head snapshot outside the package").toThrow(/^migration-block: packages\/pub\/release-gates\.json lists the snapshot \.\.\/demo\/api\/a\.api\.md, which is not a path inside packages\/pub$/u);
    expect(compare(blocked), "the same removal with its block, the head readable").not.toThrow();
  }, 60_000);
  it("admits a package with its gates file and snapshots, and reads a withdrawn package's missing files as a removal", () => {
    const listing = (publishable: readonly string[], unreleased: readonly string[]) => JSON.stringify({ schemaVersion: 2, packages: publishable.map((name) => ({ name: `@openlup/${name}`, directory: `packages/${name}`, publish: true })), unreleased: unreleased.map((name) => ({ directory: `packages/${name}`, reason: "a module in progress" })) });
    expect(compare((write) => write("config/openlup-packages.json", listing(["demo", "pub"], [])), { "config/openlup-packages.json": listing(["pub"], ["demo"]) }), "the module's final pull request").not.toThrow();
    const withdraw = (write: (path: string, contents: string) => void, root: string) => { write("config/openlup-packages.json", listing(["demo"], ["pub"])); rmSync(join(root, "packages/pub/release-gates.json")); };
    expect(compare(withdraw), "withdrawn, its gates file removed").toThrow(red);
    expect(compare((write, root) => { withdraw(write, root); write("packages/pub/CHANGELOG.md", changelog(BLOCK)); }), "the same with a block").not.toThrow();
  }, 60_000);
});
