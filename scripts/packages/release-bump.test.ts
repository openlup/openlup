import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bumpRelease, setVersionFields } from "./release-bump.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const lock = (packages: Record<string, unknown>) => `${JSON.stringify({ name: "fixture", version: "0.0.0", lockfileVersion: 3, requires: true, packages }, null, 2)}\n`;
const changelog = "# Changelog\n\n## [Unreleased]\n\n- Publishable on the npm `preview` dist-tag as `0.7.0`, for source preview\n  `openlup-source-preview/7`.\n- Publishable on the npm `preview` dist-tag as `0.6.0`, for source preview\n  `openlup-source-preview/6`.\n";

/** A tree at the lockstep 0.7.0 whose root lock also holds an unrelated dependency at 0.7.0. */
function fixture(): { root: string; files: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "release-bump-"));
  roots.push(root);
  const files: Record<string, string> = {
    "config/openlup-packages.json": '{\n  "schemaVersion": 1,\n  "version": "0.7.0",\n  "packages": [\n    { "name": "@openlup/core", "directory": "packages/core", "publish": true },\n    { "name": "@openlup/kit", "directory": "packages/kit", "publish": false }\n  ],\n  "unreleased": []\n}\n',
    "package-lock.json": lock({ "": { name: "fixture", workspaces: ["packages/*"] }, "node_modules/unrelated": { version: "0.7.0" }, "packages/core": { name: "@openlup/core", version: "0.7.0" }, "packages/kit": { name: "@openlup/kit", version: "0.7.0" } }),
    "packages/core/package.json": '{\n  "name": "@openlup/core",\n  "version": "0.7.0",\n  "dependencies": { "unrelated": "0.7.0" }\n}\n',
    "packages/core/package-lock.json": lock({ "": { name: "@openlup/core", version: "0.7.0" }, "node_modules/unrelated": { version: "0.7.0" } }).replace('"version": "0.0.0"', '"version": "0.7.0"'),
    "packages/core/CHANGELOG.md": changelog,
    "packages/kit/package.json": '{ "name": "@openlup/kit", "version": "0.7.0", "private": true }\n',
  };
  for (const [path, contents] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), contents); }
  return { root, files };
}
const read = (root: string, files: Record<string, string>) => Object.fromEntries(Object.keys(files).map((path) => [path, readFileSync(join(root, path), "utf8")]));

describe("release:bump", () => {
  it("rewrites exactly the lockstep version strings and adds the CHANGELOG line", () => {
    const { root, files } = fixture();
    expect(bumpRelease(root, 9).sort()).toEqual(["config/openlup-packages.json", "package-lock.json", "packages/core/CHANGELOG.md", "packages/core/package-lock.json", "packages/core/package.json", "packages/kit/package.json"]);
    const after = read(root, files);
    for (const path of Object.keys(files).filter((path) => !path.endsWith(".md"))) {
      const lines = (text: string) => text.split("\n");
      const changed = lines(files[path]!).map((line, index) => [line, lines(after[path]!)[index]]).filter(([before, now]) => before !== now);
      expect(changed.every(([before, now]) => before!.replace('"version": "0.7.0"', '"version": "0.9.0"') === now), path).toBe(true);
    }
    expect(JSON.parse(after["package-lock.json"]!).packages).toMatchObject({ "node_modules/unrelated": { version: "0.7.0" }, "packages/core": { version: "0.9.0" }, "packages/kit": { version: "0.9.0" } });
    expect(JSON.parse(after["packages/core/package-lock.json"]!)).toMatchObject({ version: "0.9.0", packages: { "": { version: "0.9.0" }, "node_modules/unrelated": { version: "0.7.0" } } });
    expect(JSON.parse(after["packages/core/package.json"]!).dependencies).toEqual({ unrelated: "0.7.0" });
    expect(after["packages/core/CHANGELOG.md"]).toBe(changelog.replace("- Publishable on the npm `preview` dist-tag as `0.7.0`", "- Publishable on the npm `preview` dist-tag as `0.9.0`, for source preview\n  `openlup-source-preview/9`.\n$&"));
  });

  it("refuses a number that does not advance the version, a skewed carrier and a missing CHANGELOG line, and writes nothing", () => {
    const { root, files } = fixture();
    for (const preview of [7, 6, 1.5]) expect(() => bumpRelease(root, preview), String(preview)).toThrow(/the next preview number must be above 7/u);
    writeFileSync(join(root, "packages/kit/package.json"), files["packages/kit/package.json"]!.replace("0.7.0", "0.6.0"));
    expect(() => bumpRelease(root, 9)).toThrow(/^packages\/kit\/package\.json: version is "0\.6\.0", not the lockstep 0\.7\.0$/u);
    writeFileSync(join(root, "packages/kit/package.json"), files["packages/kit/package.json"]!);
    writeFileSync(join(root, "packages/core/CHANGELOG.md"), "# Changelog\n");
    expect(() => bumpRelease(root, 9)).toThrow(/CHANGELOG\.md: has no "Publishable/u);
    expect(read(root, files)).toEqual({ ...files, "packages/core/CHANGELOG.md": "# Changelog\n" });
  });

  it("refuses a lockstep field that is not a plain version member", () => {
    expect(() => setVersionFields("a.json", '{"version":"0.7.0"}', [["version"]], "0.7.0", "0.9.0")).toThrow(/is not written as/u);
    expect(() => setVersionFields("a.json", '{"version": "0.8.0"}', [["version"]], "0.7.0", "0.9.0")).toThrow(/is "0\.8\.0", not the lockstep 0\.7\.0/u);
  });

  it("runs from the command line and refuses anything but one preview number", () => {
    const { root } = fixture();
    const script = resolve("scripts/packages/release-bump.ts");
    const run = (...args: string[]) => { try { return { code: 0, out: execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", script, ...args], { cwd: root, encoding: "utf8", stdio: "pipe" }) }; } catch (error) { return { code: (error as { status: number }).status, out: String((error as { stderr: string }).stderr) }; } };
    expect(run()).toMatchObject({ code: 2 });
    expect(run("09")).toMatchObject({ code: 2 });
    expect(run("7")).toMatchObject({ code: 1, out: expect.stringMatching(/refused: the lockstep version is 0\.7\.0/u) });
    expect(run("9")).toMatchObject({ code: 0, out: expect.stringContaining("release:bump: rewrote packages/core/CHANGELOG.md") });
  });
});
