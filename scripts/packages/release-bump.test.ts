import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bumpRelease, npmPublishedPackedBytes, setVersionFields } from "./release-bump.ts";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const lock = (packages: Record<string, unknown>) => `${JSON.stringify({ name: "fixture", version: "0.0.0", lockfileVersion: 3, requires: true, packages }, null, 2)}\n`;
const changelog = "# Changelog\n\n## [Unreleased]\n\n- Publishable on the npm `preview` dist-tag as `0.7.0`, for source preview\n  `openlup-source-preview/7`.\n- Publishable on the npm `preview` dist-tag as `0.6.0`, for source preview\n  `openlup-source-preview/6`.\n";
const line = (version: string, name = "core") => `- Publishable on the npm \`latest\` dist-tag as \`${version}\`, from tag\n  \`openlup-${name}-v${version}\`.\n`;
/** The version's section, which opens with its "Publishable" line, directly below the Unreleased heading. */
const section = (version: string, name = "core") => `## [${version}]\n\n${line(version, name)}\n`;

/** Two released packages with their own versions; core's lock and the root lock also hold an unrelated dependency at 0.7.0. */
function fixture(): { root: string; files: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "release-bump-"));
  roots.push(root);
  const files: Record<string, string> = {
    "config/openlup-packages.json": '{\n  "schemaVersion": 2,\n  "packages": [\n    { "name": "@openlup/core", "directory": "packages/core", "publish": true },\n    { "name": "@openlup/kit", "directory": "packages/kit", "publish": false }\n  ],\n  "unreleased": []\n}\n',
    "package-lock.json": lock({ "": { name: "fixture", workspaces: ["packages/*"] }, "node_modules/unrelated": { version: "0.7.0" }, "packages/core": { name: "@openlup/core", version: "0.7.0" }, "packages/kit": { name: "@openlup/kit", version: "2.1.0" } }),
    "packages/core/package.json": '{\n  "name": "@openlup/core",\n  "version": "0.7.0",\n  "dependencies": { "unrelated": "0.7.0" }\n}\n',
    "packages/core/package-lock.json": lock({ "": { name: "@openlup/core", version: "0.7.0" }, "node_modules/unrelated": { version: "0.7.0" } }).replace('"version": "0.0.0"', '"version": "0.7.0"'),
    "packages/core/CHANGELOG.md": changelog,
    "packages/kit/package.json": '{ "name": "@openlup/kit", "version": "2.1.0", "private": true }\n',
  };
  for (const [path, contents] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), contents); }
  return { root, files };
}
const read = (root: string, files: Record<string, string>) => Object.fromEntries(Object.keys(files).map((path) => [path, readFileSync(join(root, path), "utf8")]));
const changedLines = (before: string, after: string) => before.split("\n").map((text, index) => [text, after.split("\n")[index]]).filter(([was, now]) => was !== now);

describe("release:bump", () => {
  it("rewrites exactly the one package's version strings and opens its CHANGELOG section", () => {
    const { root, files } = fixture();
    expect(bumpRelease(root, "core", "0.9.0").sort()).toEqual(["package-lock.json", "packages/core/CHANGELOG.md", "packages/core/package-lock.json", "packages/core/package.json"]);
    const after = read(root, files);
    for (const path of ["package-lock.json", "packages/core/package-lock.json", "packages/core/package.json"]) {
      expect(changedLines(files[path]!, after[path]!).every(([was, now]) => was!.replace('"version": "0.7.0"', '"version": "0.9.0"') === now), path).toBe(true);
    }
    for (const path of ["config/openlup-packages.json", "packages/kit/package.json"]) expect(after[path], path).toBe(files[path]);
    expect(JSON.parse(after["package-lock.json"]!).packages).toMatchObject({ "node_modules/unrelated": { version: "0.7.0" }, "packages/core": { version: "0.9.0" }, "packages/kit": { version: "2.1.0" } });
    expect(JSON.parse(after["packages/core/package-lock.json"]!)).toMatchObject({ version: "0.9.0", packages: { "": { version: "0.9.0" }, "node_modules/unrelated": { version: "0.7.0" } } });
    expect(JSON.parse(after["packages/core/package.json"]!).dependencies).toEqual({ unrelated: "0.7.0" });
    expect(after["packages/core/CHANGELOG.md"]).toBe(changelog.replace("## [Unreleased]\n\n", `$&${section("0.9.0")}`));
    expect(bumpRelease(root, "core", "0.9.1")).toContain("packages/core/CHANGELOG.md");
    expect(readFileSync(join(root, "packages/core/CHANGELOG.md"), "utf8")).toBe(changelog.replace("## [Unreleased]\n\n", `$&${section("0.9.1")}${section("0.9.0")}`));
  });

  it("versions each package on its own and writes no CHANGELOG line for an unpublishable one", () => {
    const { root, files } = fixture();
    expect(bumpRelease(root, "kit", "3.0.0").sort()).toEqual(["package-lock.json", "packages/kit/package.json"]);
    const after = read(root, files);
    expect(JSON.parse(after["packages/kit/package.json"]!).version).toBe("3.0.0");
    expect(JSON.parse(after["package-lock.json"]!).packages).toMatchObject({ "packages/core": { version: "0.7.0" }, "packages/kit": { version: "3.0.0" } });
    for (const path of ["packages/core/package.json", "packages/core/package-lock.json", "packages/core/CHANGELOG.md", "config/openlup-packages.json"]) expect(after[path], path).toBe(files[path]);
  });

  it("refuses a version that does not advance, an unknown package, a skewed carrier and a CHANGELOG without its Unreleased heading, and writes nothing", () => {
    const { root, files } = fixture();
    for (const version of ["0.7.0", "0.6.9", "0.0.1"]) expect(() => bumpRelease(root, "core", version), version).toThrow(/^@openlup\/core is at 0\.7\.0; the next version must be a release version above it$/u);
    for (const version of ["0.9.0-rc.1", "09.0.0", "0.9", "latest"]) expect(() => bumpRelease(root, "core", version), version).toThrow(/is not a MAJOR\.MINOR\.PATCH release version/u);
    expect(() => bumpRelease(root, "absent", "1.0.0")).toThrow(/^packages\/absent is not a released package/u);
    expect(() => bumpRelease(root, "Core", "1.0.0")).toThrow(/not a package directory name/u);
    expect(() => bumpRelease(root, "../core", "1.0.0")).toThrow(/not a package directory name/u);
    writeFileSync(join(root, "packages/core/package-lock.json"), files["packages/core/package-lock.json"]!.replace('"version": "0.7.0"', '"version": "0.6.0"'));
    expect(() => bumpRelease(root, "core", "0.9.0")).toThrow(/^packages\/core\/package-lock\.json: version is "0\.6\.0", not the current 0\.7\.0$/u);
    writeFileSync(join(root, "packages/core/package-lock.json"), files["packages/core/package-lock.json"]!);
    writeFileSync(join(root, "packages/core/CHANGELOG.md"), "# Changelog\n");
    expect(() => bumpRelease(root, "core", "0.9.0")).toThrow(/CHANGELOG\.md: has no "## \[Unreleased\]" heading followed by a blank line/u);
    expect(read(root, files)).toEqual({ ...files, "packages/core/CHANGELOG.md": "# Changelog\n" });
  });

  it("moves the growth baseline to the published version it replaces, keeps it for an unpublished one, or writes nothing", () => {
    const gates = '{\n  "pack": {\n    "maxFiles": 10,\n    "baseline": {\n      "version": "0.6.0",\n      "packedBytes": 100\n    }\n  }\n}\n';
    const moved = '{\n  "pack": {\n    "maxFiles": 10,\n    "baseline": {\n      "version": "0.7.0",\n      "packedBytes": 12345\n    }\n  }\n}\n';
    const path = "packages/core/release-gates.json";
    const refused = fixture();
    writeFileSync(join(refused.root, path), gates);
    expect(() => bumpRelease(refused.root, "core", "0.9.0", () => { throw new Error("@openlup/core@0.7.0: the registry could not be read"); })).toThrow("the registry could not be read");
    expect({ ...read(refused.root, refused.files), [path]: readFileSync(join(refused.root, path), "utf8") }).toEqual({ ...refused.files, [path]: gates });
    for (const baseline of ["null", '{ "version": "0.6.0" }', '{ "version": 6, "packedBytes": 100 }']) {
      writeFileSync(join(refused.root, path), `{ "pack": { "baseline": ${baseline} } }\n`);
      expect(() => bumpRelease(refused.root, "core", "0.9.0", () => 12345), baseline).toThrow(`${path}: pack.baseline needs a version string and an integer packedBytes`);
    }
    const unpublished = fixture();
    writeFileSync(join(unpublished.root, path), gates);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(bumpRelease(unpublished.root, "core", "0.9.0", () => undefined)).not.toContain(path);
    expect(readFileSync(join(unpublished.root, path), "utf8")).toBe(gates);
    expect(JSON.parse(readFileSync(join(unpublished.root, "packages/core/package.json"), "utf8")).version).toBe("0.9.0");
    const { root } = fixture(), asked: string[] = [];
    writeFileSync(join(root, path), gates);
    expect(bumpRelease(root, "core", "0.9.0", (name, version) => { asked.push(`${name}@${version}`); return 12345; })).toContain(path);
    expect(asked).toEqual(["@openlup/core@0.7.0"]);
    expect(readFileSync(join(root, path), "utf8")).toBe(moved);
  });

  it("reads the registry only through the npm that runs release:bump", () => {
    vi.stubEnv("npm_execpath", "");
    expect(() => npmPublishedPackedBytes("@openlup/core", "0.7.0")).toThrow("release:bump reads the registry through npm: run it as npm run release:bump");
    vi.stubEnv("npm_execpath", "npm-cli.js");
    expect(() => npmPublishedPackedBytes("@openlup/core", "0.7.0")).toThrow("run it as npm run release:bump");
  });

  it("takes the packed bytes of exactly one published tarball with the registry's integrity", () => {
    const row = { name: "@openlup/core", version: "0.7.0", size: 12345, integrity: "sha512-fixture" };
    const calls: string[][] = [];
    const failure = (stdout: string) => Object.assign(new Error("Command failed: npm view"), { stdout });
    const npm = (rows: unknown, view: () => string = () => JSON.stringify("sha512-fixture")) => (args: string[]) => { calls.push(args); return args[0] === "view" ? view() : JSON.stringify(rows); };
    expect(npmPublishedPackedBytes("@openlup/core", "0.7.0", npm([row]))).toBe(12345);
    expect(calls).toEqual([["view", "@openlup/core@0.7.0", "dist.integrity", "--json"], ["pack", "@openlup/core@0.7.0", "--dry-run", "--json", "--ignore-scripts"]]);
    expect(npmPublishedPackedBytes("@openlup/core", "0.7.0", npm([row], () => { throw failure('{ "error": { "code": "E404" } }'); }))).toBeUndefined();
    for (const stdout of ['{ "error": { "code": "EAI_AGAIN" } }', "", "not json"]) {
      expect(() => npmPublishedPackedBytes("@openlup/core", "0.7.0", npm([row], () => { throw failure(stdout); })), stdout).toThrow("@openlup/core@0.7.0: the registry could not be read");
    }
    const views = [() => JSON.stringify("sha512-other"), () => "null"];
    for (const view of views) expect(() => npmPublishedPackedBytes("@openlup/core", "0.7.0", npm([row], view))).toThrow("@openlup/core@0.7.0: npm reported no single published tarball with the registry's integrity");
    for (const rows of [[], [row, row], [{ ...row, version: "0.6.0" }], [{ ...row, name: "@openlup/kit" }], [{ ...row, size: 0 }], [{ ...row, size: "12345" }], [{ ...row, integrity: undefined }], { 0: row }]) {
      expect(() => npmPublishedPackedBytes("@openlup/core", "0.7.0", npm(rows)), JSON.stringify(rows)).toThrow("@openlup/core@0.7.0: npm reported no single published tarball with the registry's integrity");
    }
  });

  it("refuses a version field that is not a plain version member", () => {
    expect(() => setVersionFields("a.json", '{"version":"0.7.0"}', [["version"]], "0.7.0", "0.9.0")).toThrow(/is not written as/u);
    expect(() => setVersionFields("a.json", '{"version": "0.8.0"}', [["version"]], "0.7.0", "0.9.0")).toThrow(/is "0\.8\.0", not the current 0\.7\.0/u);
  });

  it("runs from the command line and refuses anything but a package and one release version", () => {
    const { root } = fixture();
    const script = resolve("scripts/packages/release-bump.ts");
    const run = (...args: string[]) => { try { return { code: 0, out: execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", script, ...args], { cwd: root, encoding: "utf8", stdio: "pipe" }) }; } catch (error) { return { code: (error as { status: number }).status, out: String((error as { stderr: string }).stderr) }; } };
    expect(run()).toMatchObject({ code: 2 });
    expect(run("9")).toMatchObject({ code: 2 });
    expect(run("core", "0.9")).toMatchObject({ code: 2 });
    expect(run("core", "0.9.0", "extra")).toMatchObject({ code: 2 });
    expect(run("core", "0.7.0")).toMatchObject({ code: 1, out: expect.stringMatching(/refused: @openlup\/core is at 0\.7\.0/u) });
    expect(run("core", "0.9.0")).toMatchObject({ code: 0, out: expect.stringContaining("release:bump: rewrote packages/core/CHANGELOG.md") });
  });

  it("logs removed fragments and stages only their deletions from the set command", () => {
    const { root } = fixture(), fragment = "packages/core/changes/a-one.md";
    mkdirSync(dirname(join(root, fragment)), { recursive: true }); writeFileSync(join(root, fragment), "- A change.\n");
    const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: root, encoding: "utf8" }).trim();
    git("init", "-q"); git("add", "."); git("commit", "-qm", "fixture");
    writeFileSync(join(root, "packages/kit/package.json"), readFileSync(join(root, "packages/kit/package.json"), "utf8") + "\n");
    const output = execFileSync(process.execPath, ["--experimental-strip-types", resolve("scripts/packages/release-bump.ts"), "--set", "0.9.0"], { cwd: root, encoding: "utf8" });
    expect(output).toContain(`release:bump: removed ${fragment}`);
    expect(output).not.toContain(`rewrote ${fragment}`);
    expect(git("diff", "--cached", "--name-status")).toBe(`D\t${fragment}`);
    expect(git("ls-files", "--", fragment)).toBe("");
  });
});
