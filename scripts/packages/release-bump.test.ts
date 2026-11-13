import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bumpRelease, bumpSet, npmPublishedPackedBytes, setVersionFields } from "./release-bump.ts";
import * as docs from "./release-docs-pass.ts";


const checkGuide = (root: string): string => execFileSync(process.execPath, ["--experimental-strip-types", resolve("packages/core/scripts/documentation-contract.ts"), "--check-guide", join(root, "packages/core")], { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
function expectedConfigurationRegion(root: string): string {
  // Plan a separate empty page so the expected body does not depend on the page under test.
  const pending = "docs/guide/reference/configuration-expected.md";
  const output = execFileSync(process.execPath, ["--experimental-strip-types", resolve("packages/core/scripts/documentation-contract.ts"), "--plan-guide", "0.9.0", root], {
    cwd: root, encoding: "utf8", stdio: "pipe",
    input: JSON.stringify({ [pending]: "# Configuration\n\n<!-- generated:configuration-keys -->\n<!-- /generated:configuration-keys -->\n" }),
  });
  const plan = JSON.parse(output) as { writes: Array<[string, string]> };
  const source = plan.writes.find(([file]) => file === join(root, "packages/core", pending))?.[1];
  const region = source?.match(/<!-- generated:configuration-keys -->\n([\s\S]*?)<!-- \/generated:configuration-keys -->/u)?.[1];
  if (region === undefined) throw new Error("Expected a planned configuration-keys region for the empty pending page");
  return region;
}
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
const git = (root: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: root, encoding: "utf8" }).trim();
const page = "packages/core/docs/guide/upgrade/v0-9-0.md";
// The configuration-keys generator reads package sources, links the platform API reports and
// omits provider-specific names through the repository neutrality scanner (stdin mode only).
function addConfigurationInputs(root: string, files: Record<string, string>): void {
  Object.assign(files, {
    "packages/core/src/settings.ts": 'export const baseUrlKey = "APP_BASE_URL";\n',
    "packages/platform/api/index.api.md": "# API report\n",
    "packages/ui/smoke/neutrality.ts": readFileSync(resolve("packages/ui/smoke/neutrality.ts"), "utf8"),
  });
  for (const [path, source] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), source); }
}
function setFixture() {
  const f = fixture();
  Object.assign(f.files, {
    "config/openlup-packages.json": JSON.stringify({ schemaVersion: 2, packages: [{ name: "@openlup/core", directory: "packages/core", publish: true }, { name: "@openlup/outbox", directory: "packages/outbox", publish: true }, { name: "@openlup/kit", directory: "packages/kit", publish: false }], unreleased: [] }),
    "config/documentation-guide-allowlist.json": JSON.stringify({ schemaVersion: 1, terms: [] }),
    "packages/outbox/package.json": '{ "name": "@openlup/outbox", "version": "0.7.0" }\n',
    "packages/outbox/CHANGELOG.md": "# Changelog\n\n## [Unreleased]\n\n",
    "packages/core/changes/z-last.md": "- Last core change.\n",
    "packages/core/changes/a-first.md": "- First core change.\n",
    "packages/outbox/changes/one.md": "- Outbox change.\n",
    "packages/kit/changes/keep.md": "- Unconsumed change.\n",
  });
  for (const [path, source] of Object.entries(f.files)) { mkdirSync(dirname(join(f.root, path)), { recursive: true }); writeFileSync(join(f.root, path), source); }
  git(f.root, "init", "-q"); git(f.root, "add", "."); git(f.root, "commit", "-qm", "fixture"); git(f.root, "tag", "openlup-core-v0.7.0");
  return f;
}

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

  it("logs removed fragments and stages their deletions and the upgrade page from the set command", () => {
    const { root } = fixture(), fragment = "packages/core/changes/a-one.md";
    mkdirSync(dirname(join(root, fragment)), { recursive: true }); writeFileSync(join(root, fragment), "- A change.\n");
    git(root, "init", "-q"); git(root, "add", "."); git(root, "commit", "-qm", "fixture"); git(root, "tag", "openlup-core-v0.7.0");
    writeFileSync(join(root, "packages/kit/package.json"), readFileSync(join(root, "packages/kit/package.json"), "utf8") + "\n");
    const output = execFileSync(process.execPath, ["--experimental-strip-types", resolve("scripts/packages/release-bump.ts"), "--set", "0.9.0"], { cwd: root, encoding: "utf8" });
    expect(output).toContain(`release:bump: removed ${fragment}`);
    expect(output).not.toContain(`rewrote ${fragment}`);
    expect(output).toContain(`release:bump: rewrote ${page}`);
    expect(git(root, "diff", "--cached", "--name-status")).toBe(`D\t${fragment}\nA\t${page}`);
    expect(git(root, "ls-files", "--", fragment)).toBe("");
  });

  it("assembles every consumed body before deleting fragments and preserves their order", () => {
    const { root, files } = setFixture(), paths = bumpSet(root, "0.9.0");
    const result = readFileSync(join(root, page), "utf8");
    for (const path of Object.keys(files).filter((path) => /packages\/(?:core|outbox)\/changes\//u.test(path))) {
      expect(result).toContain(files[path]!.trimEnd()); expect(existsSync(join(root, path))).toBe(false); expect(paths).toContain(path);
    }
    expect(result.indexOf("First core change.")).toBeLessThan(result.indexOf("Last core change."));
    expect(readFileSync(join(root, "packages/kit/changes/keep.md"), "utf8")).toBe(files["packages/kit/changes/keep.md"]);
    expect(result).not.toContain("Unconsumed change."); expect(paths).toContain(page);
  });

  it("prepares the set and consumes fragments without a previous core tag", () => {
    const { root } = setFixture(); git(root, "tag", "-d", "openlup-core-v0.7.0");
    expect(bumpSet(root, "0.9.0")).toContain(page);
    const source = readFileSync(join(root, page), "utf8");
    expect(source).toContain("# Upgrading to 0.9.0\n");
    expect(source).toContain("## API changes\n\nThe previous release could not be determined");
    expect(source).toContain("First core change.");
    expect(existsSync(join(root, "packages/core/changes/a-first.md"))).toBe(false);
  });

  it("writes nothing and deletes no fragments when page assembly fails after file planning", () => {
    const { root, files } = setFixture();
    vi.spyOn(docs, "assembleUpgradePage").mockImplementation(() => { throw new Error("assembly failure"); });
    expect(() => bumpSet(root, "0.9.0")).toThrow("assembly failure");
    expect(read(root, files)).toEqual(files); expect(existsSync(join(root, page))).toBe(false);
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("refuses a pre-existing upgrade page without writing or consuming anything", () => {
    const { root, files } = setFixture();
    mkdirSync(dirname(join(root, page)), { recursive: true }); writeFileSync(join(root, page), "# Existing bytes\n");
    const before = git(root, "status", "--porcelain");
    expect(() => bumpSet(root, "0.9.0")).toThrow(`${page}: upgrade page already exists`);
    expect(read(root, files)).toEqual(files); expect(readFileSync(join(root, page), "utf8")).toBe("# Existing bytes\n");
    expect(git(root, "status", "--porcelain")).toBe(before);
  });

  it("warns about page contract violations without refusing the bump", () => {
    const { root } = setFixture();
    writeFileSync(join(root, "packages/core/changes/a-first.md"), "- W99 internal task.\n");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(bumpSet(root, "0.9.0")).toContain(page);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("task or milestone ID): W99"));
    expect(readFileSync(join(root, page), "utf8")).toContain("- W99 internal task.");
  });

  it("plans guide regeneration without writes, then refreshes existing and newly assembled pages before consuming fragments", () => {
    const { root, files } = setFixture();
    const guide = "packages/core/docs/guide/reference/configuration.md";
    const link = (version: string) => `https://github.com/openlup/openlup/blob/openlup-core-v${version}/packages/core/CHANGELOG.md`;
    const stale = `# Configuration\n\n[Changelog](${link("0.7.0")})\n\n<!-- generated:configuration-keys -->\nold body\n<!-- /generated:configuration-keys -->\n`;
    Object.assign(files, {
      [guide]: stale,
      "config/environment-variables.json": JSON.stringify({ variables: [{ name: "APP_BASE_URL", owner: "platform", category: "server-runtime", requiredIn: ["production"], secret: false }] }),
      "packages/core/changes/a-first.md": stale.replace("# Configuration", "### Configuration"),
    });
    addConfigurationInputs(root, files);
    git(root, "add", "."); git(root, "commit", "-qm", "guide fixture");
    // The region the generator owns, at the target version; it must list the key the package reads.
    const fresh = expectedConfigurationRegion(root);
    expect(fresh).toContain("| `APP_BASE_URL` | platform | server-runtime | production | no |\n");
    const planned = docs.planReleaseGuide(root, "0.9.0");
    expect(planned.violations).toEqual([]);
    expect(planned.writes).toEqual([[join(root, guide), stale.replace(link("0.7.0"), link("0.9.0")).replace("old body\n", fresh)]]);
    expect(read(root, files)).toEqual(files); expect(git(root, "status", "--porcelain")).toBe("");

    const paths = bumpSet(root, "0.9.0");
    expect(paths.filter((path) => path === page)).toHaveLength(1);
    for (const path of [guide, page]) {
      const source = readFileSync(join(root, path), "utf8");
      expect(source).toContain(link("0.9.0")); expect(source).not.toContain(link("0.7.0"));
      expect(source).toContain(fresh); expect(source).not.toContain("old body");
      expect(paths).toContain(path);
    }
    expect(existsSync(join(root, "packages/core/changes/a-first.md"))).toBe(false);
    expect(git(root, "diff", "--cached", "--name-status")).toContain(`M\t${guide}`);
    expect(checkGuide(root)).toBe("guide contract ok");
  });

  it("does not plan or stage another write for a guide already current at the target version", () => {
    const { root } = setFixture(), guide = "packages/core/docs/guide/README.md";
    addConfigurationInputs(root, { "config/environment-variables.json": '{"variables":[]}\n' });
    const source = `# Guide\n\n[Changelog](https://github.com/openlup/openlup/blob/openlup-core-v0.9.0/packages/core/CHANGELOG.md)\n\n<!-- generated:configuration-keys -->\n${expectedConfigurationRegion(root)}<!-- /generated:configuration-keys -->\n`;
    mkdirSync(dirname(join(root, guide)), { recursive: true }); writeFileSync(join(root, guide), source);
    git(root, "add", "."); git(root, "commit", "-qm", "current guide fixture");
    expect(docs.planReleaseGuide(root, "0.9.0")).toEqual({ writes: [], violations: [], pageViolations: {} });
    expect(bumpSet(root, "0.9.0")).not.toContain(guide);
    expect(readFileSync(join(root, guide), "utf8")).toBe(source);
    expect(git(root, "diff", "--cached", "--", guide)).toBe("");
  });

  it("re-pins and stages package entry points in a set bump, then passes the package documentation check", () => {
    const { root } = setFixture(), agents = "packages/outbox/AGENTS.md", readme = "packages/outbox/README.md";
    const source = [
      "# Package", "", "## Purpose and kind", "Kind: `rail`.", "", "## Subpath maturity",
      "| Export | Role | Maturity |", "| --- | --- | --- |", "", "## Wiring example",
      "```ts", "export const wired = 1;", "```", "", "## Sources and declarations",
      "[Core](https://github.com/openlup/openlup/blob/openlup-core-v0.7.0/README.md)",
      "[Package](https://github.com/openlup/openlup/tree/openlup-outbox-v0.7.0/packages/outbox)",
      "", "## Readiness codes", "None.", "", "## Using this package in an application", "Import the package.", "",
    ].join("\n");
    writeFileSync(join(root, agents), source);
    writeFileSync(join(root, readme), source);
    writeFileSync(join(root, "packages/outbox/release-gates.json"), '{"kind":"rail","packageSurface":{}}\n');
    git(root, "add", "."); git(root, "commit", "-qm", "package documentation fixture");
    const expected = source.replaceAll("-v0.7.0/", "-v0.9.0/");
    const planned = docs.planReleaseGuide(root, "0.9.0");
    for (const file of [agents, readme]) {
      expect(planned.writes).toContainEqual([join(root, file), expected]);
      expect(readFileSync(join(root, file), "utf8")).toBe(source);
    }
    const paths = bumpSet(root, "0.9.0");
    for (const file of [agents, readme]) {
      expect(paths).toContain(file);
      expect(readFileSync(join(root, file), "utf8")).toBe(expected);
      expect(git(root, "diff", "--cached", "--name-only")).toContain(file);
    }
    const output = execFileSync(process.execPath, ["--experimental-strip-types", resolve("packages/core/scripts/documentation-contract.ts"), "--package", join(root, "packages/outbox")], { cwd: root, encoding: "utf8", stdio: "pipe" });
    expect(output.trim()).toBe("package documentation contract ok (outbox)");
    expect(docs.planReleaseGuide(root, "0.9.0").writes).toEqual([]);
  }, 30_000);

  it("writes nothing and consumes no fragments if any package entry point has a malformed region", () => {
    const { root, files } = setFixture();
    const agents = "packages/outbox/AGENTS.md", source = "# Package\n\n<!-- generated:maturity:outbox -->\n";
    writeFileSync(join(root, agents), source);
    const before = git(root, "status", "--porcelain");
    expect(() => bumpSet(root, "0.9.0")).toThrow("package documentation planning violations");
    expect(read(root, files)).toEqual(files);
    expect(readFileSync(join(root, agents), "utf8")).toBe(source);
    expect(existsSync(join(root, page))).toBe(false);
    expect(git(root, "status", "--porcelain")).toBe(before);
  });

  it("keeps all files and fragments intact if guide planning fails", () => {
    const { root, files } = setFixture(), guide = "packages/core/docs/guide/README.md";
    const source = "# Guide\n\n<!-- generated:configuration-keys -->\nold body\n<!-- /generated:configuration-keys -->\n";
    mkdirSync(dirname(join(root, guide)), { recursive: true }); writeFileSync(join(root, guide), source);
    const before = git(root, "status", "--porcelain");
    // The missing environment-variable catalogue makes planning fail before any write.
    expect(() => bumpSet(root, "0.9.0")).toThrow(/environment-variables\.json/u);
    expect(read(root, files)).toEqual(files); expect(existsSync(join(root, page))).toBe(false);
    expect(readFileSync(join(root, guide), "utf8")).toBe(source);
    expect(git(root, "status", "--porcelain")).toBe(before);
  });

  it("re-pins the real guide and package entry points in a minimal temporary repository", () => {
    const { root } = setFixture(), core = join(root, "packages/core");
    // Every repository path the real guide links to at a release tag, derived from its pages, plus the region inputs.
    const guidePages = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? guidePages(join(directory, entry.name)) : entry.name.endsWith(".md") ? [join(directory, entry.name)] : []);
    const linked = new Set(guidePages(resolve("packages/core/docs/guide")).flatMap((page) =>
      [...readFileSync(page, "utf8").matchAll(/https:\/\/github\.com\/openlup\/openlup\/(?:blob|tree)\/openlup-core-v[0-9A-Za-z.+-]+\/([^\s)>"'`#?]+)/gu)].map((match) => decodeURIComponent(match[1]!).replace(/\/$/u, ""))));
    expect(linked.size).toBeGreaterThan(0);
    // Region inputs: release gates, package sources (configuration keys, command-line help), API
    // reports (exports, refusal codes), SQL manifests, the platform manifest and the neutrality scanner.
    const regionInputs = ["core", "outbox", "platform"].flatMap((name) => ["release-gates.json", "src", "api", "sql"].map((part) => `packages/${name}/${part}`))
      .filter((path) => existsSync(resolve(path)));
    const entryPoints = ["core", "outbox", "platform"].flatMap((name) => ["AGENTS.md", "README.md"].map((file) => `packages/${name}/${file}`));
    for (const path of ["packages/core/docs/guide", "config/openlup-packages.json", "config/documentation-guide-allowlist.json", "config/environment-variables.json", "packages/core/package.json", "packages/outbox/package.json", "packages/platform/package.json", "packages/ui/smoke/neutrality.ts", ...regionInputs, ...linked, ...entryPoints]) {
      mkdirSync(dirname(join(root, path)), { recursive: true }); cpSync(resolve(path), join(root, path), { recursive: true });
    }
    const manifest = JSON.parse(readFileSync(join(core, "package.json"), "utf8"));
    manifest.version = "0.7.0";
    writeFileSync(join(core, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const index = join(core, "docs/guide/README.md"), original = readFileSync(index, "utf8");
    const planned = docs.planReleaseGuide(root, "0.9.0");
    expect(planned.violations).toEqual([]); expect(planned.writes.map(([file]) => file)).toContain(index);
    const coreExports = planned.writes.map(([, source]) => source.match(/<!-- generated:exports:core -->\n([\s\S]*?)<!-- \/generated:exports:core -->/u)?.[1]).find((body) => body !== undefined);
    expect(coreExports).toMatch(/\n\| `[^`]+` \|/u);
    expect(readFileSync(index, "utf8")).toBe(original);
    for (const path of entryPoints) {
      const source = readFileSync(join(root, path), "utf8");
      const expected = source.replace(/(https:\/\/github\.com\/openlup\/openlup\/(?:blob|tree)\/openlup-[a-z0-9-]+-v)[0-9A-Za-z.+-]+\//gu, (_match, prefix: string) => `${prefix}0.9.0/`);
      if (source !== expected) expect(planned.writes).toContainEqual([join(root, path), expected]);
    }
    for (const [file, source] of planned.writes) writeFileSync(file, source);
    writeFileSync(join(core, "package.json"), readFileSync(join(core, "package.json"), "utf8").replace('"version": "0.7.0"', '"version": "0.9.0"'));
    expect(checkGuide(root)).toBe("guide contract ok");
    expect(docs.planReleaseGuide(root, "0.9.0")).toEqual({ writes: [], violations: [], pageViolations: {} });
  });
});
