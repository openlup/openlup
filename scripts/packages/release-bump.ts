/**
 * `npm run release:bump -- --set <version>`, from the repository root, sets
 * every publishable package of `config/openlup-packages.json` to the next set
 * version `MAJOR.MINOR.PATCH`, above the one they all carry now: the release-preparation
 * step of a set release. `npm run release:bump -- <package> <version>` sets the
 * released package `packages/<package>` alone; for a publishable package that
 * is the same step, and it is refused while another package is publishable.
 *
 * It rewrites exactly these strings: each bumped package's version in its
 * `package.json`, the root of its own `package-lock.json` and its workspace
 * entry in the root `package-lock.json`, where they exist; every exact internal
 * pin on a bumped package (`dependencies`, `peerDependencies`,
 * `optionalDependencies`) in a released package's manifest and lockfile entries;
 * and, for a publishable package, its CHANGELOG: legacy Unreleased then sorted fragments move
 * under a new `## [<version>]` heading that opens with the "Publishable" line,
 * below a fresh empty Unreleased heading. Every other byte stays, and each
 * rewritten JSON file must parse to its original with only those fields
 * changed. For a publishable package it also moves `pack.baseline` in its
 * `release-gates.json` to the version being replaced, with the packed bytes of
 * that version's published registry tarball (so preparation needs registry
 * access); when that version was never published, the baseline stays.
 * Nothing is written unless every file passes; consumed fragments are deleted
 * only after all planned writes succeed. Set preparation also plans an upgrade
 * page from those fragments and the API diff, and refreshes guide links and generated
 * regions and re-pins package entry-point links; those documentation writes and deletions are staged.
 * The package release workflow refuses a version that differs from the package's manifest.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { env as processEnvironment } from "node:process";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { PACKAGES_CONFIG_PATH, RELEASE_VERSION, SET_VERSION, parsePackageReleaseTag, parsePackagesConfig, releaseVersionAbove, type PackageEntry, type PackagesConfig } from "./package-manifest-policy.ts";

import { readChangelogFragments, type ChangelogFragment } from "./changelog-fragments.ts";
import { documentationGit } from "../documentation-routing.ts";
import { assembleUpgradePage, planReleaseGuide, previousCoreTag, previousPackageTag, upgradePagePath } from "./release-docs-pass.ts";

type Json = Record<string, unknown>;
type Edit = { path: readonly string[]; from: string | number; to: string | number };
/** The packed bytes of a published version's registry tarball; undefined when that version is not published. */
export type PublishedPackedBytes = (name: string, version: string) => number | undefined;
type CadenceFlags = { majorApproved?: boolean; exception?: "security" | "money" };
type CadenceOptions = CadenceFlags & {
  now?: () => number;
  readTagDate?: (root: string, tag: string) => number | undefined;
};
const PACKAGE = /^[a-z0-9][a-z0-9-]*$/u;
const UNRELEASED = /^## \[Unreleased\]\n\n/mu;
const PIN_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"] as const;
const MINOR_INTERVAL_MS = 21 * 24 * 60 * 60 * 1000;
const CADENCE_POLICY = ".github/VERSIONING_AND_EOL.md#release-cadence";
const at = (value: unknown, path: readonly string[]): unknown => path.reduce<unknown>((node, key) => (node !== null && typeof node === "object" ? (node as Json)[key] : undefined), value);

/** `text` with each edit's `"<key>": <from>` member set to `<to>` at exactly its key path, and nowhere else. */
export function setStringFields(file: string, text: string, edits: readonly Edit[]): string {
  const expected = JSON.parse(text) as Json;
  for (const { path, from, to } of edits) {
    if (at(expected, path) !== from) throw new Error(`${file}: ${path.join(" > ")} is ${JSON.stringify(at(expected, path))}, not the current ${from}`);
    (at(expected, path.slice(0, -1)) as Json)[path.at(-1)!] = to;
  }
  let result = text;
  for (const { path, from, to } of edits) {
    const key = JSON.stringify(path.at(-1)), needle = `${key}: ${JSON.stringify(from)}`;
    for (let index = result.indexOf(needle); index !== -1; index = result.indexOf(needle, index + 1)) {
      const candidate = `${result.slice(0, index)}${key}: ${JSON.stringify(to)}${result.slice(index + needle.length)}`;
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
export function addReleaseSection(file: string, text: string, version: string, tag: string, fragments: readonly ChangelogFragment[] = []): string {
  const unreleased = UNRELEASED.exec(text);
  if (!unreleased || [...text.matchAll(/^## \[Unreleased\]/gmu)].length !== 1) throw new Error(`${file}: has no "## [Unreleased]" heading followed by a blank line`);
  if (text.includes(`\n## [${version}]`)) throw new Error(`${file}: already has a ${version} section`);
  const end = unreleased.index + unreleased[0].length;
  const next = /^## /mu.exec(text.slice(end));
  const history = next ? end + next.index : text.length;
  const legacy = text.slice(end, history);
  const notes = fragments.length === 0 ? legacy : [legacy, ...fragments.map(({ contents }) => contents)].filter((body) => body.trim()).map((body) => `${body.trimEnd()}\n\n`).join("");
  return `${text.slice(0, end)}## [${version}]\n\n- Publishable on the npm \`latest\` dist-tag as \`${version}\`, from tag\n  \`${tag}\`.\n\n${notes}${text.slice(history)}`;
}

/** npm's own CLI, as `npm run` names it, run by this Node binary rather than found through PATH. */
function npmCli(args: string[]): string {
  const cli = processEnvironment.npm_execpath;
  if (!cli || !isAbsolute(cli)) throw new Error("release:bump reads the registry through npm: run it as npm run release:bump");
  return execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

/**
 * The registry's integrity for `name@version`, then that tarball read without
 * saving it: its `size` is the byte length, and its integrity must match the
 * registry's. Undefined only when the registry answers E404 for the version.
 */
export function npmPublishedPackedBytes(name: string, version: string, npm = npmCli): number | undefined {
  const spec = `${name}@${version}`;
  let integrity: unknown;
  try {
    integrity = JSON.parse(npm(["view", spec, "dist.integrity", "--json"]));
  } catch (error) {
    let code: unknown;
    try { code = (JSON.parse(String((error as { stdout?: unknown }).stdout)) as { error?: { code?: unknown } }).error?.code; } catch { code = undefined; }
    if (code === "E404") return undefined;
    throw new Error(`${spec}: the registry could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const packed = JSON.parse(npm(["pack", spec, "--dry-run", "--json", "--ignore-scripts"])) as Array<{ name?: unknown; version?: unknown; size?: unknown; integrity?: unknown }>;
  const [row] = Array.isArray(packed) && packed.length === 1 ? packed : [];
  if (typeof integrity !== "string" || row?.name !== name || row.version !== version || row.integrity !== integrity || !Number.isSafeInteger(row.size) || (row.size as number) <= 0) throw new Error(`${spec}: npm reported no single published tarball with the registry's integrity`);
  return row.size as number;
}

/** Every exact pin on a bumped package in the dependency fields of `node`, at `base`. */
const pins = (node: unknown, base: readonly string[], bumped: ReadonlySet<string>, from: string, to: string): Edit[] =>
  PIN_FIELDS.flatMap((field) => Object.keys((at(node, [field]) ?? {}) as Json).filter((name) => bumped.has(name)).map((name) => ({ path: [...base, field, name], from, to })));

/** The rewritten files that bring `entries` from `from` to `version`, with every internal pin on them. */
function bumpFiles(root: string, config: PackagesConfig, entries: readonly PackageEntry[], from: string, version: string, packed: PublishedPackedBytes): { writes: Array<[string, string]>; consumed: string[]; fragments: ChangelogFragment[] } {
  const consumed: string[] = [];
  const fragments: ChangelogFragment[] = [];
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
      const notes = readChangelogFragments(root, entry.directory);
      writes.push([changelog, addReleaseSection(changelog, read(changelog), version, `openlup-${entry.directory.slice("packages/".length)}-v${version}`, notes)]);
      fragments.push(...notes);
      consumed.push(...notes.map(({ path }) => path));
      // The growth baseline is the version this one replaces, as published.
      const gates = `${entry.directory}/release-gates.json`;
      const baseline = existsSync(join(root, gates)) ? at(JSON.parse(read(gates)), ["pack", "baseline"]) : undefined;
      if (baseline !== undefined) {
        const { version: was, packedBytes } = (baseline ?? {}) as Json;
        if (typeof was !== "string" || !Number.isSafeInteger(packedBytes)) throw new Error(`${gates}: pack.baseline needs a version string and an integer packedBytes`);
        const bytes = packed(entry.name, from);
        if (bytes === undefined) console.warn(`release:bump: kept ${gates}: ${entry.name}@${from} is not published, so its baseline stays`);
        else writes.push([gates, setStringFields(gates, read(gates), [{ path: ["pack", "baseline", "version"], from: was, to: from }, { path: ["pack", "baseline", "packedBytes"], from: packedBytes as number, to: bytes }])]);
      }
    }
  }
  if (rootLockEdits.length > 0) writes.push(["package-lock.json", setStringFields("package-lock.json", read("package-lock.json"), rootLockEdits)]);
  return { writes, consumed, fragments };
}

const manifestVersion = (root: string, entry: PackageEntry): unknown => (JSON.parse(readFileSync(join(root, entry.directory, "package.json"), "utf8")) as Json).version;

function taggerDate(root: string, tag: string): number | undefined {
  const seconds = documentationGit(root, ["tag", "--list", tag, "--format=%(taggerdate:unix)"]).toString("utf8").trim();
  return seconds ? Number(seconds) * 1000 : undefined;
}

function checkCadence(root: string, version: string, previousTag: string | undefined, {
  majorApproved, exception, now = Date.now, readTagDate = taggerDate,
}: CadenceOptions): void {
  if (previousTag === undefined) return; // First release.
  const previous = parsePackageReleaseTag(previousTag);
  if (!previous) throw new Error(`${previousTag} is not a package release tag`);
  const [major, minor] = version.split(".") as [string, string];
  const [previousMajor, previousMinor] = previous.version.split(".") as [string, string];
  if (BigInt(major) > BigInt(previousMajor) && !majorApproved) {
    throw new Error(`Pass --major-approved for a planned major release. Major releases ship at most once a year and remove only previously deprecated contracts after a compatibility bridge through at least one supported minor release. See ${CADENCE_POLICY}.`);
  }
  if (major !== previousMajor || BigInt(minor) <= BigInt(previousMinor) || exception) return;
  const name = previous.directory.slice("packages/".length);
  const minorTag = `openlup-${name}-v${previousMajor}.${previousMinor}.0`;
  const releasedAt = readTagDate(root, minorTag);
  if (releasedAt === undefined) throw new Error(`Cannot read the annotated tagger date for ${minorTag}. Fetch the release tags and retry.`);
  const eligibleAt = releasedAt + MINOR_INTERVAL_MS;
  if (now() < eligibleAt) {
    const date = new Date(eligibleAt).toISOString().slice(0, 10);
    throw new Error(`For a minor release, wait until ${date} (UTC). Pass --cadence-exception=security or --cadence-exception=money only for a defect of that kind whose fix requires a database or public API change. See ${CADENCE_POLICY}.`);
  }
}

const writeAll = (root: string, { writes, consumed, staged = [] }: { writes: Array<[string, string]>; consumed: string[]; staged?: string[] }): string[] => {
  for (const [file, text] of writes) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); }
  for (const file of consumed) unlinkSync(join(root, file));
  if (consumed.length > 0) documentationGit(root, ["rm", "--cached", "--quiet", "--ignore-unmatch", "--", ...consumed.map((file) => `:(literal)${file}`)]);
  if (staged.length > 0) documentationGit(root, ["add", "--", ...staged.map((file) => `:(literal)${file}`)]);
  return [...writes.map(([file]) => file), ...consumed];
};

/** Sets `packages/<name>` to `version` and returns the rewritten files. */
export function bumpRelease(root: string, name: string, version: string, packed: PublishedPackedBytes = npmPublishedPackedBytes, cadence: CadenceOptions = {}): string[] {
  if (!PACKAGE.test(name)) throw new Error(`${name} is not a package directory name under packages/`);
  if (!RELEASE_VERSION.test(version)) throw new Error(`${version} is not a MAJOR.MINOR.PATCH release version`);
  const directory = `packages/${name}`;
  const config = parsePackagesConfig(readFileSync(join(root, PACKAGES_CONFIG_PATH), "utf8"));
  const entry = config.packages.find((row) => row.directory === directory);
  if (!entry) throw new Error(`${directory} is not a released package in ${PACKAGES_CONFIG_PATH}`);
  const from = manifestVersion(root, entry);
  if (typeof from !== "string" || releaseVersionAbove(version, from) !== true) throw new Error(`${entry.name} is at ${String(from)}; the next version must be a release version above it`);
  if (entry.publish && !SET_VERSION.test(version)) throw new Error(`${entry.name} is publishable, so its next version is a set version: use 0.N.P (N >= 1) or MAJOR.MINOR.PATCH (MAJOR >= 1), not ${version}`);
  if (entry.publish && config.packages.some((row) => row.publish && row !== entry)) throw new Error(`${entry.name} moves with its set: npm run release:bump -- --set <version>`);
  checkCadence(root, version, previousPackageTag(root, name), cadence);
  return writeAll(root, bumpFiles(root, config, [entry], from, version, packed));
}

/** Sets every publishable package to the set version `version` and returns the rewritten files. */
export function bumpSet(root: string, version: string, packed: PublishedPackedBytes = npmPublishedPackedBytes, cadence: CadenceOptions = {}): string[] {
  if (!SET_VERSION.test(version)) throw new Error(`${version} is not a set version: use 0.N.P (N >= 1) or MAJOR.MINOR.PATCH (MAJOR >= 1)`);
  const config = parsePackagesConfig(readFileSync(join(root, PACKAGES_CONFIG_PATH), "utf8"));
  const publishable = config.packages.filter(({ publish }) => publish);
  if (publishable.length === 0) throw new Error(`${PACKAGES_CONFIG_PATH} lists no publishable package`);
  const current = publishable.map((entry) => [entry.name, manifestVersion(root, entry)] as const);
  const from = current[0]![1];
  if (current.some(([, other]) => other !== from)) throw new Error(`the publishable packages carry different versions (${current.map(([name, other]) => `${name}@${String(other)}`).join(", ")}); packages:check refuses that`);
  if (typeof from !== "string" || releaseVersionAbove(version, from) !== true) throw new Error(`the set is at ${String(from)}; the next set version must be above it`);
  const since = previousCoreTag(root);
  checkCadence(root, version, since, cadence);
  const page = upgradePagePath(version);
  if (lstatSync(join(root, page), { throwIfNoEntry: false })) throw new Error(`${page}: upgrade page already exists`);
  const planned = bumpFiles(root, config, publishable, from, version, packed);
  const upgrade = assembleUpgradePage({ root, version, since, fragments: planned.fragments });
  for (const violation of upgrade.violations) console.warn(`release:bump: warning: ${violation}`);
  planned.writes.push([page, upgrade.text]);
  const repositoryRoot = resolve(root);
  const guide = planReleaseGuide(repositoryRoot, version, { [join(repositoryRoot, page)]: upgrade.text });
  for (const violation of guide.violations) console.warn(`release:bump: warning: ${violation}`);
  const writes = new Map(planned.writes);
  const staged = new Set([page]);
  for (const [file, source] of guide.writes) {
    const path = relative(repositoryRoot, file).split(sep).join("/");
    writes.set(path, source);
    staged.add(path);
  }
  return writeAll(root, { writes: [...writes], consumed: planned.consumed, staged: [...staged] });
}

function parseBumpArguments([target, version, ...flags]: readonly string[]): { target: string; version: string; cadence: CadenceFlags } | undefined {
  if (!target || !version) return undefined;
  if (target === "--set" ? !SET_VERSION.test(version) : !PACKAGE.test(target) || !RELEASE_VERSION.test(version)) return undefined;
  const cadence: CadenceFlags = {};
  for (const flag of flags) {
    if (flag === "--major-approved" && !cadence.majorApproved) {
      cadence.majorApproved = true;
    } else if ((flag === "--cadence-exception=security" || flag === "--cadence-exception=money") && !cadence.exception) {
      cadence.exception = flag === "--cadence-exception=security" ? "security" : "money";
    } else {
      return undefined;
    }
  }
  return { target, version, cadence };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = parseBumpArguments(process.argv.slice(2));
  if (!args) {
    console.error("usage: npm run release:bump -- --set <MAJOR.MINOR.PATCH>, or npm run release:bump -- <package directory name> <MAJOR.MINOR.PATCH>; either form accepts [--major-approved] [--cadence-exception=security|money] after the version");
    process.exitCode = 2;
  } else {
    try {
      const { target, version, cadence } = args;
      const files = target === "--set" ? bumpSet(process.cwd(), version, undefined, cadence) : bumpRelease(process.cwd(), target, version, undefined, cadence);
      for (const file of files) console.log(`release:bump: ${existsSync(file) ? "rewrote" : "removed"} ${file}`);
    } catch (error) {
      console.error(`release:bump: refused: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
