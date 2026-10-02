/**
 * The release shape of every `@openlup/*` package, checked from its manifest alone.
 *
 * `config/openlup-packages.json` lists every package directory, as released or
 * as unreleased. Each released package carries its own `MAJOR.MINOR.PATCH`
 * version in its own manifest and is released on its own, under the tag
 * `openlup-<directory name>-v<version>`. A released package is either not yet
 * publishable (`publish: false`, and then its manifest says `private: true`) or
 * publishable, and then its manifest carries exactly the public,
 * provenance-backed publication settings. An unreleased package is always
 * private. Nothing in between passes: a half-configured package is the state
 * that publishes by accident.
 */
export const PACKAGES_CONFIG_PATH = "config/openlup-packages.json";
export const PUBLIC_REPOSITORY_URL = "git+https://github.com/openlup/openlup.git";

export type PackageEntry = { name: string; directory: string; publish: boolean };
export type UnreleasedEntry = { directory: string; reason: string };
export type PackagesConfig = { schemaVersion: 2; packages: PackageEntry[]; unreleased: UnreleasedEntry[] };
export type Finding = { subject: string; rule: string; detail: string };
/** Each released package's own manifest version, by package name. */
export type PackageVersions = ReadonlyMap<string, unknown>;
type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
/** A release version: `MAJOR.MINOR.PATCH` without leading zeros or a prerelease, because every release moves npm `latest`. */
export const RELEASE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
/** The one tag a package release carries, `openlup-<directory name>-v<release version>`, anchored at both ends. */
export const PACKAGE_RELEASE_TAG = /^openlup-([a-z0-9][a-z0-9-]*)-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u;
const DIRECTORY = /^packages\/[a-z0-9][a-z0-9-]*$/;
const NAME = /^@openlup\/[a-z0-9][a-z0-9-]*$/;
/** One comparator of a registry semver range: `4.4.3`, `^4.4.3`, `~4`, `>=1.2.0`, `1.x`. */
const COMPARATOR = /^(?:[\^~]|>=|<=|>|<|=)?\d+(?:\.(?:\d+|x|\*)){0,2}(?:-[0-9A-Za-z.-]+)?$/;
const DEPENDENCY_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"] as const;
// A publish that names no dist-tag takes `preview` and never moves `latest`. Only the release
// workflow's explicit `--tag latest`, which npm prefers to publishConfig, moves it.
const PUBLISH_CONFIG = { access: "public", provenance: true, tag: "preview" } as const;

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
/**
 * Whether release version `candidate` is above `other`, which may be any semver version: a
 * prerelease is below its release. Undefined when either version does not parse.
 */
export function releaseVersionAbove(candidate: string, other: string): boolean | undefined {
  const next = SEMVER.exec(candidate), previous = SEMVER.exec(other);
  if (!next || next[4] !== undefined || !previous) return undefined;
  for (const index of [1, 2, 3]) {
    const left = BigInt(next[index]!), right = BigInt(previous[index]!);
    if (left !== right) return left > right;
  }
  return previous[4] !== undefined;
}

/** The package and version a release tag names, or undefined when it is not a package release tag. */
export function parsePackageReleaseTag(tag: string): { directory: string; name: string; version: string } | undefined {
  const match = PACKAGE_RELEASE_TAG.exec(tag);
  return match ? { directory: `packages/${match[1]}`, name: `@openlup/${match[1]}`, version: match[2]! } : undefined;
}

/** A range the registry resolves: comparators joined by spaces and `||`. Aliases, URLs, paths, git and tags are not ranges. */
export const isRegistryRange = (range: unknown): boolean => typeof range === "string" && range.split("||").every((part) => { const tokens = part.trim().split(/\s+/); return tokens.length > 0 && tokens.every((token) => COMPARATOR.test(token)); });
const sameJson = (left: unknown, right: unknown): boolean => {
  if (isObject(left) && isObject(right)) { const keys = Object.keys(left).sort(); return JSON.stringify(keys) === JSON.stringify(Object.keys(right).sort()) && keys.every((key) => sameJson(left[key], right[key])); }
  return JSON.stringify(left) === JSON.stringify(right);
};

export function parsePackagesConfig(source: string): PackagesConfig {
  const raw: unknown = JSON.parse(source);
  const fail = (detail: string): never => { throw new Error(`${PACKAGES_CONFIG_PATH}: ${detail}`); };
  if (!isObject(raw) || raw.schemaVersion !== 2) fail("unsupported schemaVersion");
  const config = raw as Json;
  if (Object.keys(config).some((key) => !["schemaVersion", "packages", "unreleased"].includes(key))) fail("carries unknown top-level keys; a package's version is in its own manifest");
  if (!Array.isArray(config.packages) || config.packages.length === 0) fail("packages must be a non-empty array");
  if (!Array.isArray(config.unreleased)) fail("unreleased must be an array");
  const packages = (config.packages as unknown[]).map((row, index): PackageEntry => {
    if (!isObject(row) || typeof row.name !== "string" || !NAME.test(row.name)) return fail(`packages[${index}].name must be an @openlup/ name`);
    if (typeof row.directory !== "string" || !DIRECTORY.test(row.directory)) return fail(`packages[${index}].directory must be packages/<name>`);
    if (row.name !== `@openlup/${row.directory.slice("packages/".length)}`) return fail(`packages[${index}].name must be @openlup/<directory name>, the package its release tag names`);
    if (typeof row.publish !== "boolean") return fail(`packages[${index}].publish must be a boolean`);
    if (Object.keys(row).length !== 3) return fail(`packages[${index}] carries unknown keys`);
    return { name: row.name, directory: row.directory, publish: row.publish };
  });
  const unreleased = (config.unreleased as unknown[]).map((row, index): UnreleasedEntry => {
    if (!isObject(row) || typeof row.directory !== "string" || !DIRECTORY.test(row.directory)) return fail(`unreleased[${index}].directory must be packages/<name>`);
    if (typeof row.reason !== "string" || row.reason.trim() === "") return fail(`unreleased[${index}].reason is required`);
    if (Object.keys(row).length !== 2) return fail(`unreleased[${index}] carries unknown keys`);
    return { directory: row.directory, reason: row.reason };
  });
  const directories = [...packages.map(({ directory }) => directory), ...unreleased.map(({ directory }) => directory)];
  if (new Set(directories).size !== directories.length) fail("a package directory is listed twice");
  if (new Set(packages.map(({ name }) => name)).size !== packages.length) fail("a package name is listed twice");
  return { schemaVersion: 2, packages, unreleased };
}

/** Every `packages/<name>/package.json` in the tree is listed exactly once, as released or as unreleased. */
export function checkPackageDirectories(config: PackagesConfig, manifestPaths: readonly string[]): Finding[] {
  const listed = new Set([...config.packages.map(({ directory }) => directory), ...config.unreleased.map(({ directory }) => directory)]);
  const present = new Set(manifestPaths.filter((path) => /^packages\/[^/]+\/package\.json$/.test(path)).map((path) => path.slice(0, -"/package.json".length)));
  const findings: Finding[] = [];
  for (const directory of present) if (!listed.has(directory)) findings.push({ subject: directory, rule: "unlisted-package", detail: `add it to ${PACKAGES_CONFIG_PATH} as a package or as unreleased` });
  for (const directory of listed) if (!present.has(directory)) findings.push({ subject: directory, rule: "missing-package", detail: "listed, but has no package.json" });
  return findings;
}

/** An unreleased package is never publishable. */
export function checkUnreleasedManifest(entry: UnreleasedEntry, manifest: unknown): Finding[] {
  return isObject(manifest) && manifest.private === true ? [] : [{ subject: entry.directory, rule: "publication-state", detail: "an unreleased package declares private: true" }];
}

/** Walk an `exports` value and return every string target with the condition path that led to it. */
function exportTargets(value: unknown, conditions: string[] = []): Array<{ conditions: string[]; target: string }> {
  if (typeof value === "string") return [{ conditions, target: value }];
  if (Array.isArray(value)) return value.flatMap((item) => exportTargets(item, conditions));
  if (isObject(value)) return Object.entries(value).flatMap(([key, item]) => exportTargets(item, [...conditions, key]));
  return [];
}

function checkExports(subject: string, exportsField: unknown): Finding[] {
  const finding = (rule: string, detail: string): Finding => ({ subject, rule, detail });
  if (!isObject(exportsField) || Object.keys(exportsField).length === 0) return [finding("exports", "exports must be a non-empty subpath map")];
  const findings: Finding[] = [];
  for (const [key, value] of Object.entries(exportsField)) {
    if (key !== "." && !key.startsWith("./")) findings.push(finding("exports", `${key}: a subpath key starts with "./"`));
    if (key.includes("*")) findings.push(finding("wildcard-export", `${key}: wildcard exports turn internals into public API`));
    if (key.endsWith("/")) findings.push(finding("directory-export", `${key}: directory exports turn internals into public API`));
    for (const { conditions, target } of exportTargets(value)) {
      const where = [key, ...conditions].join(" > ");
      if (target.includes("*")) findings.push(finding("wildcard-export", `${where}: ${target}`));
      if (target.split("/").includes("..")) findings.push(finding("export-target", `${where}: ${target} leaves the package`));
      else if (key === "./package.json" && target === "./package.json") continue;
      else if (conditions.includes("core-source")) { if (!target.startsWith("./src/")) findings.push(finding("export-target", `${where}: a core-source target stays under ./src/`)); }
      else if (!target.startsWith("./dist/")) findings.push(finding("export-target", `${where}: ${target} is not built output under ./dist/`));
    }
  }
  return findings;
}

function checkPublication(entry: PackageEntry, manifest: Json): Finding[] {
  const finding = (rule: string, detail: string): Finding => ({ subject: entry.name, rule, detail });
  if (!entry.publish) return manifest.private === true ? [] : [finding("publication-state", "a package that is not yet publishable declares private: true")];
  const findings: Finding[] = [];
  if (manifest.private !== undefined && manifest.private !== false) findings.push(finding("publication-state", "a publishable package is not private"));
  if (manifest.license !== "Apache-2.0") findings.push(finding("license", "license is Apache-2.0"));
  if (!sameJson(manifest.publishConfig, PUBLISH_CONFIG)) findings.push(finding("publish-config", `publishConfig is exactly ${JSON.stringify(PUBLISH_CONFIG)}: public, provenance-backed, and latest only through the release workflow`));
  const repository = manifest.repository;
  if (!isObject(repository) || repository.type !== "git" || repository.url !== PUBLIC_REPOSITORY_URL || repository.directory !== entry.directory) findings.push(finding("repository", `repository is { type: "git", url: "${PUBLIC_REPOSITORY_URL}", directory: "${entry.directory}" }; provenance needs it`));
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) findings.push(finding("files", "a publishable package lists its files"));
  return findings;
}

function checkDependencies(entry: PackageEntry, manifest: Json, config: PackagesConfig, versions: PackageVersions): Finding[] {
  const finding = (rule: string, detail: string): Finding => ({ subject: entry.name, rule, detail });
  const internal = new Map(config.packages.map((row) => [row.name, row]));
  const findings: Finding[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest[field];
    if (dependencies === undefined) continue;
    if (!isObject(dependencies)) { findings.push(finding("dependencies", `${field} is an object`)); continue; }
    for (const [name, range] of Object.entries(dependencies)) {
      const where = `${field}.${name}`;
      if (name.startsWith("@openlup/")) {
        const target = internal.get(name);
        if (!target) { findings.push(finding("unknown-internal", `${where} is not a released package in ${PACKAGES_CONFIG_PATH}`)); continue; }
        if (entry.publish && !target.publish) findings.push(finding("unpublishable-dependency", `${where} is not publishable, so a registry install cannot resolve it`));
        if (range !== versions.get(name)) findings.push(finding("internal-pin", `${where} is exactly ${String(versions.get(name))}, the version of ${name}, not ${String(range)}`));
      } else if (!isRegistryRange(range)) findings.push(finding("dependency-source", `${where} is ${String(range)}, not a registry semver range`));
    }
  }
  return findings;
}

/** The release shape of one released package: identity, release version, registry dependencies, curated exports, publication state. */
export function checkPackageManifest(entry: PackageEntry, manifest: unknown, config: PackagesConfig, versions: PackageVersions): Finding[] {
  const finding = (rule: string, detail: string): Finding => ({ subject: entry.name, rule, detail });
  if (!isObject(manifest)) return [finding("manifest", `${entry.directory}/package.json is not an object`)];
  const findings: Finding[] = [];
  if (manifest.name !== entry.name) findings.push(finding("name", `${entry.directory}/package.json names ${String(manifest.name)}`));
  if (typeof manifest.version !== "string" || !RELEASE_VERSION.test(manifest.version)) findings.push(finding("version", `version ${String(manifest.version)} is not a MAJOR.MINOR.PATCH release version`));
  findings.push(...checkDependencies(entry, manifest, config, versions), ...checkExports(entry.name, manifest.exports), ...checkPublication(entry, manifest));
  return findings;
}
