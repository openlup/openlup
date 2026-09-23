import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PACKAGES_CONFIG_PATH, PUBLIC_REPOSITORY_URL, checkPackageDirectories, checkPackageManifest, parsePackagesConfig, type PackageEntry, type PackagesConfig } from "./package-manifest-policy.ts";

const config: PackagesConfig = { schemaVersion: 1, version: "0.6.0", packages: [{ name: "@openlup/core", directory: "packages/core", publish: false }, { name: "@openlup/server", directory: "packages/server", publish: true }], unreleased: [] };
const core = config.packages[0] as PackageEntry, server = config.packages[1] as PackageEntry;
const privateManifest = (patch: Record<string, unknown> = {}) => ({ name: "@openlup/core", version: "0.6.0", private: true, exports: { "./bundle": { "core-source": "./src/bundle.ts", types: "./dist/bundle.d.ts", default: "./dist/bundle.js" }, "./package.json": "./package.json" }, ...patch });
const publishable = (patch: Record<string, unknown> = {}) => ({ name: "@openlup/server", version: "0.6.0", license: "Apache-2.0", files: ["dist/**"], publishConfig: { access: "public", provenance: true, tag: "preview" }, repository: { type: "git", url: PUBLIC_REPOSITORY_URL, directory: "packages/server" }, exports: { "./runtime": { types: "./dist/runtime.d.ts", default: "./dist/runtime.js" } }, dependencies: { "@openlup/core": "0.6.0", zod: "^4.4.3" }, ...patch });
const rules = (findings: Array<{ rule: string }>) => findings.map(({ rule }) => rule);

describe("packages config", () => {
  it("parses the committed config", () => {
    const parsed = parsePackagesConfig(readFileSync(PACKAGES_CONFIG_PATH, "utf8"));
    expect(parsed.packages.map(({ name }) => name)).toContain("@openlup/core");
  });
  it("refuses an unknown schema, a bad name, unknown keys and a duplicate directory", () => {
    const text = (value: unknown) => JSON.stringify(value);
    const base = { schemaVersion: 1, version: "0.6.0", packages: [{ name: "@openlup/core", directory: "packages/core", publish: false }], unreleased: [] };
    expect(() => parsePackagesConfig(text({ ...base, schemaVersion: 2 }))).toThrow(/schemaVersion/);
    expect(() => parsePackagesConfig(text({ ...base, version: "latest" }))).toThrow(/semver/);
    expect(() => parsePackagesConfig(text({ ...base, packages: [{ name: "core", directory: "packages/core", publish: false }] }))).toThrow(/@openlup/);
    expect(() => parsePackagesConfig(text({ ...base, packages: [{ ...base.packages[0], tag: "latest" }] }))).toThrow(/unknown keys/);
    expect(() => parsePackagesConfig(text({ ...base, unreleased: [{ directory: "packages/core", reason: "twice" }] }))).toThrow(/twice/);
  });
});

describe("package directories", () => {
  it("names every package directory exactly once", () => {
    expect(checkPackageDirectories(config, ["packages/core/package.json", "packages/server/package.json"])).toEqual([]);
    expect(rules(checkPackageDirectories(config, ["packages/core/package.json", "packages/server/package.json", "packages/extra/package.json"]))).toEqual(["unlisted-package"]);
    expect(rules(checkPackageDirectories(config, ["packages/core/package.json"]))).toEqual(["missing-package"]);
  });
});

describe("package manifest", () => {
  it("accepts a private package and a publishable one", () => {
    expect(checkPackageManifest(core, privateManifest(), config)).toEqual([]);
    expect(checkPackageManifest(server, publishable(), config)).toEqual([]);
  });
  it("refuses version skew, ranged internal pins and non-registry sources", () => {
    expect(rules(checkPackageManifest(core, privateManifest({ version: "0.5.0" }), config))).toEqual(["version-skew"]);
    expect(rules(checkPackageManifest(server, publishable({ dependencies: { "@openlup/core": "^0.6.0" } }), config))).toEqual(["internal-pin"]);
    expect(rules(checkPackageManifest(server, publishable({ peerDependencies: { other: "file:../other" } }), config))).toEqual(["dependency-source"]);
  });
  it("refuses wildcard, directory and out-of-dist exports", () => {
    expect(rules(checkPackageManifest(core, privateManifest({ exports: { "./*": "./dist/*.js" } }), config))).toEqual(["wildcard-export", "wildcard-export"]);
    expect(rules(checkPackageManifest(core, privateManifest({ exports: { "./lib/": "./dist/lib/" } }), config))).toEqual(["directory-export"]);
    expect(rules(checkPackageManifest(core, privateManifest({ exports: { "./a": { default: "./src/a.ts" } } }), config))).toEqual(["export-target"]);
    expect(rules(checkPackageManifest(core, privateManifest({ exports: { "./a": { "core-source": "./dist/a.js", default: "./dist/a.js" } } }), config))).toEqual(["export-target"]);
    expect(rules(checkPackageManifest(core, privateManifest({ exports: { "./a": "./dist/../../x.js" } }), config))).toEqual(["export-target"]);
  });
  it("refuses a half-configured publication state", () => {
    expect(rules(checkPackageManifest(core, privateManifest({ private: false }), config))).toEqual(["publication-state"]);
    expect(rules(checkPackageManifest(server, publishable({ private: true }), config))).toEqual(["publication-state"]);
    expect(rules(checkPackageManifest(server, publishable({ publishConfig: { access: "public", tag: "latest" } }), config))).toEqual(["publish-config"]);
    expect(rules(checkPackageManifest(server, publishable({ publishConfig: { access: "public", provenance: true, tag: "preview", registry: "http://127.0.0.1:9" } }), config))).toEqual(["publish-config"]);
    expect(rules(checkPackageManifest(server, publishable({ repository: { type: "git", url: PUBLIC_REPOSITORY_URL } }), config))).toEqual(["repository"]);
  });
});

describe("the committed packages", () => {
  it("every listed manifest passes, and every package directory is listed", () => {
    const parsed = parsePackagesConfig(readFileSync(PACKAGES_CONFIG_PATH, "utf8"));
    const tracked = execFileSync("git", ["ls-files", "-z", "packages"], { encoding: "utf8" }).split("\0").filter(Boolean);
    const findings = [...checkPackageDirectories(parsed, tracked), ...parsed.packages.flatMap((entry) => checkPackageManifest(entry, JSON.parse(readFileSync(`${entry.directory}/package.json`, "utf8")), parsed))];
    expect(findings).toEqual([]);
  });
});
