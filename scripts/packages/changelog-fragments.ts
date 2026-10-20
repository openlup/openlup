import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ChangelogFragment = { path: string; contents: string };
export const isChangelogFragmentArea = (path: string): boolean => /^packages\/(?:core|outbox|platform)\/changes(?:\/|$)/u.test(path);
export const isChangelogFragment = (path: string): boolean => /^packages\/(?:core|outbox|platform)\/changes\/[^/]+\.md$/u.test(path);

/** The only implicit publication carrier: regular non-executable Markdown, never a directory or script. */
export function validateChangelogFragment(path: string, bytes: string | Buffer, mode: string): string {
  if (!isChangelogFragment(path) || mode !== "100644") throw new Error(`${path}: fragment must be changes/*.md, regular and non-executable`);
  const contents = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!contents.trim() || Buffer.from(contents).some((byte) => (byte < 0x20 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 0x7f)) throw new Error(`${path}: empty or malformed changelog fragment`);
  if (/^\s{0,3}#{1,2}(?:\s|$)/mu.test(contents)) throw new Error(`${path}: fragment refuses # and ## headings`);
  if (/^[\t ]*(?:<{7}|={7}|>{7}|\|{7})/mu.test(contents)) throw new Error(`${path}: fragment refuses conflict markers`);
  return contents;
}

export function readChangelogFragments(root: string, directory: string): ChangelogFragment[] {
  const area = `${directory}/changes`;
  if (!isChangelogFragmentArea(area) || !existsSync(join(root, area))) return [];
  if (!lstatSync(join(root, area)).isDirectory()) throw new Error(`${area}: fragment carrier must be a directory`);
  return readdirSync(join(root, area)).map((name) => `${area}/${name}`).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map((path) => {
    const stat = lstatSync(join(root, path));
    if (!stat.isFile()) throw new Error(`${path}: fragment must be a regular file, not a nested directory or link`);
    return { path, contents: validateChangelogFragment(path, readFileSync(join(root, path)), stat.mode & 0o111 ? "100755" : "100644") };
  });
}
