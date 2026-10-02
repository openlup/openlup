import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_REPOSITORY_URL } from "./package-manifest-policy.ts";
import { PACKAGES_MANIFEST_FILE, runPackagesCheck } from "./packages-check.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
const quiet = () => { vi.spyOn(console, "log").mockImplementation(() => undefined); return vi.spyOn(console, "error").mockImplementation(() => undefined); };
const git = (root: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, stdio: "ignore" });
const build = "node -e \"require('node:fs').mkdirSync('dist',{recursive:true});require('node:fs').writeFileSync('dist/a.js','export const a = 1;\\n')\"";

/** A repository with one private and one publishable package; each build writes dist/a.js from src/a.ts. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "packages-check-"));
  roots.push(root);
  const write = (path: string, contents: string) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), contents); };
  write("config/openlup-packages.json", JSON.stringify({ schemaVersion: 2, packages: [{ name: "@openlup/demo", directory: "packages/demo", publish: false }, { name: "@openlup/pub", directory: "packages/pub", publish: true }], unreleased: [] }));
  write("packages/demo/package.json", JSON.stringify({ name: "@openlup/demo", version: "0.1.0", private: true, files: ["dist/**"], exports: { ".": "./dist/a.js" }, scripts: { build } }, null, 2));
  write("packages/pub/package.json", JSON.stringify({ name: "@openlup/pub", version: "0.4.0", license: "Apache-2.0", files: ["dist/**"], publishConfig: { access: "public", provenance: true, tag: "preview" }, repository: { type: "git", url: PUBLIC_REPOSITORY_URL, directory: "packages/pub" }, exports: { ".": "./dist/a.js" }, scripts: { build } }, null, 2));
  for (const name of ["demo", "pub"]) write(`packages/${name}/src/a.ts`, "export const a = 1;\n");
  write(".gitignore", "dist/\nout/\n");
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
});
