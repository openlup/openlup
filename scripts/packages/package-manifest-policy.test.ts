import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PACKAGES_CONFIG_PATH, PUBLIC_REPOSITORY_URL, checkPackageDirectories, checkPackageManifest, checkUnreleasedManifest, isRegistryRange, parsePackagesConfig, type PackageEntry, type PackagesConfig } from "./package-manifest-policy.ts";

const config: PackagesConfig = { schemaVersion: 1, version: "0.6.0", packages: [{ name: "@openlup/core", directory: "packages/core", publish: false }, { name: "@openlup/server", directory: "packages/server", publish: true }, { name: "@openlup/db", directory: "packages/db", publish: true }], unreleased: [{ directory: "packages/ui", reason: "scaffold" }] };
const [core, server] = config.packages as [PackageEntry, PackageEntry, PackageEntry];
const privateManifest = (patch: Record<string, unknown> = {}) => ({ name: "@openlup/core", version: "0.6.0", private: true, exports: { "./bundle": { "core-source": "./src/bundle.ts", types: "./dist/bundle.d.ts", default: "./dist/bundle.js" }, "./package.json": "./package.json" }, ...patch });
const publishable = (patch: Record<string, unknown> = {}) => ({ name: "@openlup/server", version: "0.6.0", license: "Apache-2.0", files: ["dist/**"], publishConfig: { access: "public", provenance: true, tag: "preview" }, repository: { type: "git", url: PUBLIC_REPOSITORY_URL, directory: "packages/server" }, exports: { "./runtime": { types: "./dist/runtime.d.ts", default: "./dist/runtime.js" } }, dependencies: { "@openlup/db": "0.6.0", zod: "^4.4.3" }, ...patch });
const rules = (findings: Array<{ rule: string }>) => findings.map(({ rule }) => rule);
const text = (value: unknown) => JSON.stringify(value);
const base = { schemaVersion: 1, version: "0.6.0", packages: [{ name: "@openlup/core", directory: "packages/core", publish: false }], unreleased: [] };

describe("packages config", () => {
  it("parses the committed config", () => {
    expect(parsePackagesConfig(readFileSync(PACKAGES_CONFIG_PATH, "utf8")).packages.map(({ name }) => name)).toContain("@openlup/core");
  });
  it("refuses each malformed shape", () => {
    expect(() => parsePackagesConfig(text({ ...base, schemaVersion: 2 }))).toThrow(/schemaVersion/);
    expect(() => parsePackagesConfig(text({ ...base, extra: true }))).toThrow(/top-level/);
    expect(() => parsePackagesConfig(text({ ...base, version: "latest" }))).toThrow(/semver/);
    expect(() => parsePackagesConfig(text({ ...base, packages: [] }))).toThrow(/non-empty/);
    expect(() => parsePackagesConfig(text({ ...base, packages: [{ name: "core", directory: "packages/core", publish: false }] }))).toThrow(/@openlup/);
    expect(() => parsePackagesConfig(text({ ...base, packages: [{ ...base.packages[0], tag: "latest" }] }))).toThrow(/unknown keys/);
    expect(() => parsePackagesConfig(text({ ...base, packages: [base.packages[0], { name: "@openlup/core", directory: "packages/other", publish: false }] }))).toThrow(/name is listed twice/);
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
    expect(checkPackageManifest(core, privateManifest(), config)).toEqual([]);
    expect(checkPackageManifest(server, publishable(), config)).toEqual([]);
    expect(checkPackageManifest(server, publishable({ publishConfig: { tag: "preview", provenance: true, access: "public" } }), config)).toEqual([]);
  });
  it("refuses version skew and every non-registry or unpinned dependency", () => {
    expect(rules(checkPackageManifest(core, privateManifest({ version: "0.5.0" }), config))).toEqual(["version-skew"]);
    expect(rules(checkPackageManifest(server, publishable({ dependencies: { "@openlup/db": "^0.6.0" } }), config))).toEqual(["internal-pin"]);
    expect(rules(checkPackageManifest(server, publishable({ dependencies: { "@openlup/core": "0.6.0" } }), config))).toEqual(["unpublishable-dependency"]);
    expect(rules(checkPackageManifest(server, publishable({ dependencies: { "@openlup/ui": "^0.0.0" } }), config))).toEqual(["unknown-internal", "internal-pin"]);
    expect(rules(checkPackageManifest(server, publishable({ peerDependencies: { other: "file:../other" } }), config))).toEqual(["dependency-source"]);
    expect(rules(checkPackageManifest(server, publishable({ optionalDependencies: { alias: "npm:@openlup/core@^0.5.0" } }), config))).toEqual(["dependency-source"]);
    expect(rules(checkPackageManifest(server, publishable({ dependencies: [] }), config))).toEqual(["dependencies"]);
  });
  it("refuses malformed, wildcard, directory and out-of-dist exports", () => {
    expect(rules(checkPackageManifest(core, privateManifest({ exports: "./dist/index.js" }), config))).toEqual(["exports"]);
    expect(rules(checkPackageManifest(core, privateManifest({ exports: { bundle: "./dist/bundle.js" } }), config))).toEqual(["exports"]);
    expect(rules(checkPackageManifest(core, privateManifest({ exports: { "./*": "./dist/*.js" } }), config))).toEqual(["wildcard-export", "wildcard-export"]);
    expect(rules(checkPackageManifest(core, privateManifest({ exports: { "./lib/": "./dist/lib/" } }), config))).toEqual(["directory-export"]);
    expect(rules(checkPackageManifest(core, privateManifest({ exports: { "./a": { default: "./src/a.ts" } } }), config))).toEqual(["export-target"]);
    expect(rules(checkPackageManifest(core, privateManifest({ exports: { "./a": { "core-source": "./dist/a.js", default: "./dist/a.js" } } }), config))).toEqual(["export-target"]);
    expect(rules(checkPackageManifest(core, privateManifest({ exports: { "./a": ["./dist/a.js", "./dist/../../x.js"] } }), config))).toEqual(["export-target"]);
  });
  it("refuses a half-configured publication state", () => {
    expect(rules(checkPackageManifest(core, privateManifest({ private: false }), config))).toEqual(["publication-state"]);
    expect(rules(checkPackageManifest(server, publishable({ private: true }), config))).toEqual(["publication-state"]);
    expect(rules(checkPackageManifest(server, publishable({ license: "MIT" }), config))).toEqual(["license"]);
    expect(rules(checkPackageManifest(server, publishable({ files: [] }), config))).toEqual(["files"]);
    expect(rules(checkPackageManifest(server, publishable({ publishConfig: { access: "public", tag: "latest" } }), config))).toEqual(["publish-config"]);
    expect(rules(checkPackageManifest(server, publishable({ publishConfig: { access: "public", provenance: true, tag: "preview", registry: "http://127.0.0.1:9" } }), config))).toEqual(["publish-config"]);
    expect(rules(checkPackageManifest(server, publishable({ repository: { type: "git", url: PUBLIC_REPOSITORY_URL } }), config))).toEqual(["repository"]);
  });
});

describe("the committed packages", () => {
  it("every listed manifest passes, and every package directory is listed", () => {
    const parsed = parsePackagesConfig(readFileSync(PACKAGES_CONFIG_PATH, "utf8"));
    const tracked = execFileSync("git", ["ls-files", "-z", "packages"], { encoding: "utf8" }).split("\0").filter(Boolean);
    const read = (directory: string) => JSON.parse(readFileSync(`${directory}/package.json`, "utf8"));
    const findings = [...checkPackageDirectories(parsed, tracked), ...parsed.packages.flatMap((entry) => checkPackageManifest(entry, read(entry.directory), parsed)), ...parsed.unreleased.flatMap((entry) => checkUnreleasedManifest(entry, read(entry.directory)))];
    expect(findings).toEqual([]);
  });
});
