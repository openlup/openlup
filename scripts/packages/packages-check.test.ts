import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPackagesCheck } from "./packages-check.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
const quiet = () => { vi.spyOn(console, "log").mockImplementation(() => undefined); return vi.spyOn(console, "error").mockImplementation(() => undefined); };
const git = (root: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, stdio: "ignore" });

/** A one-package repository whose build writes dist/a.js from src/a.ts. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "packages-check-"));
  roots.push(root);
  const write = (path: string, contents: string) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), contents); };
  write("config/openlup-packages.json", JSON.stringify({ schemaVersion: 1, version: "0.1.0", packages: [{ name: "@openlup/demo", directory: "packages/demo", publish: false }], unreleased: [] }));
  write("packages/demo/package.json", JSON.stringify({ name: "@openlup/demo", version: "0.1.0", private: true, files: ["dist/**"], exports: { ".": "./dist/a.js" }, scripts: { build: "node -e \"require('node:fs').mkdirSync('dist',{recursive:true});require('node:fs').writeFileSync('dist/a.js','export const a = 1;\\n')\"" } }, null, 2));
  write("packages/demo/src/a.ts", "export const a = 1;\n");
  write(".gitignore", "dist/\n");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "fixture");
  return root;
}

describe("packages:check", () => {
  it("passes on the committed repository and refuses an unknown argument", () => {
    quiet();
    expect(runPackagesCheck(process.cwd(), [])).toBe(0);
    expect(runPackagesCheck(process.cwd(), ["--publish"])).toBe(2);
  });
  it("packs a clean package and refuses a dirty one", () => {
    const errors = quiet();
    const root = fixture();
    expect(runPackagesCheck(root, ["--pack"])).toBe(0);
    writeFileSync(join(root, "packages/demo/src/a.ts"), "export const a = 2;\n");
    expect(runPackagesCheck(root, ["--pack"])).toBe(1);
    expect(errors.mock.calls.flat().join("\n")).toMatch(/dirty-tree/);
  }, 60_000);
});
