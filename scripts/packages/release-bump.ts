/**
 * `npm run release:bump -- --set <version>`, from the repository root, sets
 * every publishable package of `config/openlup-packages.json` to the next set
 * version `0.N.P`, above the one they all carry now: the release-preparation
 * step of a set release. `npm run release:bump -- <package> <version>` sets the
 * released package `packages/<package>` alone; for a publishable package that
 * is the same step, and it is refused while another package is publishable.
 *
 * It rewrites exactly these strings: each bumped package's version in its
 * `package.json`, the root of its own `package-lock.json` and its workspace
 * entry in the root `package-lock.json`, where they exist; every exact internal
 * pin on a bumped package (`dependencies`, `peerDependencies`,
 * `optionalDependencies`) in a released package's manifest and lockfile entries;
 * and, for a publishable package, its CHANGELOG: the Unreleased entries move
 * under a new `## [<version>]` heading that opens with the "Publishable" line,
 * below a fresh empty Unreleased heading. Every other byte stays, and each
 * rewritten JSON file must parse to its original with only those fields
 * changed. Nothing is written unless every file passes. The package release
 * workflow refuses a version that differs from the package's manifest.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { PACKAGES_CONFIG_PATH, RELEASE_VERSION, SET_VERSION, parsePackagesConfig, releaseVersionAbove, type PackageEntry, type PackagesConfig } from "./package-manifest-policy.ts";

type Json = Record<string, unknown>;
type Edit = { path: readonly string[]; from: string; to: string };
const PACKAGE = /^[a-z0-9][a-z0-9-]*$/u;
const UNRELEASED = /^## \[Unreleased\]\n\n/mu;
const PIN_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"] as const;
const at = (value: unknown, path: readonly string[]): unknown => path.reduce<unknown>((node, key) => (node !== null && typeof node === "object" ? (node as Json)[key] : undefined), value);

/** `text` with each edit's `"<key>": "<from>"` member set to `<to>` at exactly its key path, and nowhere else. */
export function setStringFields(file: string, text: string, edits: readonly Edit[]): string {
  const expected = JSON.parse(text) as Json;
  for (const { path, from, to } of edits) {
    if (at(expected, path) !== from) throw new Error(`${file}: ${path.join(" > ")} is ${JSON.stringify(at(expected, path))}, not the current ${from}`);
    (at(expected, path.slice(0, -1)) as Json)[path.at(-1)!] = to;
  }
  let result = text;
  for (const { path, from, to } of edits) {
    const key = JSON.stringify(path.at(-1)), needle = `${key}: "${from}"`;
    for (let index = result.indexOf(needle); index !== -1; index = result.indexOf(needle, index + 1)) {
      const candidate = `${result.slice(0, index)}${key}: "${to}"${result.slice(index + needle.length)}`;
      if (at(JSON.parse(candidate), path) === to) { result = candidate; break; }
    }
    if (at(JSON.parse(result), path) !== to) throw new Error(`${file}: ${path.join(" > ")} is not written as ${needle}`);
  }
  if (!isDeepStrictEqual(JSON.parse(result), expected)) throw new Error(`${file}: a rewrite changed more than its fields`);
  return result;
}

/** `text` with `"version": "<from>"` replaced at exactly the key paths `fields`, and nowhere else. */
export function setVersionFields(file: string, text: string, fields: readonly string[][], from: string, to: string): string {
  return setStringFields(file, text, fields.map((path) => ({ path, from, to })));
}

/** `text` with the Unreleased entries under a new `## [<version>]` heading that opens with the "Publishable" line. */
export function addReleaseSection(file: string, text: string, version: string, tag: string): string {
  const unreleased = UNRELEASED.exec(text);
  if (!unreleased) throw new Error(`${file}: has no "## [Unreleased]" heading followed by a blank line`);
  if (text.includes(`\n## [${version}]`)) throw new Error(`${file}: already has a ${version} section`);
  const end = unreleased.index + unreleased[0].length;
  return `${text.slice(0, end)}## [${version}]\n\n- Publishable on the npm \`latest\` dist-tag as \`${version}\`, from tag\n  \`${tag}\`.\n\n${text.slice(end)}`;
}

/** Every exact pin on a bumped package in the dependency fields of `node`, at `base`. */
const pins = (node: unknown, base: readonly string[], bumped: ReadonlySet<string>, from: string, to: string): Edit[] =>
  PIN_FIELDS.flatMap((field) => Object.keys((at(node, [field]) ?? {}) as Json).filter((name) => bumped.has(name)).map((name) => ({ path: [...base, field, name], from, to })));

/** The rewritten files that bring `entries` from `from` to `version`, with every internal pin on them. */
function bumpFiles(root: string, config: PackagesConfig, entries: readonly PackageEntry[], from: string, version: string): Array<[string, string]> {
  const read = (file: string) => readFileSync(join(root, file), "utf8");
  const bumped = new Set(entries.map(({ name }) => name));
  const rootLock = JSON.parse(read("package-lock.json")) as Json;
  const rootLockEdits: Edit[] = [];
  const writes: Array<[string, string]> = [];
  for (const entry of config.packages) {
    const own = bumped.has(entry.name);
    const ownVersion = (path: readonly string[]): Edit[] => (own ? [{ path, from, to: version }] : []);
    const manifest = `${entry.directory}/package.json`;
    const manifestEdits = [...ownVersion(["version"]), ...pins(JSON.parse(read(manifest)), [], bumped, from, version)];
    if (manifestEdits.length > 0) writes.push([manifest, setStringFields(manifest, read(manifest), manifestEdits)]);
    const lockEntry = at(rootLock, ["packages", entry.directory]);
    if (lockEntry !== undefined) rootLockEdits.push(...ownVersion(["packages", entry.directory, "version"]), ...pins(lockEntry, ["packages", entry.directory], bumped, from, version));
    const ownLock = `${entry.directory}/package-lock.json`;
    if (existsSync(join(root, ownLock))) {
      const lockEdits = [...ownVersion(["version"]), ...ownVersion(["packages", "", "version"]), ...pins(at(JSON.parse(read(ownLock)), ["packages", ""]), ["packages", ""], bumped, from, version)];
      if (lockEdits.length > 0) writes.push([ownLock, setStringFields(ownLock, read(ownLock), lockEdits)]);
    }
    if (own && entry.publish) {
      const changelog = `${entry.directory}/CHANGELOG.md`;
      writes.push([changelog, addReleaseSection(changelog, read(changelog), version, `openlup-${entry.directory.slice("packages/".length)}-v${version}`)]);
    }
  }
  if (rootLockEdits.length > 0) writes.push(["package-lock.json", setStringFields("package-lock.json", read("package-lock.json"), rootLockEdits)]);
  return writes;
}

const manifestVersion = (root: string, entry: PackageEntry): unknown => (JSON.parse(readFileSync(join(root, entry.directory, "package.json"), "utf8")) as Json).version;
const writeAll = (root: string, writes: Array<[string, string]>): string[] => {
  for (const [file, text] of writes) writeFileSync(join(root, file), text);
  return writes.map(([file]) => file);
};

/** Sets `packages/<name>` to `version` and returns the rewritten files. */
export function bumpRelease(root: string, name: string, version: string): string[] {
  if (!PACKAGE.test(name)) throw new Error(`${name} is not a package directory name under packages/`);
  if (!RELEASE_VERSION.test(version)) throw new Error(`${version} is not a MAJOR.MINOR.PATCH release version`);
  const directory = `packages/${name}`;
  const config = parsePackagesConfig(readFileSync(join(root, PACKAGES_CONFIG_PATH), "utf8"));
  const entry = config.packages.find((row) => row.directory === directory);
  if (!entry) throw new Error(`${directory} is not a released package in ${PACKAGES_CONFIG_PATH}`);
  const from = manifestVersion(root, entry);
  if (typeof from !== "string" || releaseVersionAbove(version, from) !== true) throw new Error(`${entry.name} is at ${String(from)}; the next version must be a release version above it`);
  if (entry.publish && !SET_VERSION.test(version)) throw new Error(`${entry.name} is publishable, so its next version is a set version 0.N.P below 1.0, not ${version}`);
  if (entry.publish && config.packages.some((row) => row.publish && row !== entry)) throw new Error(`${entry.name} moves with its set: npm run release:bump -- --set <version>`);
  return writeAll(root, bumpFiles(root, config, [entry], from, version));
}

/** Sets every publishable package to the set version `version` and returns the rewritten files. */
export function bumpSet(root: string, version: string): string[] {
  if (!SET_VERSION.test(version)) throw new Error(`${version} is not a set version 0.N.P below 1.0`);
  const config = parsePackagesConfig(readFileSync(join(root, PACKAGES_CONFIG_PATH), "utf8"));
  const publishable = config.packages.filter(({ publish }) => publish);
  if (publishable.length === 0) throw new Error(`${PACKAGES_CONFIG_PATH} lists no publishable package`);
  const current = publishable.map((entry) => [entry.name, manifestVersion(root, entry)] as const);
  const from = current[0]![1];
  if (current.some(([, other]) => other !== from)) throw new Error(`the publishable packages carry different versions (${current.map(([name, other]) => `${name}@${String(other)}`).join(", ")}); packages:check refuses that`);
  if (typeof from !== "string" || releaseVersionAbove(version, from) !== true) throw new Error(`the set is at ${String(from)}; the next set version must be above it`);
  return writeAll(root, bumpFiles(root, config, publishable, from, version));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const set = args.length === 2 && args[0] === "--set" && SET_VERSION.test(args[1]!);
  if (!set && (args.length !== 2 || !PACKAGE.test(args[0]!) || !RELEASE_VERSION.test(args[1]!))) {
    console.error("usage: npm run release:bump -- --set <0.N.P>, or npm run release:bump -- <package directory name> <MAJOR.MINOR.PATCH>");
    process.exitCode = 2;
  } else {
    try {
      for (const file of set ? bumpSet(process.cwd(), args[1]!) : bumpRelease(process.cwd(), args[0]!, args[1]!)) console.log(`release:bump: rewrote ${file}`);
    } catch (error) {
      console.error(`release:bump: refused: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
