/**
 * `npm run release:bump -- <n>`, from the repository root, sets the lockstep
 * package version to `0.<n>.0` for the next source preview
 * `openlup-source-preview/<n>`. It rewrites exactly the lockstep version
 * strings: `config/openlup-packages.json`, and for each listed package its
 * `package.json`, the root of its own `package-lock.json` and its workspace
 * entry in the root `package-lock.json`. It adds the "Publishable" line to each
 * publishable package's CHANGELOG. Every other byte stays, and each rewritten
 * file must parse to its original with only those fields changed. Nothing is
 * written unless every file passes. Run the bump in the same later change
 * that removes compatibility files due at that preview; release prepare refuses a cut
 * whose version is not `0.<n>.0`.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { PACKAGES_CONFIG_PATH, parsePackagesConfig } from "./package-manifest-policy.ts";

type Json = Record<string, unknown>;
const LOCKSTEP = /^0\.([1-9]\d*)\.0$/u;
const CHANGELOG_ENTRY = /^- Publishable on the npm `preview` dist-tag as `0\.[1-9]\d*\.0`/mu;
const at = (value: unknown, path: readonly string[]): unknown => path.reduce<unknown>((node, key) => (node !== null && typeof node === "object" ? (node as Json)[key] : undefined), value);

/** `text` with `"version": "<from>"` replaced at exactly the key paths `fields`, and nowhere else. */
export function setVersionFields(file: string, text: string, fields: readonly string[][], from: string, to: string): string {
  const expected = JSON.parse(text) as Json;
  for (const path of fields) {
    if (at(expected, path) !== from) throw new Error(`${file}: ${path.join(" > ")} is ${JSON.stringify(at(expected, path))}, not the lockstep ${from}`);
    (at(expected, path.slice(0, -1)) as Json)[path.at(-1)!] = to;
  }
  const needle = `"version": "${from}"`;
  let result = text;
  for (let index = result.indexOf(needle); index !== -1; index = result.indexOf(needle, index + 1)) {
    const candidate = `${result.slice(0, index)}"version": "${to}"${result.slice(index + needle.length)}`;
    const before = JSON.parse(result), after = JSON.parse(candidate);
    if (fields.some((path) => at(before, path) === from && at(after, path) === to)) result = candidate;
  }
  if (!isDeepStrictEqual(JSON.parse(result), expected)) throw new Error(`${file}: a lockstep field is not written as "version": "${from}"`);
  return result;
}

/** `text` with the new "Publishable" line above the newest one. */
export function addChangelogLine(file: string, text: string, version: string, preview: number): string {
  const newest = CHANGELOG_ENTRY.exec(text);
  if (!newest) throw new Error(`${file}: has no "Publishable on the npm \`preview\` dist-tag" line to follow`);
  return `${text.slice(0, newest.index)}- Publishable on the npm \`preview\` dist-tag as \`${version}\`, for source preview\n  \`openlup-source-preview/${preview}\`.\n${text.slice(newest.index)}`;
}

/** Sets the lockstep version to `0.<preview>.0` and returns the rewritten files. */
export function bumpRelease(root: string, preview: number): string[] {
  const config = parsePackagesConfig(readFileSync(join(root, PACKAGES_CONFIG_PATH), "utf8"));
  const current = LOCKSTEP.exec(config.version)?.[1];
  if (current === undefined) throw new Error(`${PACKAGES_CONFIG_PATH}: the lockstep version ${config.version} is not 0.<n>.0`);
  if (!Number.isSafeInteger(preview) || preview <= Number(current)) throw new Error(`the lockstep version is ${config.version}; the next preview number must be above ${current}`);
  const from = config.version, to = `0.${preview}.0`;
  const edits: Array<[string, string[][]]> = [[PACKAGES_CONFIG_PATH, [["version"]]], ["package-lock.json", config.packages.map(({ directory }) => ["packages", directory, "version"])]];
  for (const { directory } of config.packages) {
    edits.push([`${directory}/package.json`, [["version"]]]);
    if (existsSync(join(root, directory, "package-lock.json"))) edits.push([`${directory}/package-lock.json`, [["version"], ["packages", "", "version"]]]);
  }
  const writes = edits.map(([file, fields]): [string, string] => [file, setVersionFields(file, readFileSync(join(root, file), "utf8"), fields, from, to)]);
  for (const { directory } of config.packages.filter(({ publish }) => publish)) {
    const file = `${directory}/CHANGELOG.md`;
    writes.push([file, addChangelogLine(file, readFileSync(join(root, file), "utf8"), to, preview)]);
  }
  for (const [file, text] of writes) writeFileSync(join(root, file), text);
  return writes.map(([file]) => file);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !/^[1-9]\d*$/u.test(args[0]!)) {
    console.error("usage: npm run release:bump -- <next source preview number>");
    process.exitCode = 2;
  } else {
    try {
      for (const file of bumpRelease(process.cwd(), Number(args[0]))) console.log(`release:bump: rewrote ${file}`);
    } catch (error) {
      console.error(`release:bump: refused: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
