// ast-grep can suppress its own rules, so this first-line check runs before scan.
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function hasFilewideIgnore(source) {
  const firstEnd = source.indexOf("\n");
  if (firstEnd < 0) return false;
  const secondEnd = source.indexOf("\n", firstEnd + 1);
  const first = source.slice(0, firstEnd).replace(/\r$/u, "");
  const second = source.slice(firstEnd + 1, secondEnd < 0 ? source.length : secondEnd).replace(/\r$/u, "");
  return /^[ \t]*(?:\/\/|\/\*+)[ \t]*ast-grep-ignore\b/u.test(first) && /^[ \t]*$/u.test(second);
}

export function checkFilewideIgnores(cwd = process.cwd()) {
  const paths = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  }).split("\0").filter((path) => /\.tsx?$/u.test(path));
  let failed = false;
  for (const path of new Set(paths)) {
    let stat;
    try { stat = lstatSync(resolve(cwd, path)); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!stat.isFile()) throw new Error(`not a regular source file: ${path}`);
    if (!hasFilewideIgnore(readFileSync(resolve(cwd, path), "utf8"))) continue;
    console.error(`${path}:1: first-line ast-grep-ignore followed by a blank line suppresses the whole file; remove the blank line`);
    failed = true;
  }
  return !failed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { if (!checkFilewideIgnores()) process.exitCode = 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
