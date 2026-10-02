import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { PACKAGES_CONFIG_PATH, PUBLIC_REPOSITORY_URL, checkPackageDirectories, checkPackageManifest, checkUnreleasedManifest, isRegistryRange, parsePackageReleaseTag, parsePackagesConfig, releaseVersionAbove, type PackageEntry, type PackagesConfig } from "./package-manifest-policy.ts";

const config: PackagesConfig = { schemaVersion: 2, packages: [{ name: "@openlup/core", directory: "packages/core", publish: false }, { name: "@openlup/server", directory: "packages/server", publish: true }, { name: "@openlup/db", directory: "packages/db", publish: true }], unreleased: [{ directory: "packages/ui", reason: "scaffold" }] };
const versions = new Map([["@openlup/core", "0.6.0"], ["@openlup/server", "1.2.0"], ["@openlup/db", "0.3.1"]]);
const [core, server] = config.packages as [PackageEntry, PackageEntry, PackageEntry];
const privateManifest = (patch: Record<string, unknown> = {}) => ({ name: "@openlup/core", version: "0.6.0", private: true, exports: { "./bundle": { "core-source": "./src/bundle.ts", types: "./dist/bundle.d.ts", default: "./dist/bundle.js" }, "./package.json": "./package.json" }, ...patch });
const publishable = (patch: Record<string, unknown> = {}) => ({ name: "@openlup/server", version: "1.2.0", license: "Apache-2.0", files: ["dist/**"], publishConfig: { access: "public", provenance: true, tag: "preview" }, repository: { type: "git", url: PUBLIC_REPOSITORY_URL, directory: "packages/server" }, exports: { "./runtime": { types: "./dist/runtime.d.ts", default: "./dist/runtime.js" } }, dependencies: { "@openlup/db": "0.3.1", zod: "^4.4.3" }, ...patch });
const rules = (findings: Array<{ rule: string }>) => findings.map(({ rule }) => rule);
const text = (value: unknown) => JSON.stringify(value);
const base = { schemaVersion: 2, packages: [{ name: "@openlup/core", directory: "packages/core", publish: false }], unreleased: [] };

describe("packages config", () => {
  it("parses the committed config", () => {
    expect(parsePackagesConfig(readFileSync(PACKAGES_CONFIG_PATH, "utf8")).packages.map(({ name }) => name)).toContain("@openlup/core");
  });
  it("refuses each malformed shape", () => {
    expect(() => parsePackagesConfig(text({ ...base, schemaVersion: 1 }))).toThrow(/schemaVersion/);
    expect(() => parsePackagesConfig(text({ ...base, extra: true }))).toThrow(/top-level/);
    expect(() => parsePackagesConfig(text({ ...base, version: "0.6.0" }))).toThrow(/top-level keys; a package's version is in its own manifest/);
    expect(() => parsePackagesConfig(text({ ...base, packages: [] }))).toThrow(/non-empty/);
    expect(() => parsePackagesConfig(text({ ...base, packages: [{ name: "core", directory: "packages/core", publish: false }] }))).toThrow(/@openlup/);
    expect(() => parsePackagesConfig(text({ ...base, packages: [{ name: "@openlup/kernel", directory: "packages/core", publish: false }] }))).toThrow(/@openlup\/<directory name>/);
    expect(() => parsePackagesConfig(text({ ...base, packages: [{ ...base.packages[0], tag: "latest" }] }))).toThrow(/unknown keys/);
    expect(() => parsePackagesConfig(text({ ...base, packages: [base.packages[0], { name: "@openlup/core", directory: "packages/core", publish: true }] }))).toThrow(/directory is listed twice/);
    expect(() => parsePackagesConfig(text({ ...base, unreleased: [{ directory: "packages/core", reason: "twice" }] }))).toThrow(/directory is listed twice/);
    expect(() => parsePackagesConfig(text({ ...base, unreleased: [{ directory: "packages/ui", reason: " " }] }))).toThrow(/reason/);
  });
});

describe("package directories", () => {
  it("names every package directory exactly once", () => {
    const all = ["packages/core/package.json", "packages/server/package.json", "packages/db/package.json", "packages/ui/package.json"];
    expect(checkPackageDirectories(config, all)).toEqual([]);
    expect(rules(checkPackageDirectories(config, [...all, "packages/extra/package.json"]))).toEqual(["unlisted-package"]);
    expect(rules(checkPackageDirectories(config, all.slice(1)))).toEqual(["missing-package"]);
  });
  it("keeps an unreleased package private", () => {
    expect(checkUnreleasedManifest({ directory: "packages/ui", reason: "scaffold" }, { private: true })).toEqual([]);
    expect(rules(checkUnreleasedManifest({ directory: "packages/ui", reason: "scaffold" }, { private: false }))).toEqual(["publication-state"]);
  });
});

describe("registry ranges", () => {
  it("accepts registry semver ranges and refuses every other source", () => {
    for (const range of ["4.4.3", "^4.4.3", "~4", ">=1.2.0 <2", "1.x", "^1.0.0 || ^2.0.0", "1.0.0-rc.1"]) expect(isRegistryRange(range)).toBe(true);
    for (const range of ["npm:@openlup/core@^0.5.0", "https://example.test/x.tgz", "../other", "file:../x", "user/repo", "git://example.test/x.git", "github:user/repo", "latest", "*", "", 4]) expect(isRegistryRange(range)).toBe(false);
  });
});

describe("package manifest", () => {
  it("accepts a private package and a publishable one, whatever the key order", () => {
    expect(checkPackageManifest(core, privateManifest(), config, versions)).toEqual([]);
    expect(checkPackageManifest(server, publishable(), config, versions)).toEqual([]);
    expect(checkPackageManifest(server, publishable({ publishConfig: { tag: "preview", provenance: true, access: "public" } }), config, versions)).toEqual([]);
  });
  it("refuses a version that is not a plain release version", () => {
    for (const version of ["0.6", "0.6.0-rc.1", "06.0.0", "0.6.0+build", "v0.6.0", 6, undefined]) expect(rules(checkPackageManifest(core, privateManifest({ version }), config, versions)), String(version)).toEqual(["version"]);
  });
  it("pins each internal dependency to that package's own version and refuses every non-registry dependency", () => {
    expect(rules(checkPackageManifest(server, publishable({ dependencies: { "@openlup/db": "^0.3.1" } }), config, versions))).toEqual(["internal-pin"]);
    expect(rules(checkPackageManifest(server, publishable({ dependencies: { "@openlup/db": "1.2.0" } }), config, versions))).toEqual(["internal-pin"]);
    expect(rules(checkPackageManifest(server, publishable({ dependencies: { "@openlup/core": "0.6.0" } }), config, versions))).toEqual(["unpublishable-dependency"]);
    expect(rules(checkPackageManifest(server, publishable({ dependencies: { "@openlup/ui": "^0.0.0" } }), config, versions))).toEqual(["unknown-internal"]);
    expect(rules(checkPackageManifest(server, publishable({ peerDependencies: { other: "file:../other" } }), config, versions))).toEqual(["dependency-source"]);
    expect(rules(checkPackageManifest(server, publishable({ optionalDependencies: { alias: "npm:@openlup/core@^0.5.0" } }), config, versions))).toEqual(["dependency-source"]);
    expect(rules(checkPackageManifest(server, publishable({ dependencies: [] }), config, versions))).toEqual(["dependencies"]);
  });
  it("refuses malformed, wildcard, directory and out-of-dist exports", () => {
    expect(rules(checkPackageManifest(core, privateManifest({ exports: "./dist/index.js" }), config, versions))).toEqual(["exports"]);
    expect(rules(checkPackageManifest(core, privateManifest({ exports: { bundle: "./dist/bundle.js" } }), config, versions))).toEqual(["exports"]);
    expect(rules(checkPackageManifest(core, privateManifest({ exports: { "./*": "./dist/*.js" } }), config, versions))).toEqual(["wildcard-export", "wildcard-export"]);
    expect(rules(checkPackageManifest(core, privateManifest({ exports: { "./lib/": "./dist/lib/" } }), config, versions))).toEqual(["directory-export"]);
    expect(rules(checkPackageManifest(core, privateManifest({ exports: { "./a": { default: "./src/a.ts" } } }), config, versions))).toEqual(["export-target"]);
    expect(rules(checkPackageManifest(core, privateManifest({ exports: { "./a": { "core-source": "./dist/a.js", default: "./dist/a.js" } } }), config, versions))).toEqual(["export-target"]);
    expect(rules(checkPackageManifest(core, privateManifest({ exports: { "./a": ["./dist/a.js", "./dist/../../x.js"] } }), config, versions))).toEqual(["export-target"]);
  });
  it("refuses a half-configured publication state", () => {
    expect(rules(checkPackageManifest(core, privateManifest({ private: false }), config, versions))).toEqual(["publication-state"]);
    expect(rules(checkPackageManifest(server, publishable({ private: true }), config, versions))).toEqual(["publication-state"]);
    expect(rules(checkPackageManifest(server, publishable({ license: "MIT" }), config, versions))).toEqual(["license"]);
    expect(rules(checkPackageManifest(server, publishable({ files: [] }), config, versions))).toEqual(["files"]);
    expect(rules(checkPackageManifest(server, publishable({ publishConfig: { access: "public", tag: "latest" } }), config, versions))).toEqual(["publish-config"]);
    expect(rules(checkPackageManifest(server, publishable({ publishConfig: { access: "public", provenance: true, tag: "latest" } }), config, versions))).toEqual(["publish-config"]);
    expect(rules(checkPackageManifest(server, publishable({ publishConfig: { access: "public", provenance: true, tag: "preview", registry: "http://127.0.0.1:9" } }), config, versions))).toEqual(["publish-config"]);
    expect(rules(checkPackageManifest(server, publishable({ repository: { type: "git", url: PUBLIC_REPOSITORY_URL } }), config, versions))).toEqual(["repository"]);
  });
});

describe("package release tags and versions", () => {
  it("parses only the anchored openlup-<package>-v<MAJOR.MINOR.PATCH> form", () => {
    expect(parsePackageReleaseTag("openlup-core-v0.11.0")).toEqual({ directory: "packages/core", name: "@openlup/core", version: "0.11.0" });
    expect(parsePackageReleaseTag("openlup-a-v1-v2.0.0")).toEqual({ directory: "packages/a-v1", name: "@openlup/a-v1", version: "2.0.0" });
    for (const tag of ["openlup-source-preview/10", "x-openlup-core-v0.11.0", "openlup-core-v0.11.0x", "openlup-core-v0.11.0\n", "openlup-core-v0.11.0-rc.1", "openlup-core-v0.11", "openlup-core-v01.0.0", "openlup-Core-v1.0.0", "openlup--v1.0.0", "openlup-core-1.0.0", "refs/tags/openlup-core-v1.0.0"]) expect(parsePackageReleaseTag(tag), tag).toBeUndefined();
  });
  it("orders a release version above lower versions and prereleases of itself only", () => {
    for (const [candidate, other] of [["0.11.0", "0.10.0"], ["0.11.0", "0.0.0"], ["1.0.0", "0.99.99"], ["1.0.0", "1.0.0-rc.1"], ["0.10.0", "0.9.0"], ["10.0.0", "9.0.0"], ["0.11.1", "0.11.0+build.1"]]) expect(releaseVersionAbove(candidate!, other!), `${candidate} > ${other}`).toBe(true);
    for (const [candidate, other] of [["0.11.0", "0.11.0"], ["0.9.0", "0.10.0"], ["0.11.0", "0.11.1-rc.1"], ["1.0.0", "2.0.0-0"]]) expect(releaseVersionAbove(candidate!, other!), `${candidate} > ${other}`).toBe(false);
    for (const [candidate, other] of [["1.0.0-rc.1", "0.1.0"], ["1.0", "0.1.0"], ["1.0.0", "latest"], ["1.0.0", "01.0.0"]]) expect(releaseVersionAbove(candidate!, other!), `${candidate} > ${other}`).toBeUndefined();
  });
});

describe("the committed packages", () => {
  it("every listed manifest passes, and every package directory is listed", () => {
    const parsed = parsePackagesConfig(readFileSync(PACKAGES_CONFIG_PATH, "utf8"));
    const tracked = execFileSync("git", ["ls-files", "-z", "packages"], { encoding: "utf8" }).split("\0").filter(Boolean);
    const read = (directory: string) => JSON.parse(readFileSync(`${directory}/package.json`, "utf8"));
    const committed = new Map(parsed.packages.map(({ name, directory }) => [name, read(directory).version]));
    const findings = [...checkPackageDirectories(parsed, tracked), ...parsed.packages.flatMap((entry) => checkPackageManifest(entry, read(entry.directory), parsed, committed)), ...parsed.unreleased.flatMap((entry) => checkUnreleasedManifest(entry, read(entry.directory)))];
    expect(findings).toEqual([]);
  });
});

describe("root consumption of built core", () => {
  it("resolves runtime exports to built JavaScript without a source condition", () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "--eval",
      "const specifier = '@openlup/core/subscription'; const mod = await import(specifier); console.log(JSON.stringify({ url: import.meta.resolve(specifier), exports: Object.keys(mod).length }));",
    ], { encoding: "utf8" });
    const result = JSON.parse(output.trim()) as { url: string; exports: number };
    expect(fileURLToPath(result.url)).toBe(join(process.cwd(), "packages/core/dist/subscription/index.js"));
    expect(result.exports).toBeGreaterThan(0);
  });

  it.each(["app", "api", "node", "mcp"])("resolves root %s types from built declarations", (project) => {
    const root = process.cwd();
    const config = ts.readConfigFile(join(root, `tsconfig.${project}.json`), ts.sys.readFile);
    expect(config.error).toBeUndefined();
    const parsed = ts.convertCompilerOptionsFromJson(config.config.compilerOptions, root);
    expect(parsed.errors).toEqual([]);
    expect(parsed.options.customConditions).toBeUndefined();
    const resolved = ts.resolveModuleName("@openlup/core/subscription", resolve(root, "src/core-resolution-probe.ts"), parsed.options, ts.sys).resolvedModule;
    expect(resolved?.resolvedFileName).toBe(join(root, "packages/core/dist/subscription/index.d.ts"));
  });
});
