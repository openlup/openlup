/**
 * `npm run release:bump -- <package> <version>`, from the repository root, sets
 * the version of the released package `packages/<package>` for its next
 * release, `openlup-<package>-v<version>`. The version is a `MAJOR.MINOR.PATCH`
 * release version above the current one. It rewrites exactly that package's
 * version strings: its `package.json`, the root of its own `package-lock.json`
 * and its workspace entry in the root `package-lock.json`, where they exist.
 * For a publishable package it adds the "Publishable" line to its CHANGELOG.
 * Every other byte stays, and each rewritten file must parse to its original
 * with only those fields changed. Nothing is written unless every file passes.
 * The package release workflow refuses a version that differs from the
 * package's manifest.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { PACKAGES_CONFIG_PATH, RELEASE_VERSION, parsePackagesConfig, releaseVersionAbove } from "./package-manifest-policy.ts";

type Json = Record<string, unknown>;
const PACKAGE = /^[a-z0-9][a-z0-9-]*$/u;
const CHANGELOG_ENTRY = /^- Publishable on the npm `(?:preview|latest)` dist-tag as `\d+\.\d+\.\d+`/mu;
const at = (value: unknown, path: readonly string[]): unknown => path.reduce<unknown>((node, key) => (node !== null && typeof node === "object" ? (node as Json)[key] : undefined), value);

/** `text` with `"version": "<from>"` replaced at exactly the key paths `fields`, and nowhere else. */
export function setVersionFields(file: string, text: string, fields: readonly string[][], from: string, to: string): string {
  const expected = JSON.parse(text) as Json;
  for (const path of fields) {
    if (at(expected, path) !== from) throw new Error(`${file}: ${path.join(" > ")} is ${JSON.stringify(at(expected, path))}, not the current ${from}`);
    (at(expected, path.slice(0, -1)) as Json)[path.at(-1)!] = to;
  }
  const needle = `"version": "${from}"`;
  let result = text;
  for (let index = result.indexOf(needle); index !== -1; index = result.indexOf(needle, index + 1)) {
    const candidate = `${result.slice(0, index)}"version": "${to}"${result.slice(index + needle.length)}`;
    const before = JSON.parse(result), after = JSON.parse(candidate);
    if (fields.some((path) => at(before, path) === from && at(after, path) === to)) result = candidate;
  }
  if (!isDeepStrictEqual(JSON.parse(result), expected)) throw new Error(`${file}: a version field is not written as "version": "${from}"`);
  return result;
}

/** `text` with the new "Publishable" line above the newest one. */
export function addChangelogLine(file: string, text: string, version: string, tag: string): string {
  const newest = CHANGELOG_ENTRY.exec(text);
  if (!newest) throw new Error(`${file}: has no "Publishable on the npm" line to follow; add a package's first line by hand`);
  return `${text.slice(0, newest.index)}- Publishable on the npm \`latest\` dist-tag as \`${version}\`, from tag\n  \`${tag}\`.\n${text.slice(newest.index)}`;
}

/** Sets `packages/<name>` to `version` and returns the rewritten files. */
export function bumpRelease(root: string, name: string, version: string): string[] {
  if (!PACKAGE.test(name)) throw new Error(`${name} is not a package directory name under packages/`);
  if (!RELEASE_VERSION.test(version)) throw new Error(`${version} is not a MAJOR.MINOR.PATCH release version`);
  const directory = `packages/${name}`;
  const config = parsePackagesConfig(readFileSync(join(root, PACKAGES_CONFIG_PATH), "utf8"));
  const entry = config.packages.find((row) => row.directory === directory);
  if (!entry) throw new Error(`${directory} is not a released package in ${PACKAGES_CONFIG_PATH}`);
  const manifest = `${directory}/package.json`;
  const from = (JSON.parse(readFileSync(join(root, manifest), "utf8")) as Json).version;
  if (typeof from !== "string" || releaseVersionAbove(version, from) !== true) throw new Error(`${entry.name} is at ${String(from)}; the next version must be a release version above it`);
  const edits: Array<[string, string[][]]> = [[manifest, [["version"]]]];
  if (at(JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")), ["packages", directory]) !== undefined) edits.push(["package-lock.json", [["packages", directory, "version"]]]);
  if (existsSync(join(root, directory, "package-lock.json"))) edits.push([`${directory}/package-lock.json`, [["version"], ["packages", "", "version"]]]);
  const writes = edits.map(([file, fields]): [string, string] => [file, setVersionFields(file, readFileSync(join(root, file), "utf8"), fields, from, version)]);
  if (entry.publish) {
    const file = `${directory}/CHANGELOG.md`;
    writes.push([file, addChangelogLine(file, readFileSync(join(root, file), "utf8"), version, `openlup-${name}-v${version}`)]);
  }
  for (const [file, text] of writes) writeFileSync(join(root, file), text);
  return writes.map(([file]) => file);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || !PACKAGE.test(args[0]!) || !RELEASE_VERSION.test(args[1]!)) {
    console.error("usage: npm run release:bump -- <package directory name> <MAJOR.MINOR.PATCH>");
    process.exitCode = 2;
  } else {
    try {
      for (const file of bumpRelease(process.cwd(), args[0]!, args[1]!)) console.log(`release:bump: rewrote ${file}`);
    } catch (error) {
      console.error(`release:bump: refused: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
